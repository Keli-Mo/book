export type VoiceMode = "free" | "topic";
export type VoiceLevel = "basic" | "advanced";
export type VoiceTopic = "animals" | "school" | "food" | "travel";

export type VoiceCorrection = { betterEn: string; explanationZh: string };
export type VoicePartialReply = { transcript: string; replyEn?: string; replyZh?: string; correction?: VoiceCorrection };
export type VoiceTurnFailure = { message: string; retryable: boolean };
export type VoiceTurn = {
  requestId: string;
  userEn: string;
  assistantEn: string;
  assistantZh: string;
  correction?: VoiceCorrection;
  audioBase64: string;
  failure?: VoiceTurnFailure;
};

export type VoiceSession = {
  mode: VoiceMode;
  level: VoiceLevel;
  topic: VoiceTopic;
  freeTurns: VoiceTurn[];
  topicTurns: VoiceTurn[];
  pendingRequestId: string | null;
};

export type VoiceReply = {
  transcript: string;
  replyEn: string;
  replyZh: string;
  correction?: VoiceCorrection;
  audioBase64: string;
};

export const createSession = (): VoiceSession => ({
  mode: "free", level: "basic", topic: "animals",
  freeTurns: [], topicTurns: [], pendingRequestId: null,
});

export const currentTurns = (session: VoiceSession): VoiceTurn[] =>
  session.mode === "free" ? session.freeTurns : session.topicTurns;

export const selectMode = (session: VoiceSession, mode: VoiceMode): VoiceSession =>
  mode === session.mode ? session : { ...session, mode, pendingRequestId: null };

export const selectLevel = (session: VoiceSession, level: VoiceLevel): VoiceSession =>
  level === session.level ? session : { ...session, level, pendingRequestId: null };

export const selectTopic = (session: VoiceSession, topic: VoiceTopic): VoiceSession =>
  topic === session.topic ? session : { ...session, topic, topicTurns: [], pendingRequestId: null };

export const beginRequest = (session: VoiceSession, requestId: string): VoiceSession =>
  ({ ...session, pendingRequestId: requestId });

// Keep subtitles and conversation context. Only older replay audio expires.
// Both modes together retain at most 20 files / 2 MiB of decoded MP3 data.
const MAX_AUDIO_TURNS_PER_MODE = 10;
const MAX_AUDIO_BYTES_PER_MODE = 1024 * 1024;
function limitReplayAudio(turns: VoiceTurn[], newestRequestId: string): VoiceTurn[] {
  const retained = new Set<string>();
  let bytes = 0;
  const newest = turns.find(turn => turn.requestId === newestRequestId);
  const candidates = [...(newest ? [newest] : []), ...turns.slice().reverse()];
  for (const turn of candidates) {
    if (!turn.audioBase64 || retained.has(turn.requestId)) continue;
    const size = Math.floor(turn.audioBase64.length * 3 / 4) - (turn.audioBase64.match(/=+$/)?.[0].length || 0);
    if (retained.size >= MAX_AUDIO_TURNS_PER_MODE || bytes + size > MAX_AUDIO_BYTES_PER_MODE) continue;
    retained.add(turn.requestId); bytes += size;
  }
  return turns.map(turn => turn.audioBase64 && !retained.has(turn.requestId) ? { ...turn, audioBase64: "" } : turn);
}

export const completeRequest = (session: VoiceSession, requestId: string, reply: VoiceReply): VoiceSession => {
  if (session.pendingRequestId !== requestId) return session;
  const turn: VoiceTurn = {
    requestId,
    userEn: reply.transcript,
    assistantEn: reply.replyEn,
    assistantZh: reply.replyZh,
    ...(reply.correction ? { correction: reply.correction } : {}),
    audioBase64: reply.audioBase64,
  };
  const key = session.mode === "free" ? "freeTurns" : "topicTurns";
  const previous = session[key];
  const exists = previous.some(item => item.requestId === requestId);
  const updated = exists ? previous.map(item => item.requestId === requestId ? turn : item) : [...previous, turn];
  return { ...session, [key]: limitReplayAudio(updated, requestId), pendingRequestId: null };
};

export const failRequest = (session: VoiceSession, requestId: string, partial?: VoicePartialReply, failure?: VoiceTurnFailure): VoiceSession => {
  if (session.pendingRequestId !== requestId) return session;
  const key = session.mode === "free" ? "freeTurns" : "topicTurns";
  const previous = session[key].find(turn => turn.requestId === requestId);
  if (!failure || (!partial && !previous)) return { ...session, pendingRequestId: null };
  const turn: VoiceTurn = {
    requestId, userEn: partial?.transcript ?? previous!.userEn,
    assistantEn: partial?.replyEn ?? previous?.assistantEn ?? "",
    assistantZh: partial?.replyZh ?? previous?.assistantZh ?? "",
    correction: partial?.correction ?? previous?.correction,
    audioBase64: previous?.audioBase64 ?? "", failure,
  };
  return { ...session, [key]: previous ? session[key].map(item => item.requestId === requestId ? turn : item) : [...session[key], turn], pendingRequestId: null };
};
