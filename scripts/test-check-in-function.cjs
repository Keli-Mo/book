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
    deleteStatus: 0, missingDeleteResult: null, deleteError: null, finalizeError: null, ownerOnlyQuery: false, forcedConflicts: 0,
    referenceQueryError: null, referenceQueryErrorOffset: 0, referenceQueryResult: undefined,
    referenceQueryDelayMs: 0, timeOffsetMs: 0 };
  let throwOnNotFound = true;
  const put = (id, data) => { records.set(id, structuredClone({ ...data, _id: id })); versions.set(id, (versions.get(id) || 0) + 1); metrics.writes++; };
  const collection = tx => ({
    async add({ data }) { const id = `legacy-${records.size}`; put(id, data); return { _id: id }; },
    doc(id) { return {
      async get() {
        if (controls.readError) throw controls.readError;
        if (controls.readResult !== undefined) return controls.readResult;
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
        if (condition.recordingFileId) {
          controls.timeOffsetMs += controls.referenceQueryDelayMs;
          if (controls.referenceQueryError && offset >= controls.referenceQueryErrorOffset) throw controls.referenceQueryError;
          if (controls.referenceQueryResult !== undefined) return controls.referenceQueryResult;
        }
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
      if ("downloadResult" in controls) return controls.downloadResult;
      if (!files.has(fileID)) throw Object.assign(new Error("file not uploaded"), { code: "FILE_NOT_FOUND" });
      return { fileContent: files.get(fileID), errMsg: "downloadFile:ok", ...(controls.downloadStatus === undefined ? {} : { statusCode: controls.downloadStatus }) };
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
  vm.runInNewContext(source, { module: mod, exports: mod.exports, Buffer, URL,
    Date: class extends Date { static now() { return Date.now() + controls.timeOffsetMs; } }, console: { error() {} },
    require: name => name === "wx-server-sdk" ? cloud : require(name) });
  const call = (action, payload = {}) => mod.exports.main({ ...payload, action });
  const prepare = async (payload = input()) => { const result = await call("prepare", payload);
    assert.equal(result.ok, true, `prepare 应成功：${JSON.stringify(result)}`); return result.data; };
  const upload = (p, content = bytes) => { const id = `cloud://test.bucket/${p.cloudPath}`; files.set(id, content); return id; };
  return { call, prepare, upload, records, files, controls, metrics };
}

const cases = [];
const test = (name, run) => cases.push({ name, run });

for (const [label, patch] of [
  ["缺少 HTTP 状态", {}],
  ["成功 HTTP 与权限 errCode 矛盾", { statusCode: 200, errCode: -503002 }],
  ["零 errCode 与失败 code 矛盾", { statusCode: 200, errCode: 0, code: "STORAGE_REQUEST_FAIL" }],
  ["成功 HTTP 与 errno 矛盾", { statusCode: 200, errno: -1 }],
  ["成功 HTTP 与失败 errMsg 矛盾", { statusCode: 200, errMsg: "downloadFile:fail storage permission denied" }],
  ["非数值 HTTP 状态", { statusCode: "200" }],
]) test(`分享核验拒绝${label}，不误判损坏`, async () => {
  const h = harness(), event = input({ shareVersion: 2 }), p = await h.prepare(event), recordingFileId = h.upload(p);
  await h.call("commit", { ...event, recordingFileId });
  const before = plain([...h.records]);
  for (const fileContent of [Buffer.alloc(0), Buffer.alloc(bytes.length, 1), bytes]) {
    h.controls.downloadResult = { fileContent, ...patch };
    const result = await h.call("shareStatus", { id: p.id, shareRequestId: event.requestId });
    assert.equal(result.ok, false, "SDK 未明确成功，不可返回 active/missing/invalid");
    assert.equal(result.code, "SHARE_STATUS_UNAVAILABLE");
    assert.deepEqual(plain([...h.records]), before); assert.equal(h.metrics.deletes, 0);
  }
});

test("本人主动核验分享：真实文件读取、明确失效、未知错误保留状态", async () => {
  const h = harness(), event = input({ shareVersion: 2 }), p = await h.prepare(event);
  const recordingFileId = h.upload(p);
  await h.call("commit", { ...event, recordingFileId });
  const probe = () => h.call("shareStatus", { id: p.id, shareRequestId: event.requestId });
  const writes = h.metrics.writes;
  const active = await probe();
  assert.equal(active.ok, true, "本人主动核验应返回可用状态");
  assert.deepEqual(plain(active.data), { state: "active" });
  for (const content of [Buffer.alloc(0), Buffer.alloc(bytes.length, 1)]) {
    h.files.set(recordingFileId, content);
    assert.deepEqual(plain((await probe()).data), { state: "invalid" }, "明确大小或摘要不匹配可以主动恢复");
  }
  h.files.set(recordingFileId, bytes);
  for (const error of [{ errCode: -503003 }, { code: "STORAGE_FILE_NONEXIST" }]) {
    h.controls.downloadError = error;
    assert.deepEqual(plain((await probe()).data), { state: "missing" });
  }
  for (const error of [{ errCode: -503002 }, { code: "ETIMEDOUT" }, { code: "STORAGE_REQUEST_FAIL", message: "Status:404 Url:https://secret?token=private" }, { message: "storage file not exists" }]) {
    h.controls.downloadError = error;
    const result = await probe();
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /secret|private|https:/);
  }
  h.controls.downloadError = null;
  for (const status of ["deletePending", "deleted"]) {
    h.records.get(p.id).status = status;
    assert.deepEqual(plain((await probe()).data), { state: "deleted" });
  }
  h.records.get(p.id).status = "active"; h.records.get(p.id).expiresAtMs = 1;
  assert.deepEqual(plain((await probe()).data), { state: "expired" });
  h.controls.owner = "visitor";
  assert.equal((await probe()).code, "FORBIDDEN");
  h.controls.owner = "owner-openid"; h.records.delete(p.id);
  assert.deepEqual(plain((await probe()).data), { state: "missing" });
  for (const readResult of [{}, { data: undefined }, { data: false }]) {
    h.controls.readResult = readResult;
    assert.equal((await probe()).ok, false, "只有 SDK 明确 data:null 可以判为记录缺失");
  }
  assert.equal(h.metrics.writes, writes); assert.equal(h.metrics.deletes, 0);
});

test("分享核验也必须先阻止跨 owner 文件引用，网络读取失败不能判缺失", async () => {
  const h = harness(), event = input({ shareVersion: 2 }), p = await h.prepare(event), recordingFileId = h.upload(p);
  await h.call("commit", { ...event, recordingFileId });
  const downloads = h.metrics.downloads;
  h.records.set("foreign-alias", { _id: "foreign-alias", _openid: "other", recordingFileId });
  const probe = () => h.call("shareStatus", { id: p.id, shareRequestId: event.requestId });
  assert.equal((await probe()).ok, false); assert.equal(h.metrics.downloads, downloads);
  h.records.delete("foreign-alias"); h.controls.readError = { code: "ETIMEDOUT" };
  assert.equal((await probe()).ok, false); assert.equal(h.metrics.downloads, downloads);
});
const legacyFixture = (h, patch = {}) => {
  const record = { bookId: "3", bookTitle: "CASA", practiceId: "3-page-4", practiceIndex: 0,
    pageNumber: 4, sectionTitle: "课程导入", imageUrl: "https://example.test/page-4.png", durationMs: 3200,
    _id: "legacy", _openid: "owner-openid", shareToken: "legacy-share-token",
    recordingFileId: "cloud://test.bucket/checkins/legacy.mp3", createdAt: "2025-01-01", ...patch };
  h.records.set(record._id, record);
  h.files.set(record.recordingFileId, bytes);
  return record;
};
test("旧 create 一律禁用且鉴权优先、无任何副作用", async () => {
  const h = harness(), before = plain(h.metrics);
  for (const payload of [{ ...input(), recordingFileId: "cloud://test.bucket/checkins/legacy.mp3" }, {},
    { recordingFileId: "invalid", _openid: "other-owner" }]) {
    assert.equal((await h.call("create", payload)).code, "LEGACY_CREATE_DISABLED");
  }
  h.controls.owner = "";
  assert.equal((await h.call("create", input())).code, "UNAUTHENTICATED");
  assert.equal(h.records.size, 0); assert.deepEqual(h.metrics, before);
});
test("旧文件跨 owner 引用时双方详情及删除均拒绝，所有状态参与核验", async () => {
  for (const status of [undefined, "active", "pending", "deletePending", "deleted"]) {
    const h = harness(), first = legacyFixture(h);
    legacyFixture(h, { _id: "alias", _openid: "other-owner", ...(status ? { status } : {}) });
    const before = plain([...h.records]);
    for (const [id, owner] of [[first._id, first._openid], ["alias", "other-owner"]]) {
      // 墓碑和 pending 自己的详情/删除仍遵循原状态规则；有效的另一行必须发现它们。
      if (id === "alias" && status && status !== "active") continue;
      h.controls.owner = owner;
      assert.equal((await h.call("detail", { id })).code, "FILE_REFERENCE_CONFLICT");
      h.controls.owner = "visitor";
      assert.equal((await h.call("detail", { id, shareToken: first.shareToken })).code, "FILE_REFERENCE_CONFLICT");
      h.controls.owner = owner;
      assert.equal((await h.call("remove", { id })).code, "FILE_REFERENCE_CONFLICT");
    }
    assert.deepEqual(plain([...h.records]), before); assert.equal(h.files.size, 1);
    assert.equal(h.metrics.signed + h.metrics.deletes + h.metrics.writes, 0);
  }
});
test("引用核验读取全部分页，后页跨 owner 冲突或错误均失败关闭", async () => {
  for (const mode of ["conflict", "error", "malformed"]) {
    const h = harness(), first = legacyFixture(h);
    for (let i = 0; i < 105; i++) legacyFixture(h, { _id: `same-owner-${i}`, createdAt: "2026-01-01" });
    if (mode === "conflict") legacyFixture(h, { _id: "older-alias", _openid: "other-owner", createdAt: "2020-01-01" });
    if (mode === "error") {
      h.controls.referenceQueryError = { code: "ECONNRESET", message: "reference query failed" };
      h.controls.referenceQueryErrorOffset = 100;
    }
    if (mode === "malformed") h.controls.referenceQueryResult = { data: null };
    const before = plain([...h.records]);
    for (const action of ["detail", "remove"]) {
      const result = await h.call(action, { id: first._id });
      assert.equal(result.ok, false, `${mode}: ${action} 必须失败关闭`);
      if (mode === "conflict") assert.equal(result.code, "FILE_REFERENCE_CONFLICT");
      if (mode === "error") assert.equal(result.code, "ECONNRESET");
    }
    assert.deepEqual(plain([...h.records]), before); assert.equal(h.files.size, 1);
    assert.equal(h.metrics.signed + h.metrics.deletes + h.metrics.writes, 0);
  }
});
test("协议文件存在旧别名时 commit 下载、双方详情与删除均拒绝", async () => {
  for (const shareVersion of [1, 2]) {
    const h = harness(), event = input({ shareVersion }), p = await h.prepare(event), recordingFileId = h.upload(p);
    legacyFixture(h, { _id: "alias", _openid: "other-owner", recordingFileId });
    const beforeCommit = plain(h.metrics);
    assert.equal((await h.call("commit", { ...event, recordingFileId })).code, "FILE_REFERENCE_CONFLICT");
    assert.deepEqual(h.metrics, beforeCommit);
    h.records.delete("alias");
    assert.equal((await h.call("commit", { ...event, recordingFileId })).ok, true);
    legacyFixture(h, { _id: "alias", _openid: "other-owner", recordingFileId });
    const before = plain([...h.records]), metrics = plain(h.metrics);
    for (const [id, owner] of [[p.id, "owner-openid"], ["alias", "other-owner"]]) {
      h.controls.owner = owner;
      for (const action of ["detail", "remove"]) assert.equal((await h.call(action, { id })).code, "FILE_REFERENCE_CONFLICT");
    }
    assert.deepEqual(plain([...h.records]), before); assert.deepEqual(h.metrics, metrics); assert.equal(h.files.size, 1);
  }
});
test("commit 引用查询失败不下载、不激活预留，重试成功", async () => {
  for (const shareVersion of [1, 2]) {
    const h = harness(), event = input({ shareVersion }), p = await h.prepare(event), recordingFileId = h.upload(p);
    h.controls.referenceQueryError = { code: "ETIMEDOUT", message: "reference query timeout" };
    const before = plain([...h.records]), metrics = plain(h.metrics);
    assert.equal((await h.call("commit", { ...event, recordingFileId })).code, "ETIMEDOUT");
    assert.deepEqual(plain([...h.records]), before); assert.deepEqual(h.metrics, metrics); assert.equal(h.files.size, 1);
    h.controls.referenceQueryError = null;
    assert.equal((await h.call("commit", { ...event, recordingFileId })).ok, true);
  }
});
test("协议 owner 路径即使尚无本人记录也不能被旧别名读取或删除", async () => {
  for (const shareVersion of [1, 2]) {
    const h = harness(), p = await h.prepare(input({ shareVersion })), recordingFileId = h.upload(p);
    const alias = legacyFixture(h, { _id: "alias", _openid: "other-owner", recordingFileId });
    h.controls.owner = "other-owner";
    const before = plain([...h.records]), metrics = plain(h.metrics);
    for (const action of ["detail", "remove"]) {
      assert.equal((await h.call(action, { id: alias._id })).code, "FILE_REFERENCE_CONFLICT");
    }
    assert.deepEqual(plain([...h.records]), before); assert.deepEqual(h.metrics, metrics); assert.equal(h.files.size, 1);
  }
});
test("引用核验期间到期的分享不签 URL，未到期则按核验后余量签名", async () => {
  for (const remainingMs of [2000, 10000]) {
    const h = harness(), event = input({ shareVersion: 2 }), p = await h.prepare(event);
    assert.equal((await h.call("commit", { ...event, recordingFileId: h.upload(p) })).ok, true);
    h.records.get(p.id).expiresAtMs = Date.now() + remainingMs;
    h.controls.referenceQueryDelayMs = 3000;
    const result = await h.call("detail", { id: p.id });
    if (remainingMs === 2000) {
      assert.equal(result.code, "SHARE_EXPIRED"); assert.equal(h.metrics.signed, 0);
    } else {
      assert.equal(result.ok, true); assert.ok(h.metrics.lastSign[0].maxAge <= 7);
    }
  }
});
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
    assert.equal(h.metrics.signed, 0);
    const listed = (await h.call("listMine")).data;
    if (status === "deletePending") assert.deepEqual(plain(listed.map(row => [row.id, row.status, row.shareToken])), [[p.id, "deletePending", ""]]);
    else assert.deepEqual(plain(listed), []);
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
  assert.deepEqual(plain(listed.data.map(record => record.id)), ["active", ...Array.from({ length: 13 }, (_, i) => `row-${84-i*2}`), ...Array.from({ length: 36 }, (_, i) => `row-${59-i}`)]);
});
test("超过100条新版失效记录不遮蔽较旧的历史", async () => {
  const h = harness(); h.controls.ownerOnlyQuery = true;
  for (let i = 0; i < 260; i++) h.records.set(`expired-${i}`, {
    _id: `expired-${i}`, _openid: "owner-openid", shareVersion: 2,
    status: ["active", "pending", "deleted"][i % 3],
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
test("删除失败对本人可见可重试、对访客不可见且迟到 commit 不复活", async () => {
  const h = harness(), p = await h.prepare(), event = { ...input(), recordingFileId: h.upload(p) };
  assert.equal((await h.call("commit", event)).ok, true);
  h.controls.owner = "visitor"; assert.equal((await h.call("remove", { id: p.id })).ok, false); assert.equal(h.metrics.deletes, 0);
  h.controls.owner = "owner-openid"; h.controls.deleteStatus = -1;
  assert.equal((await h.call("remove", { id: p.id })).ok, false); assert.equal(h.records.get(p.id).status, "deletePending");
  assert.equal(h.files.size, 1); assert.equal((await h.call("detail", { id: p.id })).ok, false);
  assert.equal((await h.call("listMine")).data.find(row => row.id === p.id)?.status, "deletePending");
  h.records.get(p.id).expiresAtMs = 1;
  assert.equal((await h.call("listMine")).data.find(row => row.id === p.id)?.status, "deletePending", "待删除记录过期仍保留重试入口");
  h.controls.owner = "visitor";
  assert.deepEqual(plain((await h.call("listMine")).data), []);
  assert.equal((await h.call("detail", { id: p.id, shareToken: h.records.get(p.id).shareToken })).ok, false);
  h.controls.owner = "owner-openid";
  assert.equal((await h.call("commit", event)).code, "REQUEST_DELETED"); assert.equal((await h.call("prepare", input())).code, "REQUEST_DELETED");
  h.controls.deleteStatus = 0; assert.equal((await h.call("remove", { id: p.id })).ok, true);
  assert.equal(h.records.get(p.id).status, "deleted"); assert.equal(h.files.size, 0);
  const count = h.metrics.deletes; assert.equal((await h.call("remove", { id: p.id })).ok, true); assert.equal(h.metrics.deletes, count);
  assert.equal((await h.call("commit", event)).code, "REQUEST_DELETED");
});
test("已有旧 fixture 的 owner、口令、列表及本人删除重试兼容", async () => {
  const h = harness(), record = legacyFixture(h), id = record._id;
  assert.equal((await h.call("detail", { id })).data.durationMs, 3200);
  h.controls.owner = "visitor"; assert.equal((await h.call("detail", { id })).ok, false);
  assert.equal((await h.call("detail", { id, shareToken: "wrong-token" })).ok, false);
  assert.equal((await h.call("detail", { id, shareToken: record.shareToken })).ok, true);
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
