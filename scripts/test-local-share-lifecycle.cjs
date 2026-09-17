/* eslint-disable import/no-commonjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { loadReader, signing } = require('./test-bounded-recording-download.cjs');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const clone = value => structuredClone(value);
const DAY = 86400000;
let now = Date.UTC(2026, 8, 11);
class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const metadata = new Map(), localFiles = new Map(), cloudFiles = new Map(), documents = new Map();
const counters = { upload: 0, cloudCall: 0, localRemove: 0, signed: 0 };
let sequence = 0;
let currentOpenId = 'student';
let dropNextCommitResponse = false;
let responseMode = '';
let failShareWrite = false;
let referenceQueryError = null;
let probeSignError = null;
let probeSignPatch;
const streamControls = {};
const diagnostics = [];
const diagnose = (stage, details) => diagnostics.push({ stage, ...details });
const collection = {
  where(condition) {
    let offset = 0, pageSize = 100, sortField = null, sortDirection = 'asc';
    return {
      orderBy(field, direction) { sortField = field; sortDirection = direction; return this; },
      skip(value) { offset = value; return this; },
      limit(value) { pageSize = value; return this; },
      async get() {
        if (condition.recordingFileId && referenceQueryError) throw referenceQueryError;
        const rows = [...documents.values()].filter(record =>
          Object.entries(condition).every(([field, value]) => record[field] === value));
        if (sortField) rows.sort((a, b) => String(a[sortField]).localeCompare(String(b[sortField])) * (sortDirection === 'desc' ? -1 : 1));
        return { data: clone(rows.slice(offset, offset + pageSize)) };
      },
    };
  },
  doc(id) { return {
    get: async () => ({ data: clone(documents.get(id) || null) }),
    set: async ({ data }) => { documents.set(id, clone({ ...data, _id: id })); },
    update: async ({ data }) => { documents.set(id, clone({ ...documents.get(id), ...data })); },
  }; },
};
const database = {
  collection: () => collection,
  serverDate: ({ offset = 0 } = {}) => new Date(now + offset),
  runTransaction: async operation => operation({ collection: () => collection }),
};
const serverSdk = {
  DYNAMIC_CURRENT_ENV: 'dynamic', init() {}, database: () => database,
  getWXContext: () => ({ OPENID: currentOpenId, ENV: 'test' }),
  downloadFile: async () => { throw new Error('禁止整文件 SDK 下载'); },
  deleteFile: async ({ fileList }) => ({ fileList: fileList.map(fileID => {
    cloudFiles.delete(fileID);
    return { fileID, status: 0 };
  }) }),
  getTempFileURL: async ({ fileList }) => {
    counters.signed++;
    if (probeSignError) throw probeSignError;
    const value = fileList[0];
    const fileID = typeof value === 'string' ? value : value.fileID;
    if (!cloudFiles.has(fileID)) throw { errCode: -503003 };
    return { ...signing(fileID), ...probeSignPatch };
  },
};
const reader = loadReader({ files: cloudFiles, controls: streamControls, metrics: counters, clock: { now: () => now } });
const serverModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'cloudfunctions/checkIn/index.js'), 'utf8'), {
  module: serverModule, exports: serverModule.exports, Buffer, URL, Date: TestDate,
  process: { env: { SHARE_STORAGE_FILE_ID_PREFIX: 'cloud://test.bucket/' } },
  console: { error() {}, warn() {}, log() {} },
  require: name => name === 'wx-server-sdk' ? serverSdk : name === './recordingDownload' ? reader : require(name),
});
const wx = { cloud: {
  callFunction: async ({ data }) => {
    counters.cloudCall++;
    const result = await serverModule.exports.main(responseMode === 'legacy' ? { ...data, shareVersion: 1 } : data);
    if (responseMode === 'missing-expiry' && result.ok) delete result.data.expiresAtMs;
    // 模拟服务器已经提交成功，但客户端断网未收到回包。
    if (data.action === 'commit' && result.ok && dropNextCommitResponse) {
      dropNextCommitResponse = false;
      throw Object.assign(new Error('network response lost'), { code: 'NETWORK_ERROR' });
    }
    return { result };
  },
  uploadFile({ cloudPath, filePath, success }) {
    const fileID = `cloud://test.bucket/${cloudPath}`;
    counters.upload++;
    cloudFiles.set(fileID, Buffer.from(localFiles.get(filePath)));
    queueMicrotask(() => success({ fileID }));
    return { abort() {}, onProgressUpdate() {} };
  },
}, getFileInfo({ filePath, success, fail }) {
  const content = localFiles.get(filePath);
  if (!content) return fail({ code: 'ENOENT' });
  success({ size: content.length, digest: crypto.createHash('sha1').update(content).digest('hex') });
} };
const load = relative => {
  const mod = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(source, { module: mod, exports: mod.exports, wx, Date: TestDate, console, setTimeout, clearTimeout,
    require: name => load(path.relative(root, path.resolve(root, path.dirname(relative), `${name}.ts`))),
  });
  return mod.exports;
};
const { createPendingCheckInStore } = load('src/features/listeningPractice/pendingCheckInStore.ts');
const { createCheckInSubmissionCoordinator } = load('src/features/listeningPractice/checkInSubmissionCoordinator.ts');
const service = load('src/services/cloudCheckIn.ts');
const createStore = () => createPendingCheckInStore({
  storage: { get: key => clone(metadata.get(key)), set: (key, data) => {
    if (failShareWrite && data.some(item => item.share && !metadata.get(key)?.find(old => old.requestId === item.requestId)?.share)) {
      throw Object.assign(new Error('setStorageSync:fail quota exceeded'), { code: 'STORAGE_FULL' });
    }
    metadata.set(key, clone(data));
  } },
  file: {
    usageBytes: () => [...localFiles].filter(([file]) => file.startsWith('/saved/'))
      .reduce((total, [, content]) => total + content.length, 0),
    save: temp => { const savedFilePath = `/saved/${++sequence}.mp3`; localFiles.set(savedFilePath, localFiles.get(temp)); localFiles.delete(temp); return { savedFilePath }; },
    exists: file => localFiles.has(file),
    remove: file => { counters.localRemove++; localFiles.delete(file); },
  },
  clock: { now: () => now }, random: { hex: () => (++sequence).toString(16).padStart(32, '0') },
  diagnose,
});
const createCoordinator = pendingStore => createCheckInSubmissionCoordinator({
  pendingStore, getRecordingInfo: service.getCheckInRecordingInfo,
  prepareCheckIn: service.prepareCheckIn, commitCheckIn: service.commitCheckIn,
  startPreparedCheckInUpload: service.startPreparedCheckInUpload,
  scheduler: { setTimeout, clearTimeout }, clock: { now: () => now },
  diagnose,
});

(async () => {
  let store = createStore();
  localFiles.set('/temp/first.mp3', Buffer.from('fixture recording bytes, not microphone validation'));
  const saved = await store.saveRecording({ tempFilePath: '/temp/first.mp3', durationMs: 3000,
    fileSizeBytes: localFiles.get('/temp/first.mp3').length,
    context: { bookId: '3', bookTitle: 'CASA', practiceId: '3-page-4', practiceIndex: 0,
      pageNumber: 4, imageUrl: 'https://example.test/page4.png', sectionTitle: 'Unit 1' },
  });
  assert.equal(await store.complete(saved.item.requestId, true), true);
  assert.equal(localFiles.has(saved.item.localPath), true, '完成练习必须保留本地文件');
  assert.equal(counters.cloudCall, 0, '保存和完成练习不能调用云端');
  store = createStore();
  await store.ready();
  await store.cleanup();
  assert.equal(store.list().length, 1, '重启后仍能恢复完成的本地录音');
  assert.equal(counters.cloudCall, 0);

  let coordinator = createCoordinator(store);
  const pending = await store.beginShare(saved.item.requestId);
  assert.notEqual(pending.shareRequestId, pending.requestId, '本地编号和云分享代次分离');
  const first = await coordinator.submit(pending).promise;
  assert.equal(first.state, 'committed', JSON.stringify(first));
  assert.equal(first.expiresAtMs, now + 30 * DAY, '有效期必须来自服务器首次确认');
  assert.equal(counters.upload, 1);
  assert.equal(localFiles.has(saved.item.localPath), true, '上传成功后仍保留本地录音');
  assert.equal(store.list()[0].share.id, first.id);
  const firstRequest = pending.shareRequestId;
  currentOpenId = 'friend';
  const friendDetail = await service.getCheckInDetail(first.id, first.shareToken);
  assert.equal(friendDetail.isOwner, false, '另一账号持有本条分享口令才可获取播放地址');
  assert.ok(friendDetail.recordingUrl);
  await assert.rejects(service.getCheckInDetail(first.id, 'wrong-token'));
  await assert.rejects(service.getCheckInDetail(first.id));
  currentOpenId = 'student';

  // 真实客户端到真实云函数：跨 owner 旧引用和核验查询错误均不能签名，也不清除任何引用/文件。
  const firstDocument = documents.get(first.id);
  documents.set('legacy-alias', { _id: 'legacy-alias', _openid: 'another-student',
    recordingFileId: firstDocument.recordingFileId, shareToken: 'legacy-alias-token' });
  const conflictDocuments = clone([...documents]), conflictFiles = clone([...cloudFiles]);
  const signedBefore = counters.signed;
  await assert.rejects(service.getCheckInDetail(first.id), error => error.code === 'FILE_REFERENCE_CONFLICT');
  currentOpenId = 'friend';
  await assert.rejects(service.getCheckInDetail(first.id, first.shareToken), error => error.code === 'FILE_REFERENCE_CONFLICT');
  currentOpenId = 'student';
  assert.equal(counters.signed, signedBefore);
  assert.deepEqual([...documents], conflictDocuments); assert.deepEqual(clone([...cloudFiles]), conflictFiles);
  // 只撤回测试注入的别名，继续原有生命周期验证；不调用生产删除逻辑处理冲突。
  documents.delete('legacy-alias');
  referenceQueryError = Object.assign(new Error('reference query timeout'), { code: 'ETIMEDOUT' });
  await assert.rejects(service.getCheckInDetail(first.id), error => error.code === 'ETIMEDOUT');
  referenceQueryError = null;
  assert.equal(counters.signed, signedBefore);
  assert.deepEqual(documents.get(first.id), firstDocument);
  assert.equal(cloudFiles.has(firstDocument.recordingFileId), true);

  now += 29 * DAY;
  store = createStore(); await store.ready(); coordinator = createCoordinator(store);
  const same = await store.beginShare(saved.item.requestId);
  assert.equal(same.shareRequestId, firstRequest);
  const reused = await coordinator.submit(same).promise;
  assert.equal(reused.state, 'committed');
  assert.equal(reused.id, first.id);
  assert.equal(reused.expiresAtMs, first.expiresAtMs, '重复分享不自动延长有效期');
  assert.equal(counters.upload, 1, '有效期内不重复上传');

  now += 2 * DAY;
  await assert.rejects(service.getCheckInDetail(first.id, first.shareToken), error => error.code === 'SHARE_EXPIRED');
  const fresh = await store.beginShare(saved.item.requestId);
  assert.notEqual(fresh.shareRequestId, firstRequest);
  const second = await coordinator.submit(fresh).promise;
  assert.equal(second.state, 'committed', JSON.stringify(second));
  assert.notEqual(second.id, first.id);
  assert.equal(second.expiresAtMs, now + 30 * DAY);
  assert.equal(counters.upload, 2);
  assert.equal(counters.localRemove, 0);
  assert.equal(store.list().length, 1, '再分享不能生成第二条本地录音');
  await assert.rejects(service.getCheckInDetail(first.id, first.shareToken), error => error.code === 'SHARE_EXPIRED');
  assert.equal((await service.getCheckInDetail(second.id, second.shareToken)).id, second.id);

  localFiles.set('/temp/uncertain.mp3', Buffer.from('another local recording'));
  const uncertain = await store.saveRecording({ tempFilePath: '/temp/uncertain.mp3', durationMs: 4000,
    fileSizeBytes: localFiles.get('/temp/uncertain.mp3').length, context: saved.item.context,
  });
  assert.equal(await store.complete(uncertain.item.requestId, true), true);
  const uncertainShare = await store.beginShare(uncertain.item.requestId);
  dropNextCommitResponse = true;
  assert.equal((await coordinator.submit(uncertainShare).promise).state, 'failed');
  assert.equal(counters.upload, 3);
  const expectedExpiry = now + 30 * DAY;
  now += DAY;
  store = createStore(); await store.ready(); coordinator = createCoordinator(store);
  const retry = await store.beginShare(uncertain.item.requestId);
  assert.equal(retry.shareRequestId, uncertainShare.shareRequestId);
  const recovered = await coordinator.submit(retry).promise;
  assert.equal(recovered.state, 'committed', JSON.stringify(recovered));
  assert.equal(recovered.expiresAtMs, expectedExpiry, '丢回包重试不能延长服务端首次提交期限');
  assert.equal(counters.upload, 3, '丢回包重启重试应从真实服务端找回结果，不重传');
  assert.equal(localFiles.has(uncertain.item.localPath), true);
  assert.equal(counters.localRemove, 0);

  // 真实客户端、协调器、仓储和服务端一起覆盖旧版响应与本地写失败，不能只用宽松的 markShared 假实现。
  for (const mode of ['legacy', 'missing-expiry', 'storage-failure']) {
    localFiles.set('/temp/retry.mp3', Buffer.from(`recording ${mode}`));
    const record = await store.saveRecording({ tempFilePath: '/temp/retry.mp3', durationMs: 2000,
      fileSizeBytes: localFiles.get('/temp/retry.mp3').length, context: saved.item.context });
    await store.complete(record.item.requestId, true);
    const snapshot = await store.beginShare(record.item.requestId);
    const uploadedBefore = counters.upload;
    responseMode = mode === 'storage-failure' ? '' : mode;
    failShareWrite = mode === 'storage-failure';
    diagnostics.length = 0;
    const failed = await coordinator.submit(snapshot).promise;
    if (mode === 'storage-failure') {
      assert.equal(failed.state, 'committed');
      assert.equal(failed.cleanupPending, true);
      assert.ok(diagnostics.some(log => log.stage === 'share.metadata.write.failed' && log.error.code === 'STORAGE_FULL'));
    } else {
      assert.equal(failed.state, 'failed', `${mode} 不应误报云端已生成但本地保存失败`);
      assert.equal(failed.error.code, 'SHARE_PROTOCOL_MISMATCH');
      assert.ok(diagnostics.some(log => log.stage === `share.${mode === 'legacy' ? 'preparing' : 'committing'}.failed` && log.error.code === 'SHARE_PROTOCOL_MISMATCH'));
    }
    assert.equal(counters.upload - uploadedBefore, mode === 'legacy' ? 0 : 1);
    assert.equal(store.list().find(item => item.requestId === record.item.requestId).share, undefined);
    responseMode = ''; failShareWrite = false;
    store = createStore(); await store.ready(); coordinator = createCoordinator(store);
    const retrySnapshot = await store.beginShare(record.item.requestId);
    assert.equal(retrySnapshot.shareRequestId, snapshot.shareRequestId, '失败不能偷偷换代');
    const success = await coordinator.submit(retrySnapshot).promise;
    assert.equal(success.state, 'committed'); assert.equal(success.cleanupPending, false);
    assert.equal(counters.upload - uploadedBefore, 1, '重启恢复只补写分享状态，不能重复上传');
    assert.equal(localFiles.has(record.item.localPath), true);
    assert.equal(counters.localRemove, 0);
    const detail = await service.getCheckInDetail(success.id, success.shareToken);
    assert.ok(detail.recordingUrl);
  }

  // 用户主动检查 → 持久化失效当前代 → 再次主动分享。使用真实服务/仓储/协调器/云函数。
  for (const broken of ['deleted', 'missing', 'invalid']) {
    const localId = saved.item.requestId;
    let current = store.list().find(item => item.requestId === localId);
    const oldShare = current.share, oldGeneration = current.shareRequestId;
    const uploadsBefore = counters.upload;
    const unchanged = clone(current);
    for (const malformed of [{ errMsg: undefined }, { errCode: -503002 }, { errCode: 0, code: 'STORAGE_REQUEST_FAIL' }]) {
      probeSignPatch = malformed;
      await assert.rejects(service.getCheckInShareStatus(oldShare.id, oldGeneration), error => error.code === 'SHARE_STATUS_UNAVAILABLE');
      assert.deepEqual(clone(store.list().find(item => item.requestId === localId)), unchanged);
      assert.equal(counters.upload, uploadsBefore);
      assert.equal(localFiles.has(current.localPath), true);
    }
    probeSignPatch = undefined;
    for (const patch of [{ httpStatus: 404 }, { complete: false }, { chunks: [Buffer.alloc(9 * 1024 * 1024)] }]) {
      Object.assign(streamControls, patch);
      await assert.rejects(service.getCheckInShareStatus(oldShare.id, oldGeneration), error => error.code === 'SHARE_STATUS_UNAVAILABLE');
      assert.deepEqual(clone(store.list().find(item => item.requestId === localId)), unchanged);
      assert.equal(counters.upload, uploadsBefore); assert.equal(localFiles.has(current.localPath), true);
      for (const key of Object.keys(patch)) delete streamControls[key];
    }
    probeSignError = { code: 'ETIMEDOUT', message: 'https://secret?token=private' };
    await assert.rejects(service.getCheckInShareStatus(oldShare.id, oldGeneration), error => error.code === 'SHARE_STATUS_UNAVAILABLE');
    probeSignError = null;
    assert.deepEqual(clone(store.list().find(item => item.requestId === localId)), unchanged);
    assert.equal(counters.upload, uploadsBefore);
    assert.equal((await service.getCheckInShareStatus(oldShare.id, oldGeneration)).state, 'active');
    if (broken === 'deleted') await service.removeCheckIn(oldShare.id);
    else if (broken === 'missing') cloudFiles.delete(documents.get(oldShare.id).recordingFileId);
    else cloudFiles.set(documents.get(oldShare.id).recordingFileId, Buffer.from('corrupted audio'));
    assert.equal((await service.getCheckInShareStatus(oldShare.id, oldGeneration)).state, broken);
    assert.equal(await store.markShareExpired(localId, oldGeneration), true);
    assert.equal(counters.upload, uploadsBefore, '核验失效不得自动重传');
    assert.ok(documents.has(oldShare.id), '恢复分享必须保留防重记录');
    store = createStore(); await store.ready(); coordinator = createCoordinator(store);
    current = store.list().find(item => item.requestId === localId);
    assert.equal(current.share, undefined); assert.equal(localFiles.has(current.localPath), true);
    const next = await store.beginShare(localId);
    assert.notEqual(next.shareRequestId, oldGeneration);
    const restored = await coordinator.submit(next).promise;
    assert.equal(restored.state, 'committed'); assert.notEqual(restored.id, oldShare.id);
    assert.equal(counters.upload, uploadsBefore + 1);
    assert.equal(await store.markShareExpired(localId, oldGeneration), false, '旧代迟到核验不能清除新分享');
    assert.equal(store.list().find(item => item.requestId === localId).share.id, restored.id);
    assert.equal(counters.localRemove, 0);
  }

  const appConfig = fs.readFileSync(path.join(root, 'src/app.config.ts'), 'utf8');
  assert.ok(counters.downloads > 0, '真实 helper 必须确实执行 HTTPS 流');
  assert.equal(reader.timers.size, 0);
  assert.match(appConfig, /点击分享后才会上传云端/, '麦克风用途应与新上传手势一致');
  console.log('本地分享集成通过：完成零联网、重启恢复、好友口令鉴权、30天过期重传、丢回包/本地回写失败幂等恢复、旧协议拦截、脱敏日志接线、本地不删除。');
})().catch(error => { console.error(error); process.exitCode = 1; });
