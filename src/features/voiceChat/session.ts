export type VoiceMode = "free" | "topic";
export type VoiceLevel = "basic" | "advanced";
export type VoiceTopic = "animals" | "school" | "food" | "travel";

export type VoiceCorrection = { betterEn: string; explanationZh: string };
export type VoiceTurn = {
  requestId: string;
  userEn: string;
  assistantEn: string;
  assistantZh: string;
  correction?: VoiceCorrection;
  audioBase64: string;
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
  return { ...session, [key]: [...session[key], turn], pendingRequestId: null };
};

export const failRequest = (session: VoiceSession, requestId: string): VoiceSession =>
  session.pendingRequestId === requestId ? { ...session, pendingRequestId: null } : session;
