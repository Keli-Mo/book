/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { inspect } = require("node:util");
const root = path.join(__dirname, "../cloudfunctions/cleanupExpiredShares");
const source = fs.existsSync(path.join(root, "index.js")) ? fs.readFileSync(path.join(root, "index.js"), "utf8") : "exports.main = async () => ({ ok: true });";
const NOW = 1800000000000;
const prefix = "cloud://test.bucket/";
const idFor = i => i.toString(16).padStart(64, "0");
const row = (i, patch = {}) => {
  const cloudPath = `expiring-shares-v2/${"a".repeat(64)}/${i.toString(16).padStart(32, "0")}-${"b".repeat(64)}.mp3`;
  return { _id: idFor(i), shareVersion: 2, status: "active", cloudPath,
    recordingFileId: prefix + cloudPath, expiresAtMs: NOW - 1, ...patch };
};
function harness(initial = [row(1)]) {
  const records = new Map(initial.map(r => [r._id, structuredClone(r)])), state = new Map(), versions = new Map();
  const capturedLogs = [];
  const files = new Set(initial.map(r => r.recordingFileId).filter(Boolean));
  const metrics = { writes: 0, deletes: 0, queries: 0, conflicts: 0 };
  const env = { SHARE_CLEANUP_ENABLED: "true", SHARE_STORAGE_FILE_ID_PREFIX: prefix };
  const controls = { context: { SOURCE: "wx_trigger", ENV: "test" }, contextError: null, deleteError: null,
    deleteStatus: 0, deleteErrMsg: undefined, missingStatus: -503003, finalizeError: null, beforeMark: null,
    readError: null, queryError: null };
  const readMap = (name, tx) => tx ? tx[name] : name === "checkins" ? records : state;
  const write = (name, id, data) => { readMap(name).set(id, { ...structuredClone(data), _id: id });
    const key = `${name}/${id}`; versions.set(key, (versions.get(key) || 0) + 1); metrics.writes++; };
  const collection = (name, tx) => ({
    doc(id) { return {
      async get() { if (controls.readError) throw controls.readError;
        if (tx) tx.reads.set(`${name}/${id}`, tx.versions.get(`${name}/${id}`) || 0);
        return { data: structuredClone(readMap(name, tx).get(id) || null) }; },
      async set({ data }) {
        if (name === "checkins" && data.status === "deleted" && controls.finalizeError) throw controls.finalizeError;
        if (tx) tx.writes.push({ name, id, data: structuredClone(data) }); else write(name, id, data);
      },
    }; },
    where(condition) { let size = 50;
      return { orderBy(key, direction) { assert.equal(key, "_id"); assert.equal(direction, "asc"); return this; },
        limit(n) { assert.ok(n <= 50); size = n; return this; }, async get() { metrics.queries++;
          if (controls.queryError) throw controls.queryError;
          const data = [...readMap(name).values()].filter(r => Object.entries(condition).every(([key, val]) =>
            val && typeof val === "object" && "gt" in val ? r[key] > val.gt : r[key] === val))
            .sort((a, b) => a._id.localeCompare(b._id)).slice(0, size).map(r => structuredClone(r));
          if (controls.beforeMark) { const callback = controls.beforeMark; controls.beforeMark = null; callback(); }
          return { data };
        } };
    },
  });
  const db = { collection: name => collection(name), command: { gt: value => ({ gt: value }) },
    async runTransaction(operation) {
      const tx = { checkins: structuredClone(records), shareCleanupState: structuredClone(state), versions: new Map(versions), reads: new Map(), writes: [] };
      const result = await operation({ collection: name => collection(name, tx) });
      if ([...tx.reads].some(([key, version]) => (versions.get(key) || 0) !== version)) {
        metrics.conflicts++; throw Object.assign(new Error("conflict"), { code: "DATABASE_TRANSACTION_CONFLICT" });
      }
      for (const w of tx.writes) write(w.name, w.id, w.data);
      return result;
    },
  };
  const cloud = { init() {}, DYNAMIC_CURRENT_ENV: "dynamic", database: () => db, getWXContext: () => {
    if (controls.contextError) throw controls.contextError;
    return controls.context;
  },
    async deleteFile({ fileList }) {
      metrics.deletes++;
      for (const fileID of fileList) {
        const record = [...records.values()].find(r => prefix + r.cloudPath === fileID);
        assert.ok(record && ["deletePending", "deleted"].includes(record.status), "必须先失效再删文件");
      }
      if (controls.deleteError) throw controls.deleteError;
      return { fileList: fileList.map(fileID => {
        const status = files.has(fileID) ? controls.deleteStatus : controls.missingStatus;
        if (status === 0) files.delete(fileID);
        return { fileID, status, ...(controls.deleteErrMsg === undefined ? {} : { errMsg: controls.deleteErrMsg }) };
      }) };
    },
  };
  const mod = { exports: {} };
  vm.runInNewContext(source, { exports: mod.exports, module: mod, process: { env }, Date: class extends Date { static now() { return NOW; } },
    console: { info() {}, error(...args) { capturedLogs.push(inspect(args)); } },
    require: name => name === "wx-server-sdk" ? cloud : require(path.join(root, name)) });
  return { call: (event = {}) => mod.exports.main(event), records, state, files, metrics, controls, env, capturedLogs };
}
const cases = [];
const test = (name, run) => cases.push({ name, run });
test("默认dryrun，事件不能启用删除", async () => {
  const h = harness(); delete h.env.SHARE_CLEANUP_ENABLED;
  const result = await h.call({ enabled: true, dryRun: false });
  assert.equal(result.dryRun, true); assert.equal(result.candidates, 1);
  assert.equal(h.metrics.deletes + h.metrics.writes, 0);
});
test("只信SDK定时来源，拒绝客户端、调用链及伪造timer", async () => {
  for (const context of [{ SOURCE: "wx_client" }, { SOURCE: "wx_client,scf" }, { SOURCE: "wx_devtools" }, {},
    { SOURCE: "timer" }, { SOURCE: "wx_trigger", OPENID: "owner" }]) {
    const h = harness(); h.controls.context = { ENV: "test", ...context };
    const r = await h.call({ Type: "Timer", SOURCE: "wx_trigger" });
    assert.equal(r.code, "FORBIDDEN"); assert.equal(h.metrics.deletes + h.metrics.writes + h.metrics.queries, 0);
  }
});
test("未配置或错误可信前缀阻断删除，不构造猜测bucket", async () => {
  for (const value of [undefined, "cloud://foreign.bucket/", "cloud://test.bucket/checkins/", "cloud://test.bucket/../", "https://test/"]) {
    const h = harness([row(1, { status: "pending", recordingFileId: undefined, expiresAtMs: undefined, pendingExpiresAtMs: NOW - 1 })]);
    h.env.SHARE_STORAGE_FILE_ID_PREFIX = value;
    const r = await h.call(); assert.equal(r.dryRun, true); assert.equal(r.code, "STORAGE_PREFIX_REQUIRED");
    assert.equal(r.validated, 0, "没有可信前缀时不能宣称候选已校验通过");
    assert.equal(h.metrics.deletes + h.metrics.writes, 0);
  }
});
test("只清理新版到期记录，错误路径和旧无期限记录留存", async () => {
  const initial = [row(1), row(2, { shareVersion: undefined }), row(3, { expiresAtMs: undefined }),
    row(4, { expiresAtMs: NOW + 1 }), row(5, { cloudPath: "checkins/legacy.mp3" }),
    row(6, { recordingFileId: "cloud://foreign.bucket/book.mp3" }),
    row(7, { expiresAtMs: undefined, pendingExpiresAtMs: NOW - 1 })];
  const h = harness(initial), r = await h.call();
  assert.equal(r.deleted, 1); assert.equal(r.failed, 2); assert.equal(h.records.get(idFor(1)).status, "deleted");
  for (let i = 2; i <= 7; i++) assert.equal(h.records.get(idFor(i)).status, "active");
  assert.equal(h.files.size, 6);
});
test("只读预演同样校验路径和文件归属，不能把不安全候选报为通过", async () => {
  const initial = [row(1), row(2, { cloudPath: "textbooks/book.mp3" }),
    row(3, { recordingFileId: "cloud://foreign.bucket/recording.mp3" }),
    row(4, { expiresAtMs: NOW + 1 }), row(5, { shareVersion: undefined })];
  const h = harness(initial);
  const before = JSON.stringify([...h.records]);
  const r = await h.call({ dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.candidates, 3);
  assert.equal(r.validated, 1, "仅一条到期记录通过路径/环境检查");
  assert.equal(r.failed, 2, "不安全路径和跨桶 fileID 必须在预演报错");
  assert.equal(r.deleted, 0);
  assert.equal(h.metrics.writes + h.metrics.deletes, 0);
  assert.equal(JSON.stringify([...h.records]), before);
  assert.equal(h.files.size, 5);
});
test("预演精确处理到期边界并只读翻页，不改正式清理游标", async () => {
  const h = harness(Array.from({ length: 51 }, (_, i) => row(i + 1, { expiresAtMs: NOW })));
  h.records.set(idFor(52), row(52, { expiresAtMs: NOW + 1 }));
  h.state.set("v2", { cursor: idFor(9), revision: 2 });
  const first = await h.call({ dryRun: true });
  assert.equal(first.scanned, 50);
  assert.equal(first.validated, 50);
  assert.equal(first.nextCursor, idFor(50));
  const second = await h.call({ dryRun: true, cursor: first.nextCursor });
  assert.equal(second.scanned, 2);
  assert.equal(second.validated, 1);
  assert.equal(second.candidates, 1);
  assert.equal(second.nextCursor, "");
  assert.deepEqual(h.state.get("v2"), { cursor: idFor(9), revision: 2 });
  assert.equal(h.metrics.writes + h.metrics.deletes, 0);
});
test("小批持久游标扫多页并回绕，旧记录不占分页", async () => {
  const h = harness(Array.from({ length: 121 }, (_, i) => row(i + 1)));
  let count = 0;
  for (let i = 0; i < 3; i++) { const r = await h.call(); assert.ok(r.scanned <= 50); count += r.deleted; }
  assert.equal(count, 121); assert.equal(h.files.size, 0); assert.equal(h.state.get("v2").cursor, "");
});
test("未知删除错误留引用，重试明确不存在后收敛", async () => {
  const h = harness(); h.controls.deleteStatus = -1;
  let r = await h.call(); assert.equal(r.failed, 1); assert.equal(h.records.get(idFor(1)).status, "deletePending");
  assert.equal(h.records.get(idFor(1)).recordingFileId, row(1).recordingFileId);
  h.controls.deleteStatus = 0; h.controls.finalizeError = new Error("finalize offline");
  r = await h.call(); assert.equal(r.failed, 1); assert.equal(h.files.size, 0);
  assert.equal(h.records.get(idFor(1)).status, "deletePending");
  h.controls.finalizeError = null; r = await h.call(); assert.equal(r.deleted, 1);
  assert.equal(h.records.get(idFor(1)).status, "deleted");
});
test("逐条与外层清理错误只使用固定分类且不记录敏感字段", async () => {
  const secretMarker = "SYNTHETIC_PRIVATE_VALUE";
  const unsafeMessage = `https://example.test/audio?token=${secretMarker}`;
  const assertSafe = (h, result) => {
    assert.equal(JSON.stringify({ response: result, logs: h.capturedLogs }).includes(secretMarker), false);
  };

  const returnedFailure = harness();
  returnedFailure.controls.deleteStatus = -1;
  returnedFailure.controls.deleteErrMsg = unsafeMessage;
  const returnedResult = await returnedFailure.call();
  assert.equal(returnedResult.failed, 1); assertSafe(returnedFailure, returnedResult);
  assert.match(returnedFailure.capturedLogs.at(-1), /code: 'FILE_DELETE_UNCONFIRMED'/);

  const thrownFailure = harness();
  thrownFailure.controls.deleteError = { code: `ARBITRARY_${secretMarker}`, errMsg: unsafeMessage };
  const thrownResult = await thrownFailure.call();
  assert.equal(thrownResult.failed, 1); assertSafe(thrownFailure, thrownResult);
  assert.match(thrownFailure.capturedLogs.at(-1), /code: 'CLEANUP_FAILED'/);

  const finalFailure = harness();
  finalFailure.controls.finalizeError = new Error(unsafeMessage);
  const finalResult = await finalFailure.call();
  assert.equal(finalResult.failed, 1); assertSafe(finalFailure, finalResult);
  assert.match(finalFailure.capturedLogs.at(-1), /code: 'CLEANUP_FAILED'/);

  const outerFailure = harness();
  outerFailure.controls.readError = Object.assign(new Error(unsafeMessage), { code: `ARBITRARY_${secretMarker}` });
  const outerResult = await outerFailure.call();
  assert.equal(outerResult.ok, false); assert.equal(outerResult.code, "CLEANUP_FAILED");
  assertSafe(outerFailure, outerResult);
  assert.match(outerFailure.capturedLogs.at(-1), /code: 'CLEANUP_FAILED'/);
});
test("清理上下文读取失败也返回可安全构建的固定结果", async () => {
  const secretMarker = "SYNTHETIC_CONTEXT_PRIVATE_VALUE";
  const h = harness();
  h.controls.contextError = Object.assign(new Error(`https://example.test/context?token=${secretMarker}`), {
    code: `ARBITRARY_${secretMarker}`,
  });
  const result = await h.call();
  assert.equal(result.ok, false); assert.equal(result.code, "CLEANUP_FAILED");
  assert.equal(result.dryRun, true); assert.equal(result.scanned, 0); assert.equal(result.failed, 0);
  assert.equal(JSON.stringify({ response: result, logs: h.capturedLogs }).includes(secretMarker), false);
  assert.equal(h.capturedLogs.length, 1);
  assert.match(h.capturedLogs[0], /code: 'CLEANUP_FAILED'/);
  assert.equal(h.metrics.deletes + h.metrics.writes + h.metrics.queries, 0);
});
test("外部同名事务冲突 code 不得冒充内部固定分类", async () => {
  const secretMarker = "SYNTHETIC_CONFLICT_PRIVATE_VALUE";
  const externalError = () => Object.assign(new Error(`https://example.test/conflict?token=${secretMarker}`), {
    code: "DATABASE_TRANSACTION_CONFLICT",
  });

  const read = harness(); read.controls.readError = externalError();
  const readResult = await read.call();
  assert.equal(readResult.ok, false); assert.equal(readResult.code, "CLEANUP_FAILED");
  assert.equal(JSON.stringify({ response: readResult, logs: read.capturedLogs }).includes(secretMarker), false);
  assert.match(read.capturedLogs.at(-1), /code: 'CLEANUP_FAILED'/);

  const remove = harness(); remove.controls.deleteError = externalError();
  const removeResult = await remove.call();
  assert.equal(removeResult.ok, true); assert.equal(removeResult.failed, 1);
  assert.equal(JSON.stringify({ response: removeResult, logs: remove.capturedLogs }).includes(secretMarker), false);
  assert.match(remove.capturedLogs.at(-1), /code: 'CLEANUP_FAILED'/);
});
test("泛化404及权限未知码不能当作文件已不存在", async () => {
  for (const error of [{ code: 404, message: "not found" }, { errCode: -503002 }, { code: "TIMEOUT" }]) {
    const h = harness(); h.controls.deleteError = error;
    assert.equal((await h.call()).failed, 1); assert.equal(h.records.get(idFor(1)).status, "deletePending");
  }
});
test("pending未commit孤儿及墓碑后迟到上传可再次删除", async () => {
  const r = row(1, { status: "pending", recordingFileId: undefined, expiresAtMs: undefined, pendingExpiresAtMs: NOW - 1 });
  const h = harness([r]); h.files.add(prefix + r.cloudPath);
  assert.equal((await h.call()).deleted, 1); assert.equal(h.files.size, 0);
  assert.equal(h.records.get(r._id).status, "deleted"); assert.equal(h.records.get(r._id).cloudPath, r.cloudPath);
  h.files.add(prefix + r.cloudPath); assert.equal((await h.call()).deleted, 1); assert.equal(h.files.size, 0);
});
test("并发清理事务冲突可重试，分页后提交胜出不误删", async () => {
  const h = harness(); const results = await Promise.all([h.call(), h.call()]);
  assert.ok(results.every(r => r.ok)); assert.equal(h.files.size, 0); assert.ok(h.metrics.conflicts > 0);
  const r = row(1, { status: "pending", expiresAtMs: undefined, pendingExpiresAtMs: NOW - 1 });
  const k = harness([r]); k.controls.beforeMark = () => Object.assign(k.records.get(r._id), { status: "active", expiresAtMs: NOW + 86400000 });
  assert.equal((await k.call()).deleted, 0); assert.equal(k.metrics.deletes, 0);
});
(async () => { let failures = 0; for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`); }
} assert.equal(failures, 0, `${failures}/${cases.length} 项清理测试失败`);
console.log(`分享清理测试通过：${cases.length} 组。`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
