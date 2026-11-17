const { createHash, randomBytes } = require("node:crypto");

const COLLECTION = "voice_chat_quota";
const FREE_ROUNDS = 5;
const PACK_ROUNDS = 50;
const PACK_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const LEASE_MS = 120 * 1000;

function digest(...parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function reject(code) {
  throw Object.assign(new Error(code), { code });
}

function balance(account, time) {
  const pending = account.pending;
  const pack = account.pack && account.pack.expiresAt > time ? account.pack : null;
  return {
    freeRemaining: FREE_ROUNDS - account.freeUsed - (pending?.source === "free" ? 1 : 0),
    packRemaining: pack ? PACK_ROUNDS - pack.used - (pending?.source === "pack" ? 1 : 0) : 0,
    packExpiresAt: account.pack?.expiresAt ?? null,
    ...(pending ? { pendingUntil: pending.expiresAt } : {}),
  };
}

// A user's document holds at most one reservation. Completed requests and
// confirmed orders each have their own small receipt, with no conversation data.
function createQuotaStore(db, { now = Date.now } = {}) {
  async function withAccount(openId, operation) {
    if (typeof openId !== "string" || !openId.trim()) reject("INVALID_ACCOUNT");
    const accountId = digest("account", openId);
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.runTransaction(async (transaction) => {
          const collection = transaction.collection(COLLECTION);
          const doc = collection.doc(accountId);
          const { data } = await doc.get();
          const time = now();
          const account = data === null ? { freeUsed: 0, pack: null, pending: null } : {
            freeUsed: data.freeUsed, pack: data.pack, pending: data.pending,
          };
          const pack = account.pack;
          if (!Number.isInteger(account.freeUsed) || account.freeUsed < 0 || account.freeUsed > FREE_ROUNDS ||
              (pack && (!Number.isSafeInteger(pack.expiresAt) || !Number.isInteger(pack.used) ||
                pack.used < 0 || pack.used > PACK_ROUNDS))) {
            reject("QUOTA_STATE_INVALID");
          }
          if (account.pending && account.pending.expiresAt <= time) account.pending = null;
          return operation({ account, accountId, doc, collection, time });
        }, 0);
      } catch (error) {
        const conflict = error?.code === "DATABASE_TRANSACTION_CONFLICT" ||
          /\[ResourceUnavailable\.TransactionConflict\]/.test(error?.errMsg || error?.message || "");
        if (!conflict || attempt >= 3) throw error;
      }
    }
  }

  function requestDoc(collection, accountId, requestId) {
    return collection.doc(digest("turn", accountId, requestId.toLowerCase()));
  }

  return {
    status(openId) {
      return withAccount(openId, ({ account, time }) => balance(account, time));
    },

    reserve(openId, requestId) {
      requestId = requestId.toLowerCase();
      const token = randomBytes(16).toString("hex");
      return withAccount(openId, async ({ account, accountId, doc, collection, time }) => {
        const receipt = await requestDoc(collection, accountId, requestId).get();
        if (receipt.data) reject("REQUEST_COMPLETED");
        if (account.pending) reject("REQUEST_IN_PROGRESS");
        const { freeRemaining, packRemaining } = balance(account, time);
        if (freeRemaining <= 0 && packRemaining <= 0) reject("QUOTA_EXHAUSTED");
        account.pending = {
          requestId, tokenHash: digest(token), source: freeRemaining > 0 ? "free" : "pack",
          expiresAt: time + LEASE_MS,
        };
        await doc.set({ data: account });
        return { token };
      });
    },

    complete(openId, requestId, token) {
      requestId = requestId.toLowerCase();
      const tokenHash = digest(token);
      return withAccount(openId, async ({ account, accountId, doc, collection, time }) => {
        const receiptDoc = requestDoc(collection, accountId, requestId);
        const { data: receipt } = await receiptDoc.get();
        if (receipt) {
          if (receipt.tokenHash !== tokenHash) reject("INVALID_RECEIPT");
          return balance(account, time);
        }
        const pending = account.pending;
        if (!pending || pending.requestId !== requestId) reject("RESERVATION_EXPIRED");
        if (pending.tokenHash !== tokenHash) reject("INVALID_RECEIPT");
        // Honor a paid turn reserved before the pack's deadline, even if the ACK
        // crosses that deadline. A new pack cannot replace it while pending.
        if (pending.source === "free") account.freeUsed++;
        else account.pack.used++;
        account.pending = null;
        await doc.set({ data: account });
        await receiptDoc.set({ data: { tokenHash, completedAt: time } });
        return balance(account, time);
      });
    },

    release(openId, requestId, token) {
      requestId = requestId.toLowerCase();
      return withAccount(openId, async ({ account, doc, time }) => {
        if (account.pending?.requestId === requestId && account.pending.tokenHash === digest(token)) {
          account.pending = null;
          await doc.set({ data: account });
        }
        return balance(account, time);
      });
    },

    // Internal fulfillment only. The caller must verify the order and recipient
    // before invoking this method; it is never dispatched from a client event.
    grantPack(openId, orderId) {
      if (typeof orderId !== "string" || !orderId.trim() || orderId.length > 128) reject("INVALID_ORDER");
      return withAccount(openId, async ({ account, accountId, doc, collection, time }) => {
        const orderDoc = collection.doc(digest("order", orderId));
        const { data: receipt } = await orderDoc.get();
        if (receipt) {
          if (receipt.accountId !== accountId) reject("ORDER_ACCOUNT_MISMATCH");
          return balance(account, time);
        }
        if (account.pending) reject("REQUEST_IN_PROGRESS");
        if (balance(account, time).packRemaining > 0) reject("PACK_ACTIVE");
        account.pack = { used: 0, expiresAt: time + PACK_DURATION_MS };
        await doc.set({ data: account });
        await orderDoc.set({ data: { accountId, grantedAt: time } });
        return balance(account, time);
      });
    },
  };
}

module.exports = { createQuotaStore, COLLECTION, FREE_ROUNDS, PACK_ROUNDS, PACK_DURATION_MS, LEASE_MS };
