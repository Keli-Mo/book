const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const constantsRoot = path.join(
  projectRoot,
  "src/pages/BookDetail/Components/BookPreview/constants",
);

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

const { concatImages } = loadTypeScriptConstants("images.ts");
const { allAudioList } = loadTypeScriptConstants("audioList.ts");
const bookId = "3";
const imageUrls = concatImages[bookId] || [];
const audioByPage = allAudioList[bookId] || {};
const pageToImage = new Map();

for (const [imageIndex, imageUrl] of imageUrls.entries()) {
  const decodedUrl = decodeURIComponent(imageUrl.split("?")[0]);
  const match = decodedUrl.match(/_(\d+)\.(?:png|jpe?g|webp)$/i);
  if (!match) throw new Error(`图片 ${imageIndex} 无法解析真实页号：${imageUrl}`);
  const pageNumber = Number(match[1]);
  if (pageToImage.has(pageNumber)) throw new Error(`教材真实页号重复：${pageNumber}`);
  pageToImage.set(pageNumber, imageIndex);
}

let trackCount = 0;
let adjustedPositionCount = 0;
for (const [pageKey, tracks] of Object.entries(audioByPage)) {
  if (!Array.isArray(tracks) || tracks.length === 0) continue;
  const pageNumber = Number(pageKey);
  if (!pageToImage.has(pageNumber)) throw new Error(`音频页 ${pageNumber} 找不到对应教材图片`);

  for (const [trackIndex, track] of tracks.entries()) {
    if (!track.url || !Array.isArray(track.offset)) {
      throw new Error(`音频页 ${pageNumber} 的第 ${trackIndex + 1} 段数据不完整`);
    }
    trackCount += 1;
    const left = ((Number(track.offset[0]) - 653) / 469) * 100;
    const top = ((Number(track.offset[1]) - 167) / 606) * 100;
    if (left < 1 || left > 96 || top < 1 || top > 96) {
      adjustedPositionCount += 1;
      console.warn(
        `坐标校正：教材页 ${pageNumber} 第 ${trackIndex + 1} 段（${left.toFixed(2)}%, ${top.toFixed(2)}%）`,
      );
    }
  }
}

console.log(
  `映射校验通过：${imageUrls.length} 张教材图片，${trackCount} 段音频，${adjustedPositionCount} 个热点需边界校正。`,
);
