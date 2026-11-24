const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildMessages, createProviders } = require('../cloudfunctions/voiceChat/providers');
const { createHandler, parseReply } = require('../cloudfunctions/voiceChat/handler');

const context = { requestId: 'a'.repeat(32), mode: 'free', level: 'basic', turns: [] };
const prompt = buildMessages({ ...context, transcript: '我喜欢熊猫。' })[0].content;
const lines = prompt.split('\n');
function example(label) {
  const index = lines.findIndex(line => line.startsWith(label));
  assert.ok(index >= 0, `missing guidance example: ${label}`);
  return JSON.parse(lines[index + 1]);
}

test('Chinese-only guidance models one English sentence and gently invites practice', () => {
  const value = example('Example for a clear Chinese-only utterance');
  assert.match(value.replyEn, /You can say/);
  assert.match(value.replyEn, /(?:try|say).*English/i);
  assert.equal(value.correction, null, 'using Chinese is not a grammar mistake');
  assert.match(prompt, /Chinese-only.*meaning is clear/i);
  assert.match(prompt, /mixed-language.*normal conversation/i);
  assert.match(prompt, /Never shame|Do not shame/);
});

test('Chinese request for English help ends with practice of the example, not a change of topic', () => {
  const value = example('Example for a Chinese-only request for help');
  assert.match(value.replyEn, /You can say/);
  assert.match(value.replyEn, /Please help me say it in English/);
  assert.match(value.replyEn, /Can you try/);
  assert.doesNotMatch(value.replyEn, /what.*(?:talk|like)|what topic/i);
  assert.equal(value.correction, null);
  assert.equal((value.replyEn.match(/\?/g) || []).length, 1);
  assert.match(prompt, /only question must invite.*modeled sentence.*never ask about a new topic/i);
});

test('unclear meaning asks for another short English sentence without inventing an object', () => {
  const value = example('Example when the intended object is unclear');
  assert.match(value.replyEn, /say.*again.*short English sentence/i);
  assert.equal(value.correction, null);
  assert.doesNotMatch(value.replyEn, /panda|pasta|apple|heard|angry|upset/i);
  assert.match(prompt, /Do not guess a specific word/);
  assert.match(prompt, /do not have access to the audio/i);
});

test('profane text gets a friendly English prompt without guessing emotion or recognition quality', () => {
  const value = example('Example for a profane utterance');
  assert.match(value.replyEn, /friendly English sentence/i);
  assert.equal(value.correction, null);
  assert.doesNotMatch(value.replyEn, /fuck|angry|upset|rude|bad word|misheard|recognition/i);
  assert.match(prompt, /Do not infer.*angry|Do not infer.*upset/i);
});

test('every guidance example is valid for the actual bilingual reply validator and English speech', () => {
  const examples = lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.ok(examples.length >= 6, 'Chinese-only and profanity examples must accompany normal and mixed speech');
  for (const value of examples) {
    assert.doesNotThrow(() => parseReply(value));
    assert.ok(value.replyEn.length <= 220);
    assert.doesNotMatch(value.replyEn, /\p{Script=Han}/u);
    assert.ok((value.replyEn.match(/\?/g) || []).length <= 1);
  }
  assert.match(prompt, /Never quote.*Chinese.*replyEn/i);
});

test('Chinese guidance preserves original transcription and sends only English to speech synthesis', async () => {
  const expected = example('Example for a clear Chinese-only utterance');
  const transcript = '我喜欢熊猫。';
  const spoken = [], modelInputs = [];
  const providers = createProviders({ env: { DEEPSEEK_API_KEY: 'fixture' }, postJson: async (_url, _key, body) => {
    modelInputs.push(JSON.parse(body.messages[1].content));
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(expected) } }] };
  } });
  const handler = createHandler({ ...providers, enabled: true, getOpenId: () => 'tester', allowedOpenIds: new Set(['tester']),
    transcribe: async () => transcript, synthesize: async text => { spoken.push(text); return 'QUJD'; } });
  const result = await handler({ ...context, durationMs: 2500,
    audioBase64: Buffer.from('ID3fixture-audio').toString('base64'), progressProtocol: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.data.transcript, transcript);
  assert.equal(result.data.replyZh, expected.replyZh);
  assert.deepEqual(spoken, [expected.replyEn]);
  assert.deepEqual(modelInputs, [{ conversation: [], currentUtterance: transcript }]);
});

test('guidance does not convert empty recognition or ASR failure into a fabricated model turn', async () => {
  for (const [transcribe, code] of [
    [async () => '', 'NO_SPEECH'],
    [async () => { throw Object.assign(new Error('fixture'), { code: 'ETIMEDOUT' }); }, 'ASR_TIMEOUT'],
  ]) {
    const calls = [];
    const handler = createHandler({ enabled: true, getOpenId: () => 'tester', allowedOpenIds: new Set(['tester']), transcribe,
      reply: async () => { calls.push('reply'); }, synthesize: async () => { calls.push('tts'); } });
    const result = await handler({ ...context, durationMs: 2500,
      audioBase64: Buffer.from('ID3fixture-audio').toString('base64'), progressProtocol: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.partial, undefined);
    assert.deepEqual(calls, []);
  }
});
