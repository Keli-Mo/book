const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { modelReplyError } = require('../cloudfunctions/voiceChat/errors');

const appId = 'wxdb6824b2da985a21';
const request = { requestId: 'a'.repeat(32), mode: 'free', level: 'basic', turns: [],
  durationMs: 1400, audioBase64: Buffer.from('ID3-test-fixture').toString('base64'), progressProtocol: 1 };
const reply = { replyEn: 'Pasta is tasty! What sauce do you like?', replyZh: '意大利面很好吃！你喜欢什么酱汁？', correction: null };
const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/voiceChat/index.js'), 'utf8');

function load({ env = {}, context = { OPENID: 'new-tester', APPID: appId }, failReply = false } = {}) {
  const calls = [], logs = [];
  const moduleRef = { exports: {} };
  const environment = { VOICE_CHAT_ENABLED: 'true', VOICE_CHAT_ALLOWED_OPENIDS: 'owner',
    VOICE_CHAT_UNLIMITED_OPENIDS: 'owner', VOICE_CHAT_DEBUG_OPENIDS: 'owner',
    SCF_FUNCTIONNAME: 'voiceChatDiagnostics', VOICE_CHAT_OPEN_TRIAL: 'true', ...env };
  const cloud = { DYNAMIC_CURRENT_ENV: 'test-env', init() {}, getWXContext: () => context,
    database() { throw Error('Open test service must not initialize quota storage'); } };
  const requireStub = name => {
    if (name === 'wx-server-sdk') return cloud;
    if (name === './handler') return require('../cloudfunctions/voiceChat/handler');
    if (name === './quota') return { createQuotaStore() { throw Error('Unexpected quota storage'); } };
    if (name === './providers') return { createProviders: () => ({
      transcribe: async () => { calls.push('asr'); return 'I like 意大利面。'; },
      reply: async () => { calls.push('reply'); if (failReply) throw modelReplyError('MODEL_CONTENT_EMPTY'); return reply; },
      synthesize: async () => { calls.push('tts'); return 'QUJD'; },
    }) };
    throw Error('Unexpected import: ' + name);
  };
  new Function('module', 'exports', 'require', 'process', 'console', source)(
    moduleRef, moduleRef.exports, requireStub, { env: environment }, { warn: raw => logs.push(JSON.parse(raw)) });
  return { main: moduleRef.exports.main, calls, logs };
}

test('the explicitly opened diagnostics function accepts new same-app users without quota or individual lists', async () => {
  const { main, calls } = load({ env: { VOICE_CHAT_ALLOWED_OPENIDS: '', VOICE_CHAT_QUOTA_ENABLED: 'true' } });
  assert.deepEqual(await main({ action: 'quotaStatus' }), { ok: true, data: { quota: { kind: 'unlimited' } } });
  for (let n = 0; n < 7; n++) {
    const result = await main({ ...request, requestId: n.toString(16).padStart(32, '0') });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.quota, { kind: 'unlimited' });
    assert.equal(result.data.receipt, undefined);
  }
  assert.equal(calls.length, 21);
});

test('production, other functions, missing function identity and absent or malformed switches retain the original allowlist', async () => {
  for (const env of [
    { SCF_FUNCTIONNAME: 'voiceChat' }, { SCF_FUNCTIONNAME: 'someOtherFunction' }, { SCF_FUNCTIONNAME: undefined },
    { VOICE_CHAT_OPEN_TRIAL: undefined }, { VOICE_CHAT_OPEN_TRIAL: 'false' }, { VOICE_CHAT_OPEN_TRIAL: '1' },
  ]) {
    const unlisted = load({ env });
    assert.equal((await unlisted.main(request)).code, 'TRIAL_ONLY');
    assert.equal((await unlisted.main({ action: 'quotaStatus' })).code, 'TRIAL_ONLY');
    assert.deepEqual(unlisted.calls, []);
    const owner = load({ env, context: { OPENID: 'owner', APPID: appId } });
    assert.equal((await owner.main(request)).ok, true);
  }
});

test('open trial still requires trusted same-app identity and does not accept client-supplied identity or environment', async () => {
  for (const context of [{}, { OPENID: 'owner' }, { OPENID: 'owner', APPID: 'other-app' }, { APPID: appId }]) {
    const { main, calls } = load({ context });
    const forged = { ...request, openId: 'owner', OPENID: 'owner', APPID: appId, envVersion: 'trial', openTrial: true };
    assert.equal((await main(forged)).code, 'UNAUTHORIZED');
    assert.equal((await main({ ...forged, action: 'trialIdentity' })).code, 'UNAUTHORIZED');
    assert.deepEqual(calls, []);
  }
  const closed = load({ env: { VOICE_CHAT_OPEN_TRIAL: 'false' } });
  assert.equal((await closed.main({ ...request, openTrial: true, envVersion: 'trial', openId: 'owner' })).code, 'TRIAL_ONLY');
});

test('opening the service does not grant raw diagnostic logging unless all three internal lists contain the real user', async () => {
  for (const missing of ['VOICE_CHAT_ALLOWED_OPENIDS', 'VOICE_CHAT_UNLIMITED_OPENIDS', 'VOICE_CHAT_DEBUG_OPENIDS']) {
    const { main, logs } = load({ context: { OPENID: 'owner', APPID: appId }, env: { [missing]: '' }, failReply: true });
    const result = await main({ ...request, debug: true, openId: 'owner' });
    assert.equal(result.reasonCode, 'MODEL_CONTENT_EMPTY');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].debugText, undefined);
  }
  const publicUser = load({ failReply: true });
  assert.equal((await publicUser.main({ ...request, openId: 'owner', debug: true })).reasonCode, 'MODEL_CONTENT_EMPTY');
  assert.equal(publicUser.logs[0].debugText, undefined);
  const owner = load({ context: { OPENID: 'owner', APPID: appId }, failReply: true });
  await owner.main(request);
  assert.equal(owner.logs[0].debugText.transcript, 'I like 意大利面。');
});

test('the total enable switch and input validation remain effective for open trial users', async () => {
  const disabled = load({ env: { VOICE_CHAT_ENABLED: 'false' } });
  assert.equal((await disabled.main(request)).code, 'NOT_ENABLED');
  assert.deepEqual(disabled.calls, []);
  const opened = load();
  assert.equal((await opened.main({ ...request, durationMs: 30001 })).code, 'INVALID_ARGUMENT');
  assert.equal((await opened.main({ ...request, action: 'grantPack' })).code, 'INVALID_ARGUMENT');
  assert.equal((await opened.main({ action: 'confirmTurn' })).code, 'INVALID_RECEIPT');
  assert.deepEqual(opened.calls, []);
});
