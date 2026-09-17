/* eslint-disable import/no-commonjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const MAX = 8 * 1024 * 1024;
const fileID = 'cloud://test.bucket/fixture.mp3';
const secret = 'sensitive-signature-marker';
const signing = (id = fileID) => ({ errMsg: 'getTempFileURL:ok', fileList: [
  { fileID: id, status: 0, errMsg: 'ok', tempFileURL: `https://example.test/${encodeURIComponent(id)}?sig=${secret}%2F` },
] });

// Shared by both real-handler integrations. Only example.test URLs resolve to memory.
// Clock/timers are deterministic; no socket, native timer or real SDK is used.
function loadReader({ files = new Map([[fileID, Buffer.from('x')]]), controls = {}, metrics = {},
  clock = { now: () => 1000 }, cryptoModule = crypto, urlModule = require('node:url') } = {}) {
  const timers = new Map(), requests = [], responses = [];
  let nextTimer = 0;
  const destroyable = () => {
    const stream = new EventEmitter();
    stream.destroyed = false;
    stream.destroy = () => {
      if (stream.destroyed) return;
      stream.destroyed = true;
      if (controls.destroyError) stream.emit('error', new Error(secret));
      if (controls.destroyThrow) throw new Error(secret);
    };
    return stream;
  };
  const https = { request(url, options, callback) {
    assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'example.test');
    assert.equal(options.method, 'GET'); assert.equal(options.agent, false);
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    assert.ok(url.search.includes('%2F') || !url.search, '签名 query 不得重复编码');
    if (controls.requestThrow) throw new Error(secret);
    metrics.downloads = (metrics.downloads || 0) + 1;
    const req = destroyable(); requests.push(req);
    req.respond = () => {
        const res = destroyable(); responses.push(res);
        res.statusCode = 'httpStatus' in controls ? controls.httpStatus : 200;
        res.headers = controls.headers || {};
        res.rawHeaders = controls.rawHeaders || Object.entries(res.headers).flat();
        res.complete = controls.complete !== false;
        callback(res);
        if (controls.manual) return;
        const id = decodeURIComponent(url.pathname.slice(1));
        assert.ok(files.has(id), 'GET 必须对应内存文件');
        const body = files.get(id);
        const chunks = controls.chunks || Array.from({ length: Math.ceil(body.length / 65536) },
          (_, i) => body.subarray(i * 65536, (i + 1) * 65536));
        for (const chunk of chunks) {
          if (res.destroyed && !controls.emitAfterDestroy) break;
          if (controls.beforeChunk) controls.beforeChunk();
          res.emit('data', chunk);
        }
        if (controls.abort) res.emit('aborted');
        if (controls.earlyClose) res.emit('close');
        res.emit('end');
        if (controls.afterEnd) controls.afterEnd();
    };
    req.end = () => {
      if (controls.endThrow) throw new Error(secret);
      if (controls.noResponse) return;
      queueMicrotask(req.respond);
    };
    return req;
  } };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/checkIn/recordingDownload.js'), 'utf8'), {
    module: mod, exports: mod.exports, Buffer,
    Date: class extends Date { static now() { return clock.now(); } },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: clock.now() + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    console: { error() { assert.fail('helper 不得输出日志'); }, log() { assert.fail('helper 不得输出日志'); } },
    require(name) {
      if (name === 'https') return https;
      if (name === 'crypto') return cryptoModule;
      if (name === 'url') return urlModule;
      throw new Error(`Unexpected module ${name}`);
    },
  });
  return { ...mod.exports, requests, responses, timers,
    tick() { for (const [id, timer] of [...timers]) if (timer.at <= clock.now()) { timers.delete(id); timer.fn(); } },
  };
}
module.exports = { loadReader, signing };

async function main() {
  let count = 0;
  const test = async (name, run) => { await run(); count++; console.log(`PASS ${name}`); };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const setup = (controls = {}, bytes = Buffer.from('x'), overrides = {}) => {
    let now = 1000, hashed = 0;
    const metrics = {};
    const instrumentedCrypto = { createHash(algorithm) {
      if (controls.hashCreateThrow) throw new Error(secret);
      const hash = crypto.createHash(algorithm);
      return { update(chunk) { hashed += chunk.length;
        if (controls.hashUpdateThrow) throw new Error(secret); hash.update(chunk); },
      digest(format) { if (controls.hashDigestThrow) throw new Error(secret); return hash.digest(format); } };
    } };
    const reader = loadReader({ controls, metrics, files: new Map([[fileID, bytes]]),
      clock: { now: () => now }, cryptoModule: instrumentedCrypto, ...overrides });
    let signed = 0;
    const cloud = { getTempFileURL(args) {
      signed++; assert.deepEqual(JSON.parse(JSON.stringify(args)), { fileList: [{ fileID, maxAge: 600 }] });
      if (controls.signThrow) throw controls.signThrow;
      if (controls.sign) return controls.sign();
      return Promise.resolve('signResult' in controls ? controls.signResult : signing());
    } };
    return { ...reader, metrics, cloud, controls, get hashed() { return hashed; }, get signed() { return signed; },
      advance(ms, fire = true) { now += ms; if (fire) reader.tick(); },
      read(deadlineAtMs = 1100) { return reader.readRecordingDigest(cloud, fileID, { deadlineAtMs }); } };
  };
  const failure = async (h, kind) => {
    await assert.rejects(h.read(), error => {
      assert.equal(error.code, kind); assert.equal(error.message, kind);
      assert.equal(error.cause, undefined); assert.doesNotMatch(error.stack, /sensitive-signature-marker/); return true;
    });
    assert.equal(h.timers.size, 0);
    assert.ok(h.requests.every(req => req.destroyed)); assert.ok(h.responses.every(res => res.destroyed));
    assert.ok(h.hashed <= MAX);
  };
  for (const size of [1, MAX]) await test(`完整 ${size} 字节流`, async () => {
    const body = Buffer.alloc(size, 7), h = setup({}, body);
    const result = await h.read();
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { fileSizeBytes: size,
      contentSha1: crypto.createHash('sha1').update(body).digest('hex') });
    assert.equal(h.hashed, size); assert.equal(h.MAX_RECORDING_BYTES, MAX);
    assert.equal(h.timers.size, 0); assert.ok(h.requests[0].destroyed); assert.ok(h.responses[0].destroyed);
  });
  await test('9MiB 跨块超限：越界及迟到块不入 hash', async () => {
    const h = setup({ emitAfterDestroy: true, destroyError: true }, Buffer.alloc(9 * 1024 * 1024));
    await failure(h, 'LIMIT'); assert.equal(h.hashed, MAX);
    h.responses[0].emit('error', new Error(secret)); h.requests[0].emit('error', new Error(secret));
    h.responses[0].emit('end');
  });
  await test('单个越界块不入 hash', async () => {
    const h = setup({ chunks: [Buffer.alloc(MAX - 1), Buffer.alloc(2), Buffer.alloc(1)], emitAfterDestroy: true });
    await failure(h, 'LIMIT'); assert.equal(h.hashed, MAX - 1);
  });
  for (const headers of [{ 'content-length': String(MAX + 1) }, { 'content-length': String(9 * 1024 * 1024) }])
    await test('头超限立即停止，无 hash', async () => { const h = setup({ headers }); await failure(h, 'LIMIT'); assert.equal(h.hashed, 0); });
  for (const length of ['-1', '1.0', '1e0', ' 1', '9007199254740992', '1, 1', ['1'], '2', '0'])
    await test(`拒绝非法或不符长度 ${JSON.stringify(length)}`, async () => {
      await failure(setup({ headers: { 'content-length': length } }), 'UNAVAILABLE');
    });
  await test('一致长度正常，冲突重复头拒绝', async () => {
    assert.equal((await setup({ headers: { 'content-length': '1' } }).read()).fileSizeBytes, 1);
    await failure(setup({ headers: { 'content-length': '1' }, rawHeaders: ['Content-Length', '1', 'content-length', '2'] }), 'UNAVAILABLE');
  });
  for (const controls of [{ complete: false }, { earlyClose: true }, { abort: true }, { chunks: ['x'] },
    { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-encoding': 'br' } },
    { headers: { 'content-encoding': ['identity'] } }])
    await test(`不可信流 ${JSON.stringify(controls)}`, async () => { await failure(setup(controls), 'UNAVAILABLE'); });
  for (const status of [undefined, '200', 204, 206, 301, 302, 307, 403, 404, 500])
    await test(`HTTP ${status} 不证明缺失且不跟随`, async () => {
      const h = setup({ httpStatus: status, headers: { location: 'https://example.test/redirect' } });
      await failure(h, 'UNAVAILABLE'); assert.equal(h.metrics.downloads, 1); assert.equal(h.hashed, 0);
    });
  const malformed = [null, {}, { ...signing(), errMsg: undefined }, { ...signing(), fileList: [] },
    { ...signing(), fileList: [...signing().fileList, ...signing().fileList] }];
  for (const patch of [{ fileID: 'other' }, { status: undefined }, { status: '0' }, { errMsg: undefined },
    { errMsg: 'fail' }, { errCode: -503003 }, { code: 'STORAGE_FILE_NONEXIST' }, { errno: -1 },
    { errCode: 0, code: 'STORAGE_REQUEST_FAIL' }, { code: '0' }, { status: -503003 }])
    malformed.push({ ...signing(), fileList: [{ ...signing().fileList[0], ...patch }] });
  for (const patch of [{ errCode: -503003 }, { code: 'STORAGE_FILE_NONEXIST' }, { errno: -1 },
    { errCode: 0, code: 'STORAGE_REQUEST_FAIL' }, { code: '0' }]) malformed.push({ ...signing(), ...patch });
  for (const [i, signResult] of malformed.entries()) await test(`签名矛盾/畸形 ${i}`, async () => {
    const h = setup({ signResult }); await failure(h, 'UNAVAILABLE'); assert.equal(h.metrics.downloads || 0, 0);
  });
  for (const signThrow of [{ errCode: -503003 }, { code: 'STORAGE_FILE_NONEXIST' },
    { errCode: -503003, code: 'STORAGE_FILE_NONEXIST', errno: -503003 }])
    await test('同步纯 typed 缺失', async () => { await failure(setup({ signThrow }), 'MISSING'); });
  await test('异步缺失和 SDK 包装失败条目', async () => {
    await failure(setup({ sign: () => Promise.reject({ code: 'STORAGE_FILE_NONEXIST' }) }), 'MISSING');
    await failure(setup({ signResult: { ...signing(), fileList: [{ fileID, status: -503003,
      errMsg: 'storage file not exists', tempFileURL: '' }] } }), 'MISSING');
  });
  for (const signThrow of [{ errCode: -503003, code: 0 }, { errCode: -503003, errno: -503002 },
    { errCode: -503003, errMsg: 'getTempFileURL:ok' }, { code: 'STORAGE_FILE_NONEXIST', tempFileURL: 'https://example.test' },
    { errCode: -503003, status: 0 }, { message: 'storage file not exists' }, new Error(secret)])
    await test('缺失与成功/权限矛盾不失效', async () => { await failure(setup({ signThrow }), 'UNAVAILABLE'); });
  for (const url of ['http://example.test/x', 'https://user:pass@example.test/x', 'https://example.test:444/x',
    'https://example.test/x#fragment', 'garbage']) await test(`拒绝 URL ${url}`, async () => {
      const result = signing(); result.fileList[0].tempFileURL = url;
      const h = setup({ signResult: result }); await failure(h, 'UNAVAILABLE'); assert.equal(h.metrics.downloads || 0, 0);
    });
  for (const field of ['requestThrow', 'endThrow', 'hashCreateThrow', 'hashUpdateThrow', 'hashDigestThrow'])
    await test(`同步异常 ${field} 安全清理`, async () => { await failure(setup({ [field]: true, destroyError: true }), 'UNAVAILABLE'); });
  await test('URL 解析同步异常安全清理', async () => {
    await failure(setup({}, undefined, { urlModule: { URL: class { constructor() { throw new Error(secret); } } } }), 'UNAVAILABLE');
  });
  await test('入口 deadline 已过，不签名', async () => {
    const h = setup(); h.advance(101); await failure(h, 'TIMEOUT'); assert.equal(h.signed, 0);
  });
  for (const late of ['success', 'reject', 'never']) await test(`签名总时限 ${late}`, async () => {
    let resolveSign, rejectSign;
    const h = setup({ sign: () => new Promise((resolve, reject) => { resolveSign = resolve; rejectSign = reject; }) });
    const result = h.read().catch(error => error); await flush(); h.advance(100);
    assert.equal((await result).code, 'TIMEOUT');
    if (late === 'success') resolveSign(signing());
    if (late === 'reject') rejectSign(new Error(secret));
    await flush(); assert.equal(h.metrics.downloads || 0, 0); assert.equal(h.timers.size, 0);
  });
  await test('签名结束不依赖 timer 调度也检查绝对 deadline', async () => {
    const h = setup({ sign: () => { h.advance(101, false); return signing(); } }); await failure(h, 'TIMEOUT');
  });
  await test('持续滴流不会续预算；超时后 end/error 安全', async () => {
    const h = setup({ manual: true, destroyError: true }); const result = h.read().catch(error => error);
    await flush(); h.responses[0].emit('data', Buffer.from('x')); h.advance(50);
    h.responses[0].emit('data', Buffer.from('x')); h.advance(51, false);
    h.responses[0].emit('data', Buffer.alloc(100)); h.responses[0].emit('end');
    assert.equal((await result).code, 'TIMEOUT'); assert.equal(h.hashed, 2); assert.equal(h.timers.size, 0);
  });
  await test('网络停住及迟到 response 要销毁并接住 error', async () => {
    const h = setup({ noResponse: true, manual: true, destroyError: true }); const result = h.read().catch(error => error);
    await flush(); assert.equal(h.requests.length, 1); assert.equal(h.responses.length, 0);
    h.advance(100); h.requests[0].respond(); await flush();
    assert.equal((await result).code, 'TIMEOUT'); assert.equal(h.timers.size, 0);
    assert.equal(h.responses.length, 1);
    for (const res of h.responses) { assert.ok(res.destroyed); res.emit('error', new Error(secret)); }
  });
  for (const stage of ['request', 'response']) await test(`${stage} error 不传播原文/伪缺失`, async () => {
    const h = setup({ manual: true, destroyError: true }); const result = h.read().catch(error => error); await flush();
    (stage === 'request' ? h.requests[0] : h.responses[0]).emit('error', Object.assign(new Error(secret), { code: 'STORAGE_FILE_NONEXIST' }));
    assert.equal((await result).code, 'UNAVAILABLE'); assert.equal(h.timers.size, 0);
    assert.ok(h.requests[0].destroyed); assert.ok(h.responses[0].destroyed);
  });
  await test('无 response 超时；新调用状态独立', async () => {
    const h = setup({ noResponse: true }); const result = h.read().catch(error => error);
    await flush(); h.advance(100); assert.equal((await result).code, 'TIMEOUT'); assert.ok(h.requests[0].destroyed);
    h.controls.noResponse = false; assert.equal((await h.read(1300)).fileSizeBytes, 1);
  });
  await test('end 时绝对 deadline 仍有效', async () => {
    const h = setup({ manual: true }); const result = h.read().catch(error => error); await flush();
    h.responses[0].emit('data', Buffer.from('x')); h.advance(101, false); h.responses[0].emit('end');
    assert.equal((await result).code, 'TIMEOUT'); assert.equal(h.timers.size, 0);
  });
  console.log(`${count}/${count} bounded recording tests passed (fake HTTPS/clock; no real network)`);
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
