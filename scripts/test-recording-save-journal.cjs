const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const mod = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/features/listeningPractice/pendingCheckInStore.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module: mod, exports: mod.exports });
const { createPendingCheckInStore, PENDING_CHECK_IN_STORAGE_KEY: KEY } = mod.exports;
const JOURNAL = 'pending-check-ins-v1-save-journal';
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const context = { bookId: '1', bookTitle: 'Book', practiceId: 'p', practiceIndex: 0, pageNumber: 1, imageUrl: 'image', sectionTitle: 'unit' };
const info = { fileSizeBytes: 100, contentSha1: 'b'.repeat(40) };
const record = () => ({ requestId: 'a'.repeat(32), localPath: '/saved/old.mp3', recoverable: true, context,
  durationMs: 1200, ...info, cloudFileId: '', status: 'local', updatedAtMs: 1, createdAtMs: 1,
  shareRequestId: 'd'.repeat(32), share: { id: 'share', shareToken: 'private', expiresAtMs: 10000 } });
function fixture(records = []) {
  const data = new Map([[KEY, copy(records)]]);
  const files = new Map(records.map(item => [item.localPath, copy(info)]));
  files.set('/tmp/download', copy(info));
  const calls = { saves: 0, removes: [], writes: [] };
  let failIndex = false, failJournal = false, sequence = 0;
  const adapters = {
    storage: { get: key => copy(data.get(key)), set: (key, value) => {
      if (key === KEY && failIndex) throw new Error('index write failed');
      if (key === JOURNAL && failJournal) throw new Error('journal write failed');
      data.set(key, copy(value)); calls.writes.push(key);
    } },
    file: { usageBytes: () => 100, exists: p => files.has(p), info: async p => {
      if (!files.has(p)) throw new Error('ENOENT'); return copy(files.get(p));
    }, save: async () => { calls.saves++; const savedFilePath = `/saved/new-${calls.saves}.mp3`; files.set(savedFilePath, copy(info)); return { savedFilePath, ...info }; },
    remove: p => { calls.removes.push(p); files.delete(p); } },
    clock: { now: () => 2 }, random: { hex: () => (++sequence).toString(16).padStart(32, '0') },
  };
  return { data, files, calls, adapters, start: () => createPendingCheckInStore(adapters),
    failIndex: value => { failIndex = value; }, failJournal: value => { failJournal = value; } };
}
const save = store => store.saveRecording({ tempFilePath: '/tmp/new', context, durationMs: 1200, fileSizeBytes: 100 });

test('saved recording survives an index failure and process restart without moving the file again', async () => {
  const f = fixture(); f.failIndex(true);
  const result = await save(f.start()); assert.equal(result.persisted, false);
  f.failIndex(false); const restarted = f.start(); await restarted.ready();
  assert.equal(restarted.list().length, 1, 'saved file must not become an untracked orphan');
  assert.equal(restarted.list()[0].localPath, result.item.localPath);
  assert.equal(restarted.list()[0].requestId, result.item.requestId);
  assert.equal(restarted.list()[0].recoverable, true);
  assert.equal(f.data.get(KEY).length, 1);
  assert.equal(f.calls.saves, 1); assert.deepEqual(f.calls.removes, []);
});

test('continuing index failure leaves a visible retry record after restart', async () => {
  const f = fixture(); f.failIndex(true); const result = await save(f.start());
  const restarted = f.start(); await restarted.ready();
  assert.equal(restarted.list().length, 1);
  assert.equal(restarted.list()[0].recoverable, false);
  f.failIndex(false); assert.equal((await restarted.retrySave(result.item.requestId)).persisted, true);
  assert.equal(f.calls.saves, 1);
});

test('restored local copy survives index failure and offline restart with the same original record', async () => {
  const old = record(); const f = fixture([old]); f.failIndex(true);
  await assert.rejects(f.start().restoreRecording(old, '/tmp/download', info), /索引/);
  f.failIndex(false); const restarted = f.start(); await restarted.ready();
  assert.equal(restarted.list().length, 1);
  assert.equal(restarted.list()[0].localPath, '/saved/new-1.mp3');
  assert.equal(restarted.list()[0].requestId, old.requestId);
  assert.deepEqual(copy(restarted.list()[0].share), old.share);
  assert.equal(f.files.has(old.localPath), true); assert.equal(f.calls.saves, 1);
});

test('stale journal never replaces a newer record or recreates a removed restore target', async () => {
  for (const deleted of [false, true]) {
    const old = record(); const f = fixture([old]); f.failIndex(true);
    await assert.rejects(f.start().restoreRecording(old, '/tmp/download', info));
    const newer = { ...old, updatedAtMs: 99, shareRequestId: 'e'.repeat(32) };
    f.data.set(KEY, deleted ? [] : [newer]); f.failIndex(false);
    const restarted = f.start(); await restarted.ready();
    assert.deepEqual(copy(restarted.list()), deleted ? [] : [newer]);
    assert.deepEqual(f.calls.removes, []);
  }
});

test('delete clears pending journal before deleting and cannot resurrect on the next restart', async () => {
  const f = fixture(); f.failIndex(true); const first = f.start(); const result = await save(first);
  f.failIndex(false); const restarted = f.start(); await restarted.ready();
  assert.equal(await restarted.remove(result.item.requestId), true);
  const again = f.start(); await again.ready(); assert.equal(again.list().length, 0);
  assert.equal(f.files.has(result.item.localPath), false);
});

test('a pending journal that cannot be cancelled blocks deletion before touching audio', async () => {
  const f = fixture(); f.failIndex(true); const first = f.start(); const result = await save(first);
  f.failJournal(true);
  assert.equal(await first.remove(result.item.requestId), false);
  assert.equal(f.files.has(result.item.localPath), true); assert.deepEqual(f.calls.removes, []);
});

test('corrupt journal is preserved and prevents new saves from overwriting recovery evidence', async () => {
  const f = fixture([record()]); const corrupt = { version: 99, entries: ['future'] }; f.data.set(JOURNAL, corrupt);
  const first = f.start(); await first.ready(); assert.equal(first.list().length, 1);
  assert.equal((await save(first)).persisted, false);
  assert.deepEqual(f.data.get(JOURNAL), corrupt); assert.equal(f.calls.saves, 0);
  assert.deepEqual(f.data.get(KEY), [record()]);
});

test('mismatched saved bytes are not adopted into the index and no file is deleted', async () => {
  const f = fixture(); f.failIndex(true); const result = await save(f.start());
  f.files.set(result.item.localPath, { ...info, contentSha1: 'c'.repeat(40) }); f.failIndex(false);
  const restarted = f.start(); await restarted.ready();
  assert.deepEqual(f.data.get(KEY), []);
  assert.ok(f.data.has(JOURNAL), 'retain recovery evidence for a later retry');
  assert.deepEqual(f.calls.removes, []);
});

test('native saved path is journalled before later metadata reads can be interrupted', async () => {
  const f = fixture(); let journalAtNativeSave;
  f.adapters.file.save = async (_temp, onSaved) => {
    f.files.set('/saved/native.mp3', copy(info));
    if (onSaved) await onSaved('/saved/native.mp3');
    journalAtNativeSave = copy(f.data.get(JOURNAL));
    return { savedFilePath: '/saved/native.mp3', ...info };
  };
  await save(f.start());
  assert.equal(journalAtNativeSave?.entries[0].item.localPath, '/saved/native.mp3');
  f.data.set(KEY, []); f.data.set(JOURNAL, journalAtNativeSave);
  const restarted = f.start(); await restarted.ready();
  assert.equal(restarted.list()[0].localPath, '/saved/native.mp3');
  assert.equal(restarted.list()[0].contentSha1, info.contentSha1);
});

test('restore journal remains retryable offline when index writing still fails on restart', async () => {
  const old = record(); const f = fixture([old]); f.failIndex(true);
  await assert.rejects(f.start().restoreRecording(old, '/tmp/download', info));
  const restarted = f.start(); await restarted.ready(); f.failIndex(false);
  const retried = await restarted.retryRestoreRecording(old.requestId);
  assert.equal(retried.localPath, '/saved/new-1.mp3'); assert.equal(f.calls.saves, 1);
});

test('leftover successful-save journal cannot roll back later completion or sharing metadata', async () => {
  const f = fixture(); const originalSet = f.adapters.storage.set;
  f.adapters.storage.set = (key, value) => {
    if (key === JOURNAL && value.entries.length === 0) throw new Error('clear failed');
    originalSet(key, value);
  };
  const first = f.start(); const result = await save(first); assert.equal(result.persisted, true);
  await first.complete(result.item.requestId, true); await first.beginShare(result.item.requestId);
  const latest = copy(f.data.get(KEY)); const restarted = f.start(); await restarted.ready();
  assert.deepEqual(copy(restarted.list()), latest);
  assert.equal(restarted.list().length, 1);
});

test('unreadable primary index is never replaced from a save journal', async () => {
  const f = fixture(); f.failIndex(true); await save(f.start());
  const broken = { unknown: 'preserve' }; f.data.set(KEY, broken); f.failIndex(false);
  const restarted = f.start(); await restarted.ready();
  assert.deepEqual(f.data.get(KEY), broken); assert.deepEqual(f.calls.removes, []);
});

test('failure of both durable writes cannot report successful saving', async () => {
  const f = fixture([record()]); f.failIndex(true); f.failJournal(true);
  const result = await save(f.start()); assert.equal(result.persisted, false);
  assert.equal(result.item.recoverable, false); assert.deepEqual(f.data.get(KEY), [record()]);
  assert.equal(f.files.has(result.item.localPath), true); assert.deepEqual(f.calls.removes, []);
});

test('failed deletion retains a pending saved recording across restart', async () => {
  for (const failure of ['exists', 'remove']) {
    const f = fixture(); f.failIndex(true); const first = f.start(); const result = await save(first);
    const original = f.adapters.file[failure]; f.adapters.file[failure] = () => { throw new Error('temporary IO failure'); };
    assert.equal(await first.remove(result.item.requestId), false);
    f.adapters.file[failure] = original;
    const restarted = f.start(); await restarted.ready();
    assert.equal(restarted.list().length, 1, 'failed deletion must not orphan a still-existing recording');
    assert.equal(restarted.list()[0].localPath, result.item.localPath);
    assert.equal(restarted.list()[0].recoverable, false);
    f.failIndex(false); assert.equal((await restarted.retrySave(result.item.requestId)).persisted, true);
  }
});

test('transient journal read failure can be retried in the same process', async () => {
  const f = fixture(); const original = f.adapters.storage.get; let failed = false;
  f.adapters.storage.get = key => { if (key === JOURNAL && !failed) { failed = true; throw new Error('temporary IO'); } return original(key); };
  const first = f.start(); const result = await save(first); assert.equal(result.persisted, false);
  assert.equal((await first.retrySave(result.item.requestId)).persisted, true);
});

test('restore retries saved journal locally after startup fingerprint read temporarily fails', async () => {
  const old = record(); const f = fixture([old]); f.failIndex(true);
  await assert.rejects(f.start().restoreRecording(old, '/tmp/download', info));
  f.failIndex(false); const original = f.adapters.file.info;
  f.adapters.file.info = async () => { throw new Error('temporary IO'); };
  const restarted = f.start(); await restarted.ready();
  await assert.rejects(restarted.retryRestoreRecording(old.requestId), 'must not fall back to cloud on an unverified saved copy');
  f.adapters.file.info = original;
  assert.equal((await restarted.retryRestoreRecording(old.requestId)).localPath, '/saved/new-1.mp3');
  assert.equal(f.calls.saves, 1);
});

test('failed deletion of a restore target keeps the downloaded copy available for explicit offline retry', async () => {
  const old = record(); const f = fixture([old]); f.failIndex(true);
  const first = f.start(); await assert.rejects(first.restoreRecording(old, '/tmp/download', info));
  f.adapters.file.remove = () => { throw new Error('EIO'); };
  assert.equal(await first.remove(old.requestId), false);
  f.failIndex(false); const restarted = f.start(); await restarted.ready();
  assert.equal(restarted.list()[0].localPath, old.localPath, 'cancelled restore must not run automatically');
  assert.equal((await restarted.retryRestoreRecording(old.requestId)).localPath, '/saved/new-1.mp3');
  assert.equal(f.calls.saves, 1);
});

test('interruption after audio deletion but before journal clearing does not resurrect a new recording', async () => {
  const f = fixture(); f.failIndex(true); const first = f.start(); const result = await save(first);
  const original = f.adapters.storage.set;
  f.adapters.storage.set = (key, value) => {
    if (key === JOURNAL && value.entries.length === 0) throw new Error('clear failed'); original(key, value);
  };
  assert.equal(await first.remove(result.item.requestId), true);
  const restarted = f.start(); await restarted.ready(); assert.equal(restarted.list().length, 0);
  assert.equal(f.files.has(result.item.localPath), false);
});
