import { Button, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, useUnload } from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";
import { createVoiceRecorder } from "@/features/voiceChat/recording";
import { readVoiceRecordingBase64, removeRecordedTempFile, removeVoiceFile, saveVoiceAudioBase64, sweepVoiceAudioFiles } from "@/features/voiceChat/playback";
import {
  beginRequest, completeRequest, createSession, currentTurns, failRequest,
  selectLevel, selectMode, selectTopic,
  type VoiceLevel, type VoiceMode, type VoiceSession, type VoiceTopic,
} from "@/features/voiceChat/session";
import { callVoiceChat, getVoiceChatQuota, getVoiceChatTrialId, isVoiceChatPreview, type VoiceChatQuota } from "@/services/voiceChat";
import { createVoiceChatReceipts } from "./receipts";
import { microphoneError, safeVoiceError, voiceError } from "@/services/voiceChatErrors";

import "./VoiceChat.scss";

type ChatPhase = "idle" | "recording" | "processing" | "speaking" | "repeat-recording";
const TOPICS: { id: VoiceTopic; label: string }[] = [
  { id: "animals", label: "动物" }, { id: "school", label: "校园" },
  { id: "food", label: "美食" }, { id: "travel", label: "旅行" },
];
const makeRequestId = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

function quotaDetails(quota: VoiceChatQuota | null) {
  if (!quota) return null;
  if (quota.kind === "unlimited") return { blocked: false, text: "内部测试 · 不限轮数" };
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
  const [error, setError] = useState("");
  const [repeatPath, setRepeatPath] = useState("");
  const repeatPathRef = useRef("");
  const [repeatIndex, setRepeatIndex] = useState(-1);
  const repeatForRef = useRef(-1);
  const recorderRef = useRef<ReturnType<typeof createVoiceRecorder> | null>(null);
  const playerRef = useRef<Taro.InnerAudioContext | null>(null);
  const audioPathsRef = useRef(new Map<string, string>());
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

  useEffect(() => { void sweepVoiceAudioFiles(() => new Set(audioPathsRef.current.values())); }, []);

  const updateSession = (next: VoiceSession) => { sessionRef.current = next; setSession(next); };
  const updatePhase = (next: ChatPhase) => { phaseRef.current = next; setPhase(next); };
  const stopPlayback = () => {
    const player = playerRef.current;
    playerRef.current = null;
    if (player) { try { player.stop(); player.destroy(); } catch (_error) { /* old player */ } }
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
    updateSession(selectTopic(sessionRef.current, topic));
  };

  const playPath = (filePath: string, requestId?: string) => {
    if (sessionRef.current.pendingRequestId || phaseRef.current === "recording" || phaseRef.current === "repeat-recording") return;
    stopPlayback();
    try {
      const player = Taro.createInnerAudioContext();
      playerRef.current = player;
      if (requestId) {
        player.onPlay(() => {
          if (!activeRef.current || playerRef.current !== player) return;
          setError("");
          receipts.playbackStarted(requestId);
        });
      }
      player.src = filePath;
      player.onEnded(() => { if (playerRef.current === player) { playerRef.current = null; player.destroy(); updatePhase("idle"); } });
      player.onError(() => {
        if (playerRef.current !== player) return;
        playerRef.current = null;
        player.destroy();
        updatePhase("idle");
        setError(requestId && receipts.isUnplayed(requestId) ? "英文语音未能播放，本轮还没有扣除。可点「重听」再试。" : voiceError("PLAYBACK_FAILED").message);
      });
      updatePhase("speaking");
      player.play();
    } catch (_error) { stopPlayback(); updatePhase("idle"); setError(voiceError("PLAYBACK_FAILED").message); }
  };
  const playReply = async (requestId: string, audioBase64: string, expectedGeneration = generationRef.current) => {
    try {
      let filePath = audioPathsRef.current.get(requestId);
      if (!filePath) {
        filePath = await saveVoiceAudioBase64(requestId, audioBase64);
        if (!activeRef.current) { void removeVoiceFile(filePath); return; }
        audioPathsRef.current.set(requestId, filePath);
      }
      if (activeRef.current && expectedGeneration === generationRef.current) playPath(filePath, requestId);
    } catch (_error) {
      if (activeRef.current && expectedGeneration === generationRef.current) {
        updatePhase("idle");
        setError(receipts.isUnplayed(requestId) ? "英文语音保存失败，本轮还没有扣除。可点「重听」再试。" : voiceError("FILE_SAVE_FAILED").message);
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

  const submitRecording = async (filePath: string, durationMs: number, generation: number) => {
    if (!activeRef.current || generation !== generationRef.current) return;
    updatePhase("processing");
    const snapshot = sessionRef.current;
    const requestId = makeRequestId();
    updateSession(beginRequest(snapshot, requestId));
    try {
      const audioBase64 = await readVoiceRecordingBase64(filePath).catch(() => { throw voiceError("FILE_READ_FAILED"); });
      if (audioBase64.length > 400000) throw voiceError("RECORD_TOO_LARGE");
      if (durationMs < 300) throw voiceError("RECORD_TOO_SHORT");
      const result = await callVoiceChat({
        requestId, mode: snapshot.mode, level: snapshot.level, topic: snapshot.topic,
        durationMs, audioBase64,
        turns: currentTurns(snapshot).slice(-8).map((turn) => ({ userEn: turn.userEn, assistantEn: turn.assistantEn })),
      });
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
      updateSession(next);
      setError("");
      await playReply(requestId, result.audioBase64, generation);
      if (result.receipt) void refreshQuota();
    } catch (caught) {
      if (!activeRef.current || generation !== generationRef.current) return;
      updateSession(failRequest(sessionRef.current, requestId));
      showError(safeVoiceError(caught, "VOICE_CHAT_ERROR").message);
      void refreshQuota();
    } finally {
      void removeRecordedTempFile(filePath);
    }
  };

  const ensureMic = async () => {
    if (Taro.getStorageSync("voiceChatAudioNoticeAccepted") !== true) {
      const choice = await Taro.showModal({
        title: "语音聊天说明",
        content: "录音会发给腾讯云识别；识别出的文字交给 DeepSeek 生成回答，英文回复再交给腾讯云合成语音。聊天不会保存到“我的打卡”。是否继续？",
        confirmText: "同意继续",
      });
      if (!choice.confirm) return false;
      Taro.setStorageSync("voiceChatAudioNoticeAccepted", true);
    }
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
    finally { startingRef.current = false; }
  };

  useDidShow(() => { receipts.retryPlayed(); void refreshQuota(); });
  useDidHide(() => { interrupt(); });
  useUnload(() => {
    activeRef.current = false;
    interrupt();
    clearRepeat();
    for (const filePath of audioPathsRef.current.values()) void removeVoiceFile(filePath);
    audioPathsRef.current.clear();
  });

  return (
    <View className='voice-chat'>
      <View className='voice-chat__settings'>
        <View className='voice-chat__switches'>
          <Button disabled={lockSettings} className={session.mode === "free" ? "is-active" : ""} onClick={() => changeMode("free")}>自由聊天</Button>
          <Button disabled={lockSettings} className={session.mode === "topic" ? "is-active" : ""} onClick={() => changeMode("topic")}>主题聊天</Button>
        </View>
        {session.mode === "topic" && <View className='voice-chat__topics'>
          {TOPICS.map((topic) => <Button key={topic.id} disabled={lockSettings} className={session.topic === topic.id ? "is-active" : ""} onClick={() => changeTopic(topic.id)}>{topic.label}</Button>)}
        </View>}
        <View className='voice-chat__levels'>
          <Text>对话难度</Text>
          <Button disabled={lockSettings} className={session.level === "basic" ? "is-active" : ""} onClick={() => changeLevel("basic")}>基础</Button>
          <Button disabled={lockSettings} className={session.level === "advanced" ? "is-active" : ""} onClick={() => changeLevel("advanced")}>进阶</Button>
        </View>
      </View>

      <ScrollView className='voice-chat__messages' scrollY scrollIntoView={turns.length ? `turn-${turns.length - 1}` : undefined}>
        {turns.length === 0 && <View className='voice-chat__empty'>
          {!balance?.blocked && <Text>想聊什么？点下方麦克风，用英语和我说话吧。</Text>}
          {isVoiceChatPreview() && phase === "idle" && <Button className='voice-chat__trial-id' size='mini' onClick={copyTrialId}>复制我的试用编号</Button>}
        </View>}
        {turns.map((turn, index) => <View id={`turn-${index}`} key={turn.requestId} className='voice-chat__turn'>
          <View className='voice-chat__user'><Text>{turn.userEn}</Text></View>
          <View className='voice-chat__assistant'>
            <Text className='voice-chat__english'>{turn.assistantEn}</Text>
            <Text className='voice-chat__chinese'>{turn.assistantZh}</Text>
            {turn.correction && <View className='voice-chat__correction'>
              <Text>更自然的说法：{turn.correction.betterEn}</Text>
              <Text>{turn.correction.explanationZh}</Text>
            </View>}
            <View className='voice-chat__actions'>
              <Button disabled={phase === "processing" || phase === "recording" || phase === "repeat-recording"} onClick={() => { void playReply(turn.requestId, turn.audioBase64); }}>重听</Button>
              <Button disabled={phase === "processing" || phase === "recording" || (phase === "repeat-recording" && repeatForRef.current !== index)} onClick={() => phase === "repeat-recording" && repeatForRef.current === index ? recorderRef.current?.stop() : void startRecording("repeat", index)}>
                {phase === "repeat-recording" && repeatForRef.current === index ? "结束跟读" : "跟读"}
              </Button>
              {repeatIndex === index && repeatPath && <Button disabled={phase === "processing" || phase === "recording" || phase === "repeat-recording"} onClick={() => playPath(repeatPath)}>回听自己</Button>}
            </View>
          </View>
        </View>)}
        {phase === "processing" && <View className='voice-chat__thinking'>正在听懂并准备英文回答…</View>}
      </ScrollView>

      <View className='voice-chat__composer'>
        {error && <Text className='voice-chat__error'>{error}</Text>}
        {balance && <View className='voice-chat__quota'>
          <Text>{balance.text}</Text>
          {balance.blocked && <Button className='voice-chat__refresh' onClick={() => { receipts.retryPlayed(); void refreshQuota(); }}>刷新轮数</Button>}
        </View>}
        <Button className='voice-chat__mic' disabled={phase === "processing" || phase === "repeat-recording" || (phase !== "recording" && balance?.blocked)} onClick={() => phase === "recording" ? recorderRef.current?.stop() : void startRecording("chat") }>
          {phase === "recording" ? "结束说话" : phase === "processing" ? "正在回复…" : "点这里说英语"}
        </Button>
        <Text className='voice-chat__notice'>{quota?.kind === "metered" ? "英文回复首次播放计 1 轮。重听和本地跟读免费。" : "聊天语音会发送到服务端处理；跟读录音只用于本地回听。"}</Text>
      </View>
    </View>
  );
}
