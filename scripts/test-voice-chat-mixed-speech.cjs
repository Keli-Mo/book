const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createProviders } = require('../cloudfunctions/voiceChat/providers');
const { createHandler } = require('../cloudfunctions/voiceChat/handler');

const request = { requestId: 'c'.repeat(32), mode: 'free', level: 'basic', turns: [],
  durationMs: 2500, audioBase64: Buffer.from('ID3fixture-audio').toString('base64'), progressProtocol: 1 };
const answer = { replyEn: 'Pasta is tasty! What sauce do you like?', replyZh: '意大利面很好吃！你喜欢什么酱汁？', correction: null };
const response = content => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
const access = { enabled: true, getOpenId: () => 'tester', allowedOpenIds: new Set(['tester']) };

test('mixed Chinese and English survives ASR, conversation history and returned subtitles unchanged; TTS only receives English', async () => {
  for (const transcript of ['I like 意大利面。', 'I like pasta t意面。', '我喜欢意大利面。']) {
    const inputs = [], spoken = [], turns = [{ userEn: '我饿了。', assistantEn: 'What food do you like?' }];
    const providers = createProviders({ env: { DEEPSEEK_API_KEY: 'fixture' }, postJson: async (_url, _key, body) => {
      inputs.push(JSON.parse(body.messages[1].content));
      return response(JSON.stringify(answer));
    } });
    const handler = createHandler({ ...providers, ...access, transcribe: async () => transcript,
      synthesize: async text => { spoken.push(text); return 'QUJD'; } });
    const result = await handler({ ...request, turns });
    assert.equal(result.ok, true);
    assert.equal(result.data.transcript, transcript);
    assert.deepEqual(inputs, [{ conversation: turns, currentUtterance: transcript }]);
    assert.deepEqual(spoken, [answer.replyEn]);
  }
});

test('mixed transcript remains available after two empty replies and retryReply uses it without another recognition', async () => {
  const transcript = 'I like 意大利面。', logs = [];
  let asrCalls = 0, modelCalls = 0, ttsCalls = 0;
  const providers = createProviders({ env: { DEEPSEEK_API_KEY: 'fixture' }, postJson: async () => {
    modelCalls++;
    return response(modelCalls <= 2 ? '  ' : JSON.stringify(answer));
  } });
  const handler = createHandler({ ...providers, ...access,
    unlimitedOpenIds: new Set(['tester']), debugOpenIds: new Set(['tester']),
    transcribe: async () => { asrCalls++; return transcript; },
    synthesize: async () => { ttsCalls++; return 'QUJD'; }, logDiagnostic: value => logs.push(value) });
  const failed = await handler(request);
  assert.equal(failed.ok, false);
  assert.equal(failed.reasonCode, 'MODEL_CONTENT_EMPTY');
  assert.equal(failed.partial.transcript, transcript);
  assert.equal(logs[0].debugText.transcript, transcript);
  const recovered = await handler({ ...request, action: 'retryReply', transcript: failed.partial.transcript });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.data.transcript, transcript);
  assert.equal(asrCalls, 1);
  assert.equal(modelCalls, 3);
  assert.equal(ttsCalls, 1);
});
