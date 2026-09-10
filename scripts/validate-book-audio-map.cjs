const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const constantsRoot = path.join(
  projectRoot,
  "src/pages/BookDetail/Components/BookPreview/constants",
);
const BOOK_IDS = Array.from({ length: 23 }, (_, index) => String(index + 3));

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

const findNoAudioCatalogRanges = (catalog, images, audioPageNumbers) =>
  catalog
    .map((entry, catalogIndex) => {
      const endIndex =
        catalogIndex === catalog.length - 1
          ? images.length - 1
          : catalog[catalogIndex + 1].page - 1;
      const hasAudio = images
        .slice(entry.page, endIndex + 1)
        .some((imageUrl) => audioPageNumbers.has(parseImagePageNumber(imageUrl)));
      return hasAudio ? null : `${entry.name}（${entry.page}–${endIndex}）`;
    })
    .filter(Boolean);

const validateBookData = ({ log = true } = {}) => {
  const { concatImages } = loadTypeScriptConstants("images.ts");
  const { allAudioList } = loadTypeScriptConstants("audioList.ts");
  const { catalogLists } = loadTypeScriptConstants("catalogList.ts");
  const report = {
    books: [],
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

    const pageToImage = new Map();
    for (const [imageIndex, imageUrl] of images.entries()) {
      if (new URL(imageUrl).protocol !== "https:") {
        throw new Error(`教材 ${bookId} 图片 ${imageIndex} 未使用 HTTPS URL`);
      }
      const pageNumber = parseImagePageNumber(imageUrl);
      if (pageNumber === null) continue;
      if (pageToImage.has(pageNumber)) {
        throw new Error(`教材 ${bookId} 的真实页号重复：${pageNumber}`);
      }
      pageToImage.set(pageNumber, imageIndex);
    }

    let audioPageCount = 0;
    let audioSegmentCount = 0;
    const audioPageNumbers = new Set();
    const bounds = {
      left: { min: Infinity, max: -Infinity },
      top: { min: Infinity, max: -Infinity },
    };
    for (const [pageKey, tracks] of Object.entries(audioByPage)) {
      if (!Array.isArray(tracks) || tracks.length === 0) continue;
      const pageNumber = Number(pageKey);
      if (!Number.isInteger(pageNumber) || !pageToImage.has(pageNumber)) {
        throw new Error(`教材 ${bookId} 音频页 ${pageKey} 找不到对应教材图片`);
      }
      audioPageCount += 1;
      audioPageNumbers.add(pageNumber);

      for (const [trackIndex, track] of tracks.entries()) {
        if (!track.url || !Array.isArray(track.offset) || track.offset.length !== 2) {
          throw new Error(`教材 ${bookId} 第 ${pageNumber} 页第 ${trackIndex + 1} 段数据不完整`);
        }
        if (new URL(track.url).protocol !== "https:") {
          throw new Error(`教材 ${bookId} 第 ${pageNumber} 页第 ${trackIndex + 1} 段未使用 HTTPS URL`);
        }
        const [left, top] = parseTrackCoordinate(track);
        if (!Number.isFinite(left) || !Number.isFinite(top)) {
          throw new Error(`教材 ${bookId} 第 ${pageNumber} 页第 ${trackIndex + 1} 段坐标无法解析`);
        }
        bounds.left.min = Math.min(bounds.left.min, left);
        bounds.left.max = Math.max(bounds.left.max, left);
        bounds.top.min = Math.min(bounds.top.min, top);
        bounds.top.max = Math.max(bounds.top.max, top);
        audioSegmentCount += 1;
      }
    }

    const noAudioCatalogRanges = findNoAudioCatalogRanges(
      catalog,
      images,
      audioPageNumbers,
    );
    const bookReport = {
      bookId,
      imageCount: images.length,
      audioPageCount,
      audioSegmentCount,
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
    console.log(
      `映射校验通过：23 本教材，${report.imageCount} 张教材图片，${report.practicePageCount} 个训练页，${report.audioSegmentCount} 段音频。`,
    );
  }
  return report;
};

module.exports = { validateBookData };

if (require.main === module) {
  validateBookData();
}
