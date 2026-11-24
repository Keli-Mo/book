const assert = require("node:assert/strict");
const test = require("node:test");
const { createQuotaStore, LEASE_MS } = require("../cloudfunctions/voiceChat/quota");
const { createHandler } = require("../cloudfunctions/voiceChat/handler");

const student = "student-a";
const otherStudent = "student-b";
const requestId = n => n.toString(16).padStart(32, "0");
const hasCode = expected => error => error.code === expected;

// Serialize committed transactions, and discard all writes if the callback rejects.
function fixture() {
  let docs = new Map();
  let clock = Date.UTC(2026, 10, 17);
  let queue = Promise.resolve();
  function collection(rows, name) {
    return { doc(id) {
      const key = name + "/" + id;
      return {
        async get() { return { data: structuredClone(rows.get(key) ?? null) }; },
        async set({ data }) { rows.set(key, { ...structuredClone(data), _id: id }); return { stats: { updated: 1 } }; },
      };
    } };
  }
  const db = {
    collection: name => collection(docs, name),
    runTransaction(callback) {
      const result = queue.then(async () => {
        const next = structuredClone(docs);
        const value = await callback({ collection: name => collection(next, name) });
        docs = next;
        return value;
      });
      queue = result.catch(() => {});
      return result;
    },
  };
  return { store: createQuotaStore(db, { now: () => clock }), advance: ms => { clock += ms; } };
}

async function deliver(store, n, user = student) {
  const id = requestId(n);
  const { token } = await store.reserve(user, id);
  return store.complete(user, id, token);
}

test("a partial failure can retry the same request and confirmation debits exactly once", async () => {
  const { store } = fixture();
  let failing = true, asrCalls = 0;
  const handler = createHandler({ enabled: true, getOpenId: () => student, allowedOpenIds: new Set([student]),
    quotaEnabled: true, quota: store,
    transcribe: async () => { asrCalls++; return "I like pandas."; },
    reply: async () => { if (failing) throw new Error("temporary"); return { replyEn: "Pandas are cute!", replyZh: "熊猫很可爱！" }; },
    synthesize: async () => "QUJD",
  });
  const input = { requestId: requestId(8), mode: "free", level: "basic", topic: "animals", turns: [],
    durationMs: 2000, audioBase64: Buffer.from("ID3fixture").toString("base64"), quotaProtocol: 1, progressProtocol: 1 };
  const failed = await handler(input);
  assert.equal(failed.partial.transcript, "I like pandas.");
  assert.equal((await store.status(student)).freeRemaining, 5);
  failing = false;
  const retry = { ...input, action: "retryReply", transcript: failed.partial.transcript };
  const succeeded = await handler(retry);
  assert.equal(succeeded.ok, true);
  assert.equal(asrCalls, 1);
  const held = await store.status(student);
  assert.equal(held.freeRemaining, 4, "one turn is reserved while waiting for playback");
  assert.ok(held.pendingUntil);
  const confirm = { action: "confirmTurn", ...succeeded.data.receipt };
  assert.equal((await handler(confirm)).data.quota.freeRemaining, 4);
  assert.equal((await handler(confirm)).data.quota.freeRemaining, 4);
  assert.equal((await handler(retry)).code, "REQUEST_COMPLETED");
});

test("a free account has exactly five confirmed turns across concurrent requests", async () => {
  const { store } = fixture();
  assert.equal((await store.status(student)).freeRemaining, 5);
  for (let i = 1; i <= 4; i++) await deliver(store, i);
  const ids = [requestId(5), requestId(6)];
  const reservations = await Promise.allSettled(ids.map(id => store.reserve(student, id)));
  const winner = reservations.findIndex(result => result.status === "fulfilled");
  assert.notEqual(winner, -1);
  assert.equal(reservations[1 - winner].reason.code, "REQUEST_IN_PROGRESS");
  const { token } = reservations[winner].value;
  const confirmations = await Promise.all(ids.map(() => store.complete(student, ids[winner], token)));
  for (const result of confirmations) assert.equal(result.freeRemaining, 0);
  await assert.rejects(store.reserve(student, requestId(7)), hasCode("QUOTA_EXHAUSTED"));
  await assert.rejects(store.reserve(student, ids[winner]), hasCode("REQUEST_COMPLETED"));
  assert.equal((await store.status(otherStudent)).freeRemaining, 5);
});

test("a failed or undelivered round releases the hold without consuming the free turn", async () => {
  const { store, advance } = fixture();
  const id = requestId(1);
  const first = await store.reserve(student, id);
  await assert.rejects(store.reserve(student, id), hasCode("REQUEST_IN_PROGRESS"));
  await store.release(student, id, first.token);
  assert.equal((await store.status(student)).freeRemaining, 5);
  const lost = await store.reserve(student, requestId(2));
  advance(LEASE_MS + 1);
  assert.equal((await store.status(student)).freeRemaining, 5);
  const later = await store.reserve(student, requestId(3));
  await assert.rejects(store.complete(student, requestId(2), lost.token));
  await assert.rejects(store.complete(otherStudent, requestId(3), later.token));
  await assert.rejects(store.complete(student, requestId(3), first.token));
  assert.equal((await store.complete(student, requestId(3), later.token)).freeRemaining, 4);
});

test("a 7-day grant gives 50 turns once and an expired order cannot be reused", async () => {
  const { store, advance } = fixture();
  for (let i = 1; i <= 5; i++) await deliver(store, i);
  const order = "trial-order-00001";
  await store.grantPack(student, order);
  assert.equal((await store.status(student)).packRemaining, 50);
  const quota = await deliver(store, 6);
  assert.equal(quota.freeRemaining, 0);
  assert.equal(quota.packRemaining, 49);
  await store.grantPack(student, order);
  assert.equal((await store.status(student)).packRemaining, 49);
  await assert.rejects(store.grantPack(student, "trial-order-00002"), hasCode("PACK_ACTIVE"));
  advance(7 * 24 * 60 * 60 * 1000);
  const expired = await store.status(student);
  assert.equal(expired.packRemaining, 0);
  assert.equal(expired.packExpiresAt, quota.packExpiresAt);
  await store.grantPack(student, order);
  await assert.rejects(store.reserve(student, requestId(7)), hasCode("QUOTA_EXHAUSTED"));
  await store.grantPack(student, "trial-order-00002");
  assert.equal((await store.status(student)).packRemaining, 50);
});

test("a turn started before pack expiry settles once against that pack", async () => {
  const { store, advance } = fixture();
  for (let i = 1; i <= 5; i++) await deliver(store, i);
  await store.grantPack(student, "first-order");
  advance(7 * 24 * 60 * 60 * 1000 - 1000);
  const id = requestId(6);
  const { token } = await store.reserve(student, id);
  advance(2000);
  await assert.rejects(store.grantPack(student, "new-order"), hasCode("REQUEST_IN_PROGRESS"));
  await store.complete(student, id, token);
  await store.grantPack(student, "new-order");
  assert.equal((await store.complete(student, id, token)).packRemaining, 50);
  await assert.rejects(store.grantPack(otherStudent, "new-order"));
});

test("the metered cloud function recovers from a lost reply and a lost confirmation", async () => {
  const { store, advance } = fixture();
  let generated = 0;
  const call = createHandler({
    enabled: true, quotaEnabled: true, quota: store,
    allowedOpenIds: new Set([student]), getOpenId: () => student,
    transcribe: async () => "Hello!", reply: async () => ({ replyEn: "Hi!", replyZh: "你好！" }),
    synthesize: async () => { generated++; return "SUQzc2FtcGxl"; },
  });
  const first = {
    quotaProtocol: 1, mode: "free", level: "basic", requestId: requestId(1), durationMs: 600,
    audioBase64: "SUQzc2FtcGxl", turns: [],
  };
  const status = async () => (await call({ action: "quotaStatus" })).data.quota;
  const lost = await call(first);
  assert.ok(lost.data.receipt?.token);
  assert.equal((await call(first)).code, "REQUEST_IN_PROGRESS");
  assert.equal(generated, 1);
  advance(LEASE_MS + 1);
  assert.equal((await status()).freeRemaining, 5);
  const retry = await call(first);
  assert.ok(retry.data.audioBase64);
  const ack = { action: "confirmTurn", ...retry.data.receipt };
  assert.equal((await call({ action: "confirmTurn", ...lost.data.receipt })).ok, false);
  assert.equal((await call(ack)).data.quota.freeRemaining, 4);
  assert.equal((await call(ack)).data.quota.freeRemaining, 4);
  assert.equal((await call(first)).code, "REQUEST_COMPLETED");
  assert.equal(generated, 2);
});
