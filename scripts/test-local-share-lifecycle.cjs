/* eslint-disable import/no-commonjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
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
const counters = { upload: 0, cloudCall: 0, localRemove: 0 };
let sequence = 0;
let dropNextCommitResponse = false;
const collection = {
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
  getWXContext: () => ({ OPENID: 'student', ENV: 'test' }),
  downloadFile: async ({ fileID }) => {
    if (!cloudFiles.has(fileID)) throw Object.assign(new Error('missing file'), { code: 'FILE_NOT_FOUND' });
    return { fileContent: cloudFiles.get(fileID) };
  },
  getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(value => {
    const fileID = typeof value === 'string' ? value : value.fileID;
    return { fileID, status: 0, tempFileURL: `https://example.test/${encodeURIComponent(fileID)}` };
  }) }),
};
const serverModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'cloudfunctions/checkIn/index.js'), 'utf8'), {
  module: serverModule, exports: serverModule.exports, Buffer, URL, Date: TestDate,
  process: { env: { SHARE_STORAGE_FILE_ID_PREFIX: 'cloud://test.bucket/' } },
  console: { error() {}, warn() {}, log() {} },
  require: name => name === 'wx-server-sdk' ? serverSdk : require(name),
});
const wx = { cloud: {
  callFunction: async ({ data }) => {
    counters.cloudCall++;
    const result = await serverModule.exports.main(data);
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
  storage: { get: key => clone(metadata.get(key)), set: (key, data) => metadata.set(key, clone(data)) },
  file: {
    save: temp => { const savedFilePath = `/saved/${++sequence}.mp3`; localFiles.set(savedFilePath, localFiles.get(temp)); localFiles.delete(temp); return { savedFilePath }; },
    exists: file => localFiles.has(file),
    remove: file => { counters.localRemove++; localFiles.delete(file); },
  },
  clock: { now: () => now }, random: { hex: () => (++sequence).toString(16).padStart(32, '0') },
});
const createCoordinator = pendingStore => createCheckInSubmissionCoordinator({
  pendingStore, getRecordingInfo: service.getCheckInRecordingInfo,
  prepareCheckIn: service.prepareCheckIn, commitCheckIn: service.commitCheckIn,
  startPreparedCheckInUpload: service.startPreparedCheckInUpload,
  scheduler: { setTimeout, clearTimeout }, clock: { now: () => now },
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

  const appConfig = fs.readFileSync(path.join(root, 'src/app.config.ts'), 'utf8');
  assert.match(appConfig, /点击分享后才会上传云端/, '麦克风用途应与新上传手势一致');
  console.log('本地分享集成通过：完成零联网、重启恢复、真实服务协议、30天过期重传、丢回包幂等恢复、旧链接不复活、本地不删除。');
})().catch(error => { console.error(error); process.exitCode = 1; });
