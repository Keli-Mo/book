const https = require("node:https");
const { voiceError, modelReplyError } = require("./errors");

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
    "The child may use Chinese or mix Chinese and English. Never shame or criticize Chinese use. For a Chinese-only utterance whose meaning is clear, acknowledge its meaning, model one short useful English sentence, and gently invite the child to try saying that sentence in English. The only question must invite practice of that modeled sentence; never ask about a new topic or preferences instead. This also applies when the child says they do not know how to say something in English: offer a simple request for help and invite them to try it. Make this an invitation, not a demand; do not add a second practice question or treat Chinese use as a grammar mistake.",
    "For a mixed-language utterance whose meaning is clear, continue normal conversation in English. Offer at most one useful English expression when needed; do not interrupt every mixed-language turn with a request to speak only English.",
    "Understand the whole utterance, including negation and preferences, and respond to its meaning in English. When useful, naturally model one short English expression for a clear Chinese phrase. This optional vocabulary help shares the one-point correction limit: choose just ONE unfamiliar word or short phrase OR ONE grammar point, never combine multiple translations or an extra grammar lesson. Explain vocabulary help kindly in Chinese, not as a grammar error. Do not repeat an expression already taught in recent history unless the child asks for it again.",
    "Transcripts may contain stray letters, duplicated words or mixed-script recognition artifacts. If the meaning is clear, continue naturally without commenting on the recording, the language mix or how well the child spoke. Do not teach or correct those artifacts, invent a pronunciation error, or claim you heard words not established by the transcript. If the English expression is already present beside its Chinese equivalent, no vocabulary correction is needed.",
    "If the intended meaning is uncertain, briefly say you are not sure what the child means and invite them to say it again in a short English sentence before continuing the topic. Do not guess a specific word, offer invented candidate meanings, or treat an uncertain interpretation as fact. You do not have access to the audio: do not claim the child spoke unclearly, the microphone failed, or recognition was wrong. Set correction to null for such clarification. Clarification and language support take priority over topic prompting.",
    "If the current utterance contains profanity, gently invite one friendly English sentence without repeating the profanity or lecturing. Do not infer that the child is angry or upset, and do not claim the words were misrecognized. Set correction to null for this redirection.",
    "Respond to the child's meaning first. If a clear and useful mistake occurs, correct at most one point naturally in the spoken English reply. Do not invent a mistake or correct uncertain pronunciation from a transcript.",
    "Return exactly one valid JSON object. Start with { and end with }. Do not output Markdown or text outside JSON. Past assistant messages are conversation history; your next response must always follow this JSON format.",
    "Example without a correction:",
    JSON.stringify({ replyEn: "I like apples! What fruit do you like?", replyZh: "我喜欢苹果！你喜欢什么水果？", correction: null }),
    "Example with one correction:",
    JSON.stringify({ replyEn: "I like pandas. Pandas are cute! What other animals do you like?", replyZh: "我喜欢熊猫。熊猫很可爱！你还喜欢什么动物？", correction: { betterEn: "I like pandas.", explanationZh: "泛指喜欢熊猫，用复数 pandas。" } }),
    "Example of optional vocabulary help for a clear mixed-language utterance, I like 意大利面, when the expression has not already been taught:",
    JSON.stringify({ replyEn: 'Pasta is tasty! You can say, "I like pasta." What sauce do you like?', replyZh: "意大利面很好吃！你可以说：我喜欢意大利面。你喜欢什么酱汁？", correction: { betterEn: "I like pasta.", explanationZh: "意大利面可以用 pasta 表达。" } }),
    "Example for a clear Chinese-only utterance, 我喜欢熊猫:",
    JSON.stringify({ replyEn: 'Pandas are cute! You can say, "I like pandas." Can you try saying it in English?', replyZh: "熊猫很可爱！你可以说：我喜欢熊猫。你能试着用英语说一遍吗？", correction: null }),
    "Example for a Chinese-only request for help, 我不知道怎么用英语说:",
    JSON.stringify({ replyEn: 'That\'s okay! You can say, "Please help me say it in English." Can you try that?', replyZh: "没关系！你可以说：请帮我用英语表达。你能试着说一遍吗？", correction: null }),
    "Example when the intended object is unclear, I like 那个，就是那个:",
    JSON.stringify({ replyEn: "I'm not sure what you mean. Could you say it again in a short English sentence?", replyZh: "我还不确定你的意思。你能用一句简短的英语再说一遍吗？", correction: null }),
    "Example for a profane utterance:",
    JSON.stringify({ replyEn: "Let's try a friendly English sentence. What do you like?", replyZh: "我们试着说一句友善的英语吧。你喜欢什么？", correction: null }),
    "replyEn must be English only, at most 220 characters, and include the exact betterEn sentence when correction is present. Never quote or copy Chinese source words into replyEn or betterEn, including inside quotation marks; put Chinese only in replyZh or explanationZh. replyZh translates the whole replyEn into Chinese. explanationZh briefly explains the one correction in Chinese.",
    "Keep the content appropriate for children. Do not ask for personal contact details or an address.",
    "The user message is a JSON object containing conversation history and currentUtterance. Respond only to currentUtterance, using history as context. Always return the complete JSON reply object.",
  ].join("\n");
  // Plain assistant history encourages a plain-English continuation, which
  // JSON mode masks as spaces. Preserve it as data, not output examples.
  return [{ role: "system", content: instruction },
    { role: "user", content: JSON.stringify({ conversation: input.turns, currentUtterance: input.transcript }) }];
}

function postJson(url, apiKey, body, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let deadline;
    const fail = error => { clearTimeout(deadline); reject(error); };
    const payload = JSON.stringify(body);
    const req = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: timeoutMs,
      agent: false,
    }, (res) => {
      let result = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        result += chunk;
        if (result.length > 1000000) req.destroy(modelReplyError("MODEL_HTTP_RESPONSE_TOO_LARGE"));
      });
      res.on("error", fail);
      res.on("aborted", () => fail(Object.assign(new Error("Response interrupted"), { code: "ECONNRESET" })));
      res.on("end", () => {
        clearTimeout(deadline);
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(Object.assign(new Error("DeepSeek HTTP error"), { statusCode: res.statusCode }));
        try { resolve(JSON.parse(result)); } catch { reject(modelReplyError("MODEL_HTTP_JSON_INVALID")); }
      });
    });
    deadline = setTimeout(() => req.destroy(Object.assign(new Error("DeepSeek timeout"), { code: "ETIMEDOUT" })), timeoutMs);
    req.on("timeout", () => req.destroy(Object.assign(new Error("DeepSeek timeout"), { code: "ETIMEDOUT" })));
    req.on("error", fail);
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
      // DevTools can return an EBML/WebM container with an .mp3 filename.
      // Diagnose the actual bytes before sending unsupported audio to ASR.
      if (audio.length >= 4 && audio.readUInt32BE(0) === 0x1a45dfa3) throw voiceError("AUDIO_FORMAT_UNSUPPORTED");
      if (env.VOICE_CHAT_ASR_PROVIDER === "deepseek") {
        return (options.deepseekTranscribe || require("./deepseekAsr").transcribeDeepseek)(audio, env.DEEPSEEK_API_KEY);
      }
      if (env.VOICE_CHAT_ASR_PROVIDER && env.VOICE_CHAT_ASR_PROVIDER !== "tencent") throw configError();
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
      const now = options.now || Date.now;
      const startedAt = now();
      let body = {
        model: "deepseek-flash",
        messages: buildMessages(input),
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        max_tokens: 350,
        stream: false,
      };
      // At most two model calls share one 20-second budget. HTTP/permission
      // failures and nonblank malformed responses are never blindly retried.
      for (let attempt = 0; attempt < 2; attempt++) {
        const remainingMs = Math.max(1, 20000 - (now() - startedAt));
        if (attempt && remainingMs < 1000) throw modelReplyError("MODEL_CONTENT_EMPTY");
        const result = await (options.postJson || postJson)(DEEPSEEK_URL, env.DEEPSEEK_API_KEY, body, remainingMs);
        // Collect bounded diagnostics before validation discards a response.
        try {
          const observation = input.diagnostics?.modelResponse(result);
          if (observation?.catch) observation.catch(() => {});
        } catch {}
        if (result?.choices?.[0]?.finish_reason !== "stop") throw modelReplyError("MODEL_FINISH_INCOMPLETE");
        const content = result.choices[0].message?.content;
        if (typeof content !== "string") throw modelReplyError("MODEL_CONTENT_MISSING");
        if (!content.trim()) {
          if (attempt === 1) throw modelReplyError("MODEL_CONTENT_EMPTY");
          body = { ...body, messages: [{ ...body.messages[0], content: body.messages[0].content +
            "\nYour previous attempt returned no JSON. Return a non-empty JSON object containing replyEn, replyZh and correction. Do not output plain conversation outside the object." }, body.messages[1]] };
          continue;
        }
        try { return JSON.parse(content); } catch { throw modelReplyError("MODEL_JSON_INVALID"); }
      }
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
