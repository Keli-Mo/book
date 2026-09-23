const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const constantsRoot = path.join(
  projectRoot,
  "src/pages/BookDetail/Components/BookPreview/constants",
);
const BOOK_IDS = Array.from({ length: 27 }, (_, index) => String(index + 3));
const MAPPING_VERSION = "audio-key-minus-2/v1";

// 常量文件没有运行时依赖，转译后直接读取，避免再维护一份音频清单。
const loadTypeScriptConstants = (filename) => {
  const source = fs.readFileSync(path.join(constantsRoot, filename), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const loadedModule = { exports: {} };
  new Function("module", "exports", "require", output)(
    loadedModule,
    loadedModule.exports,
    require,
  );
  return loadedModule.exports;
};

const parseImagePageNumber = (imageUrl) => {
  const decodedUrl = decodeURIComponent(imageUrl.split("?")[0]);
  const match = decodedUrl.match(/_(\d+)\.(?:png|jpe?g|webp)$/i);
  return match ? Number(match[1]) : null;
};

const parseTrackCoordinate = (track) => {
  const [x, y] = track.offset;
  if (track.flag === "Percentage") {
    return [Number.parseFloat(x), Number.parseFloat(y)];
  }
  if (track.flag === "Cambridge") {
    return [((x - 3576) / 825) * 100, ((y - 202) / 1061) * 100];
  }
  return [((x - 653) / 469) * 100, ((y - 167) / 606) * 100];
};

const formatCoordinateBounds = (bounds) =>
  `${bounds.left.min.toFixed(2)}%–${bounds.left.max.toFixed(2)}%, ${bounds.top.min.toFixed(2)}%–${bounds.top.max.toFixed(2)}%`;

const getDecodedFilename = (url) =>
  decodeURIComponent(new URL(url).pathname.split("/").pop() || "");

const getSection = (catalog, imageIndex) => {
  let section = "课程导入";
  for (const entry of catalog) {
    if (entry.page > imageIndex) break;
    section = entry.name;
  }
  return section;
};

const findNoAudioCatalogRanges = (catalog, imageCount, audioImageIndexes) =>
  catalog
    .map((entry, catalogIndex) => {
      const endIndex =
        catalogIndex === catalog.length - 1
          ? imageCount - 1
          : catalog[catalogIndex + 1].page - 1;
      const hasAudio = [...audioImageIndexes].some(
        (imageIndex) => imageIndex >= entry.page && imageIndex <= endIndex,
      );
      return hasAudio
        ? null
        : `${entry.name}（图片索引 ${entry.page}–${endIndex}）`;
    })
    .filter(Boolean);

const isOutsideImage = ({ leftPercent, topPercent }) =>
  leftPercent < 0 || leftPercent > 100 || topPercent < 0 || topPercent > 100;

const formatMapping = (mapping) =>
  `教材 ${mapping.bookId} 音频键 ${mapping.rawAudioKey} -> 图片索引 ${mapping.imageIndex} -> 真实页 ${mapping.imagePageNumber} -> ${mapping.section} -> ${mapping.audioFilename}`;

const formatCoordinateWarning = (mapping) =>
  `坐标警告：教材 ${mapping.bookId}，音频键 ${mapping.rawAudioKey}，图片索引 ${mapping.imageIndex}，真实页 ${mapping.imagePageNumber}，轨 ${mapping.trackNumber}，原坐标 ${JSON.stringify(mapping.rawOffset)}，换算 (${mapping.leftPercent.toFixed(2)}%, ${mapping.topPercent.toFixed(2)}%)，音频 ${mapping.audioFilename}`;

const validateBookData = ({ log = true } = {}) => {
  const { concatImages } = loadTypeScriptConstants("images.ts");
  const { allAudioList } = loadTypeScriptConstants("audioList.ts");
  const { catalogLists } = loadTypeScriptConstants("catalogList.ts");
  const report = {
    mappingVersion: MAPPING_VERSION,
    books: [],
    mappings: [],
    coordinateWarnings: [],
    imageCount: 0,
    practicePageCount: 0,
    audioSegmentCount: 0,
  };

  for (const bookId of BOOK_IDS) {
    const images = concatImages[bookId];
    const audioByPage = allAudioList[bookId];
    const catalog = catalogLists[bookId];
    if (!Array.isArray(images) || !audioByPage || !Array.isArray(catalog)) {
      throw new Error(`教材 ${bookId} 的图片、音频或目录常量缺失`);
    }

    const imagePageNumbers = [];
    const seenPageNumbers = new Set();
    for (const [imageIndex, imageUrl] of images.entries()) {
      if (new URL(imageUrl).protocol !== "https:") {
        throw new Error(`教材 ${bookId} 图片 ${imageIndex} 未使用 HTTPS URL`);
      }
      const pageNumber = parseImagePageNumber(imageUrl);
      imagePageNumbers.push(pageNumber);
      if (pageNumber === null) continue;
      if (seenPageNumbers.has(pageNumber)) {
        throw new Error(`教材 ${bookId} 的真实页号重复：${pageNumber}`);
      }
      seenPageNumbers.add(pageNumber);
    }

    let audioPageCount = 0;
    let audioSegmentCount = 0;
    const audioImageIndexes = new Set();
    const bounds = {
      left: { min: Infinity, max: -Infinity },
      top: { min: Infinity, max: -Infinity },
    };
    for (const [rawAudioKey, tracks] of Object.entries(audioByPage)) {
      if (!Array.isArray(tracks) || tracks.length === 0) continue;
      const audioKey = Number(rawAudioKey);
      // 历史录点工具把 currentImageIndex + 2 写成键；该键不是教材图片的印刷页号。
      const imageIndex = audioKey - 2;
      if (
        !/^(?:0|[1-9]\d*)$/.test(rawAudioKey) ||
        !Number.isSafeInteger(audioKey) ||
        imageIndex < 0 ||
        imageIndex >= images.length
      ) {
        throw new Error(
          `教材 ${bookId} 音频键 ${rawAudioKey} 映射图片索引 ${imageIndex} 不存在`,
        );
      }
      const imagePageNumber = imagePageNumbers[imageIndex];
      if (imagePageNumber === null) {
        throw new Error(
          `教材 ${bookId} 音频键 ${rawAudioKey} 映射图片索引 ${imageIndex} 无法解析真实页号`,
        );
      }
      audioPageCount += 1;
      audioImageIndexes.add(imageIndex);
      const section = getSection(catalog, imageIndex);

      for (const [trackIndex, track] of tracks.entries()) {
        if (!track.url || !Array.isArray(track.offset) || track.offset.length !== 2) {
          throw new Error(
            `教材 ${bookId} 音频键 ${rawAudioKey} 图片索引 ${imageIndex} 真实页 ${imagePageNumber} 轨 ${trackIndex + 1} 原坐标 ${JSON.stringify(track?.offset)} 数据不完整`,
          );
        }
        if (new URL(track.url).protocol !== "https:") {
          throw new Error(
            `教材 ${bookId} 音频键 ${rawAudioKey} 图片索引 ${imageIndex} 真实页 ${imagePageNumber} 轨 ${trackIndex + 1} 未使用 HTTPS URL`,
          );
        }
        const [leftPercent, topPercent] = parseTrackCoordinate(track);
        if (!Number.isFinite(leftPercent) || !Number.isFinite(topPercent)) {
          throw new Error(
            `教材 ${bookId} 音频键 ${rawAudioKey} 图片索引 ${imageIndex} 真实页 ${imagePageNumber} 轨 ${trackIndex + 1} 原坐标 ${JSON.stringify(track.offset)} 坐标无法解析`,
          );
        }
        const mapping = {
          bookId,
          rawAudioKey: audioKey,
          imageIndex,
          imagePageNumber,
          section,
          trackNumber: trackIndex + 1,
          audioFilename: getDecodedFilename(track.url),
          rawOffset: [...track.offset],
          coordinateType: track.flag || "pixel",
          leftPercent,
          topPercent,
        };
        report.mappings.push(mapping);
        if (isOutsideImage(mapping)) report.coordinateWarnings.push(mapping);
        bounds.left.min = Math.min(bounds.left.min, leftPercent);
        bounds.left.max = Math.max(bounds.left.max, leftPercent);
        bounds.top.min = Math.min(bounds.top.min, topPercent);
        bounds.top.max = Math.max(bounds.top.max, topPercent);
        audioSegmentCount += 1;
      }
    }

    const noAudioCatalogRanges = findNoAudioCatalogRanges(
      catalog,
      images.length,
      audioImageIndexes,
    );
    const bookReport = {
      bookId,
      imageCount: images.length,
      audioPageCount,
      audioSegmentCount,
      mappingCount: audioSegmentCount,
      coordinateBounds: bounds,
      noAudioCatalogRanges,
    };
    report.books.push(bookReport);
    report.imageCount += images.length;
    report.practicePageCount += audioPageCount;
    report.audioSegmentCount += audioSegmentCount;

    if (log) {
      console.log(
        `教材 ${bookId}：${images.length} 张图片，${audioPageCount} 个音频页，${audioSegmentCount} 段音频，边界坐标 ${formatCoordinateBounds(bounds)}，无音频目录区间：${noAudioCatalogRanges.join("；") || "无"}`,
      );
    }
  }

  if (log) {
    const representativeMapping = report.mappings.find(
      ({ bookId, rawAudioKey }) => bookId === "8" && rawAudioKey === 37,
    );
    console.log(
      `映射规则 ${MAPPING_VERSION}：历史音频键 K 映射 images[K - 2]，真实页号取图片文件名，目录按图片索引判定。`,
    );
    if (representativeMapping) console.log(formatMapping(representativeMapping));
    report.coordinateWarnings.forEach((warning) =>
      console.log(formatCoordinateWarning(warning)),
    );
    console.log(
      `映射校验通过：${BOOK_IDS.length} 本教材，${report.imageCount} 张教材图片，${report.practicePageCount} 个训练页，${report.audioSegmentCount} 段音频；坐标轻微越界 ${report.coordinateWarnings.length} 处（仅警告）。`,
    );
  }
  return report;
};

module.exports = { validateBookData };

if (require.main === module) {
  validateBookData();
}
