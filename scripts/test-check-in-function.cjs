/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const source = fs.readFileSync(path.join(__dirname, "../cloudfunctions/checkIn/index.js"), "utf8");
const hash = (algo, value) => crypto.createHash(algo).update(value).digest("hex");
const bytes = Buffer.from("one real recording");
const input = (patch = {}) => ({ requestId: "abcdef0123456789abcdef0123456789", durationMs: 3200.4,
  fileSizeBytes: bytes.length, contentSha1: hash("sha1", bytes), bookId: "3", bookTitle: "CASA",
  practiceId: "3-page-4", practiceIndex: 0, pageNumber: 4, sectionTitle: "课程导入",
  imageUrl: "https://example.test/page-4.png", ...patch });
const plain = value => JSON.parse(JSON.stringify(value));

function harness() {
  const records = new Map(), versions = new Map(), files = new Map();
  const metrics = { writes: 0, deletes: 0, downloads: 0, attempts: 0, conflicts: 0, signed: 0 };
  const controls = { owner: "owner-openid", readError: null, downloadError: null, downloadStatus: 200,
    deleteStatus: 0, missingDeleteResult: null, deleteError: null, finalizeError: null, ownerOnlyQuery: false, forcedConflicts: 0 };
  let throwOnNotFound = true;
  const put = (id, data) => { records.set(id, structuredClone({ ...data, _id: id })); versions.set(id, (versions.get(id) || 0) + 1); metrics.writes++; };
  const collection = tx => ({
    async add({ data }) { const id = `legacy-${records.size}`; put(id, data); return { _id: id }; },
    doc(id) { return {
      async get() {
        if (controls.readError) throw controls.readError;
        if (tx) tx.reads.set(id, tx.versions.get(id) || 0);
        const data = (tx ? tx.snapshot : records).get(id);
        if (!data && throwOnNotFound) throw new Error(`document with _id ${id} does not exist`);
        return { data: structuredClone(data || null), errMsg: "document.get:ok" };
      },
      async set({ data }) {
        assert.equal(typeof data, "object", "微信 SDK set 使用 { data }");
        if (data.status === "deleted" && controls.finalizeError) throw controls.finalizeError;
        if (tx) tx.writes.set(id, structuredClone(data)); else put(id, data);
        return { _id: id, stats: { updated: 1 }, errMsg: "document.set:ok" };
      },
      async remove() { records.delete(id); versions.set(id, (versions.get(id) || 0) + 1); metrics.writes++; },
    }; },
    where(condition) {
      if (controls.ownerOnlyQuery) assert.deepEqual(Object.keys(condition), ["_openid"], "不能新增 status 复合索引依赖");
      let limit = Infinity, offset = 0;
      return { orderBy() { return this; }, skip(n) { offset = n; return this; }, limit(n) { limit = n; return this; }, async get() {
        if (controls.readError) throw controls.readError;
        return { data: [...records.values()].filter(record => Object.entries(condition).every(([key, value]) =>
          value && value.notIn ? !value.notIn.includes(record[key]) : record[key] === value))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(offset, offset + limit).map(v => structuredClone(v)) };
      } };
    },
  });
  const db = { collection: () => collection(null), serverDate: () => "2026-09-11T01:00:00Z", command: { nin: notIn => ({ notIn }) },
    // 乐观事务：各调用读独立快照、暂存写入，提交时检查版本；不排队串行运行。
    async runTransaction(callback, retries = 3) {
      for (let attempt = 0; ; attempt++) {
        metrics.attempts++;
        const tx = { snapshot: structuredClone(records), versions: new Map(versions), reads: new Map(), writes: new Map() };
        try {
          const result = await callback({ collection: () => collection(tx) });
          if ([...tx.reads].some(([id, version]) => (versions.get(id) || 0) !== version) || controls.forcedConflicts > 0) {
            if (controls.forcedConflicts > 0) controls.forcedConflicts--;
            metrics.conflicts++;
            throw Object.assign(new Error("[ResourceUnavailable.TransactionConflict]"), { code: "DATABASE_TRANSACTION_CONFLICT" });
          }
          for (const [id, data] of tx.writes) put(id, data);
          return result;
        } catch (error) {
          if (error.code !== "DATABASE_TRANSACTION_CONFLICT" || attempt >= retries) throw error;
        }
      }
    },
  };
  const cloud = { DYNAMIC_CURRENT_ENV: "dynamic", init() {}, database: (options = {}) => {
    throwOnNotFound = options.throwOnNotFound !== false;
    return db;
  },
    getWXContext: () => ({ OPENID: controls.owner, ENV: "test" }),
    async downloadFile({ fileID }) {
      metrics.downloads++;
      if (controls.downloadError) throw controls.downloadError;
      if (!files.has(fileID)) throw Object.assign(new Error("file not uploaded"), { code: "FILE_NOT_FOUND" });
      return { fileContent: files.get(fileID), ...(controls.downloadStatus === undefined ? {} : { statusCode: controls.downloadStatus }) };
    },
    async getTempFileURL({ fileList }) { metrics.signed++; metrics.lastSign = plain(fileList); return { fileList: fileList.map(item => {
      const fileID = typeof item === "string" ? item : item.fileID;
      return { fileID, status: 0, tempFileURL: `https://example.test/${encodeURIComponent(fileID)}` };
    }) }; },
    async deleteFile({ fileList }) { metrics.deletes++;
      if (controls.deleteError) throw controls.deleteError;
      return { fileList: fileList.map(fileID => {
      if (!files.has(fileID) && controls.missingDeleteResult) return { fileID, ...controls.missingDeleteResult };
      if (controls.deleteStatus === 0) files.delete(fileID);
      return { fileID, status: controls.deleteStatus, errMsg: controls.deleteStatus ? "storage denied" : "ok" };
    }) }; },
  };
  const mod = { exports: {} };
  vm.runInNewContext(source, { module: mod, exports: mod.exports, Buffer, URL, console: { error() {} },
    require: name => name === "wx-server-sdk" ? cloud : require(name) });
  const call = (action, payload = {}) => mod.exports.main({ ...payload, action });
  const prepare = async (payload = input()) => { const result = await call("prepare", payload);
    assert.equal(result.ok, true, `prepare 应成功：${JSON.stringify(result)}`); return result.data; };
  const upload = (p, content = bytes) => { const id = `cloud://test.bucket/${p.cloudPath}`; files.set(id, content); return id; };
  return { call, prepare, upload, records, files, controls, metrics };
}

const cases = [];
const test = (name, run) => cases.push({ name, run });
test("尚未提交的分享不能删除且无副作用", async () => {
  const h = harness();
  const p = await h.prepare(input({ shareVersion: 2 }));
  const before = plain(h.records.get(p.id));
  const writes = h.metrics.writes;
  const result = await h.call("remove", { id: p.id });
  assert.equal(result.ok, false);
  assert.equal(result.code, "SHARE_NOT_COMMITTED");
  assert.deepEqual(plain(h.records.get(p.id)), before);
  assert.equal(h.metrics.writes, writes);
  assert.equal(h.metrics.deletes, 0);
});
test("新版预留持久化、并发幂等与载荷冲突", async () => {
  const h = harness(), event = input({ shareVersion: 2 });
  const [p, q] = await Promise.all([h.prepare(event), h.prepare(event)]);
  assert.deepEqual(plain(p), plain(q)); assert.equal(h.records.size, 1);
  const record = h.records.get(p.id);
  assert.equal(record.status, "pending"); assert.equal(record.shareVersion, 2);
  assert.ok(record.pendingExpiresAtMs > Date.now()); assert.equal(record.expiresAtMs, undefined);
  assert.match(p.cloudPath, /^expiring-shares-v2\//);
  assert.equal((await h.call("prepare", { ...event, bookTitle: "变化" })).code, "REQUEST_ID_CONFLICT");
  assert.equal((await h.call("prepare", input())).code, "REQUEST_ID_CONFLICT");
  assert.deepEqual(plain((await h.call("listMine")).data), []);
  assert.equal((await h.call("detail", { id: p.id })).ok, false); assert.equal(h.metrics.signed, 0);
});
test("新版仅预留可提交、首次提交起30天且重试不续期", async () => {
  const h = harness(), event = input({ shareVersion: 2 });
  assert.equal((await h.call("commit", { ...event, recordingFileId: "cloud://test.bucket/x" })).code, "SHARE_NOT_PREPARED");
  const p = await h.prepare(event), file = h.upload(p), before = Date.now();
  const [a, b] = await Promise.all([h.call("commit", { ...event, recordingFileId: file }), h.call("commit", { ...event, recordingFileId: file })]);
  assert.equal(a.ok, true); assert.deepEqual(plain(a), plain(b));
  assert.ok(a.data.expiresAtMs >= before + 30 * 86400000);
  assert.ok(a.data.expiresAtMs <= Date.now() + 30 * 86400000);
  assert.equal((await h.prepare(event)).expiresAtMs, a.data.expiresAtMs);
  assert.equal(h.records.get(p.id).cloudPath, p.cloudPath);
});
test("新版过期或墓碑永不复活，过期详情不签URL", async () => {
  for (const status of ["pending", "active", "deletePending", "deleted"]) {
    const h = harness(), event = input({ shareVersion: 2 }), p = await h.prepare(event), recordingFileId = h.upload(p);
    assert.equal((await h.call("commit", { ...event, recordingFileId })).ok, true);
    Object.assign(h.records.get(p.id), { status, expiresAtMs: 1, pendingExpiresAtMs: 1 });
    assert.equal((await h.call("prepare", event)).ok, false);
    assert.equal((await h.call("commit", { ...event, recordingFileId })).ok, false);
    assert.equal((await h.call("detail", { id: p.id })).code, "SHARE_EXPIRED");
    assert.equal(h.metrics.signed, 0); assert.deepEqual(plain((await h.call("listMine")).data), []);
  }
});
test("新版签名URL不超过剩余有效期且最多300秒", async () => {
  const h = harness(), event = input({ shareVersion: 2 }), p = await h.prepare(event), recordingFileId = h.upload(p);
  assert.equal((await h.call("commit", { ...event, recordingFileId })).ok, true);
  assert.equal((await h.call("detail", { id: p.id })).ok, true);
  assert.deepEqual(h.metrics.lastSign, [{ fileID: recordingFileId, maxAge: 300 }]);
  h.records.get(p.id).expiresAtMs = Date.now() + 2500;
  assert.equal((await h.call("detail", { id: p.id })).ok, true);
  assert.ok(h.metrics.lastSign[0].maxAge <= 2);
  h.records.get(p.id).expiresAtMs = Date.now() + 500;
  const count = h.metrics.signed;
  assert.equal((await h.call("detail", { id: p.id })).code, "SHARE_EXPIRED");
  assert.equal(h.metrics.signed, count);
});
test("prepare 只读、大小写与规范化载荷", async () => {
  const h = harness(), p = await h.prepare(input({ requestId: input().requestId.toUpperCase(), bookTitle: " CASA " }));
  assert.deepEqual(plain(p), plain(await h.prepare(input({ durationMs: 3200 }))));
  assert.equal(p.state, "upload-required"); assert.equal(p.id, hash("sha256", `owner-openid:${input().requestId}`));
  assert.match(p.cloudPath, new RegExp(`^checkins/${hash("sha256", "owner-openid")}/${input().requestId}-[a-f0-9]{64}\\.mp3$`));
  assert.equal(h.metrics.writes + h.metrics.downloads, 0);
  assert.notEqual(p.cloudPath, (await h.prepare(input({ sectionTitle: "不同课程" }))).cloudPath);
});
test("非法参数、缺身份零副作用", async () => {
  const h = harness();
  for (const change of [{ requestId: "../bad" }, { requestId: "" }, { requestId: "a".repeat(33) }, { contentSha1: "bad" },
    { durationMs: NaN }, { durationMs: 499 }, { fileSizeBytes: 0 }, { fileSizeBytes: 1.5 }, { practiceIndex: -1 }, { bookId: "" }]) {
    const r = await h.call("prepare", input(change)); assert.equal(r.ok, false); assert.ok(r.code); assert.ok(r.message);
  }
  h.controls.owner = ""; assert.equal((await h.call("prepare", input())).ok, false);
  assert.equal(h.metrics.writes + h.metrics.downloads + h.metrics.deletes, 0);
});
test("上传后 commit 幂等、响应丢失重放、prepare 跳过上传", async () => {
  const h = harness(), p = await h.prepare(), event = { ...input(), recordingFileId: h.upload(p) };
  const a = await h.call("commit", event); assert.equal(a.ok, true);
  assert.deepEqual(plain(a), plain(await h.call("commit", event)));
  assert.equal(h.records.size, 1); assert.equal(h.metrics.writes, 1);
  const record = h.records.get(p.id); assert.equal(record.durationMs, 3200); assert.equal(record.fileSizeBytes, bytes.length);
  assert.equal(record.contentSha1, input().contentSha1); assert.match(record.payloadDigest, /^[a-f0-9]{64}$/);
  assert.match(a.data.shareToken, /^[a-f0-9]{32}$/);
  const ready = await h.prepare(); assert.equal(ready.state, "committed"); assert.equal(ready.shareToken, a.data.shareToken);
  assert.equal(h.metrics.deletes, 0);
});
test("并发提交发生真实版本冲突且最终仅一条", async () => {
  const h = harness(), p = await h.prepare(), event = { ...input(), recordingFileId: h.upload(p) };
  const [a, b] = await Promise.all([h.call("commit", event), h.call("commit", event)]);
  assert.equal(a.ok, true); assert.deepEqual(plain(a), plain(b)); assert.equal(h.records.size, 1); assert.equal(h.metrics.writes, 1);
  assert.ok(h.metrics.conflicts >= 1, "必须实际冲突，不能普通 Map 串行自证");
});
test("不同载荷先 prepare 后竞争不覆盖文件", async () => {
  const h = harness(), first = input(), second = input({ bookTitle: "别的教材" });
  const p = await h.prepare(first), q = await h.prepare(second), aFile = h.upload(p), bFile = h.upload(q);
  assert.notEqual(aFile, bFile);
  const rs = await Promise.all([h.call("commit", { ...first, recordingFileId: aFile }), h.call("commit", { ...second, recordingFileId: bFile })]);
  assert.equal(rs.filter(r => r.ok).length, 1); assert.equal(rs.find(r => !r.ok).code, "REQUEST_ID_CONFLICT");
  assert.equal(h.records.size, 1); assert.equal(h.files.size, 2); assert.equal(h.metrics.deletes, 0);
});
test("同 ID 载荷冲突、不同用户隔离", async () => {
  const h = harness(), p = await h.prepare(), recordingFileId = h.upload(p);
  assert.equal((await h.call("commit", { ...input(), recordingFileId })).ok, true);
  for (const patch of [{ durationMs: 4000 }, { fileSizeBytes: bytes.length + 1 }, { contentSha1: "f".repeat(40) }, { pageNumber: 5 }]) {
    assert.equal((await h.call("prepare", input(patch))).code, "REQUEST_ID_CONFLICT");
    assert.equal((await h.call("commit", { ...input(patch), recordingFileId })).code, "REQUEST_ID_CONFLICT");
  }
  h.controls.owner = "other-owner"; const q = await h.prepare(); assert.notEqual(q.id, p.id); assert.notEqual(q.cloudPath, p.cloudPath);
  assert.equal((await h.call("commit", { ...input(), recordingFileId })).ok, false);
  assert.equal((await h.call("commit", { ...input(), recordingFileId: h.upload(q) })).ok, true); assert.equal(h.records.size, 2);
});
test("严格文件路径、存在性、大小与内容验证", async () => {
  const h = harness(), p = await h.prepare(), expected = `cloud://test.bucket/${p.cloudPath}`;
  for (const recordingFileId of [expected, expected + "?x=1", expected + "/../x", expected.replace("test.bucket", "foreign.bucket"),
    expected.replace(input().requestId, "0".repeat(32)), "cloud://test.bucket/checkins/other.mp3"]) {
    assert.equal((await h.call("commit", { ...input(), recordingFileId })).ok, false);
  }
  h.upload(p, Buffer.from("wrong")); assert.equal((await h.call("commit", { ...input(), recordingFileId: expected })).ok, false);
  h.upload(p, Buffer.alloc(bytes.length)); assert.equal((await h.call("commit", { ...input(), recordingFileId: expected })).ok, false);
  assert.equal(h.metrics.writes + h.metrics.deletes, 0);
});
test("数据库网络失败不是缺文档，下载错误原文保留", async () => {
  const h = harness(); h.controls.readError = { code: "ECONNRESET", message: "database network failed" };
  const r = await h.call("prepare", input()); assert.equal(r.code, "ECONNRESET"); assert.equal(r.message, "database network failed");
  assert.equal(h.metrics.writes, 0); h.controls.readError = null;
  const p = await h.prepare(), recordingFileId = h.upload(p); h.controls.downloadError = { code: "ETIMEDOUT", message: "storage timeout" };
  const f = await h.call("commit", { ...input(), recordingFileId }); assert.equal(f.code, "ETIMEDOUT"); assert.equal(f.message, "storage timeout");
  assert.equal(h.metrics.deletes + h.metrics.writes, 0); assert.equal(h.files.size, 1);
});
test("Node SDK 下载仅 fileContent 成功，显式非 200 仍拒绝", async () => {
  for (const status of [undefined, 200, 403, 503]) {
    const h = harness(), p = await h.prepare(); h.controls.downloadStatus = status;
    const result = await h.call("commit", { ...input(), recordingFileId: h.upload(p) });
    assert.equal(result.ok, status === undefined || status === 200, `statusCode=${status}`);
    assert.equal(h.records.size, result.ok ? 1 : 0);
    assert.equal(h.metrics.deletes, 0);
  }
});
test("删文件后最终事务失败，再收到明确不存在仍能收敛墓碑", async () => {
  for (const finalizeError of [{ code: "ECONNRESET", message: "finalize network failed" },
    { code: "DATABASE_TRANSACTION_CONFLICT", message: "[ResourceUnavailable.TransactionConflict]" }]) {
    for (const missing of [{ status: -503003, errMsg: "storage file not exists" },
      { thrown: { errCode: -503003, errMsg: "storage file not exists" } },
      { status: "STORAGE_FILE_NONEXIST" }, { errMsg: "storage file not exists" }]) {
      const h = harness(), p = await h.prepare(), event = { ...input(), recordingFileId: h.upload(p) };
      assert.equal((await h.call("commit", event)).ok, true);
      h.controls.finalizeError = finalizeError;
      const failed = await h.call("remove", { id: p.id });
      assert.equal(failed.ok, false); assert.equal(failed.code, finalizeError.code);
      assert.equal(h.files.size, 0, "首次删除确实成功，不能用尚存文件冒充恢复场景");
      assert.equal(h.records.get(p.id).status, "deletePending");
      assert.equal(h.metrics.deletes, 1);
      assert.equal(h.metrics.attempts, finalizeError.code === "ECONNRESET" ? 3 : 5);
      assert.equal((await h.call("commit", event)).code, "REQUEST_DELETED");
      h.controls.finalizeError = null;
      h.controls.missingDeleteResult = missing;
      h.controls.deleteError = missing.thrown || null;
      assert.equal((await h.call("remove", { id: p.id })).ok, true, JSON.stringify(missing));
      assert.equal(h.records.get(p.id).status, "deleted"); assert.equal(h.metrics.deletes, 2);
      assert.equal((await h.call("commit", event)).code, "REQUEST_DELETED");
      assert.equal((await h.call("detail", { id: p.id })).ok, false);
      assert.deepEqual(plain((await h.call("listMine")).data), []);
    }
  }
});
test("删除权限、超时、泛化未找到与未知错误不能伪装完成", async () => {
  for (const error of [{ status: -503002, errMsg: "storage permission denied" },
    { status: 404, errMsg: "environment not found" }, { status: -1, errMsg: "storage file not exists" },
    { errMsg: "file not found or permission denied" }, { errCode: "ETIMEDOUT", errMsg: "storage timeout" }]) {
    const h = harness(), p = await h.prepare(), event = { ...input(), recordingFileId: h.upload(p) };
    assert.equal((await h.call("commit", event)).ok, true);
    h.files.clear(); h.controls.missingDeleteResult = error;
    assert.equal((await h.call("remove", { id: p.id })).ok, false);
    assert.equal(h.records.get(p.id).status, "deletePending");
    assert.equal((await h.call("commit", event)).code, "REQUEST_DELETED");
    h.controls.deleteError = error;
    assert.equal((await h.call("remove", { id: p.id })).ok, false);
    assert.equal(h.records.get(p.id).status, "deletePending");
  }
});
test("列表复用 owner/时间查询，服务端隐藏墓碑并保留 50 条旧记录", async () => {
  const h = harness(); h.controls.ownerOnlyQuery = true;
  for (let i = 0; i < 85; i++) {
    h.records.set(`row-${i}`, { ...input(), _id: `row-${i}`, _openid: "owner-openid", createdAt: String(i).padStart(3, "0"),
      ...(i >= 60 ? { status: i % 2 ? "deleted" : "deletePending" } : {}) });
  }
  h.records.set("active", { ...input(), _id: "active", _openid: "owner-openid", status: "active", createdAt: "100" });
  h.records.set("foreign", { ...input(), _id: "foreign", _openid: "other", createdAt: "101" });
  const listed = await h.call("listMine"); assert.equal(listed.ok, true, listed.message);
  assert.deepEqual(plain(listed.data.map(record => record.id)), ["active", ...Array.from({ length: 49 }, (_, i) => `row-${59-i}`)]);
});
test("超过100条新版失效记录不遮蔽较旧的历史", async () => {
  const h = harness(); h.controls.ownerOnlyQuery = true;
  for (let i = 0; i < 260; i++) h.records.set(`expired-${i}`, {
    _id: `expired-${i}`, _openid: "owner-openid", shareVersion: 2,
    status: ["active", "pending", "deleted", "deletePending"][i % 4],
    expiresAtMs: 1, pendingExpiresAtMs: 1, createdAt: `z${String(i).padStart(3, "0")}`,
  });
  h.records.set("legacy", { ...input(), _id: "legacy", _openid: "owner-openid", createdAt: "a" });
  assert.deepEqual(plain((await h.call("listMine")).data.map(r => r.id)), ["legacy"]);
});
test("事务冲突有限重试且无重复下载/中间写入", async () => {
  const h = harness(), p = await h.prepare(), event = { ...input(), recordingFileId: h.upload(p) }; h.controls.forcedConflicts = 2;
  assert.equal((await h.call("commit", event)).ok, true); assert.equal(h.metrics.attempts, 3);
  assert.equal(h.metrics.downloads, 1); assert.equal(h.metrics.writes, 1);
  const k = harness(), q = await k.prepare(); k.controls.forcedConflicts = 20;
  assert.equal((await k.call("commit", { ...input(), recordingFileId: k.upload(q) })).ok, false);
  assert.ok(k.metrics.attempts <= 4); assert.equal(k.metrics.writes, 0);
});
test("删除失败墓碑隐藏、可重试且迟到 commit 不复活", async () => {
  const h = harness(), p = await h.prepare(), event = { ...input(), recordingFileId: h.upload(p) };
  assert.equal((await h.call("commit", event)).ok, true);
  h.controls.owner = "visitor"; assert.equal((await h.call("remove", { id: p.id })).ok, false); assert.equal(h.metrics.deletes, 0);
  h.controls.owner = "owner-openid"; h.controls.deleteStatus = -1;
  assert.equal((await h.call("remove", { id: p.id })).ok, false); assert.equal(h.records.get(p.id).status, "deletePending");
  assert.equal(h.files.size, 1); assert.equal((await h.call("detail", { id: p.id })).ok, false);
  assert.deepEqual(plain((await h.call("listMine")).data), []);
  assert.equal((await h.call("commit", event)).code, "REQUEST_DELETED"); assert.equal((await h.call("prepare", input())).code, "REQUEST_DELETED");
  h.controls.deleteStatus = 0; assert.equal((await h.call("remove", { id: p.id })).ok, true);
  assert.equal(h.records.get(p.id).status, "deleted"); assert.equal(h.files.size, 0);
  const count = h.metrics.deletes; assert.equal((await h.call("remove", { id: p.id })).ok, true); assert.equal(h.metrics.deletes, count);
  assert.equal((await h.call("commit", event)).code, "REQUEST_DELETED");
});
test("旧 create/detail/list/remove 与无 status 记录兼容", async () => {
  const h = harness(), created = await h.call("create", { ...input(), recordingFileId: "cloud://test.bucket/checkins/legacy.mp3" });
  assert.equal(created.ok, true); const id = created.data.id;
  assert.equal((await h.call("detail", { id })).data.durationMs, 3200);
  h.controls.owner = "visitor"; assert.equal((await h.call("detail", { id })).ok, false);
  assert.equal((await h.call("detail", { id, shareToken: created.data.shareToken })).ok, true);
  assert.equal((await h.call("remove", { id })).ok, false); assert.deepEqual(plain((await h.call("listMine")).data), []);
  h.controls.owner = "owner-openid"; assert.equal((await h.call("listMine")).data.length, 1);
  h.controls.deleteStatus = -1; assert.equal((await h.call("remove", { id })).ok, false); assert.ok(h.records.has(id));
  h.controls.deleteStatus = 0; assert.equal((await h.call("remove", { id })).ok, true); assert.equal(h.records.size, 0);
});

(async () => { let failures = 0; for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
} assert.equal(failures, 0, `${failures}/${cases.length} 项云函数契约失败`);
console.log(`云函数协议测试通过：${cases.length} 组，含乐观冲突、文件校验和墓碑。`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
