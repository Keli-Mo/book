const https = require("node:https");
const { voiceError } = require("./errors");

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const TOPIC_LABELS = { animals: "animals", school: "school life", food: "food", travel: "travel" };

const configError = () => voiceError("CONFIG_MISSING");

function buildMessages(input) {
  const difficulty = input.level === "basic"
    ? "Use short everyday English sentences, one simple follow-up question, and words suited to a beginner."
    : "Use natural but clear English, a fuller reply, and one thoughtful follow-up question.";
  const scope = input.mode === "topic"
    ? `Stay on the topic of ${TOPIC_LABELS[input.topic] || "everyday life"}. If the child wanders, gently return to it.`
    : "Let the child choose the topic and follow their interests.";
  const instruction = [
    "You are a friendly English speaking partner for a child.",
    difficulty, scope,
    "Respond to the child's meaning first. If a clear and useful mistake occurs, correct at most one point naturally in the spoken English reply. Do not invent a mistake or correct uncertain pronunciation from a transcript.",
    "Reply with JSON only: {\"replyEn\":string,\"replyZh\":string,\"correction\":null|{\"betterEn\":string,\"explanationZh\":string}}.",
    "replyEn must be English only, at most 220 characters, and include the exact betterEn sentence when correction is present. replyZh translates the whole replyEn into Chinese. explanationZh briefly explains the one correction in Chinese.",
    "Keep the content appropriate for children. Do not ask for personal contact details or an address.",
  ].join(" ");
  const messages = [{ role: "system", content: instruction }];
  for (const turn of input.turns) {
    messages.push({ role: "user", content: turn.userEn });
    messages.push({ role: "assistant", content: turn.assistantEn });
  }
  messages.push({ role: "user", content: input.transcript });
  return messages;
}

function postJson(url, apiKey, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 20000,
      agent: false,
    }, (res) => {
      let result = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        result += chunk;
        if (result.length > 1000000) req.destroy(voiceError("BAD_MODEL_REPLY"));
      });
      res.on("error", reject);
      res.on("aborted", () => reject(Object.assign(new Error("Response interrupted"), { code: "ECONNRESET" })));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(Object.assign(new Error("DeepSeek HTTP error"), { statusCode: res.statusCode }));
        try { resolve(JSON.parse(result)); } catch { reject(voiceError("BAD_MODEL_REPLY")); }
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("DeepSeek timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end(payload);
  });
}

function tencentClientConfig(env) {
  const inCloud = env.TENCENTCLOUD_RUNENV === "SCF" || Boolean(env.SCF_FUNCTIONNAME);
  let secretId = env.VOICE_CHAT_TENCENT_SECRET_ID;
  let secretKey = env.VOICE_CHAT_TENCENT_SECRET_KEY;
  // Older local test runners supply this pair. Keep each credential pair together.
  if (!inCloud && secretId === undefined && secretKey === undefined) {
    secretId = env.TENCENTCLOUD_SECRET_ID;
    secretKey = env.TENCENTCLOUD_SECRET_KEY;
  }
  if (!secretId || !secretKey) throw configError();
  return {
    credential: { secretId, secretKey },
    region: env.VOICE_CHAT_TENCENT_REGION || (!inCloud && env.TENCENTCLOUD_REGION) || "ap-guangzhou",
    profile: { httpProfile: { reqMethod: "POST", reqTimeout: 15 } },
  };
}

function createProviders(options = {}) {
  const env = options.env || process.env;
  return {
    async transcribe(audio) {
      const config = tencentClientConfig(env);
      const client = options.asrClient || new (require("tencentcloud-sdk-nodejs-asr").asr.v20190614.Client)(config);
      const result = await client.SentenceRecognition({
        EngSerViceType: "16k_en", SourceType: 1, VoiceFormat: "mp3",
        Data: audio.toString("base64"), DataLen: audio.length,
      });
      if (typeof result?.Result !== "string") throw voiceError("ASR_UNAVAILABLE");
      return result.Result;
    },
    async reply(input) {
      if (!env.DEEPSEEK_API_KEY) throw configError();
      const result = await (options.postJson || postJson)(DEEPSEEK_URL, env.DEEPSEEK_API_KEY, {
        model: "deepseek-flash",
        messages: buildMessages(input),
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        max_tokens: 350,
        stream: false,
      });
      if (result?.choices?.[0]?.finish_reason !== "stop") throw voiceError("BAD_MODEL_REPLY");
      const content = result.choices[0].message?.content;
      if (typeof content !== "string" || !content.trim()) throw voiceError("BAD_MODEL_REPLY");
      try { return JSON.parse(content); } catch { throw voiceError("BAD_MODEL_REPLY"); }
    },
    async synthesize(text, context) {
      const config = tencentClientConfig(env);
      const client = options.ttsClient || new (require("tencentcloud-sdk-nodejs-tts").tts.v20190823.Client)(config);
      const result = await client.TextToVoice({
        Text: text, SessionId: context.requestId, VoiceType: 101050,
        PrimaryLanguage: 2, SampleRate: 16000, Codec: "mp3",
        Speed: context.level === "basic" ? -1 : 0,
      });
      return result?.Audio || "";
    },
  };
}

module.exports = { buildMessages, createProviders, tencentClientConfig };
