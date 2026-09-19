const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const moduleContainer = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/features/listeningPractice/pendingCheckInStore.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module: moduleContainer, exports: moduleContainer.exports });
const { createPendingCheckInStore, PENDING_CHECK_IN_STORAGE_KEY: KEY } = moduleContainer.exports;
const BACKUP = 'pending-check-ins-v1-upgrade-backup';
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const old = (patch = {}) => ({ requestId: 'a'.repeat(32), localPath: '/saved/old.mp3', recoverable: true,
  context: { bookId: '1', bookTitle: 'Book', practiceId: 'p', practiceIndex: 0, pageNumber: 1, imageUrl: 'image', sectionTitle: 'unit' },
  durationMs: 1234, fileSizeBytes: 100, cloudFileId: 'cloud://old', status: 'local', updatedAtMs: 1, ...patch });
function setup(raw, exists = () => true) {
  const data = new Map([[KEY, copy(raw)]]);
  const writes = [], diagnostics = [], removed = [];
  let failBackup = false;
  const adapters = {
    storage: { get: key => copy(data.get(key)), set: (key, value) => {
      if (key === BACKUP && failBackup) throw new Error('backup unavailable');
      writes.push(key); data.set(key, copy(value));
    } },
    file: { exists, usageBytes: () => 0, save: () => ({ savedFilePath: '/saved/new.mp3' }), remove: p => removed.push(p) },
    clock: { now: () => 2 }, random: { hex: () => 'b'.repeat(32) }, diagnose: stage => diagnostics.push(stage),
  };
  return { data, writes, diagnostics, removed, adapters, store: createPendingCheckInStore(adapters), failBackup: () => { failBackup = true; } };
}
test('cleanup retains missing legacy recording without fingerprint and preserves persistence status', async () => {
  const f = setup([old()], () => false);
  await f.store.cleanup();
  assert.equal(f.store.list().length, 1);
  assert.equal(f.store.list()[0].fileAvailability, 'missing');
  assert.equal(f.store.list()[0].recoverable, true);
  assert.equal(f.store.list()[0].contentSha1, undefined);
  assert.equal(f.data.get(KEY)[0].cloudFileId, 'cloud://old');
  assert.deepEqual(f.removed, []);
  assert.ok(f.diagnostics.includes('cleanup.file.missing'));
});
test('existence failures retain unavailable recording; a later successful check restores availability', async () => {
  let fails = true;
  const f = setup([old()], () => { if (fails) throw new Error('IO'); return true; });
  await f.store.cleanup();
  assert.equal(f.store.list()[0].fileAvailability, 'unavailable');
  assert.ok(f.diagnostics.includes('cleanup.file.unavailable'));
  fails = false; await f.store.cleanup();
  assert.equal(f.store.list()[0].fileAvailability, 'available');
});
test('mutations retain unknown fields, unknown entries and ambiguous duplicate IDs verbatim', async () => {
  const duplicate = old({ requestId: 'c'.repeat(32) });
  const unknown = [null, 'future', { version: 99 }, duplicate, { ...duplicate, localPath: '/other' }];
  const record = old({ contentSha1: 'D'.repeat(40), extra: { version: 2 }, context: { ...old().context, future: true } });
  const original = [record, ...unknown];
  const f = setup(original); await f.store.ready();
  assert.equal(f.store.list().length, 1, 'ambiguous duplicate IDs must not become playable');
  assert.ok(await f.store.markFailed(record.requestId));
  assert.deepEqual(f.data.get(KEY).slice(1), unknown);
  assert.deepEqual(f.data.get(KEY)[0], { ...record, status: 'failed', updatedAtMs: 2 });
  assert.deepEqual(f.data.get(BACKUP), original);
  assert.equal(f.writes[0], BACKUP);
  await f.store.complete(record.requestId, true);
  assert.deepEqual(f.data.get(BACKUP), original, 'snapshot must remain original');
  assert.equal(f.writes.filter(key => key === BACKUP).length, 1);
  assert.equal(await f.store.remove(record.requestId), true);
  assert.deepEqual(f.data.get(KEY), unknown, 'explicit deletion must preserve quarantined entries');
});
test('new IDs avoid quarantined IDs and tolerate malformed unknown requestId fields', async () => {
  const unknown = [{ requestId: { toLowerCase: 4 } }, { requestId: 'b'.repeat(32) }];
  const f = setup(unknown);
  const ids = ['b'.repeat(32), 'c'.repeat(32)];
  f.adapters.random.hex = () => ids.shift();
  const result = await f.store.saveRecording({ tempFilePath: '/tmp/new', context: old().context, durationMs: 1, fileSizeBytes: 1 });
  assert.equal(result.persisted, true);
  assert.equal(result.item.requestId, 'c'.repeat(32));
  assert.deepEqual(f.data.get(KEY).slice(0, 2), unknown);
});
test('failed backup during save preserves old index and exposes saved file for retry', async () => {
  const f = setup([old()]); f.failBackup();
  const result = await f.store.saveRecording({ tempFilePath: '/tmp/new', context: old().context, durationMs: 1, fileSizeBytes: 1 });
  assert.equal(result.persisted, false);
  assert.equal(result.item.localPath, '/saved/new.mp3');
  assert.deepEqual(f.data.get(KEY), [old()]);
  assert.ok(f.diagnostics.includes('metadata.backup.failed'));
});
test('unreadable backup blocks mutation instead of overwriting unknown snapshot', async () => {
  const f = setup([old()]); f.data.set(BACKUP, { broken: true });
  assert.equal(await f.store.markFailed(old().requestId), null);
  assert.deepEqual(f.data.get(KEY), [old()]);
  assert.deepEqual(f.data.get(BACKUP), { broken: true });
});
test('non-array corrupt index never becomes an empty writable library', async () => {
  for (const raw of [{ version: 99 }, 'broken', 0, false]) {
    const f = setup(raw); await f.store.cleanup();
    const result = await f.store.saveRecording({ tempFilePath: '/tmp/new', context: old().context, durationMs: 1, fileSizeBytes: 1 });
    assert.equal(result.persisted, false);
    assert.deepEqual(f.data.get(KEY), raw);
    assert.deepEqual(f.writes, []);
  }
});
test('empty storage sentinels allow a first save', async () => {
  for (const raw of [undefined, null, '']) {
    const f = setup(raw);
    assert.equal((await f.store.saveRecording({ tempFilePath: '/tmp/new', context: old().context, durationMs: 1, fileSizeBytes: 1 })).persisted, true);
    assert.equal(f.data.get(KEY).length, 1);
  }
});
test('failed snapshot blocks existing-index overwrite', async () => {
  const original = [old()]; const f = setup(original); f.failBackup();
  assert.equal(await f.store.markFailed(old().requestId), null);
  assert.deepEqual(f.data.get(KEY), original);
  assert.deepEqual(f.writes, []);
});
test('explicit deletion remains deleted after restart even when snapshot contains recording', async () => {
  const f = setup([old()], () => false);
  assert.equal(await f.store.remove(old().requestId), true);
  assert.deepEqual(f.data.get(KEY), []);
  assert.deepEqual(f.data.get(BACKUP), [old()]);
  const restarted = createPendingCheckInStore(f.adapters); await restarted.cleanup();
  assert.equal(restarted.list().length, 0);
  assert.deepEqual(f.data.get(BACKUP), [old()]);
});
