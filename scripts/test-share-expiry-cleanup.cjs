/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { inspect } = require("node:util");
const root = path.join(__dirname, "../cloudfunctions/cleanupExpiredShares");
const source = fs.existsSync(path.join(root, "index.js")) ? fs.readFileSync(path.join(root, "index.js"), "utf8") : "exports.main = async () => ({ ok: true });";
const NOW = 1800000000000;
const prefix = "cloud://test.bucket/";
const idFor = i => i.toString(16).padStart(64, "0");
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const row = (i, patch = {}) => {
  const owner = "owner-primary";
  const requestId = i.toString(16).padStart(32, "0");
  const payloadDigest = "b".repeat(64);
  const cloudPath = `expiring-shares-v2/${sha256(owner)}/${requestId}-${payloadDigest}.mp3`;
  return { _id: idFor(i), _openid: owner, requestId, payloadDigest,
    shareVersion: 2, status: "active", cloudPath,
    recordingFileId: prefix + cloudPath, expiresAtMs: NOW - 1, ...patch };
};
function harness(initial = [row(1)]) {
  const records = new Map(initial.map(r => [r._id, structuredClone(r)])), state = new Map(), versions = new Map();
  const capturedLogs = [];
  const files = new Set(initial.map(r => r.recordingFileId).filter(Boolean));
  const metrics = { writes: 0, deletes: 0, queries: 0, referenceQueries: [], conflicts: 0,
    stateReads: 0, transactions: [] };
  const clock = { elapsedMs: 0 };
  const env = { SHARE_CLEANUP_ENABLED: "true", SHARE_STORAGE_FILE_ID_PREFIX: prefix };
  const controls = { context: { SOURCE: "wx_trigger", ENV: "test" }, contextError: null, deleteError: null,
    deleteStatus: 0, deleteErrMsg: undefined, missingStatus: -503003, finalizeError: null, beforeMark: null,
    checkpointError: null, beforeCheckpoint: null, readError: null, queryError: null,
    referenceQueryError: null, referenceQueryData: undefined, beforeReferenceReturn: null,
    transactionMs: 0, deleteMs: 0, queryMs: 0, referenceQueryMs: 0,
    stateReadMs: 0, hardBudgetMs: Infinity };
  const advance = ms => {
    clock.elapsedMs += ms;
    if (clock.elapsedMs >= controls.hardBudgetMs) throw new Error("SYNTHETIC_HARD_TIMEOUT_PRIVATE_VALUE");
  };
  const readMap = (name, tx) => tx ? tx[name] : name === "checkins" ? records : state;
  const write = (name, id, data) => { readMap(name).set(id, { ...structuredClone(data), _id: id });
    const key = `${name}/${id}`; versions.set(key, (versions.get(key) || 0) + 1); metrics.writes++; };
  const collection = (name, tx) => ({
    doc(id) { return {
      async get() { if (controls.readError) throw controls.readError;
        if (name === "shareCleanupState" && tx && controls.beforeCheckpoint) {
          const callback = controls.beforeCheckpoint;
          controls.beforeCheckpoint = null;
          callback(data => write(name, id, data));
        }
        if (name === "shareCleanupState" && !tx) { metrics.stateReads++; advance(controls.stateReadMs); }
        if (tx) tx.reads.set(`${name}/${id}`, tx.versions.get(`${name}/${id}`) || 0);
        return { data: structuredClone(readMap(name, tx).get(id) || null) }; },
      async set({ data }) {
        if (name === "checkins" && data.status === "deleted" && controls.finalizeError) throw controls.finalizeError;
        if (name === "shareCleanupState" && controls.checkpointError) throw controls.checkpointError;
        if (tx) tx.writes.push({ name, id, data: structuredClone(data) }); else write(name, id, data);
      },
    }; },
    where(condition) { let size = 50, ordered = false;
      return { orderBy(key, direction) { assert.equal(key, "_id"); assert.equal(direction, "asc"); ordered = true; return this; },
        limit(n) { assert.ok(n <= 50); size = n; return this; }, async get() { metrics.queries++;
          const referenceQuery = Object.keys(condition).length === 1 && typeof condition.recordingFileId === "string";
          if (referenceQuery) {
            metrics.referenceQueries.push({ condition: structuredClone(condition), limit: size, ordered });
            if (controls.referenceQueryError) throw controls.referenceQueryError;
          }
          if (controls.queryError) throw controls.queryError;
          let data = [...readMap(name).values()].filter(r => Object.entries(condition).every(([key, val]) =>
            val && typeof val === "object" && "gt" in val ? r[key] > val.gt : r[key] === val))
            .sort((a, b) => a._id.localeCompare(b._id)).slice(0, size).map(r => structuredClone(r));
          if (referenceQuery && controls.referenceQueryData !== undefined) data = controls.referenceQueryData;
          if (controls.beforeMark) { const callback = controls.beforeMark; controls.beforeMark = null; callback(); }
          if (referenceQuery && controls.beforeReferenceReturn) {
            const callback = controls.beforeReferenceReturn;
            controls.beforeReferenceReturn = null;
            callback();
          }
          advance(controls.queryMs + (referenceQuery ? controls.referenceQueryMs : 0));
          return { data };
        } };
    },
  });
  const db = { collection: name => collection(name), command: { gt: value => ({ gt: value }) },
    async runTransaction(operation) {
      const startedAtMs = clock.elapsedMs;
      const tx = { checkins: structuredClone(records), shareCleanupState: structuredClone(state), versions: new Map(versions), reads: new Map(), writes: [] };
      const result = await operation({ collection: name => collection(name, tx) });
      const phase = [...tx.reads.keys()].some(key => key.startsWith("shareCleanupState/")) ? "checkpoint"
        : tx.writes.some(w => w.data.status === "deleted") ? "finalize" : "mark";
      metrics.transactions.push({ phase, startedAtMs });
      advance(typeof controls.transactionMs === "function" ? controls.transactionMs(phase) : controls.transactionMs);
      if (controls.transactionConflict?.(phase) ||
          [...tx.reads].some(([key, version]) => (versions.get(key) || 0) !== version)) {
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
      const deleteError = typeof controls.deleteError === "function" ? controls.deleteError(fileList) : controls.deleteError;
      if (deleteError) throw deleteError;
      advance(controls.deleteMs);
      return { fileList: fileList.map(fileID => {
        const status = files.has(fileID) ? controls.deleteStatus : controls.missingStatus;
        if (status === 0) files.delete(fileID);
        return { fileID, status, ...(controls.deleteErrMsg === undefined ? {} : { errMsg: controls.deleteErrMsg }) };
      }) };
    },
  };
  const mod = { exports: {} };
  vm.runInNewContext(source, { exports: mod.exports, module: mod, process: { env }, Date: class extends Date { static now() { return NOW + clock.elapsedMs; } },
    console: { info() {}, error(...args) { capturedLogs.push(inspect(args)); } },
    require: name => name === "wx-server-sdk" ? cloud : name === "crypto" ? crypto : require(path.join(root, name)) });
  return { call: (event = {}) => { clock.elapsedMs = 0; return mod.exports.main(event, controls.runtimeContext); },
    records, state, files, metrics, controls, env, capturedLogs, clock };
}
const cases = [];
const test = (name, run) => cases.push({ name, run });
test("慢候选跨越准入截止后仍可安全收尾并多轮回绕", async () => {
  const h = harness([row(1), row(2)]);
  Object.assign(h.controls, {
    referenceQueryMs: 900, transactionMs: 350, deleteMs: 50,
    hardBudgetMs: 3000, runtimeContext: { time_limit_in_ms: 3000 },
  });
  for (let i = 0; i < 4 && (h.files.size || h.state.get("v2")?.cursor); i++) {
    const result = await h.call();
    assert.equal(result.ok, true);
    assert.ok(h.clock.elapsedMs < 3000);
    if (i < 2) {
      assert.equal(result.processed, 1);
      assert.equal(result.budgetExhausted, true);
      assert.equal(result.nextCursor, idFor(i + 1));
      assert.equal(h.clock.elapsedMs, 2000, "完成检查点后不再发起页尾写入");
    }
  }
  assert.equal(h.files.size, 0);
  assert.equal(h.records.get(idFor(1)).status, "deleted");
  assert.equal(h.records.get(idFor(2)).status, "deleted");
  assert.equal(h.state.get("v2").cursor, "");
  assert.ok(h.metrics.transactions.every(tx => tx.startedAtMs < 2000));
});
test("引用核验达到1200ms仍可收尾但不接下一候选，预演保持零写零删", async () => {
  for (const dryRun of [false, true]) {
    const h = harness([row(1), row(2)]);
    h.controls.referenceQueryMs = 1200;
    const result = await h.call({ dryRun });
    assert.equal(result.ok, true);
    assert.equal(result.processed, 1);
    assert.equal(result.candidates, 1);
    assert.equal(result.validated, 1);
    assert.equal(result.deleted, dryRun ? 0 : 1);
    assert.equal(result.nextCursor, idFor(1));
    assert.equal(result.budgetExhausted, true);
    assert.equal(h.records.get(idFor(2)).status, "active");
    if (dryRun) assert.equal(h.metrics.writes + h.metrics.deletes, 0);
  }
});
test("可信时限不超过预留时鉴权后零数据库和存储I/O并记录脱敏零进展类别", async () => {
  for (const time_limit_in_ms of [1000, 500]) {
    const h = harness();
    h.controls.runtimeContext = { time_limit_in_ms };
    const result = await h.call();
    assert.equal(result.ok, true);
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.processed, 0);
    assert.equal(result.failed, 0);
    assert.equal(h.metrics.stateReads + h.metrics.queries + h.metrics.writes + h.metrics.deletes, 0);
    assert.equal(h.metrics.transactions.length, 0);
    assert.deepEqual(h.capturedLogs, ["[ '分享清理预算不足', { code: 'CLEANUP_BUDGET_EXHAUSTED' } ]"]);
  }
});
test("可信较长时限可完成慢候选且只接一条，超过20秒的配置仍受上限约束", async () => {
  const h = harness([row(1), row(2)]);
  Object.assign(h.controls, { runtimeContext: { time_limit_in_ms: 6000 },
    referenceQueryMs: 2500, transactionMs: 350, deleteMs: 50, hardBudgetMs: 6000 });
  const result = await h.call();
  assert.equal(result.processed, 1);
  assert.equal(result.deleted, 1);
  assert.equal(result.nextCursor, idFor(1));
  assert.equal(h.files.size, 1);
  assert.equal(h.clock.elapsedMs, 3600);
  const capped = harness();
  Object.assign(capped.controls, { runtimeContext: { time_limit_in_ms: 100000 }, referenceQueryMs: 19000 });
  const stopped = await capped.call();
  assert.equal(stopped.budgetExhausted, true);
  assert.equal(stopped.processed, 0);
  assert.equal(stopped.validated, 0);
  assert.equal(capped.metrics.writes + capped.metrics.deletes, 0);
  assert.equal(capped.metrics.transactions.length, 0);
});
test("缺失或非法context回退3000ms，event伪造字段不能扩张收尾预算", async () => {
  for (const runtimeContext of [undefined, null, {}, ...[NaN, Infinity, "20000", -1, 1.5, 0,
    Number.MAX_SAFE_INTEGER + 1].map(time_limit_in_ms => ({ time_limit_in_ms }))]) {
    const h = harness();
    Object.assign(h.controls, { runtimeContext, referenceQueryMs: 2000 });
    const result = await h.call({ time_limit_in_ms: 20000, runtimeContext: { time_limit_in_ms: 20000 } });
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.validated, 0);
    assert.equal(result.processed, 0);
    assert.equal(result.failed, 0);
    assert.equal(h.metrics.writes + h.metrics.deletes, 0);
    assert.equal(h.metrics.transactions.length, 0);
    assert.equal(h.state.has("v2"), false);
    assert.match(h.capturedLogs.at(-1), /code: 'CLEANUP_BUDGET_EXHAUSTED'/);
  }
});
test("标记和删除耗尽收尾预算时不越过未完成行，下一调用重新核验后恢复", async () => {
  for (const phase of ["mark", "delete"]) {
    const h = harness();
    Object.assign(h.controls, { referenceQueryMs: 900,
      transactionMs: phase === "mark" ? 1100 : 100, deleteMs: phase === "delete" ? 1000 : 0 });
    const result = await h.call();
    assert.equal(result.ok, true);
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.processed, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.nextCursor, "");
    assert.equal(h.records.get(idFor(1)).status, "deletePending");
    assert.equal(h.records.get(idFor(1)).recordingFileId, row(1).recordingFileId);
    assert.equal(h.metrics.deletes, phase === "delete" ? 1 : 0);
    assert.equal(h.metrics.transactions.length, 1);
    assert.equal(h.state.has("v2"), false);
    Object.assign(h.controls, { referenceQueryMs: 0, transactionMs: 0, deleteMs: 0 });
    const resumed = await h.call();
    assert.equal(resumed.deleted, 1);
    assert.equal(h.metrics.referenceQueries.length, 2);
    assert.equal(h.records.get(idFor(1)).status, "deleted");
    assert.equal(h.files.size, 0);
    assert.equal(h.state.get("v2").cursor, "");
  }
});
test("结束事务刚好用尽预算时保留旧持久游标，后续可重验墓碑并恢复", async () => {
  const h = harness();
  h.state.set("v2", { cursor: idFor(0), revision: 5 });
  Object.assign(h.controls, { referenceQueryMs: 900, deleteMs: 100,
    transactionMs: phase => phase === "finalize" ? 900 : 100 });
  const result = await h.call();
  assert.equal(result.ok, true);
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.deleted, 1);
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.nextCursor, idFor(0));
  assert.equal(h.metrics.transactions.length, 2);
  assert.equal(h.records.get(idFor(1)).status, "deleted");
  assert.equal(h.files.size, 0);
  assert.deepEqual(h.state.get("v2"), { cursor: idFor(0), revision: 5 });
  Object.assign(h.controls, { referenceQueryMs: 0, transactionMs: 0, deleteMs: 0 });
  assert.equal((await h.call()).deleted, 1);
  assert.equal(h.metrics.referenceQueries.length, 2);
  assert.equal(h.state.get("v2").cursor, "");
});
test("标记结束及检查点事务冲突耗尽收尾预算后不再重试且可恢复", async () => {
  for (const phase of ["mark", "finalize", "checkpoint"]) {
    const h = harness();
    h.state.set("v2", { cursor: idFor(0), revision: 5 });
    Object.assign(h.controls, { referenceQueryMs: 900, deleteMs: 100,
      transactionMs: kind => kind === phase ? ({ mark: 1100, finalize: 900, checkpoint: 800 })[phase] : 100,
      transactionConflict: kind => kind === phase });
    const result = await h.call();
    assert.equal(result.ok, true);
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.failed, 0);
    assert.equal(result.processed, phase === "checkpoint" ? 1 : 0);
    assert.equal(result.deleted, phase === "checkpoint" ? 1 : 0);
    assert.equal(h.metrics.conflicts, 1, "达到收尾截止后不得再发起冲突重试");
    assert.equal(result.nextCursor, idFor(0));
    assert.deepEqual(h.state.get("v2"), { cursor: idFor(0), revision: 5 });
    assert.equal(h.metrics.deletes, phase === "mark" ? 0 : 1);
    assert.equal(h.records.get(idFor(1)).status,
      phase === "mark" ? "active" : phase === "finalize" ? "deletePending" : "deleted");
    Object.assign(h.controls, { referenceQueryMs: 0, deleteMs: 0, transactionMs: 0, transactionConflict: null });
    assert.equal((await h.call()).deleted, 1);
    assert.equal(h.metrics.referenceQueries.length, 2);
    assert.equal(h.records.get(idFor(1)).status, "deleted");
    assert.equal(h.files.size, 0);
    assert.equal(h.state.get("v2").cursor, "");
  }
});
test("默认dryrun，事件不能启用删除", async () => {
  const h = harness(); delete h.env.SHARE_CLEANUP_ENABLED;
  const result = await h.call({ enabled: true, dryRun: false });
  assert.equal(result.dryRun, true); assert.equal(result.candidates, 1);
  assert.equal(h.metrics.deletes + h.metrics.writes, 0);
});
for (const phase of ["mark", "finalize", "checkpoint"]) {
  test(`${phase}最后一次冲突刚好耗尽预算也不能冒充候选处理完成`, async () => {
    const h = harness();
    Object.assign(h.controls, {
      referenceQueryMs: ({ mark: 800, finalize: 700, checkpoint: 600 })[phase],
      transactionMs: kind => kind === phase ? 400 : 100,
      transactionConflict: kind => kind === phase,
    });
    const result = await h.call();
    assert.equal(result.ok, true);
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.failed, 0);
    assert.equal(result.processed, phase === "checkpoint" ? 1 : 0);
    assert.equal(h.metrics.conflicts, 3);
    assert.equal(h.clock.elapsedMs, 2000);
    assert.equal(h.metrics.deletes, phase === "mark" ? 0 : 1);
    assert.equal(h.state.has("v2"), false);
  });
}
test("预演收尾预算耗尽时仍返回此前已经审核的连续位置", async () => {
  const h = harness([row(1, { expiresAtMs: NOW + 1 }), row(2)]);
  h.controls.referenceQueryMs = 2000;
  const result = await h.call({ dryRun: true });
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.processed, 1);
  assert.equal(result.nextCursor, idFor(1));
  assert.equal(result.validated, 0);
  assert.equal(h.metrics.writes + h.metrics.deletes, 0);
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
test("fixture使用真实owner请求摘要绑定路径", async () => {
  const record = row(31);
  assert.ok(record._openid);
  assert.match(record.requestId, /^[a-f0-9]{32}$/);
  assert.match(record.payloadDigest, /^[a-f0-9]{64}$/);
  assert.equal(record.cloudPath,
    `expiring-shares-v2/${sha256(record._openid)}/${record.requestId}-${record.payloadDigest}.mp3`);
});
test("预演和正式模式都拒绝owner或请求摘要与路径不一致且不改变记录和文件", async () => {
  const invalid = [
    { _openid: "owner-other" },
    { _openid: undefined },
    { requestId: "f".repeat(32) },
    { requestId: undefined },
    { payloadDigest: "c".repeat(64) },
    { payloadDigest: undefined },
  ];
  for (const dryRun of [true, false]) {
    for (const patch of invalid) {
      const record = row(1, patch), h = harness([record]);
      const before = structuredClone(h.records.get(record._id));
      const result = await h.call({ dryRun });
      assert.equal(result.failed, 1);
      assert.equal(result.validated, 0);
      assert.equal(h.metrics.deletes, 0);
      assert.deepEqual(h.records.get(record._id), before);
      assert.equal(h.files.has(record.recordingFileId), true);
      assert.match(h.capturedLogs.at(-1), /code: 'INVALID_SHARE_BINDING'/);
    }
  }
});
test("active必须有可信fileID，pending、deletePending和deleted可只保留完整可信路径", async () => {
  const active = row(1, { recordingFileId: undefined });
  const pending = row(2, { status: "pending", recordingFileId: undefined,
    expiresAtMs: undefined, pendingExpiresAtMs: NOW - 1 });
  const deleting = row(3, { status: "deletePending", recordingFileId: undefined });
  const deleted = row(4, { status: "deleted", recordingFileId: undefined });
  const h = harness([active, pending, deleting, deleted]);
  const result = await h.call({ dryRun: true });
  assert.equal(result.candidates, 4);
  assert.equal(result.validated, 3);
  assert.equal(result.failed, 1);
  assert.equal(h.metrics.writes + h.metrics.deletes, 0);
});
test("同fileID的其他owner或同owner第二条记录都阻断且不能先写deletePending", async () => {
  for (const dryRun of [true, false]) {
    for (const aliasOwner of ["owner-other", "owner-primary"]) {
      const target = row(10);
      const alias = row(11, { _openid: aliasOwner, shareVersion: undefined,
        status: "deleted", expiresAtMs: undefined, recordingFileId: target.recordingFileId });
      const h = harness([target, alias]);
      const result = await h.call({ dryRun });
      assert.equal(result.failed, 1);
      assert.equal(result.validated, 0);
      assert.equal(result.deleted, 0);
      assert.equal(h.records.get(target._id).status, "active");
      assert.equal(h.metrics.deletes, 0);
      assert.equal(h.files.has(target.recordingFileId), true);
      assert.match(h.capturedLogs.at(-1), /code: 'FILE_REFERENCE_CONFLICT'/);
    }
  }
});
test("引用核验不按owner期限状态或旧协议过滤且只取两条", async () => {
  const target = row(500);
  const statuses = ["active", "pending", "deletePending", "deleted"];
  const aliases = Array.from({ length: 100 }, (_, index) => row(index + 1, {
    _openid: index % 2 ? "owner-primary" : "owner-other",
    shareVersion: index % 3 ? undefined : 1,
    status: statuses[index % statuses.length],
    expiresAtMs: index % 2 ? NOW + 86400000 : undefined,
    pendingExpiresAtMs: index % 2 ? undefined : NOW - 86400000,
    recordingFileId: target.recordingFileId,
  }));
  const h = harness([...aliases, target]);
  const result = await h.call({ dryRun: true });
  assert.equal(result.candidates, 1);
  assert.equal(result.validated, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(h.metrics.referenceQueries, [{
    condition: { recordingFileId: target.recordingFileId }, limit: 2, ordered: false,
  }]);
  assert.equal(h.metrics.deletes + h.metrics.writes, 0);
});
test("引用查询异常和非数组结果固定失败关闭且不泄漏SDK错误", async () => {
  const secret = "SYNTHETIC_REFERENCE_PRIVATE_VALUE";
  for (const configure of [
    h => { h.controls.referenceQueryError = new Error(secret); },
    h => { h.controls.referenceQueryData = null; },
  ]) {
    const h = harness(); configure(h);
    const result = await h.call();
    assert.equal(result.failed, 1);
    assert.equal(result.validated, 0);
    assert.equal(h.records.get(idFor(1)).status, "active");
    assert.equal(h.metrics.deletes, 0);
    assert.match(h.capturedLogs.at(-1), /code: 'FILE_REFERENCE_CHECK_FAILED'/);
    assert.equal(JSON.stringify({ result, logs: h.capturedLogs }).includes(secret), false);
  }
});
test("引用核验耗尽收尾预算时不报validated且不写状态或推进游标", async () => {
  const h = harness();
  h.controls.referenceQueryMs = 2000;
  const result = await h.call();
  assert.equal(result.ok, true);
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.validated, 0);
  assert.equal(result.processed, 0);
  assert.equal(result.nextCursor, "");
  assert.equal(h.records.get(idFor(1)).status, "active");
  assert.equal(h.state.has("v2"), false);
  assert.equal(h.metrics.deletes + h.metrics.writes, 0);
});
test("正式首事务拒绝预检后改变的完整绑定", async () => {
  const record = row(1), h = harness([record]);
  h.controls.beforeReferenceReturn = () => {
    h.records.get(record._id).requestId = "f".repeat(32);
  };
  const result = await h.call();
  assert.equal(result.failed, 1);
  assert.equal(result.deleted, 0);
  assert.equal(h.metrics.deletes, 0);
  assert.equal(h.records.get(record._id).status, "active");
  assert.equal(h.files.has(record.recordingFileId), true);
  assert.match(h.capturedLogs.at(-1), /code: 'INVALID_SHARE_BINDING'/);
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
test("软预算逐候选检查点可在硬超时前多轮推进完整页", async () => {
  const h = harness(Array.from({ length: 51 }, (_, i) => row(i + 1)));
  h.controls.transactionMs = 30;
  h.controls.deleteMs = 70;
  h.controls.hardBudgetMs = 3000;
  const results = [];
  for (let i = 0; i < 10 && (h.files.size > 0 || h.state.get("v2")?.cursor); i++) {
    const result = await h.call();
    results.push(result);
    assert.equal(result.ok, true, "软预算退出必须早于模拟硬超时");
    assert.ok(h.clock.elapsedMs < h.controls.hardBudgetMs, "不得触及模拟硬预算");
  }
  assert.ok(results.some(result => result.budgetExhausted === true), "完整页应触发软预算分批");
  assert.equal(results.reduce((sum, result) => sum + result.processed, 0), 51);
  assert.equal(h.files.size, 0);
  assert.ok([...h.records.values()].every(record => record.status === "deleted"));
  assert.equal(h.state.get("v2").cursor, "");
});
test("查询已耗尽软预算时保留正式游标且不启动候选", async () => {
  const h = harness([row(1), row(2), row(3)]);
  h.state.set("v2", { cursor: idFor(1), revision: 4 });
  h.controls.queryMs = 1200;
  const result = await h.call();
  assert.equal(result.ok, true);
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.scanned, 2);
  assert.equal(result.processed, 0);
  assert.equal(result.candidates, 0);
  assert.equal(result.nextCursor, idFor(1));
  assert.deepEqual(h.state.get("v2"), { cursor: idFor(1), revision: 4 });
  assert.equal(h.metrics.deletes + h.metrics.writes, 0);
});
test("正式游标读取已耗尽软预算时不再启动分页查询", async () => {
  const h = harness([row(1), row(2)]);
  h.state.set("v2", { cursor: idFor(1), revision: 4 });
  h.controls.stateReadMs = 1200;
  const result = await h.call();
  assert.equal(result.ok, true);
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.scanned, 0);
  assert.equal(result.processed, 0);
  assert.equal(result.nextCursor, idFor(1));
  assert.equal(h.metrics.queries, 0, "软预算耗尽后不得强行启动页面读取");
  assert.deepEqual(h.state.get("v2"), { cursor: idFor(1), revision: 4 });
});
test("dry-run预算退出只返回实际审核位置且不写正式状态", async () => {
  const h = harness([row(1), row(2), row(3)]);
  h.state.set("v2", { cursor: idFor(9), revision: 2 });
  h.controls.queryMs = 1200;
  const result = await h.call({ dryRun: true, cursor: idFor(1) });
  assert.equal(result.ok, true);
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.processed, 0);
  assert.equal(result.candidates, 0);
  assert.equal(result.validated, 0, "未启动的候选不能声明已校验");
  assert.equal(result.nextCursor, idFor(1));
  assert.deepEqual(h.state.get("v2"), { cursor: idFor(9), revision: 2 });
  assert.equal(h.metrics.deletes + h.metrics.writes, 0);
});
test("候选检查点失败立即停止且保留可重试墓碑引用", async () => {
  const h = harness([row(1), row(2)]);
  h.controls.checkpointError = new Error("SYNTHETIC_CHECKPOINT_PRIVATE_VALUE");
  const result = await h.call();
  assert.equal(result.ok, false);
  assert.equal(result.code, "CLEANUP_FAILED");
  assert.equal(result.processed, 1);
  assert.equal(h.metrics.deletes, 1);
  assert.equal(h.records.get(idFor(1)).status, "deleted");
  assert.equal(h.records.get(idFor(1)).recordingFileId, row(1).recordingFileId);
  assert.equal(h.records.get(idFor(2)).status, "active", "检查点失败后不得继续删除");
  assert.equal(h.state.has("v2"), false);
  assert.equal(JSON.stringify({ result, logs: h.capturedLogs }).includes("SYNTHETIC_CHECKPOINT_PRIVATE_VALUE"), false);
});
test("单候选未知删除错误推进检查点且不阻塞后续安全记录", async () => {
  const h = harness([row(1), row(2)]);
  let first = true;
  h.controls.deleteError = () => first ? (first = false, new Error("SYNTHETIC_DELETE_PRIVATE_VALUE")) : null;
  const result = await h.call();
  assert.equal(result.ok, true);
  assert.equal(result.failed, 1);
  assert.equal(result.deleted, 1);
  assert.equal(result.processed, 2);
  assert.equal(h.records.get(idFor(1)).status, "deletePending");
  assert.equal(h.records.get(idFor(1)).recordingFileId, row(1).recordingFileId);
  assert.equal(h.records.get(idFor(2)).status, "deleted");
  assert.equal(h.state.get("v2").cursor, "");
  const retry = await h.call();
  assert.equal(retry.ok, true);
  assert.equal(h.records.get(idFor(1)).status, "deleted");
  assert.equal(h.files.size, 0);
});
test("纯active页只在页尾保存已扫描前缀", async () => {
  const h = harness(Array.from({ length: 51 }, (_, i) => row(i + 1, { expiresAtMs: NOW + 1 })));
  const first = await h.call();
  assert.equal(first.scanned, 50);
  assert.equal(first.processed, 50);
  assert.equal(first.candidates, 0);
  assert.equal(first.nextCursor, idFor(50));
  assert.equal(h.metrics.writes, 1, "跳过未到期记录不得逐条写检查点");
  const second = await h.call();
  assert.equal(second.scanned, 1);
  assert.equal(second.processed, 1);
  assert.equal(second.nextCursor, "");
  assert.equal(h.metrics.writes, 2);
  assert.equal(h.metrics.deletes, 0);
});
test("满页游标在下一次空页回绕且不伪报处理记录", async () => {
  const h = harness(Array.from({ length: 50 }, (_, i) => row(i + 1, { expiresAtMs: NOW + 1 })));
  const first = await h.call();
  assert.equal(first.nextCursor, idFor(50));
  const second = await h.call();
  assert.equal(second.scanned, 0);
  assert.equal(second.processed, 0);
  assert.equal(second.candidates, 0);
  assert.equal(second.nextCursor, "");
  assert.equal(h.state.get("v2").cursor, "");
});
test("并发revision前进时中止且不覆盖较新游标", async () => {
  const h = harness(Array.from({ length: 50 }, (_, i) => row(i + 1, { expiresAtMs: NOW + 1 })));
  h.controls.beforeCheckpoint = save => save({ cursor: idFor(99), revision: 1, updatedAtMs: NOW });
  const result = await h.call();
  assert.equal(result.ok, false);
  assert.equal(result.code, "CLEANUP_STATE_CHANGED");
  assert.equal(h.state.get("v2").cursor, idFor(99));
  assert.equal(h.state.get("v2").revision, 1);
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
  assert.ok(results.some(r => r.ok));
  assert.ok(results.every(r => r.ok || r.code === "CLEANUP_STATE_CHANGED"));
  assert.equal(h.files.size, 0); assert.ok(h.metrics.conflicts > 0);
  const r = row(1, { status: "pending", expiresAtMs: undefined, pendingExpiresAtMs: NOW - 1 });
  const k = harness([r]); k.controls.beforeMark = () => Object.assign(k.records.get(r._id), { status: "active", expiresAtMs: NOW + 86400000 });
  assert.equal((await k.call()).deleted, 0); assert.equal(k.metrics.deletes, 0);
});
(async () => { let failures = 0; for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`); }
} assert.equal(failures, 0, `${failures}/${cases.length} 项清理测试失败`);
console.log(`分享清理测试通过：${cases.length} 组。`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
