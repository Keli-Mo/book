const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHandler } = require('../cloudfunctions/voiceChat/handler');
const { modelReplyError } = require('../cloudfunctions/voiceChat/errors');
const { buildMessages } = require('../cloudfunctions/voiceChat/providers');
const { parseReply } = require('../cloudfunctions/voiceChat/handler');
const { createPage, elements, textOf, byClass, load } = require('./test-practice-book-route.cjs');

const transcript = 'Do you like plastic?';
const reply = { replyEn: 'Plastic is useful. What toys do you like?', replyZh: '塑料很有用。你喜欢什么玩具？' };
const request = { requestId: 'f'.repeat(32), mode: 'free', level: 'basic', topic: 'animals',
  durationMs: 2000, audioBase64: Buffer.from('ID3-fixture').toString('base64'), turns: [], progressProtocol: 1, quotaProtocol: 1 };

test('JSON output guidance includes valid examples for answers with and without correction', () => {
  const messages = buildMessages({ ...request, transcript, turns: [{ userEn: 'Hi', assistantEn: 'Hello!' }] });
  const examples = messages[0].content.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.ok(examples.length >= 2);
  for (const example of examples) assert.ok(parseReply(example).replyEn);
  assert.ok(examples.some(example => example.correction === null));
  assert.ok(examples.some(example => example.correction));
  for (const example of examples.filter(example => example.correction)) {
    assert.ok(example.replyEn.includes(example.correction.betterEn));
  }
  const context = JSON.parse(messages.at(-1).content);
  assert.equal(context.currentUtterance, transcript);
  assert.equal(context.conversation[0].assistantEn, 'Hello!');
});
function fixture(failStage = 'reply', metered = false) {
  const calls = [], logs = [], quotaCalls = [];
  let failing = true;
  const handler = createHandler({
    enabled: true, getOpenId: () => 'tester', allowedOpenIds: new Set(['tester']),
    quotaEnabled: metered, quota: {
      reserve: async () => { quotaCalls.push('reserve'); return { token: 'b'.repeat(32) }; },
      release: async () => { quotaCalls.push('release'); },
      complete: async () => { quotaCalls.push('complete'); return { freeRemaining: 4, packRemaining: 0, packExpiresAt: null }; },
    },
    transcribe: async () => { calls.push('asr'); return transcript; },
    reply: async () => { calls.push('reply'); if (failing && failStage === 'reply') throw modelReplyError('MODEL_CONTENT_EMPTY'); return reply; },
    synthesize: async () => { calls.push('tts'); if (failing && failStage === 'tts') throw Object.assign(Error('private-provider-detail'), { code: 'ETIMEDOUT' }); return 'QUJD'; },
    logDiagnostic: item => logs.push(item),
  });
  return { handler, calls, logs, quotaCalls, recover: () => { failing = false; }, fail: () => { failing = true; } };
}

test('empty AI reply returns this request’s validated transcript; reply-only retry does not repeat ASR', async () => {
  const f = fixture();
  const failed = await f.handler(request);
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.partial, { transcript });
  assert.equal(failed.reasonCode, 'MODEL_CONTENT_EMPTY');
  assert.ok(!JSON.stringify(f.logs).includes(transcript), 'public partial results do not enable content logs');
  f.recover();
  const result = await f.handler({ ...request, action: 'retryReply', transcript, audioBase64: undefined, durationMs: undefined });
  assert.equal(result.ok, true);
  assert.equal(result.data.transcript, transcript);
  assert.deepEqual(f.calls, ['asr', 'reply', 'reply', 'tts']);
});

test('TTS failure retains bilingual reply; speech-only retry does not repeat recognition or model calls', async () => {
  const f = fixture('tts');
  const failed = await f.handler(request);
  assert.deepEqual(failed.partial, { transcript, ...reply });
  assert.equal(failed.stage, 'tts');
  f.recover();
  const result = await f.handler({ ...request, action: 'retrySpeech', transcript, reply,
    audioBase64: undefined, durationMs: undefined });
  assert.equal(result.ok, true);
  assert.equal(result.data.replyEn, reply.replyEn);
  assert.deepEqual(f.calls, ['asr', 'reply', 'tts', 'tts']);
});

test('retry keeps access, validation and quota protection and only confirms a successfully played turn', async () => {
  const f = fixture('reply', true);
  assert.equal((await f.handler(request)).ok, false);
  assert.deepEqual(f.quotaCalls, ['reserve', 'release']);
  f.recover();
  const result = await f.handler({ ...request, action: 'retryReply', transcript });
  assert.equal(result.ok, true);
  assert.deepEqual(f.quotaCalls, ['reserve', 'release', 'reserve']);
  assert.equal(result.data.receipt.requestId, request.requestId);
  const disabled = createHandler({ enabled: true, getOpenId: () => 'stranger', allowedOpenIds: new Set(['tester']) });
  assert.equal((await disabled({ ...request, action: 'retryReply', transcript })).code, 'TRIAL_ONLY');
  const count = f.calls.length;
  for (const change of [{ action: 'retryReply', transcript: '' }, { action: 'retryReply', transcript: 'x'.repeat(501) },
    { action: 'retrySpeech', transcript, reply: { ...reply, replyEn: '中文' } }, { action: 'retrySpeech', transcript, reply: null }]) {
    assert.equal((await f.handler({ ...request, ...change })).ok, false);
  }
  assert.equal(f.calls.length, count, 'invalid retry never calls a paid provider');
});

test('old clients and failures before recognition receive no partial text', async () => {
  const f = fixture();
  assert.equal((await f.handler({ ...request, progressProtocol: undefined })).partial, undefined);
  assert.equal((await f.handler({ ...request, audioBase64: '', transcript: 'forged' })).partial, undefined);
});

test('client accepts bounded partial data only for the matching request and correct stage', () => {
  const api = load('src/services/voiceChat.ts', {
    '@/cloud': { CLOUD_ENV_ID: 'test' }, '@/services/appEntry': { readMiniProgramEnvVersion: () => 'develop' },
  });
  const failure = { ok: false, code: 'BAD_MODEL_REPLY', stage: 'reply', reasonCode: 'MODEL_CONTENT_EMPTY', requestId: request.requestId, partial: { transcript } };
  assert.throws(() => api.readVoiceChatResponse(failure, request.requestId), error => error.partial?.transcript === transcript);
  for (const change of [{ requestId: '0'.repeat(32) }, { stage: 'asr' }, { partial: { transcript: 'x'.repeat(501) } },
    { partial: { transcript, replyEn: 'unvalidated response', replyZh: '' } }]) {
    assert.throws(() => api.readVoiceChatResponse({ ...failure, ...change }, request.requestId), error => !error.partial);
  }
});

const settle = () => new Promise(resolve => setImmediate(resolve));
const mic = page => byClass(page.render(), 'voice-chat__mic');
const button = (page, label) => elements(page.render()).find(node => node.type === 'Button' && textOf(node) === label);
function pageFixture(f) {
  let recording, starts = 0;
  const invocations = [];
  const page = createPage('src/pages/VoiceChat/VoiceChat.tsx', {}, {
    deferAudioPlay: true, taroOverrides: { getStorageSync: () => true, setStorageSync: () => {} },
    overrides: {
      wx: { cloud: { callFunction: async ({ data }) => {
        if (data.action === 'quotaStatus') return { result: { ok: true, data: { quota: { kind: 'unlimited' } } } };
        invocations.push(data); return { result: await f.handler(data) };
      } } },
      '@/cloud': { CLOUD_ENV_ID: 'test' }, '@/services/appEntry': { readMiniProgramEnvVersion: () => 'develop' },
      '@/features/voiceChat/recording': { createVoiceRecorder: () => ({
        start(onStop) { starts++; recording = onStop; },
        stop() { const done = recording; recording = undefined; done('/sample.mp3', 2000); },
        cancel() { recording = undefined; }, isActive: () => Boolean(recording),
      }) },
      '@/features/voiceChat/playback': {
        sweepVoiceAudioFiles: async () => {}, removeRecordedTempFile: async () => {}, removeVoiceFile: async () => {},
        readVoiceRecordingBase64: async () => request.audioBase64, saveVoiceAudioBase64: async () => '/reply.mp3',
      },
    },
  });
  return { page, invocations, starts: () => starts };
}

for (const stage of ['reply', 'tts']) test(`page keeps partial ${stage} results and retries on the original message without recording again`, async () => {
  const f = fixture(stage), p = pageFixture(f), page = p.page;
  try {
    page.render(); page.show(); await settle();
    mic(page).props.onClick(); await settle(); mic(page).props.onClick(); await settle();
    assert.equal(textOf(byClass(page.render(), 'voice-chat__user')), transcript);
    assert.equal(byClass(byClass(page.render(), 'voice-chat__composer'), 'voice-chat__error'), undefined);
    if (stage === 'tts') assert.ok(textOf(page.render()).includes(reply.replyEn));
    assert.equal(button(page, '重听'), undefined, 'no playback button before audio exists');
    f.recover();
    const retry = button(page, stage === 'reply' ? '重新回答' : '重新发声');
    assert.ok(retry); retry.props.onClick(); retry.props.onClick(); await settle();
    assert.equal(p.starts(), 1);
    assert.equal(p.invocations.length, 2, 'double click only dispatches one retry');
    assert.equal(p.invocations[1].action, stage === 'reply' ? 'retryReply' : 'retrySpeech');
    assert.equal(p.invocations[1].audioBase64, undefined);
    assert.equal(elements(page.render()).filter(n => n.props?.className === 'voice-chat__user').length, 1);
    assert.ok(button(page, '重听'));
    assert.ok(textOf(page.render()).includes(reply.replyZh));
  } finally { page.unload(); page.dispose(); }
});

test('failed retry keeps the same transcript and can recover again without adding messages', async () => {
  const f = fixture(), { page } = pageFixture(f);
  try {
    page.render(); page.show(); await settle();
    mic(page).props.onClick(); await settle(); mic(page).props.onClick(); await settle();
    button(page, '重新回答').props.onClick(); await settle();
    assert.equal(elements(page.render()).filter(n => n.props?.className === 'voice-chat__user').length, 1);
    assert.equal(textOf(byClass(page.render(), 'voice-chat__user')), transcript);
    assert.ok(button(page, '重新回答'));
    f.recover(); button(page, '重新回答').props.onClick(); await settle();
    assert.ok(button(page, '重听'));
    assert.deepEqual(f.calls, ['asr', 'reply', 'reply', 'reply', 'tts']);
  } finally { page.unload(); page.dispose(); }
});

test('retry uses its original context, excluding later turns and failed placeholders', async () => {
  const f = fixture(), { page, invocations } = pageFixture(f);
  try {
    page.render(); page.show(); await settle();
    mic(page).props.onClick(); await settle(); mic(page).props.onClick(); await settle();
    f.recover();
    mic(page).props.onClick(); await settle(); mic(page).props.onClick(); await settle();
    assert.deepEqual(invocations[1].turns, [], 'failed placeholder is not model history');
    button(page, '进阶').props.onClick();
    button(page, '重新回答').props.onClick(); await settle();
    assert.equal(invocations[2].requestId, invocations[0].requestId);
    assert.equal(invocations[2].level, 'basic');
    assert.deepEqual(invocations[2].turns, []);
    assert.equal(elements(page.render()).filter(n => n.props?.className === 'voice-chat__user').length, 2);
  } finally { page.unload(); page.dispose(); }
});

for (const leave of ['mode', 'unload']) test(`late retry cannot update or play after ${leave}`, async () => {
  const f = fixture(), { page, invocations } = pageFixture(f);
  let finish;
  try {
    page.render(); page.show(); await settle();
    mic(page).props.onClick(); await settle(); mic(page).props.onClick(); await settle();
    f.handler = () => new Promise(resolve => { finish = resolve; });
    button(page, '重新回答').props.onClick(); await settle();
    if (leave === 'mode') button(page, '主题聊天').props.onClick(); else page.unload();
    finish({ ok: true, data: { requestId: invocations[0].requestId, transcript, ...reply, audioBase64: 'QUJD' } });
    await settle();
    assert.equal(button(page, '重听'), undefined);
    if (leave === 'mode') {
      assert.equal(byClass(page.render(), 'voice-chat__user'), undefined);
      button(page, '自由聊天').props.onClick();
      assert.ok(button(page, '重新回答'));
    }
  } finally { page.unload(); page.dispose(); }
});
