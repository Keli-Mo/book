/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const records = new Map();
const deletedFiles = [];
let currentOpenId = "owner-openid";
let nextId = 1;

const buildQuery = (predicate) => ({
  orderBy() {
    return this;
  },
  limit() {
    return this;
  },
  async get() {
    return { data: [...records.values()].filter(predicate) };
  },
});

const collection = {
  async add({ data }) {
    const id = `record-${nextId++}`;
    records.set(id, { _id: id, ...data });
    return { _id: id };
  },
  doc(id) {
    return {
      async get() {
        return { data: records.get(id) };
      },
      async remove() {
        records.delete(id);
      },
    };
  },
  where(condition) {
    return buildQuery((item) => item._openid === condition._openid);
  },
};

const mockCloud = {
  DYNAMIC_CURRENT_ENV: "dynamic",
  init() {},
  database() {
    return {
      collection() {
        return collection;
      },
      serverDate() {
        return "2026-08-27T08:00:00.000Z";
      },
    };
  },
  getWXContext() {
    return { OPENID: currentOpenId };
  },
  async getTempFileURL({ fileList }) {
    return {
      fileList: fileList.map((fileID) => ({
        fileID,
        tempFileURL: `https://example.test/${encodeURIComponent(fileID)}`,
      })),
    };
  },
  async deleteFile({ fileList }) {
    deletedFiles.push(...fileList);
    return { fileList };
  },
};

const sourcePath = path.resolve(__dirname, "../cloudfunctions/checkIn/index.js");
const source = fs.readFileSync(sourcePath, "utf8");
const moduleContainer = { exports: {} };
vm.runInNewContext(source, {
  module: moduleContainer,
  exports: moduleContainer.exports,
  console,
  require(moduleName) {
    if (moduleName === "wx-server-sdk") return mockCloud;
    return require(moduleName);
  },
});

const call = (event) => moduleContainer.exports.main(event);

(async () => {
  const created = await call({
    action: "create",
    recordingFileId: "cloud://test.bucket/checkins/2026-08-27/record.mp3",
    durationMs: 3200,
    bookId: "3",
    bookTitle: "CASA阅读启蒙&自然拼读 1",
    practiceId: "3-page-4",
    practiceIndex: 0,
    pageNumber: 4,
    sectionTitle: "课程导入",
    imageUrl: "https://example.test/page-4.png",
  });
  assert.equal(created.ok, true);
  assert.match(created.data.shareToken, /^[a-f0-9]{32}$/);

  const ownerDetail = await call({ action: "detail", id: created.data.id });
  assert.equal(ownerDetail.ok, true);
  assert.equal(ownerDetail.data.isOwner, true);
  assert.match(ownerDetail.data.recordingUrl, /^https:\/\/example\.test\//);

  currentOpenId = "visitor-openid";
  const deniedDetail = await call({ action: "detail", id: created.data.id });
  assert.equal(deniedDetail.ok, false);

  const sharedDetail = await call({
    action: "detail",
    id: created.data.id,
    shareToken: created.data.shareToken,
  });
  assert.equal(sharedDetail.ok, true);
  assert.equal(sharedDetail.data.isOwner, false);

  const visitorList = await call({ action: "listMine" });
  assert.deepEqual(visitorList.data, []);
  const visitorDelete = await call({ action: "remove", id: created.data.id });
  assert.equal(visitorDelete.ok, false);

  currentOpenId = "owner-openid";
  const ownerList = await call({ action: "listMine" });
  assert.equal(ownerList.data.length, 1);
  const ownerDelete = await call({ action: "remove", id: created.data.id });
  assert.equal(ownerDelete.ok, true);
  assert.equal(records.size, 0);
  assert.equal(deletedFiles.length, 1);

  console.log("云函数测试通过：创建、本人列表、分享口令鉴权和删除流程均正常。");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
