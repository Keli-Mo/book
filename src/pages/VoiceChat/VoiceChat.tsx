import { Button, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, useUnload } from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";
import { createVoiceRecorder } from "@/features/voiceChat/recording";
import { readVoiceRecordingBase64, removeRecordedTempFile, removeVoiceFile, saveVoiceAudioBase64, sweepVoiceAudioFiles } from "@/features/voiceChat/playback";
import {
  beginRequest, completeRequest, createSession, currentTurns, failRequest,
  selectLevel, selectMode, selectTopic,
  type VoiceLevel, type VoiceMode, type VoiceSession, type VoiceTopic, type VoiceTurn,
} from "@/features/voiceChat/session";
import { callVoiceChat, retryVoiceChat, getVoiceChatQuota, getVoiceChatTrialId, isVoiceChatPreview,
  type VoiceChatQuota, type VoiceChatContext, type VoiceChatError, type VoiceChatResponse } from "@/services/voiceChat";
import { createVoiceChatReceipts } from "./receipts";
import { microphoneError, safeVoiceError, voiceError } from "@/services/voiceChatErrors";
import VoiceOrb, { type VoiceOrbState } from "./VoiceOrb";

import "./VoiceChat.scss";

type ChatPhase = "idle" | "recording" | "processing" | "speaking" | "repeat-recording";
type PendingAudioWrite = { generation: number; promise: Promise<string | undefined> };
const TOPICS: { id: VoiceTopic; label: string }[] = [
  { id: "animals", label: "动物" }, { id: "school", label: "校园" },
  { id: "food", label: "美食" }, { id: "travel", label: "旅行" },
];
const makeRequestId = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const OPENERS: Record<VoiceTopic, { en: string; zh: string }> = {
  animals: { en: "What is your favorite animal?", zh: "你最喜欢什么动物？" },
  school: { en: "What do you like about school?", zh: "你喜欢学校里的什么？" },
  food: { en: "What food do you like?", zh: "你喜欢什么食物？" },
  travel: { en: "Where would you like to go?", zh: "你想去哪里玩？" },
};

function quotaDetails(quota: VoiceChatQuota | null) {
  if (!quota) return null;
  if (quota.kind === "unlimited") return { blocked: false, text: "内部测试" };
  const expired = quota.packExpiresAt !== null && quota.packExpiresAt <= Date.now();
  const packRemaining = expired ? 0 : quota.packRemaining;
  const remaining = quota.freeRemaining + packRemaining;
  if (quota.pendingUntil) return { blocked: true, text: "上一轮正在处理，确认后更新轮数。" };
  if (!remaining) {
    const text = quota.packExpiresAt === null ? "5 轮免费体验已用完。" : expired ? "体验包已到期，免费轮数也已用完。" : "可用轮数已用完。";
    return { blocked: true, text };
  }
  const balances: string[] = [];
  if (quota.freeRemaining) balances.push(`免费剩余 ${quota.freeRemaining} 轮`);
  if (packRemaining && quota.packExpiresAt) {
    const end = new Date(quota.packExpiresAt);
    const clock = [end.getHours(), end.getMinutes()].map(value => String(value).padStart(2, "0")).join(":");
    balances.push(`体验包剩余 ${packRemaining} 轮，${end.getMonth() + 1} 月 ${end.getDate()} 日 ${clock} 到期`);
  }
  return { blocked: false, text: balances.join(" · ") };
}

export default function VoiceChat() {
  const [session, setSession] = useState<VoiceSession>(createSession);
  const sessionRef = useRef(session);
  const [phase, setPhase] = useState<ChatPhase>("idle");
  const [starting, setStarting] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setPageError] = useState("");
  const errorPlaybackPathRef = useRef<string | undefined>();
  const [audioErrors, setAudioErrors] = useState<Record<string, string>>({});
  const [repeatPath, setRepeatPath] = useState("");
  const repeatPathRef = useRef("");
  const [repeatIndex, setRepeatIndex] = useState(-1);
  const repeatForRef = useRef(-1);
  const recorderRef = useRef<ReturnType<typeof createVoiceRecorder> | null>(null);
  const playerRef = useRef<Taro.InnerAudioContext | null>(null);
  const playingReplyRef = useRef<string | undefined>();
  const playbackIntentRef = useRef(0);
  const audioPathsRef = useRef(new Map<string, string>());
  const audioWritesRef = useRef(new Map<string, PendingAudioWrite>());
  const initialAudioSweepRef = useRef<Promise<void>>(Promise.resolve());
  const retryContextsRef = useRef(new Map<string, VoiceChatContext>());
  const generationRef = useRef(0);
  const activeRef = useRef(true);
  const phaseRef = useRef<ChatPhase>("idle");
  const startingRef = useRef(false);
  const [quota, setQuota] = useState<VoiceChatQuota | null>(null);
  const quotaVersion = useRef(0);
  const turns = currentTurns(session);
  const balance = quotaDetails(quota);
  const refreshQuota = useCallback(async () => {
    if (!activeRef.current) return;
    const version = ++quotaVersion.current;
    try {
      const latest = await getVoiceChatQuota();
      if (activeRef.current && version === quotaVersion.current) setQuota(latest);
    } catch { /* Recording still checks access server-side, including on older trial servers. */ }
  }, []);
  const [receipts] = useState(() => createVoiceChatReceipts(refreshQuota));
  const lockSettings = phase === "processing" && quota?.kind === "metered";

  useEffect(() => {
    if (quota?.kind !== "metered") return;
    const now = Date.now();
    const deadlines: number[] = [];
    if (quota.pendingUntil) deadlines.push(Math.max(now + 2000, quota.pendingUntil));
    if (quota.packExpiresAt && quota.packExpiresAt > now) deadlines.push(quota.packExpiresAt);
    if (!deadlines.length) return;
    const timer = setTimeout(() => { void refreshQuota(); }, Math.min(...deadlines) - now + 300);
    return () => clearTimeout(timer);
  }, [quota, refreshQuota]);

  useEffect(() => {
    initialAudioSweepRef.current = sweepVoiceAudioFiles(() => new Set(audioPathsRef.current.values())).catch(() => {});
  }, []);

  const setError = (message: string, playbackPath?: string) => {
    errorPlaybackPathRef.current = playbackPath;
    setPageError(message);
  };
  const setReplyAudioError = (requestId: string, message = "") => {
    setAudioErrors(previous => {
      if (!message && !previous[requestId]) return previous;
      const next = { ...previous };
      if (message) next[requestId] = message;
      else delete next[requestId];
      return next;
    });
  };
  const updateSession = (next: VoiceSession) => {
    const before = new Map([...sessionRef.current.freeTurns, ...sessionRef.current.topicTurns].map(turn => [turn.requestId, turn.audioBase64]));
    const retained = new Map([...next.freeTurns, ...next.topicTurns].filter(turn => turn.audioBase64).map(turn => [turn.requestId, turn.audioBase64]));
    const expired = (id: string) => !retained.has(id) || retained.get(id) !== before.get(id);
    if (playingReplyRef.current && expired(playingReplyRef.current)) stopPlayback();
    sessionRef.current = next; setSession(next);
    setAudioErrors(previous => {
      const removed = Object.keys(previous).filter(id => expired(id));
      if (!removed.length) return previous;
      const kept = { ...previous };
      for (const id of removed) delete kept[id];
      return kept;
    });
    for (const [id, path] of audioPathsRef.current) {
      if (!expired(id)) continue;
      audioPathsRef.current.delete(id);
      void removeVoiceFile(path);
    }
  };
  const updatePhase = (next: ChatPhase) => { phaseRef.current = next; setPhase(next); };
  const stopPlayback = () => {
    playbackIntentRef.current += 1;
    const player = playerRef.current;
    playerRef.current = null;
    playingReplyRef.current = undefined;
    if (player) { try { player.stop(); player.destroy(); } catch (_error) { /* old player */ } }
    setIsPlaying(false);
    if (phaseRef.current === "speaking") updatePhase("idle");
  };
  const interrupt = () => {
    generationRef.current += 1;
    recorderRef.current?.cancel();
    stopPlayback();
    if (sessionRef.current.pendingRequestId) updateSession(failRequest(sessionRef.current, sessionRef.current.pendingRequestId));
    updatePhase("idle");
  };
  const clearRepeat = () => {
    if (repeatPathRef.current) void removeRecordedTempFile(repeatPathRef.current);
    repeatPathRef.current = "";
    setRepeatPath("");
    setRepeatIndex(-1);
    repeatForRef.current = -1;
  };
  const changeMode = (mode: VoiceMode) => {
    if (mode === sessionRef.current.mode) return;
    interrupt(); clearRepeat(); setError("");
    updateSession(selectMode(sessionRef.current, mode));
  };
  const changeLevel = (level: VoiceLevel) => {
    if (level === sessionRef.current.level) return;
    interrupt(); setError("");
    updateSession(selectLevel(sessionRef.current, level));
  };
  const changeTopic = (topic: VoiceTopic) => {
    if (topic === sessionRef.current.topic) return;
    interrupt(); clearRepeat(); setError("");
    for (const turn of sessionRef.current.topicTurns) retryContextsRef.current.delete(turn.requestId);
    updateSession(selectTopic(sessionRef.current, topic));
  };

  const playPath = (filePath: string, requestId?: string) => {
    if (sessionRef.current.pendingRequestId || phaseRef.current === "recording" || phaseRef.current === "repeat-recording") return;
    stopPlayback();
    const showPlaybackFailure = () => {
      if (requestId) {
        setReplyAudioError(requestId, receipts.isUnplayed(requestId)
          ? "这条回复的语音播放失败，本轮还没有扣除。可点「重听」再试。"
          : "这条回复的语音播放失败，可点「重听」再试。");
      } else setError("这段跟读录音播放失败，可点「回听自己」再试。", filePath);
    };
    try {
      const player = Taro.createInnerAudioContext();
      playerRef.current = player;
      playingReplyRef.current = requestId;
      player.onPlay(() => {
        if (!activeRef.current || playerRef.current !== player) return;
        setIsPlaying(true);
        if (requestId) setReplyAudioError(requestId);
        else if (errorPlaybackPathRef.current === filePath) setError("");
        if (requestId) receipts.playbackStarted(requestId);
      });
      player.src = filePath;
      player.onEnded(() => { if (playerRef.current === player) { playerRef.current = null; playingReplyRef.current = undefined; player.destroy(); setIsPlaying(false); updatePhase("idle"); } });
      player.onError(() => {
        if (playerRef.current !== player) return;
        playerRef.current = null;
        playingReplyRef.current = undefined;
        player.destroy();
        setIsPlaying(false);
        updatePhase("idle");
        showPlaybackFailure();
      });
      updatePhase("speaking");
      player.play();
    } catch (_error) { stopPlayback(); updatePhase("idle"); showPlaybackFailure(); }
  };
  const playReply = async (requestId: string, audioBase64: string, expectedGeneration = generationRef.current) => {
    const intent = ++playbackIntentRef.current;
    try {
      // Do not let a delayed startup directory scan delete a newly saved reply.
      await initialAudioSweepRef.current;
      const retained = () => [...sessionRef.current.freeTurns, ...sessionRef.current.topicTurns]
        .some(turn => turn.requestId === requestId && turn.audioBase64 === audioBase64 && Boolean(audioBase64));
      if (!activeRef.current || expectedGeneration !== generationRef.current || !retained()) return;
      let filePath = audioPathsRef.current.get(requestId);
      // A reused save may already be deleting its stale file. Await that
      // deletion before recreating the path, with at most one fresh attempt.
      for (let attempt = 0; !filePath && attempt < 2; attempt++) {
        if (!activeRef.current || expectedGeneration !== generationRef.current || intent !== playbackIntentRef.current || !retained()) return;
        let pending = audioWritesRef.current.get(requestId);
        if (!pending) {
          const write: PendingAudioWrite = { generation: expectedGeneration, promise: Promise.resolve(undefined) };
          audioWritesRef.current.set(requestId, write);
          write.promise = saveVoiceAudioBase64(requestId, audioBase64).then(async savedPath => {
            if (!activeRef.current || write.generation !== generationRef.current || !retained()) {
              await removeVoiceFile(savedPath);
              return undefined;
            }
            audioPathsRef.current.set(requestId, savedPath);
            return savedPath;
          }).finally(() => {
            if (audioWritesRef.current.get(requestId) === write) audioWritesRef.current.delete(requestId);
          });
          pending = write;
        }
        // A new replay after switching back may reuse the same in-flight save.
        pending.generation = expectedGeneration;
        filePath = await pending.promise;
      }
      if (filePath && activeRef.current && expectedGeneration === generationRef.current && intent === playbackIntentRef.current && retained()) playPath(filePath, requestId);
    } catch (_error) {
      if (activeRef.current && expectedGeneration === generationRef.current && intent === playbackIntentRef.current) {
        updatePhase("idle");
        setReplyAudioError(requestId, receipts.isUnplayed(requestId)
          ? "这条回复的语音保存失败，本轮还没有扣除。可点「重听」再试。"
          : "这条回复的语音保存失败，可点「重听」再试。");
      }
    }
  };

  const showError = (message: string) => { if (activeRef.current) { updatePhase("idle"); setError(message); } };
  const copyTrialId = async () => {
    try {
      const openId = await getVoiceChatTrialId();
      if (activeRef.current) await Taro.setClipboardData({ data: openId });
    } catch {
      if (activeRef.current) void Taro.showToast({ title: "试用编号复制失败，请重试", icon: "none" });
    }
  };

  const runTurn = async (requestId: string, generation: number, invoke: () => Promise<VoiceChatResponse>) => {
    try {
      const result = await invoke();
      if (!activeRef.current || generation !== generationRef.current) {
        if (result.receipt) void refreshQuota();
        return;
      }
      const next = completeRequest(sessionRef.current, requestId, result);
      if (next === sessionRef.current) return;
      if (result.quota) {
        quotaVersion.current += 1;
        setQuota(result.quota);
      }
      if (result.receipt) receipts.add(result.receipt);
      retryContextsRef.current.delete(requestId);
      updateSession(next);
      setError("");
      await playReply(requestId, result.audioBase64, generation);
      if (result.receipt) void refreshQuota();
    } catch (caught) {
      if (!activeRef.current || generation !== generationRef.current) return;
      const safe = safeVoiceError(caught, "VOICE_CHAT_ERROR");
      const partial = (caught as VoiceChatError)?.partial;
      const next = failRequest(sessionRef.current, requestId, partial, { message: safe.message, retryable: safe.retryable !== false });
      updateSession(next);
      if (currentTurns(next).some(turn => turn.requestId === requestId)) {
        updatePhase("idle"); setError("");
      } else {
        retryContextsRef.current.delete(requestId);
        showError(`刚才这次录音：${safe.message}`);
      }
      void refreshQuota();
    }
  };

  const submitRecording = async (filePath: string, durationMs: number, generation: number) => {
    if (!activeRef.current || generation !== generationRef.current) { void removeRecordedTempFile(filePath); return; }
    updatePhase("processing");
    const snapshot = sessionRef.current;
    const requestId = makeRequestId();
    const context: VoiceChatContext = {
      requestId, mode: snapshot.mode, level: snapshot.level, topic: snapshot.topic,
      turns: currentTurns(snapshot).filter(turn => turn.assistantEn).slice(-8).map(turn => ({ userEn: turn.userEn, assistantEn: turn.assistantEn })),
    };
    retryContextsRef.current.set(requestId, context);
    updateSession(beginRequest(snapshot, requestId));
    try {
      await runTurn(requestId, generation, async () => {
        const audioBase64 = await readVoiceRecordingBase64(filePath).catch(() => { throw voiceError("FILE_READ_FAILED"); });
        if (audioBase64.length > 400000) throw voiceError("RECORD_TOO_LARGE");
        if (durationMs < 300) throw voiceError("RECORD_TOO_SHORT");
        return callVoiceChat({ ...context, durationMs, audioBase64 });
      });
    } finally { void removeRecordedTempFile(filePath); }
  };

  const retryTurn = (turn: VoiceTurn) => {
    const context = retryContextsRef.current.get(turn.requestId);
    if (!activeRef.current || !context || !turn.failure?.retryable || startingRef.current || balance?.blocked ||
        sessionRef.current.pendingRequestId || phaseRef.current === "recording" || phaseRef.current === "repeat-recording") return;
    stopPlayback(); setError("");
    updatePhase("processing");
    updateSession(beginRequest(sessionRef.current, turn.requestId));
    void runTurn(turn.requestId, generationRef.current, () => retryVoiceChat(turn.assistantEn && turn.assistantZh
      ? { ...context, action: "retrySpeech", transcript: turn.userEn,
        reply: { replyEn: turn.assistantEn, replyZh: turn.assistantZh, correction: turn.correction } }
      : { ...context, action: "retryReply", transcript: turn.userEn }));
  };

  const ensureMic = async () => {
    const setting = await Taro.getSetting();
    if (setting.authSetting["scope.record"] === false) {
      const choice = await Taro.showModal({ title: "需要麦克风权限", content: "请允许麦克风权限后再开始英语聊天。", confirmText: "去设置" });
      if (choice.confirm) await Taro.openSetting();
      return false;
    }
    if (setting.authSetting["scope.record"] !== true) {
      try { await Taro.authorize({ scope: "scope.record" }); }
      catch (caught) { showError(microphoneError(caught, "MIC_PERMISSION").message); return false; }
    }
    return true;
  };

  const startRecording = async (kind: "chat" | "repeat", index = -1) => {
    if (startingRef.current || (kind === "chat" && balance?.blocked) || phaseRef.current === "recording" ||
        phaseRef.current === "repeat-recording" || phaseRef.current === "processing" || sessionRef.current.pendingRequestId) return;
    startingRef.current = true;
    setStarting(true);
    const generation = generationRef.current;
    let setupComplete = false;
    try {
      if (!await ensureMic() || generation !== generationRef.current || !activeRef.current) return;
      setupComplete = true;
      stopPlayback(); setError("");
      if (!recorderRef.current) recorderRef.current = createVoiceRecorder();
      repeatForRef.current = kind === "repeat" ? index : -1;
      recorderRef.current.start((filePath, durationMs) => {
        if (generation !== generationRef.current || !activeRef.current) { void removeRecordedTempFile(filePath); return; }
        if (kind === "repeat") {
          if (repeatPathRef.current) void removeRecordedTempFile(repeatPathRef.current);
          repeatPathRef.current = filePath;
          setRepeatPath(filePath);
          setRepeatIndex(index);
          updatePhase("idle");
        } else {
          void submitRecording(filePath, durationMs, generation);
        }
      }, showError);
      if (recorderRef.current.isActive()) updatePhase(kind === "repeat" ? "repeat-recording" : "recording");
    } catch (caught) { showError(microphoneError(caught, setupComplete ? "RECORD_START" : "MIC_SETUP").message); }
    finally { startingRef.current = false; if (activeRef.current) setStarting(false); }
  };

  const onOrbClick = () => {
    if (startingRef.current) return;
    if (phaseRef.current === "recording" || phaseRef.current === "repeat-recording") {
      recorderRef.current?.stop();
    } else if (phaseRef.current === "speaking") {
      stopPlayback();
    } else if (phaseRef.current === "idle") {
      void startRecording("chat");
    }
  };
  const orbState: VoiceOrbState = starting ? "loading"
    : phase === "speaking" ? (isPlaying ? "speaking" : "loading")
      : phase !== "idle" ? phase
        : balance?.blocked ? "blocked" : error ? "error" : "idle";
  const orbLabel = starting ? "正在开启麦克风"
    : phase === "recording" ? "结束说话并发送"
      : phase === "repeat-recording" ? "结束跟读，保留本地录音"
        : phase === "speaking" ? "停止播放"
          : phase === "processing" ? "正在准备英文回复"
            : balance?.blocked ? "暂时无法开始聊天，请查看可用轮数" : "开始说英语";
  const opener = session.mode === "topic" ? OPENERS[session.topic]
    : session.level === "advanced"
      ? { en: "What was the best part of your day?", zh: "今天最开心的事情是什么？" }
      : { en: "Hi! What do you like to do?", zh: "嗨！你喜欢做什么？" };

  useDidShow(() => { receipts.retryPlayed(); void refreshQuota(); });
  useDidHide(() => { interrupt(); });
  useUnload(() => {
    activeRef.current = false;
    interrupt();
    clearRepeat();
    for (const filePath of audioPathsRef.current.values()) void removeVoiceFile(filePath);
    audioPathsRef.current.clear();
    retryContextsRef.current.clear();
  });

  return (
    <View className='voice-chat'>
      <View className='voice-chat__settings'>
        <View className='voice-chat__toolbar'>
          <View className='voice-chat__switches'>
            <Button disabled={lockSettings} className={session.mode === "free" ? "is-active" : ""} onClick={() => changeMode("free")}>自由聊天</Button>
            <Button disabled={lockSettings} className={session.mode === "topic" ? "is-active" : ""} onClick={() => changeMode("topic")}>主题聊天</Button>
          </View>
        </View>
        {session.mode === "topic" && <View className='voice-chat__topics'>
          {TOPICS.map((topic) => <Button key={topic.id} disabled={lockSettings} className={session.topic === topic.id ? "is-active" : ""} onClick={() => changeTopic(topic.id)}>{topic.label}</Button>)}
        </View>}
        <View className='voice-chat__levels'>
          <Text className='voice-chat__level-label'>难度</Text>
          <Button disabled={lockSettings} className={session.level === "basic" ? "is-active" : ""} onClick={() => changeLevel("basic")}>基础</Button>
          <Button disabled={lockSettings} className={session.level === "advanced" ? "is-active" : ""} onClick={() => changeLevel("advanced")}>进阶</Button>
          {isVoiceChatPreview() && <Button className='voice-chat__trial-id' ariaLabel='复制我的试用编号' onClick={copyTrialId}>试用编号</Button>}
        </View>
        {balance && <View className={`voice-chat__quota${balance.blocked ? " voice-chat__quota--blocked" : ""}`}>
          <View className='voice-chat__quota-dot' />
          <Text>{balance.text}</Text>
          {balance.blocked && <Button className='voice-chat__refresh' onClick={() => { receipts.retryPlayed(); void refreshQuota(); }}>刷新轮数</Button>}
        </View>}
      </View>

      <ScrollView className='voice-chat__messages' scrollY scrollWithAnimation scrollIntoView={phase === "processing" ? "voice-chat-thinking" : turns.length ? `turn-${turns.length - 1}` : undefined}>
        {turns.length === 0 && <View className='voice-chat__empty'>
          <View className='voice-chat__avatar' ariaRole='img' ariaLabel='英语伙伴'><View /><View /><View /></View>
          <Text className='voice-chat__eyebrow'>YOUR ENGLISH BUDDY</Text>
          <Text className='voice-chat__greeting'>{opener.en}</Text>
          <Text className='voice-chat__translation'>{opener.zh}</Text>
        </View>}
        {turns.map((turn, index) => <View id={`turn-${index}`} key={turn.requestId} className='voice-chat__turn'>
          <View className='voice-chat__user'><Text>{turn.userEn}</Text></View>
          <View className='voice-chat__assistant'>
            <Text className='voice-chat__speaker'>英语伙伴</Text>
            {turn.assistantEn && <Text className='voice-chat__english'>{turn.assistantEn}</Text>}
            {turn.assistantZh && <Text className='voice-chat__chinese'>{turn.assistantZh}</Text>}
            {turn.correction && <View className='voice-chat__correction'>
              <Text className='voice-chat__correction-title'>这样说更自然</Text>
              <Text className='voice-chat__correction-english'>{turn.correction.betterEn}</Text>
              <Text>{turn.correction.explanationZh}</Text>
            </View>}
            <View className='voice-chat__actions'>
              {turn.failure && <View className='voice-chat__turn-error' ariaRole='alert'><Text>{turn.failure.message}</Text></View>}
              {audioErrors[turn.requestId] && <View className='voice-chat__turn-error' ariaRole='alert'><Text>{audioErrors[turn.requestId]}</Text></View>}
              {turn.failure?.retryable && <Button disabled={starting || phase === "processing" || phase === "recording" || phase === "repeat-recording" || Boolean(balance?.blocked)} onClick={() => retryTurn(turn)}>
                {turn.assistantEn ? "重新发声" : "重新回答"}
              </Button>}
              {turn.audioBase64 && <Button disabled={phase === "processing" || phase === "recording" || phase === "repeat-recording"} onClick={() => { void playReply(turn.requestId, turn.audioBase64); }}>重听</Button>}
              {turn.assistantEn && <Button disabled={phase === "processing" || phase === "recording" || (phase === "repeat-recording" && repeatForRef.current !== index)} onClick={() => phase === "repeat-recording" && repeatForRef.current === index ? recorderRef.current?.stop() : void startRecording("repeat", index)}>
                {phase === "repeat-recording" && repeatForRef.current === index ? "结束跟读" : "跟读"}
              </Button>}
              {repeatIndex === index && repeatPath && <Button disabled={phase === "processing" || phase === "recording" || phase === "repeat-recording"} onClick={() => playPath(repeatPath)}>回听自己</Button>}
            </View>
          </View>
        </View>)}
        {phase === "processing" && <View id='voice-chat-thinking' className='voice-chat__thinking' ariaRole='status' ariaLabel='正在准备英文回复'><View /><View /><View /></View>}
      </ScrollView>

      <View className='voice-chat__composer'>
        {error && <View className='voice-chat__error' ariaRole='alert'><View className='voice-chat__error-mark'>!</View><Text>{error}</Text></View>}
        <VoiceOrb state={orbState} label={orbLabel} disabled={starting || phase === "processing" || (phase === "idle" && Boolean(balance?.blocked))} onClick={onOrbClick} />
      </View>
    </View>
  );
}
