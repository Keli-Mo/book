const https = require("node:https");
const { randomBytes } = require("node:crypto");
const { voiceError } = require("./errors");

async function decodeMp3ToWav(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 8 || audio.length > 300000) throw voiceError("INVALID_AUDIO");
  const { MPEGDecoder } = await import("mpg123-decoder");
  const decoder = new MPEGDecoder();
  try {
    await decoder.ready;
    const { channelData, sampleRate, samplesDecoded, errors } = decoder.decode(audio);
    if (errors?.length || ![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate) ||
        !Number.isSafeInteger(samplesDecoded) || samplesDecoded <= 0 || samplesDecoded > sampleRate * 30.15 ||
        !Array.isArray(channelData) || channelData.length < 1 || channelData.length > 2 ||
        channelData.some(channel => channel.length !== samplesDecoded)) throw voiceError("INVALID_AUDIO");
    // PCM decoding preserves every sample, including the tail. No VAD, trimming,
    // transcription hints or model-generated words are added to the recording.
    const wav = Buffer.alloc(44 + samplesDecoded * 2);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samplesDecoded * 2, 40);
    for (let i = 0; i < samplesDecoded; i++) {
      let sample = 0;
      for (const channel of channelData) sample += channel[i] / channelData.length;
      if (!Number.isFinite(sample)) throw voiceError("INVALID_AUDIO");
      wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)), 44 + i * 2);
    }
    return wav;
  } finally { decoder.free(); }
}

function postAudio(wav, key) {
  const boundary = "haisha-" + randomBytes(12).toString("hex");
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    wav, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return new Promise((resolve, reject) => {
    let deadline;
    const fail = error => { clearTimeout(deadline); reject(error); };
    const req = https.request("https://api.deepseek.com/v1/tools/asr", {
      method: "POST", agent: false, timeout: 15000,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": payload.length },
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; if (body.length > 65536) req.destroy(voiceError("ASR_UNAVAILABLE")); });
      res.on("error", fail);
      res.on("aborted", () => fail(Object.assign(Error("ASR response interrupted"), { code: "ECONNRESET" })));
      res.on("end", () => {
        clearTimeout(deadline);
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(Object.assign(Error("ASR HTTP error"), { statusCode: res.statusCode }));
        try { resolve(JSON.parse(body)); } catch { reject(voiceError("ASR_UNAVAILABLE")); }
      });
    });
    const timeout = () => req.destroy(Object.assign(Error("ASR timeout"), { code: "ETIMEDOUT" }));
    deadline = setTimeout(timeout, 15000);
    req.on("timeout", timeout); req.on("error", fail); req.end(payload);
  });
}

async function transcribeDeepseek(audio, key, options = {}) {
  if (!key) throw voiceError("CONFIG_MISSING");
  const wav = await decodeMp3ToWav(audio);
  const result = await (options.postAudio || postAudio)(wav, key);
  if (typeof result?.text !== "string") throw voiceError("ASR_UNAVAILABLE");
  return result.text;
}

module.exports = { decodeMp3ToWav, transcribeDeepseek, postAudio };
