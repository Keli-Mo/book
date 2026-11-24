const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { createProviders } = require('../cloudfunctions/voiceChat/providers');

test('ASR selection is server-configured; DeepSeek does not require Tencent credentials', async () => {
  const audio = Buffer.from('ID3fixture'); let calls = 0;
  const provider = createProviders({ env: { VOICE_CHAT_ASR_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'fixture' },
    deepseekTranscribe: async (received, key) => { calls++; assert.equal(received, audio); assert.equal(key, 'fixture'); return 'I like spaghetti.'; } });
  assert.equal(await provider.transcribe(audio), 'I like spaghetti.');
  assert.equal(calls, 1);
  await assert.rejects(() => createProviders({ env: { VOICE_CHAT_ASR_PROVIDER: 'unknown' } }).transcribe(audio), e => e.code === 'CONFIG_MISSING');
});

test('ASR upload is bounded multipart WAV and preserves timeout and HTTP error classification', async () => {
  const { postAudio } = require('../cloudfunctions/voiceChat/deepseekAsr');
  const original = https.request, wav = Buffer.from('RIFF-private-fixture-audio');
  try {
    for (const scenario of ['ok', 'unauthorized', 'timeout', 'malformed', 'aborted']) {
      https.request = (url, options, receive) => {
        assert.equal(url, 'https://api.deepseek.com/v1/tools/asr');
        assert.equal(options.timeout, 15000);
        assert.equal(options.headers.Authorization, 'Bearer fixture');
        const req = new EventEmitter(); req.destroy = error => req.emit('error', error);
        req.end = payload => queueMicrotask(() => {
          assert.equal(payload.length, options.headers['Content-Length']);
          assert.ok(payload.includes(wav));
          assert.ok(payload.toString().includes('name="file"; filename="speech.wav"'));
          if (scenario === 'timeout') return req.emit('timeout');
          const res = new EventEmitter(); res.setEncoding = () => {};
          res.statusCode = scenario === 'unauthorized' ? 401 : 200; receive(res);
          if (scenario === 'aborted') return res.emit('aborted');
          res.emit('data', scenario === 'ok' ? '{"text":"Hello"}' : 'private-invalid-response'); res.emit('end');
        });
        return req;
      };
      if (scenario === 'ok') assert.deepEqual(await postAudio(wav, 'fixture'), { text: 'Hello' });
      else await assert.rejects(() => postAudio(wav, 'fixture'), error => {
        assert.ok(!error.message.includes('private'));
        assert.equal(error.statusCode || error.code, { unauthorized: 401, timeout: 'ETIMEDOUT', malformed: 'ASR_UNAVAILABLE', aborted: 'ECONNRESET' }[scenario]);
        return true;
      });
    }
  } finally { https.request = original; }
});

test('actual MP3 decoder preserves a synthetic tone and creates a bounded PCM WAV', async () => {
  const { decodeMp3ToWav } = require('../cloudfunctions/voiceChat/deepseekAsr');
  const mp3 = fs.readFileSync(__dirname + '/fixtures/voice-tone.mp3');
  const wav = await decodeMp3ToWav(mp3);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  const duration = (wav.length - 44) / 32000;
  assert.ok(duration >= 0.2 && duration <= 0.35);
  const values = Array.from({ length: (wav.length - 44) / 2 }, (_, n) => wav.readInt16LE(44 + n * 2));
  assert.ok(values.some(n => n > 1000) && values.some(n => n < -1000));
  await assert.rejects(() => decodeMp3ToWav(Buffer.from('ID3invalid')), e => e.code === 'INVALID_AUDIO');
});

test('DeepSeek receives audio, not context prompts; invalid responses and silence stay distinct', async () => {
  const { transcribeDeepseek } = require('../cloudfunctions/voiceChat/deepseekAsr');
  const mp3 = fs.readFileSync(__dirname + '/fixtures/voice-tone.mp3');
  let uploads = 0;
  const postAudio = async (wav, key) => { uploads++; assert.equal(key, 'fixture'); assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); return { text: 'I like spaghetti.' }; };
  assert.equal(await transcribeDeepseek(mp3, 'fixture', { postAudio }), 'I like spaghetti.');
  assert.equal(uploads, 1);
  for (const response of [{}, { text: null }, { text: 123 }]) {
    await assert.rejects(() => transcribeDeepseek(mp3, 'fixture', { postAudio: async () => response }), e => e.code === 'ASR_UNAVAILABLE');
  }
  assert.equal(await transcribeDeepseek(mp3, 'fixture', { postAudio: async () => ({ text: '' }) }), '');
  await assert.rejects(() => transcribeDeepseek(mp3, undefined, { postAudio }), e => e.code === 'CONFIG_MISSING');
});
