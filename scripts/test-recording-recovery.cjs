/* eslint-disable import/no-commonjs */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const id = 'a'.repeat(32), sha = 'b'.repeat(40);
const original = () => ({ requestId: id, localPath: 'wxfile://old-private.mp3', recoverable: true,
  context: { bookId: '22', bookTitle: '教材', practiceId: 'p', practiceIndex: 0, pageNumber: 8, imageUrl: 'cover', sectionTitle: '第一课' },
  durationMs: 3000, fileSizeBytes: 999, cloudFileId: '', status: 'local', updatedAtMs: 1,
  shareRequestId: 'c'.repeat(32), share: { id: 'owner-share', shareToken: 'secret-token', expiresAtMs: Date.now() + 60000 } });
const settle = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
function setup(options = {}) {
  const initial = options.item === null ? [] : [options.item || original()];
  const storage = new Map([['pending-check-ins-v1', initial]]);
  const files = new Map([[original().localPath, { size: 100, digest: sha }]]);
  const logs = [], calls = [], removed = [], savedPaths = [], timers = new Map();
  let timerId = 0, download, progress, aborted = 0, writes = 0;
  const control = { failIndex: false, failInfo: false, failSavedInfo: false, usage: options.usage || 0, nowOffset: 0 };
  const wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync(key, value) { writes++; if (control.failIndex && key === 'pending-check-ins-v1') throw new Error('storage full private'); storage.set(key, JSON.parse(JSON.stringify(value))); },
    cloud: { async callFunction({ data }) { calls.push(data); if (options.offline) throw new Error('network offline'); if (options.denied) return { result: { ok: false, code: 'NOT_OWNER' } }; return { result: { ok: true, data: options.source || { id: 'owner-share', recordingUrl: 'https://private.example/audio?token=secret', fileSizeBytes: 100, contentSha1: sha } } }; } },
    downloadFile(opts) { download = opts; return { abort() { aborted++; }, onProgressUpdate(callback) { progress = callback; } }; },
    saveFile({ tempFilePath, success, fail }) { if (!files.has(tempFilePath)) return fail({ code: 'ENOENT' }); const savedFilePath = `wxfile://recovered-${savedPaths.length}.mp3`; savedPaths.push(tempFilePath); files.set(savedFilePath, files.get(tempFilePath)); files.delete(tempFilePath); success({ savedFilePath }); },
    getFileInfo({ filePath, success, fail }) { const info = files.get(filePath); if (control.failInfo || (control.failSavedInfo && filePath.includes('recovered')) || !info) fail({ errCode: 1300002, errMsg: 'private path ENOENT' }); else success(info); },
    getFileSystemManager() { return {
      access({ path: p, success, fail }) { files.has(p) ? success({}) : fail({ errCode: 1300002 }); },
      getSavedFileList({ success }) { success({ fileList: [{ filePath: 'wxfile://unindexed', size: control.usage }] }); },
      unlink({ filePath, success }) { removed.push(filePath); files.delete(filePath); success({}); },
    }; },
    removeSavedFile({ filePath, success }) { removed.push(filePath); files.delete(filePath); success({}); },
    getDeviceInfo: () => ({ platform: 'ios' }),
    getAppBaseInfo: () => ({ version: '8.0.60', SDKVersion: '3.9.0' }),
    getAccountInfoSync: () => ({ miniProgram: { version: '2.4.1', envVersion: 'release' } }),
  };
  const cache = new Map();
  function load(file) {
    file = path.resolve(root, file);
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} }; cache.set(file, module.exports);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    vm.runInNewContext((options.oldJs ? 'Object.fromEntries = undefined; Array.prototype.flatMap = undefined;\n' : '') + code, { module, exports: module.exports, wx, console: { info: (...v) => logs.push(v), warn: (...v) => logs.push(v) },
      Date: class extends Date { static now() { return Date.now() + control.nowOffset; } },
      setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; }, clearTimeout: key => timers.delete(key),
      require: request => load(path.resolve(path.dirname(file), `${request}.ts`)),
    });
    return module.exports;
  }
  const runtime = load('src/features/listeningPractice/pendingCheckInRuntime.ts');
  return { runtime, wx, storage, files, logs, calls, removed, savedPaths, timers, control, get downloaded() { return Boolean(download); }, get writes() { return writes; }, get aborted() { return aborted; },
    complete(info = { size: 100, digest: sha }, statusCode = 200, tempFilePath = 'wxfile://download-private.mp3') { assert.ok(download, 'explicit recovery must create a download'); files.set(tempFilePath, info); download.success({ tempFilePath, statusCode }); },
    progress(bytes) { progress({ totalBytesWritten: bytes, totalBytesExpectedToWrite: bytes }); },
    reload: () => { cache.clear(); return load('src/features/listeningPractice/pendingCheckInRuntime.ts'); },
  };
}
test('explicit recovery uses actual native bytes, exact saved path, same ID and offline reload', async () => {
  const h = setup(), store = h.runtime.getPendingCheckInStore(); await store.ready(); await store.cleanup();
  assert.equal(h.calls.length, 0);
  assert.equal(typeof h.runtime.recoverPendingRecording, 'function', 'explicit recovery runtime entry is required');
  const p = h.runtime.recoverPendingRecording(id);
  assert.strictEqual(h.runtime.recoverPendingRecording(id), p, 'double click adopts active recovery');
  await settle(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].action, 'recoverySource'); assert.equal(h.calls[0].id, 'owner-share');
  h.complete(); const item = await p;
  assert.equal(item.localPath, 'wxfile://recovered-0.mp3'); assert.equal(item.requestId, id); assert.equal(item.fileSizeBytes, 100); assert.equal(item.contentSha1, sha);
  assert.ok(h.files.has(original().localPath)); assert.equal(h.removed.includes(original().localPath), false);
  const restarted = h.reload().getPendingCheckInStore(); await restarted.ready(); assert.equal(restarted.list()[0].localPath, item.localPath); assert.equal(h.calls.length, 1);
});
for (const scenario of ['offline', 'denied', 'missing', 'no-share', 'wrong-id', 'wrong-sha', 'wrong-size', 'oversize', 'http']) {
  test(`failure ${scenario} keeps old reference and never uploads`, async () => {
    const options = { offline: scenario === 'offline', denied: scenario === 'denied' };
    if (scenario === 'missing') options.item = null;
    if (scenario === 'no-share') options.item = { ...original(), share: undefined };
    if (scenario === 'wrong-id') options.source = { id: 'someone-else', recordingUrl: 'https://private.example/audio' };
    if (scenario === 'quota') options.usage = 90 * 1024 * 1024;
    const h = setup(options); assert.equal(typeof h.runtime.recoverPendingRecording, 'function');
    const p = h.runtime.recoverPendingRecording(id); const rejected = assert.rejects(p); await settle();
    if (['wrong-sha', 'wrong-size', 'oversize', 'http', 'quota'].includes(scenario)) h.complete({ size: scenario === 'oversize' ? 9 * 1024 * 1024 : scenario === 'wrong-size' ? 101 : 100, digest: scenario === 'wrong-sha' ? 'd'.repeat(40) : sha }, scenario === 'http' ? 500 : 200);
    await rejected;
    assert.equal(h.savedPaths.length, 0); assert.ok(h.files.has(original().localPath));
    assert.equal(h.runtime.getPendingCheckInStore().list()[0]?.localPath, scenario === 'missing' ? undefined : original().localPath);
    assert.ok(h.calls.every(call => call.action === 'recoverySource'));
  });
}
test('index failure retries saved path without downloading or saving another copy', async () => {
  const h = setup(); assert.equal(typeof h.runtime.recoverPendingRecording, 'function');
  h.control.failIndex = true; const p = h.runtime.recoverPendingRecording(id); const rejected = assert.rejects(p); await settle(); h.complete(); await rejected;
  assert.equal(h.runtime.getPendingCheckInStore().list()[0].localPath, original().localPath);
  h.control.failIndex = false; const item = await h.runtime.recoverPendingRecording(id);
  assert.equal(item.localPath, 'wxfile://recovered-0.mp3'); assert.equal(h.savedPaths.length, 1); assert.equal(h.calls.length, 1);
});
test('insufficient actual local capacity rejects before download, including legacy source without size', async () => {
  for (const legacy of [false, true]) {
    const h = setup({ usage: 90 * 1024 * 1024, ...(legacy ? { source: { id: 'owner-share', recordingUrl: 'https://private.example/audio' } } : {}) });
    const p = h.runtime.recoverPendingRecording(id); const rejected = assert.rejects(p); await settle();
    assert.equal(h.downloaded, false, '空间不足不启动下载'); await rejected;
    assert.equal(h.savedPaths.length, 0);
  }
});
for (const change of ['deleted', 'replaced', 'reshared']) test(`late recovery after ${change} cannot resurrect snapshot`, async () => {
  const h = setup(); assert.equal(typeof h.runtime.recoverPendingRecording, 'function');
  const p = h.runtime.recoverPendingRecording(id), rejected = assert.rejects(p); await settle();
  const store = h.runtime.getPendingCheckInStore();
  if (change === 'deleted') await store.remove(id);
  if (change === 'replaced') await store.update(id, { contentSha1: 'e'.repeat(40) });
  if (change === 'reshared') await store.markShared(id, { ...original().share, id: 'new-share' }, original().shareRequestId);
  h.complete(); await rejected; assert.equal(h.savedPaths.length, 0);
  if (change === 'deleted') assert.equal(store.list().length, 0); else assert.equal(store.list()[0].localPath, original().localPath);
});
for (const reason of ['timeout', 'progress']) test(`${reason} aborts download and cleans late temporary callback`, async () => {
  const h = setup(); assert.equal(typeof h.runtime.recoverPendingRecording, 'function');
  const p = h.runtime.recoverPendingRecording(id), rejected = assert.rejects(p); await settle();
  if (reason === 'timeout') { const timer = [...h.timers.values()].find(t => t.delay === 30000); assert.ok(timer); timer.callback(); }
  else h.progress(8 * 1024 * 1024 + 1);
  await rejected; assert.equal(h.aborted, 1); h.complete(); await settle();
  assert.ok(h.removed.includes('wxfile://download-private.mp3')); assert.equal(h.savedPaths.length, 0);
});
test('local diagnostic is read-only, redacted, reports measured match and actual versions', async () => {
  const h = setup(); assert.equal(typeof h.runtime.diagnoseLocalRecordingFailure, 'function');
  await h.runtime.diagnoseLocalRecordingFailure({ ...original(), contentSha1: sha }, { errCode: 10003, errMsg: 'wxfile://private OPENID secret-token https://private' });
  assert.equal(h.writes, 0); assert.equal(h.calls.length, 0); assert.equal(h.removed.length, 0);
  const text = JSON.stringify(h.logs); assert.doesNotMatch(text, /wxfile:|https:|secret-token|OPENID|bbbbbbbbbbbb/);
  assert.match(text, /playback.local.failed/); assert.match(text, /fileSizeBytes/); assert.match(text, /fingerprintMatches/); assert.match(text, /8.0.60/);
  h.files.clear(); await h.runtime.diagnoseLocalRecordingFailure(original(), { errCode: 10003 });
  assert.match(JSON.stringify(h.logs), /playback.local.access.failed/); assert.equal(h.writes, 0);
});
test('saved-file verification failures retry existing saved file with no additional download or save', async () => {
  const h = setup(); h.control.failSavedInfo = true;
  const p = h.runtime.recoverPendingRecording(id), rejected = assert.rejects(p); await settle(); h.complete(); await rejected;
  await assert.rejects(h.runtime.recoverPendingRecording(id));
  assert.equal(h.savedPaths.length, 1); assert.equal(h.calls.length, 1);
  assert.equal(h.runtime.getPendingCheckInStore().list()[0].localPath, original().localPath);
  h.control.failSavedInfo = false;
  assert.equal((await h.runtime.recoverPendingRecording(id)).localPath, 'wxfile://recovered-0.mp3');
  assert.equal(h.savedPaths.length, 1);
});
test('known old SHA cannot be replaced with a different authorized share body', async () => {
  const h = setup({ item: { ...original(), fileSizeBytes: 100, contentSha1: 'e'.repeat(40) } });
  const p = h.runtime.recoverPendingRecording(id), rejected = assert.rejects(p); await settle(); h.complete(); await rejected;
  assert.equal(h.savedPaths.length, 0); assert.equal(h.runtime.getPendingCheckInStore().list()[0].contentSha1, 'e'.repeat(40));
});
test('known old SHA with contradictory old size is rejected before save and only discards the download', async () => {
  const old = { ...original(), contentSha1: sha };
  const h = setup({ item: old });
  const writesBefore = h.writes;
  const p = h.runtime.recoverPendingRecording(id), rejected = assert.rejects(p, { code: 'RECOVERY_VERIFY_FAILED' });
  await settle(); h.complete(); await rejected;
  assert.equal(h.savedPaths.length, 0); assert.equal(h.writes, writesBefore);
  assert.equal(JSON.stringify(h.runtime.getPendingCheckInStore().list()[0]), JSON.stringify(old));
  assert.deepEqual(h.removed, ['wxfile://download-private.mp3']);
});
test('direct restore rejects contradictory old size when old SHA matches', async () => {
  const old = { ...original(), contentSha1: sha };
  const h = setup({ item: old }), store = h.runtime.getPendingCheckInStore();
  await store.ready();
  h.files.set('wxfile://direct-download.mp3', { size: 100, digest: sha });
  const writesBefore = h.writes;
  await assert.rejects(store.restoreRecording(store.list()[0], 'wxfile://direct-download.mp3', { fileSizeBytes: 100, contentSha1: sha }), { code: 'RECOVERY_VERIFY_FAILED' });
  assert.equal(h.savedPaths.length, 0); assert.equal(h.writes, writesBefore);
  assert.equal(JSON.stringify(store.list()[0]), JSON.stringify(old));
});
test('known old SHA and matching old size can recover', async () => {
  const h = setup({ item: { ...original(), fileSizeBytes: 100, contentSha1: sha } });
  const p = h.runtime.recoverPendingRecording(id); await settle(); h.complete();
  assert.equal((await p).localPath, 'wxfile://recovered-0.mp3');
});
test('capacity is rechecked after download when another operation consumes space', async () => {
  const h = setup(); const p = h.runtime.recoverPendingRecording(id), rejected = assert.rejects(p); await settle();
  h.control.usage = 90 * 1024 * 1024; h.complete(); await rejected;
  assert.equal(h.savedPaths.length, 0); assert.ok(h.files.has(original().localPath));
});
test('v2 source deadline bounds native timeout; expired source never downloads', async () => {
  for (const expired of [true, false]) {
    const h = setup({ source: { id: 'owner-share', recordingUrl: 'https://private.example/audio', expiresAtMs: Date.now() + (expired ? -1000 : 5000), fileSizeBytes: 100, contentSha1: sha } });
    const p = h.runtime.recoverPendingRecording(id), rejected = assert.rejects(p); await settle();
    if (expired) assert.equal(h.downloaded, false);
    else { const timer = [...h.timers.values()][0]; assert.ok(timer.delay > 0 && timer.delay <= 5000); timer.callback(); }
    await rejected; assert.equal(h.savedPaths.length, 0);
  }
});
test('legacy without source size/hash accepts actual bytes up to exactly 8MiB, never old onStop size', async () => {
  const h = setup({ source: { id: 'owner-share', recordingUrl: 'https://private.example/audio' } });
  const p = h.runtime.recoverPendingRecording(id); await settle(); h.complete({ size: 8 * 1024 * 1024, digest: sha });
  assert.equal((await p).fileSizeBytes, 8 * 1024 * 1024);
});
test('missing or failing optional version APIs omit unknown values and diagnostic failure never writes', async () => {
  const h = setup(); delete h.wx.getDeviceInfo; h.wx.getAppBaseInfo = () => { throw new Error('private'); }; delete h.wx.getAccountInfoSync;
  h.control.failInfo = true; await h.runtime.diagnoseLocalRecordingFailure(original(), { errCode: 10003 });
  const text = JSON.stringify(h.logs); assert.doesNotMatch(text, /platform|wechatVersion|sdkVersion|appVersion|fingerprintMatches|private/);
  assert.match(text, /playback.local.info.failed/); assert.equal(h.writes, 0); assert.equal(h.calls.length, 0);
});
test('diagnostics work without ES2019 Object.fromEntries or Array.flatMap', async () => {
  const h = setup({ oldJs: true }); await h.runtime.diagnoseLocalRecordingFailure(original(), { errCode: 10003 });
  assert.match(JSON.stringify(h.logs), /playback.local.failed/); assert.match(JSON.stringify(h.logs), /8.0.60/);
});
test('diagnostic error codes cannot carry raw tokens, owner identifiers or a SHA', () => {
  const h = setup();
  for (const code of ['secret-token', 'OPENID_PRIVATE', sha]) h.runtime.logRecordingDiagnostic('playback.local.failed', { error: { code } });
  assert.doesNotMatch(JSON.stringify(h.logs), /secret-token|OPENID_PRIVATE|bbbbbbbbbbbb/);
});
test('unknown and duplicate metadata emits only a fixed quarantine stage without writes', async () => {
  const h = setup(); h.storage.set('pending-check-ins-v1', [original(), original(), { private: 'raw-secret' }]);
  await h.runtime.getPendingCheckInStore().ready();
  assert.equal(h.runtime.getPendingCheckInStore().list().length, 0); assert.match(JSON.stringify(h.logs), /metadata.entries.quarantined/);
  assert.doesNotMatch(JSON.stringify(h.logs), /raw-secret|secret-token|wxfile:/); assert.equal(h.writes, 0);
});
test('late download success cannot bypass absolute 30s limit when timeout callback is delayed', async () => {
  const h = setup(); const p = h.runtime.recoverPendingRecording(id); await settle();
  h.control.nowOffset = 31000;
  const rejected = assert.rejects(p); h.complete(); await rejected;
  assert.equal(h.savedPaths.length, 0); assert.ok(h.removed.includes('wxfile://download-private.mp3'));
});
