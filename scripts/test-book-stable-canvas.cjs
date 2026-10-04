/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const sourcePath = path.resolve(
  __dirname,
  "../src/features/listeningPractice/bookImageSizes.ts",
);

const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2017,
  },
  fileName: sourcePath,
});
const moduleContainer = { exports: {} };
vm.runInNewContext(
  compiled.outputText,
  { module: moduleContainer, exports: moduleContainer.exports, require },
  { filename: sourcePath },
);

const { readBookStableCanvasSize } = moduleContainer.exports;
const normalize = (value) => JSON.parse(JSON.stringify(value));

const EXPECTED_CANVAS_SIZES = {
  "3": [1240, 1754], "4": [1240, 1754], "5": [1240, 1754], "6": [1240, 1754],
  "7": [1240, 1594], "8": [1240, 1594],
  "9": [1240, 1674], "10": [1240, 1674],
  "11": [2550, 3263], "12": [2550, 3263], "13": [2550, 3263], "14": [2550, 3263],
  "15": [2400, 3100], "16": [2400, 3100], "17": [2400, 3105],
  "18": [3072, 3968], "19": [2560, 3312],
  "20": [1588, 2245], "21": [1588, 2245], "22": [1588, 2245], "23": [1588, 2245],
  "24": [1587, 2079], "25": [1587, 2079],
  "26": [1040, 1411], "27": [1040, 1411], "28": [1040, 1411], "29": [1040, 1411],
  "30": [1536, 1987], "31": [1536, 1984],
};

test("当前 29 本教材都有稳定画布尺寸", () => {
  assert.equal(Object.keys(EXPECTED_CANVAS_SIZES).length, 29);
  for (const [bookId, [width, height]] of Object.entries(EXPECTED_CANVAS_SIZES)) {
    assert.deepEqual(
      normalize(readBookStableCanvasSize(bookId)),
      { width, height },
      `教材 ${bookId} 应使用核验后的稳定画布`,
    );
  }
});

test("尺寸表外的教材不臆造稳定画布", () => {
  assert.equal(readBookStableCanvasSize("unknown"), null);
});
