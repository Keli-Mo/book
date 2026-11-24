// Per-request diagnostics only. Never attach requests, credentials or audio.
const reasons = new Set([
  "MODEL_HTTP_RESPONSE_TOO_LARGE", "MODEL_HTTP_JSON_INVALID", "MODEL_FINISH_INCOMPLETE",
  "MODEL_CONTENT_MISSING", "MODEL_CONTENT_EMPTY", "MODEL_JSON_INVALID", "MODEL_OBJECT_INVALID",
  "MODEL_FIELD_TYPE", "MODEL_FIELD_EMPTY", "MODEL_FIELD_TOO_LONG", "MODEL_ENGLISH_INVALID",
  "MODEL_CHINESE_MISSING", "MODEL_CORRECTION_MISMATCH",
]);
const fields = new Set(["replyEn", "replyZh", "correction.betterEn", "correction.explanationZh"]);
const finishReasons = new Set(["stop", "length", "content_filter", "tool_calls", "function_call", "insufficient_system_resource"]);
const stages = new Set(["asr", "reply", "tts"]);
const finiteCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100000000;

function safeFailureDetails(error) {
  const source = error?.diagnostic;
  if (!source || !reasons.has(source.reasonCode)) return {};
  const details = { reasonCode: source.reasonCode };
  if (fields.has(source.field)) details.field = source.field;
  for (const name of ["actualLength", "maxLength"]) {
    if (finiteCount(source[name])) details[name] = source[name];
  }
  return details;
}

// Text is opt-in for an already-authorized internal tester. Common credential
// shapes are masked; no environment, HTTP headers or native errors are captured.
function excerpt(value, limit) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bAKID[A-Za-z0-9]{8,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .slice(0, limit);
}

function createDiagnostics(input, includeText = false) {
  const startedAt = Date.now();
  const metadata = {
    mode: input.mode, level: input.level,
    ...(input.topic ? { topic: input.topic } : {}),
    historyTurns: input.turns.length,
    inputAudioBytes: input.audio.length,
    inputDurationMs: input.durationMs,
  };
  const stageMs = {}, debugText = {}, modelAttempts = [];
  return {
    stageFinished(stage, elapsed) {
      if (stages.has(stage) && finiteCount(elapsed)) stageMs[stage] = elapsed;
    },
    transcript(value) {
      if (typeof value !== "string") return;
      metadata.transcriptCharacters = value.length;
      if (includeText) {
        debugText.transcript = excerpt(value, 500);
        debugText.transcriptTruncated = value.length > 500;
      }
    },
    modelResponse(value) {
      const choice = value?.choices?.[0], content = choice?.message?.content;
      const model = { finishReason: finishReasons.has(choice?.finish_reason) ? choice.finish_reason : "unknown" };
      model.contentKind = content === undefined ? "missing" : typeof content !== "string" ? "non_string"
        : content.length === 0 ? "empty" : content.trim().length === 0 ? "whitespace" : "text";
      for (const [target, key] of [["promptTokens", "prompt_tokens"], ["completionTokens", "completion_tokens"]]) {
        if (finiteCount(value?.usage?.[key])) model[target] = value.usage[key];
      }
      if (typeof content === "string") {
        model.contentCharacters = content.length;
        model.trimmedCharacters = content.trim().length;
        model.blank = model.trimmedCharacters === 0;
        if (includeText) {
          debugText.modelContent = excerpt(content, 2000);
          debugText.modelContentTruncated = content.length > 2000;
        }
      }
      metadata.model = model;
      if (modelAttempts.length < 2) modelAttempts.push({ ...model });
    },
    snapshot() {
      return {
        ...metadata, elapsedMs: Math.max(0, Date.now() - startedAt), stageMs: { ...stageMs },
        ...(modelAttempts.length > 1 ? { modelAttempts: modelAttempts.map(model => ({ ...model })) } : {}),
        ...(includeText && Object.keys(debugText).length ? { debugText: { ...debugText } } : {}),
      };
    },
  };
}

module.exports = { createDiagnostics, safeFailureDetails };
