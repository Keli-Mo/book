/* eslint-disable import/no-commonjs */
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");
const MAX_RECORDING_BYTES = 8 * 1024 * 1024;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const codeFields = ["errCode", "code", "errno"];
const codesAreZero = value => codeFields.every(key => !(key in value) || value[key] === 0);
const isMissingCode = code => code === -503003 || code === "STORAGE_FILE_NONEXIST";

// Only SDK typed failures can prove absence. Never inspect raw error prose or HTTP bodies.
const signingFailure = value => {
  if (!object(value)) return "UNAVAILABLE";
  const fields = [...codeFields, "status"].filter(key => key in value);
  if (!fields.length || !fields.every(key => isMissingCode(value[key])) ||
      value.errMsg === "ok" || value.errMsg === "getTempFileURL:ok" ||
      ("tempFileURL" in value && value.tempFileURL !== "")) return "UNAVAILABLE";
  return "MISSING";
};

const signingResult = (result, fileID) => {
  if (!object(result) || result.errMsg !== "getTempFileURL:ok" || !codesAreZero(result) ||
      !Array.isArray(result.fileList) || result.fileList.length !== 1) return { kind: "UNAVAILABLE" };
  const item = result.fileList[0];
  if (!object(item) || item.fileID !== fileID) return { kind: "UNAVAILABLE" };
  if (item.status !== 0 || item.errMsg !== "ok" || !codesAreZero(item)) {
    return { kind: signingFailure(item) };
  }
  if (typeof item.tempFileURL !== "string" || !item.tempFileURL) return { kind: "UNAVAILABLE" };
  const url = new URL(item.tempFileURL);
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      item.tempFileURL.includes("#") || (url.port && url.port !== "443")) return { kind: "UNAVAILABLE" };
  return { url };
};

// Compare raw duplicates as well as Node's normalized headers. The length remains
// only a precheck: every actual chunk is bounded again before hash.update.
const header = (res, name) => {
  const values = [];
  if (res.headers && name in res.headers) values.push(res.headers[name]);
  if (res.rawHeaders !== undefined) {
    if (!Array.isArray(res.rawHeaders) || res.rawHeaders.length % 2) throw new Error("UNAVAILABLE");
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      if (typeof res.rawHeaders[i] !== "string") throw new Error("UNAVAILABLE");
      if (res.rawHeaders[i].toLowerCase() === name) values.push(res.rawHeaders[i + 1]);
    }
  }
  if (values.some(value => typeof value !== "string" || value !== values[0])) throw new Error("UNAVAILABLE");
  return values[0];
};

function readRecordingDigest(cloud, fileID, { deadlineAtMs }) {
  return new Promise((resolve, reject) => {
    let settled = false, req = null, res = null, timer = null, bytes = 0, sawEnd = false;
    const expired = () => !Number.isFinite(deadlineAtMs) || Date.now() >= deadlineAtMs;
    const destroy = stream => {
      if (!stream) return;
      // Keep error listeners through and after close: destroy can emit synchronously
      // or asynchronously, including for responses that arrive after timeout.
      try { stream.destroy(); } catch (_error) { /* Already settled; no raw errors escape. */ }
    };
    const settle = (kind, result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      destroy(res); destroy(req);
      if (kind) reject(Object.assign(new Error(kind), { code: kind }));
      else resolve(result);
    };
    const unavailable = () => settle("UNAVAILABLE");
    if (expired()) { settle("TIMEOUT"); return; }
    timer = setTimeout(() => settle("TIMEOUT"), deadlineAtMs - Date.now());
    // A timed out signing RPC cannot be cancelled; always observe its eventual
    // rejection and prevent its eventual success from opening a socket.
    Promise.resolve().then(() => {
      if (settled) return;
      if (expired()) { settle("TIMEOUT"); return; }
      return cloud.getTempFileURL({ fileList: [{ fileID, maxAge: 600 }] });
    }).then(result => {
      if (settled) return;
      try {
        if (expired()) { settle("TIMEOUT"); return; }
        const signed = signingResult(result, fileID);
        if (signed.kind) { settle(signed.kind); return; }
        const hash = crypto.createHash("sha1");
        req = https.request(signed.url, { method: "GET", agent: false,
          headers: { "Accept-Encoding": "identity" } }, incoming => {
          // Attach first, including when the deadline fired before response.
          incoming.on("error", unavailable);
          if (settled) { destroy(incoming); return; }
          res = incoming;
          try {
            res.on("aborted", unavailable);
            res.on("close", () => { if (!settled && !sawEnd) unavailable(); });
            if (expired()) { settle("TIMEOUT"); return; }
            if (res.statusCode !== 200) { unavailable(); return; }
            const encoding = header(res, "content-encoding");
            if (encoding !== undefined && encoding !== "identity") { unavailable(); return; }
            const rawLength = header(res, "content-length");
            let length;
            if (rawLength !== undefined) {
              if (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength))) { unavailable(); return; }
              length = Number(rawLength);
              if (length > MAX_RECORDING_BYTES) { settle("LIMIT"); return; }
            }
            res.on("data", chunk => {
              if (settled) return;
              try {
                if (expired()) { settle("TIMEOUT"); return; }
                if (!Buffer.isBuffer(chunk)) { unavailable(); return; }
                if (chunk.length > MAX_RECORDING_BYTES - bytes) { settle("LIMIT"); return; }
                bytes += chunk.length;
                hash.update(chunk);
              } catch (_error) { unavailable(); }
            });
            res.on("end", () => {
              if (settled) return;
              try {
                sawEnd = true;
                if (expired()) { settle("TIMEOUT"); return; }
                if (res.complete !== true || (length !== undefined && length !== bytes)) { unavailable(); return; }
                settle(null, { fileSizeBytes: bytes, contentSha1: hash.digest("hex") });
              } catch (_error) { unavailable(); }
            });
          } catch (_error) { unavailable(); }
        });
        req.on("error", unavailable);
        // Also covers a synchronous response callback settling during request().
        if (settled) { destroy(req); return; }
        req.end();
      } catch (_error) { unavailable(); }
    }, error => {
      if (settled) return;
      try { settle(expired() ? "TIMEOUT" : signingFailure(error)); }
      catch (_error) { unavailable(); }
    }).catch(unavailable);
  });
}

module.exports = { MAX_RECORDING_BYTES, readRecordingDigest };
