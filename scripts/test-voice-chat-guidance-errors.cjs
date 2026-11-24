const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { failure, modelReplyError, voiceError, providerError } = require('../cloudfunctions/voiceChat/errors');

const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/services/voiceChatErrors.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const target = { exports: {} };
new Function('module', 'exports', compiled)(target, target.exports);
const client = target.exports;

test('model validation failures explain the failed answer without blaming the learner or asking for another recording', () => {
  for (const [reason, pattern] of [
    ['MODEL_ENGLISH_INVALID', /AI.*英文/],
    ['MODEL_FIELD_TOO_LONG', /AI.*过长/],
    ['MODEL_HTTP_RESPONSE_TOO_LARGE', /AI.*过长/],
    ['MODEL_FIELD_TYPE', /AI.*格式/],
    ['MODEL_OBJECT_INVALID', /AI.*格式/],
    ['MODEL_FIELD_EMPTY', /AI.*不完整/],
  ]) {
    const response = failure(modelReplyError(reason, 'private model response'));
    const error = client.safeVoiceError(response, 'VOICE_CHAT_ERROR');
    assert.equal(error.reasonCode, reason);
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /没听清|说错|中文导致|重新录|private/);
    assert.equal(client.safeVoiceError(error, 'VOICE_CHAT_ERROR').message, error.message);
  }
});

test('empty recognition gives a concrete short-English retry instruction and stays distinct from service faults', () => {
  const empty = failure(voiceError('NO_SPEECH'));
  assert.match(empty.message, /没有识别到文字/);
  assert.match(empty.message, /简短.*英语/);
  const error = client.safeVoiceError(empty, 'VOICE_CHAT_ERROR');
  assert.match(error.message, /没有识别到文字/);
  assert.match(error.message, /简短.*英语/);
  assert.match(error.message, /麦克风|慢一点/);
  for (const external of [{ code: 'ETIMEDOUT' }, { statusCode: 403 }, { statusCode: 503 }]) {
    const service = client.safeVoiceError(failure(providerError(external, 'asr')), 'VOICE_CHAT_ERROR');
    assert.notEqual(service.code, 'NO_SPEECH');
    assert.doesNotMatch(service.message, /没听清|没有识别到文字|说一句|说英语/);
  }
});
