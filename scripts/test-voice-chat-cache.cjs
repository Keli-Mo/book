const assert = require('node:assert/strict');
const { test } = require('node:test');
const { load, createPage, elements, textOf, byClass } = require('./test-practice-book-route.cjs');
const sessionApi = load('src/features/voiceChat/session.ts');
const reply = (audioBase64 = 'QUJD') => ({ transcript: 'I like pasta.', replyEn: 'Pasta is tasty!', replyZh: '意大利面很好吃！', audioBase64 });
const addTurn = (session, id, audio) => sessionApi.completeRequest(sessionApi.beginRequest(session, id), id, reply(audio));

test('long conversations keep subtitles and model context while limiting audio count in both modes', () => {
  let session = sessionApi.createSession();
  for (const mode of ['free', 'topic']) {
    session = sessionApi.selectMode(session, mode);
    for (let n = 0; n < 35; n++) session = addTurn(session, mode + n, 'QUJD');
    const turns = sessionApi.currentTurns(session);
    assert.equal(turns.length, 35);
    assert.equal(turns.filter(turn => turn.audioBase64).length, 10);
    assert.deepEqual(turns.slice(-8).map(turn => turn.requestId), Array.from({ length: 8 }, (_, n) => mode + (n + 27)));
    assert.ok(turns.every(turn => turn.userEn && turn.assistantEn && turn.assistantZh));
  }
  assert.equal([...session.freeTurns, ...session.topicTurns].filter(turn => turn.audioBase64).length, 20);
});

test('audio byte budget is enforced and a recovered old message retains its newly generated audio', () => {
  const large = 'QUJD'.repeat(300000); // 900,000 decoded bytes, within the server response limit.
  let session = sessionApi.createSession();
  for (let n = 0; n < 3; n++) session = addTurn(session, 'turn' + n, large);
  assert.equal(session.freeTurns.filter(turn => turn.audioBase64).length, 1);
  assert.equal(session.freeTurns[2].audioBase64, large);
  session = addTurn(session, 'turn0', large);
  assert.equal(session.freeTurns.length, 3);
  assert.equal(session.freeTurns.filter(turn => turn.audioBase64).length, 1);
  assert.equal(session.freeTurns[0].audioBase64, large);
});

const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const button = (page, label) => elements(page.render()).find(node => node.type === 'Button' && textOf(node) === label);
const mic = page => byClass(page.render(), 'voice-chat__mic');
function fixture(options = {}) {
  let recording;
  const files = new Set(['/unrelated-pending-recording.mp3']), writes = [], removals = [], requests = [];
  const page = createPage('src/pages/VoiceChat/VoiceChat.tsx', {}, {
    deferAudioPlay: true, taroOverrides: { getStorageSync: () => true, setStorageSync: () => {} },
    overrides: {
      '@/features/voiceChat/recording': { createVoiceRecorder: () => ({
        start(onStop) { recording = onStop; }, stop() { const done = recording; recording = null; done('/record.mp3', 1200); },
        cancel() { recording = null; }, isActive: () => Boolean(recording),
      }) },
      '@/features/voiceChat/playback': {
        sweepVoiceAudioFiles: options.sweep || (async () => {}), removeRecordedTempFile: async () => {},
        readVoiceRecordingBase64: async () => 'QUJD',
        saveVoiceAudioBase64: async id => {
          writes.push(id);
          if (options.save) await options.save(id, writes.length);
          const path = '/voice-chat-' + id + '.mp3'; files.add(path); return path;
        },
        removeVoiceFile: async path => {
          const player = page.audios.find(audio => audio.src === path && !audio.events.includes('destroy'));
          assert.equal(player, undefined, 'stop and destroy a player before deleting its file');
          removals.push(path);
          if (options.remove) await options.remove(path);
          files.delete(path);
        },
      },
      '@/services/voiceChat': {
        isVoiceChatPreview: () => true, getVoiceChatQuota: async () => ({ kind: 'unlimited' }),
        callVoiceChat: async input => { requests.push(input); return { ...reply(), requestId: input.requestId }; },
      },
    },
  });
  const start = async () => { page.render(); page.show(); await settle(); };
  const record = async () => { mic(page).props.onClick(); await settle(); mic(page).props.onClick(); await settle(); };
  const finishPlayback = () => { page.audios.at(-1)?.trigger('Ended'); page.render(); };
  const close = () => { page.unload(); page.dispose(); };
  return { page, files, writes, removals, requests, start, record, finishPlayback, close };
}

test('long chat removes expired disk audio and replay actions, keeps current replay and clears only owned files on exit', async () => {
  const f = fixture();
  try {
    await f.start();
    for (let n = 0; n < 25; n++) { await f.record(); f.finishPlayback(); }
    assert.equal(f.files.size, 11);
    assert.equal(elements(f.page.render()).filter(node => node.type === 'Button' && textOf(node) === '重听').length, 10);
    assert.equal(elements(f.page.render()).filter(node => node.props?.className === 'voice-chat__user').length, 25);
    assert.equal(f.requests.at(-1).turns.length, 8);
    button(f.page, '重听').props.onClick(); await settle();
    assert.equal(f.writes.length, 25, 'retained replay reuses its disk file');
  } finally { f.close(); }
  assert.deepEqual([...f.files], ['/unrelated-pending-recording.mp3']);
});

test('changing topic stops playback and removes abandoned topic files while keeping the free chat cache', async () => {
  const f = fixture();
  try {
    await f.start(); await f.record(); f.finishPlayback();
    const freePath = '/voice-chat-' + f.requests[0].requestId + '.mp3';
    button(f.page, '主题聊天').props.onClick(); await f.record();
    const topicPath = '/voice-chat-' + f.requests[1].requestId + '.mp3';
    button(f.page, '美食').props.onClick(); await settle();
    assert.equal(f.files.has(freePath), true);
    assert.equal(f.files.has(topicPath), false);
    assert.equal(button(f.page, '重听'), undefined);
  } finally { f.close(); }
});

for (const leave of ['topic', 'unload']) test(`a pending audio write is removed when it finishes after ${leave}`, async () => {
  const gate = deferred(), f = fixture({ save: () => gate.promise });
  try {
    await f.start(); button(f.page, '主题聊天').props.onClick(); await f.record();
    assert.equal(f.writes.length, 1);
    if (leave === 'topic') button(f.page, '美食').props.onClick(); else f.page.unload();
    gate.resolve(); await settle();
    assert.deepEqual([...f.files], ['/unrelated-pending-recording.mp3']);
    assert.equal(f.page.audios.length, 0);
  } finally { gate.resolve(); f.close(); }
});

test('rapid replay shares one in-flight write and the latest play request wins', async () => {
  const gate = deferred(), f = fixture({ save: (_id, count) => count === 1 ? Promise.reject(Error('save failed')) : gate.promise });
  try {
    await f.start(); await f.record();
    const replay = button(f.page, '重听'); assert.ok(replay);
    replay.props.onClick(); replay.props.onClick(); await settle();
    assert.equal(f.writes.length, 2, 'initial failed write plus one shared replay write');
    gate.resolve(); await settle();
    assert.equal(f.page.audios.length, 1);
  } finally { gate.resolve(); f.close(); }
});

test('switching away and back can reuse a pending save without a stale caller deleting the current replay', async () => {
  const gate = deferred(), f = fixture({ save: () => gate.promise });
  try {
    await f.start(); await f.record();
    button(f.page, '主题聊天').props.onClick();
    button(f.page, '自由聊天').props.onClick();
    button(f.page, '重听').props.onClick(); await settle();
    assert.equal(f.writes.length, 1);
    gate.resolve(); await settle();
    assert.equal(f.page.audios.length, 1);
    assert.equal(f.files.has(f.page.audios[0].src), true);
    assert.equal(f.removals.length, 0);
  } finally { gate.resolve(); f.close(); }
});

test('replay requested while a stale save is being deleted waits for removal and writes fresh audio once', async () => {
  const saving = deferred(), deleting = deferred();
  const f = fixture({ save: () => saving.promise, remove: () => deleting.promise });
  try {
    await f.start(); await f.record();
    button(f.page, '主题聊天').props.onClick();
    saving.resolve(); await settle();
    assert.equal(f.removals.length, 1, 'the stale save has entered asynchronous deletion');
    button(f.page, '自由聊天').props.onClick();
    button(f.page, '重听').props.onClick(); await settle();
    assert.equal(f.writes.length, 1, 'never overwrite a path while its old deletion is pending');
    deleting.resolve(); await settle();
    assert.equal(f.writes.length, 2);
    assert.equal(f.page.audios.length, 1);
    assert.equal(f.files.has(f.page.audios[0].src), true);
  } finally { saving.resolve(); deleting.resolve(); f.close(); }
});

test('startup cleanup finishes before new audio is written', async () => {
  const gate = deferred(), f = fixture({ sweep: () => gate.promise });
  try {
    await f.start(); await f.record();
    assert.equal(f.writes.length, 0);
    gate.resolve(); await settle();
    assert.equal(f.writes.length, 1);
    assert.equal(f.page.audios.length, 1);
  } finally { gate.resolve(); f.close(); }
});

test('voice file deletion accepts only exact owned filenames inside USER_DATA_PATH', async () => {
  const removed = [], root = 'http://usr';
  const api = load('src/features/voiceChat/playback.ts', { wx: { env: { USER_DATA_PATH: root }, getFileSystemManager: () => ({
    unlink({ filePath, success }) { removed.push(filePath); success(); },
  }) } });
  const owned = root + '/voice-chat-' + 'a'.repeat(32) + '.mp3';
  for (const path of [root + '/voice-chat-../pending.mp3', root + '/voice-chat-user-recording.mp3', '/other/voice-chat-' + 'a'.repeat(32) + '.mp3', owned]) {
    await api.removeVoiceFile(path);
  }
  assert.deepEqual(removed, [owned]);
});
