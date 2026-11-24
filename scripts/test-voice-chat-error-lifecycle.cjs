const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createPage, elements, textOf, byClass } = require('./test-practice-book-route.cjs');

const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const button = (page, label, index = 0) => elements(page.render()).filter(node => node.type === 'Button' && textOf(node) === label)[index];
const mic = page => byClass(page.render(), 'voice-chat__mic');
const cards = page => elements(page.render()).filter(node => node.props?.className === 'voice-chat__turn');
const composerError = page => byClass(byClass(page.render(), 'voice-chat__composer'), 'voice-chat__error');
function fixture(options = {}) {
  let recording;
  const requests = [], writes = [];
  const page = createPage('src/pages/VoiceChat/VoiceChat.tsx', {}, {
    deferAudioPlay: true, taroOverrides: { getStorageSync: () => true, setStorageSync: () => {} },
    overrides: {
      '@/features/voiceChat/recording': { createVoiceRecorder: () => ({
        start(done) { recording = done; }, stop() { const done = recording; recording = null; done('/record.mp3', 1500); },
        cancel() { recording = null; }, isActive: () => Boolean(recording),
      }) },
      '@/features/voiceChat/playback': {
        sweepVoiceAudioFiles: async () => {}, removeRecordedTempFile: async () => {}, removeVoiceFile: async () => {},
        readVoiceRecordingBase64: async () => 'QUJD',
        saveVoiceAudioBase64: async id => {
          writes.push(id); if (options.save) await options.save(id, writes.length);
          return '/voice-chat-' + id + '.mp3';
        },
      },
      '@/services/voiceChat': {
        isVoiceChatPreview: () => true, getVoiceChatQuota: async () => ({ kind: 'unlimited' }),
        callVoiceChat: async input => {
          requests.push(input); if (options.invoke) await options.invoke(input, requests.length);
          return { requestId: input.requestId, transcript: 'I like pasta.', replyEn: 'Pasta is tasty!', replyZh: '意大利面很好吃！', audioBase64: 'QUJD' };
        },
      },
    },
  });
  const start = async () => { page.render(); page.show(); await settle(); };
  const record = async () => { mic(page).props.onClick(); await settle(); mic(page).props.onClick(); await settle(); };
  const close = () => { page.unload(); page.dispose(); };
  return { page, requests, writes, start, record, close };
}

test('reply file errors belong to their reply and disappear after that reply plays successfully', async () => {
  const f = fixture({ save: (_id, count) => { if (count === 1) throw Error('write failed'); } });
  try {
    await f.start(); await f.record();
    assert.ok(textOf(cards(f.page)[0]).includes('Pasta is tasty!'));
    assert.match(textOf(byClass(cards(f.page)[0], 'voice-chat__turn-error')), /保存失败/);
    assert.equal(composerError(f.page), undefined, 'a completed reply does not leave the microphone in a global failure state');
    button(f.page, '重听').props.onClick(); await settle();
    f.page.audios.at(-1).trigger('Play');
    assert.equal(byClass(cards(f.page)[0], 'voice-chat__turn-error'), undefined);
    assert.equal(composerError(f.page), undefined);
  } finally { f.close(); }
});

test('replaying an older answer must not erase a newer recording failure', async () => {
  const f = fixture({ invoke: (_input, count) => { if (count === 2) throw Object.assign(Error('recognition failed'), { code: 'ASR_NETWORK' }); } });
  try {
    await f.start(); await f.record();
    f.page.audios.at(-1).trigger('Play'); f.page.audios.at(-1).trigger('Ended');
    await f.record();
    const failure = textOf(composerError(f.page)); assert.ok(failure);
    assert.match(failure, /刚才这次录音/);
    button(f.page, '重听').props.onClick(); await settle();
    f.page.audios.at(-1).trigger('Play');
    assert.equal(textOf(composerError(f.page)), failure, 'playback only recovers errors belonging to its own audio');
  } finally { f.close(); }
});

test('replaying one answer does not remove the audio failure of another answer', async () => {
  const f = fixture({ save: (_id, count) => { if (count <= 2) throw Error('write failed'); } });
  try {
    await f.start(); await f.record(); await f.record();
    assert.ok(byClass(cards(f.page)[0], 'voice-chat__turn-error'));
    assert.ok(byClass(cards(f.page)[1], 'voice-chat__turn-error'));
    button(f.page, '重听', 1).props.onClick(); await settle(); f.page.audios.at(-1).trigger('Play');
    assert.ok(byClass(cards(f.page)[0], 'voice-chat__turn-error'));
    assert.equal(byClass(cards(f.page)[1], 'voice-chat__turn-error'), undefined);
    assert.equal(composerError(f.page), undefined);
  } finally { f.close(); }
});

test('late callbacks from an old player cannot mark a newer successfully playing answer as failed', async () => {
  const f = fixture();
  try {
    await f.start(); await f.record();
    const old = f.page.audios.at(-1); old.trigger('Play'); old.trigger('Ended');
    await f.record(); f.page.audios.at(-1).trigger('Play');
    old.trigger('Error'); old.trigger('Play');
    assert.equal(composerError(f.page), undefined);
    assert.equal(elements(f.page.render()).filter(node => node.props?.className === 'voice-chat__turn-error').length, 0);
  } finally { f.close(); }
});

test('a rejected save from a discarded topic cannot show an error in the next successful topic', async () => {
  const gate = deferred(), f = fixture({ save: (_id, count) => count === 1 ? gate.promise : undefined });
  try {
    await f.start(); button(f.page, '主题聊天').props.onClick(); await f.record();
    button(f.page, '美食').props.onClick(); await f.record(); f.page.audios.at(-1).trigger('Play');
    gate.reject(Error('late save failure')); await settle();
    assert.equal(composerError(f.page), undefined);
    assert.equal(byClass(cards(f.page)[0], 'voice-chat__turn-error'), undefined);
  } finally { gate.resolve(); f.close(); }
});

test('native playback failure is attached to the existing answer and clears on successful replay', async () => {
  const f = fixture();
  try {
    await f.start(); await f.record(); f.page.audios.at(-1).trigger('Error');
    assert.match(textOf(byClass(cards(f.page)[0], 'voice-chat__turn-error')), /播放失败/);
    assert.equal(composerError(f.page), undefined);
    button(f.page, '重听').props.onClick(); await settle(); f.page.audios.at(-1).trigger('Play');
    assert.equal(byClass(cards(f.page)[0], 'voice-chat__turn-error'), undefined);
  } finally { f.close(); }
});

test('local repeat playback recovers its own error but cannot erase a newer chat failure', async () => {
  const f = fixture({ invoke: (_input, count) => { if (count === 2) throw Object.assign(Error('network failed'), { code: 'ASR_NETWORK' }); } });
  try {
    await f.start(); await f.record(); f.page.audios.at(-1).trigger('Ended');
    button(f.page, '跟读').props.onClick(); await settle(); button(f.page, '结束跟读').props.onClick(); await settle();
    button(f.page, '回听自己').props.onClick(); f.page.audios.at(-1).trigger('Error');
    assert.match(textOf(composerError(f.page)), /跟读录音播放失败/);
    button(f.page, '回听自己').props.onClick(); f.page.audios.at(-1).trigger('Play');
    assert.equal(composerError(f.page), undefined);
    f.page.audios.at(-1).trigger('Ended'); await f.record();
    const failure = textOf(composerError(f.page)); assert.ok(failure);
    button(f.page, '回听自己').props.onClick(); f.page.audios.at(-1).trigger('Play');
    assert.equal(textOf(composerError(f.page)), failure);
  } finally { f.close(); }
});
