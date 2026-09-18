import { Button, Image, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, useRouter, useShareAppMessage, useUnload } from "@tarojs/taro";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { buildDeviceLayoutClassName } from "@/features/layout/deviceLayout";
import { createTrackAudioController, getPlaybackPositionMs } from "@/features/listeningPractice/audioPlayback";
import { buildBookPracticeBundle } from "@/features/listeningPractice/bookPractice";
import type { CheckInSubmissionHandle } from "@/features/listeningPractice/checkInSubmissionCoordinator";
import { getCheckInSubmissionCoordinator } from "@/features/listeningPractice/checkInSubmissionRuntime";
import { getPendingCheckInStore, logRecordingDiagnostic } from "@/features/listeningPractice/pendingCheckInRuntime";
import type { PendingCheckIn } from "@/features/listeningPractice/pendingCheckInStore";
import { getCheckInDetail, getCheckInShareStatus, getReadableCloudError, getShareFailureMessage, type CheckInDetail as CloudDetail } from "@/services/cloudCheckIn";
import { sharedImage } from "@/constant";
import { formatCheckInTime, formatPlaybackDurationLabel } from "@/utils/checkInFormat";
import { useDeviceLayout } from "@/hooks/useDeviceLayout";
import CheckInNavigation from "./CheckInNavigation";
import "./CheckInDetail.scss";

const pendingStore = getPendingCheckInStore();
const submissionCoordinator = getCheckInSubmissionCoordinator();
type DetailView = { source: "local"; pending: PendingCheckIn; recordingUrl: string } | { source: "cloud"; cloud: CloudDetail; recordingUrl: string };

export default function CheckInDetail() {
  const layoutClassName = buildDeviceLayoutClassName(useDeviceLayout());
  const router = useRouter();
  const localId = router.params?.localId || "";
  const recordId = router.params?.id || "";
  const routeToken = router.params?.token || "";
  const [detail, setDetail] = useState<DetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackPositionMs, setPlaybackPositionMs] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [checkingShare, setCheckingShare] = useState(false);
  const checkingShareRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [expiryTick, setExpiryTick] = useState(0);
  const audioControllerRef = useRef<ReturnType<typeof createTrackAudioController> | null>(null);
  const durationRef = useRef(0);
  const mountedRef = useRef(true);
  const visibleRef = useRef(true);
  const submissionRef = useRef<CheckInSubmissionHandle | null>(null);
  const shareAttemptRef = useRef(0);
  const playAttemptRef = useRef(0);

  const values = useMemo(() => detail?.source === "local" ? {
    id: detail.pending.share?.id || "", shareToken: detail.pending.share?.shareToken || "",
    expiresAtMs: detail.pending.share?.expiresAtMs || 0, bookId: detail.pending.context.bookId,
    bookTitle: detail.pending.context.bookTitle, practiceIndex: detail.pending.context.practiceIndex,
    pageNumber: detail.pending.context.pageNumber, sectionTitle: detail.pending.context.sectionTitle,
    imageUrl: detail.pending.context.imageUrl, durationMs: detail.pending.durationMs,
    createdAt: detail.pending.completedAtMs ?? detail.pending.createdAtMs ?? detail.pending.updatedAtMs,
  } : detail?.source === "cloud" ? {
    ...detail.cloud,
    // 新协议消费服务端期限；旧云记录没有期限，继续保持兼容。
    expiresAtMs: detail.cloud.expiresAtMs ?? Number.POSITIVE_INFINITY,
  } : null, [detail]);
  const hasValidShare = Boolean(values?.id && values.shareToken && values.expiresAtMs > Date.now());

  const practiceUrl = useMemo(() => {
    if (!values || !Number.isInteger(values.practiceIndex)) return null;
    try {
      const bundle = buildBookPracticeBundle(values.bookId);
      if (!bundle || values.practiceIndex < 0 || values.practiceIndex >= bundle.practices.length) return null;
      return `/pages/Practice/Practice?bookId=${encodeURIComponent(values.bookId)}&practice=${values.practiceIndex}`;
    } catch (_error) {
      return null;
    }
  }, [values]);

  const openPractice = () => {
    const pages = Taro.getCurrentPages();
    const previousPage = pages[pages.length - 2];
    // 从刚完成的教材页进入时复用原会话，避免叠加训练页后两个页面争用同一个录音器。
    // 分享链接不携带此标记；历史记录、独立分享及页面栈丢失时仍按录音上下文打开教材。
    if (router.params?.fromPractice === "1" && previousPage?.route === "pages/Practice/Practice") {
      return Taro.navigateBack({ delta: 1 });
    }
    return Taro.navigateTo({ url: practiceUrl || "/pages/BookLibrary/BookLibrary" });
  };

  const goBack = () => {
    if (Taro.getCurrentPages().length > 1) {
      return Taro.navigateBack({ delta: 1 });
    }
    return Taro.reLaunch({ url: practiceUrl || "/pages/Home/Home" });
  };

  useShareAppMessage(() => {
    // 回调触发时再验一次期限，页面停留跨过期点也不能复活旧口令。
    if (!values || !values.id || !values.shareToken || values.expiresAtMs <= Date.now()) {
      return { title: "海沙牛娃英语跟读训练", path: "/pages/Home/Home", imageUrl: sharedImage };
    }
    return { title: `我完成了《${values.bookTitle}》${values.sectionTitle}跟读练习`, path: `/pages/CheckInDetail/CheckInDetail?id=${encodeURIComponent(values.id)}&token=${encodeURIComponent(values.shareToken)}`, imageUrl: values.imageUrl || sharedImage };
  });

  useEffect(() => {
    mountedRef.current = true;
    const controller = createTrackAudioController(
      () => Taro.createInnerAudioContext(),
      (trackId) => {
        if (trackId === null && mountedRef.current && visibleRef.current) {
          setIsPlaying(false);
          setPlaybackPositionMs(0);
        }
      },
      () => {
        if (mountedRef.current && visibleRef.current) {
          Taro.showToast({ title: "录音播放失败", icon: "none" });
        }
      },
      {
        onPlay: () => {
          if (mountedRef.current && visibleRef.current) setIsPlaying(true);
        },
        onTimeUpdate: (seconds) => {
          if (mountedRef.current && visibleRef.current) {
            setPlaybackPositionMs(getPlaybackPositionMs(seconds, durationRef.current));
          }
        },
      },
    );
    audioControllerRef.current = controller;
    return () => {
      mountedRef.current = false;
      controller.dispose();
      audioControllerRef.current = null;
    };
  }, []);

  const leavePage = () => {
    visibleRef.current = false;
    shareAttemptRef.current += 1;
    playAttemptRef.current += 1;
    audioControllerRef.current?.stop();
    submissionRef.current?.cancel();
  };
  useDidHide(() => {
    visibleRef.current = false;
    shareAttemptRef.current += 1;
    playAttemptRef.current += 1;
    audioControllerRef.current?.stop();
    setIsPlaying(false);
    setPlaybackPositionMs(0);
    submissionRef.current?.cancel();
  });
  useDidShow(() => {
    visibleRef.current = true;
    if (!localId) return;
    const latest = pendingStore.list().find((item) => item.requestId === localId);
    if (latest) setDetail({ source: "local", pending: latest, recordingUrl: latest.localPath });
    setSharing(submissionCoordinator.isSubmitting(localId));
    const handle = submissionCoordinator.getActive(localId);
    if (!handle || submissionRef.current === handle) return;
    submissionRef.current = handle;
    void handle.promise.then((result) => {
      if (!mountedRef.current || submissionRef.current !== handle) return;
      submissionRef.current = null;
      setSharing(false);
      if (!visibleRef.current) return;
      const current = pendingStore.list().find((item) => item.requestId === localId);
      if (current) setDetail({ source: "local", pending: current, recordingUrl: current.localPath });
      if (result.state !== "committed") Taro.showToast({ title: getShareFailureMessage(result.error), icon: "none" });
      else if (result.cleanupPending) Taro.showToast({ title: "分享已生成，本机状态未同步，请重试", icon: "none" });
    });
  });
  useUnload(leavePage);

  useEffect(() => {
    const expiresAtMs = detail?.source === "local" ? detail.pending.share?.expiresAtMs : undefined;
    if (!expiresAtMs || expiresAtMs <= Date.now()) return undefined;
    // 30 天超过原生计时器上限，分段唤醒并重算剩余时间。
    const delayMs = Math.min(expiresAtMs - Date.now() + 20, 2_147_000_000);
    const timer = setTimeout(() => setExpiryTick((value) => value + 1), delayMs);
    return () => clearTimeout(timer);
  }, [detail, expiryTick]);

  useEffect(() => {
    let active = true;
    visibleRef.current = true;
    void (async () => {
      try {
        if (localId) {
          await pendingStore.ready();
          const pending = pendingStore.list().find((item) => item.requestId === localId);
          if (!pending) throw new Error("这段本机录音不存在或已删除");
          if (active) { durationRef.current = pending.durationMs; setDetail({ source: "local", pending, recordingUrl: pending.localPath }); }
        } else if (recordId) {
          const cloud = await getCheckInDetail(recordId, routeToken);
          if (active) { durationRef.current = cloud.durationMs; setDetail({ source: "cloud", cloud, recordingUrl: cloud.recordingUrl }); }
        } else throw new Error("链接缺少录音编号");
      } catch (error) { if (active) setErrorMessage(localId ? (error instanceof Error ? error.message : "本机录音读取失败") : getReadableCloudError(error)); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [localId, recordId, routeToken]);

  const toggleRecording = async () => {
    const controller = audioControllerRef.current;
    if (!controller || !detail || !visibleRef.current || savingRef.current) return;
    const attempt = playAttemptRef.current + 1;
    playAttemptRef.current = attempt;
    if (isPlaying) { controller.stop(); return; }
    let recordingUrl = detail.recordingUrl;
    if (detail.source === "cloud") {
      try {
        // 云端临时地址可能短于五分钟；仅云详情在用户点播放时刷新，本地回听永不联网。
        const refreshed = await getCheckInDetail(recordId, routeToken);
        if (!mountedRef.current || !visibleRef.current || playAttemptRef.current !== attempt) return;
        recordingUrl = refreshed.recordingUrl;
        durationRef.current = refreshed.durationMs;
        setDetail({ source: "cloud", cloud: refreshed, recordingUrl });
      } catch (error) {
        if (!mountedRef.current || !visibleRef.current || playAttemptRef.current !== attempt) return;
        Taro.showToast({ title: getReadableCloudError(error), icon: "none" });
        return;
      }
    }
    if (!visibleRef.current || playAttemptRef.current !== attempt) return;
    setPlaybackPositionMs(0);
    controller.toggle("recording", recordingUrl);
  };

  const retrySaveRecording = async () => {
    if (!localId || detail?.source !== "local" || detail.pending.recoverable || savingRef.current || sharing || !visibleRef.current) return;
    savingRef.current = true;
    setSaving(true);
    audioControllerRef.current?.stop();
    try {
      const result = await pendingStore.retrySave(localId);
      // 隐藏时仅完成本地保存，返回页面会从仓储恢复，绝不在这里启动分享。
      if (!mountedRef.current || !visibleRef.current) return;
      if (result) setDetail({ source: "local", pending: result.item, recordingUrl: result.item.localPath });
      Taro.showToast({ title: result?.persisted ? "录音已安全保存" : "保存失败，请重试", icon: "none" });
    } catch (_error) {
      if (mountedRef.current && visibleRef.current) Taro.showToast({ title: "保存失败，请重试", icon: "none" });
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const prepareShare = async () => {
    if (!localId || sharing || checkingShareRef.current || savingRef.current || hasValidShare || !visibleRef.current || detail?.source !== "local" || !detail.pending.recoverable) return;
    const attempt = shareAttemptRef.current + 1;
    shareAttemptRef.current = attempt;
    setSharing(true);
    try {
      const snapshot = await pendingStore.beginShare(localId);
      if (!snapshot) throw Object.assign(new Error("分享代次保存失败"), { code: "PENDING_PERSIST_FAILED" });
      // beginShare 也可能跨过离页；用户手势失效后绝不能补启动上传。
      if (!mountedRef.current || !visibleRef.current || shareAttemptRef.current !== attempt) return;
      const handle = submissionCoordinator.submit(snapshot);
      submissionRef.current = handle;
      const result = await handle.promise;
      if (submissionRef.current === handle) submissionRef.current = null;
      if (!mountedRef.current) return;
      if (result.state === "committed" && !result.cleanupPending && visibleRef.current) {
        const latest = pendingStore.list().find((item) => item.requestId === localId);
        if (latest?.share) {
          setDetail({ source: "local", pending: latest, recordingUrl: latest.localPath });
        }
      }
      if (!visibleRef.current || shareAttemptRef.current !== attempt) return;
      if (result.state !== "committed") {
        Taro.showToast({ title: result.state === "cancelled" ? "已取消分享" : getShareFailureMessage(result.error), icon: "none" });
        return;
      }
      if (result.cleanupPending) {
        Taro.showToast({ title: "分享已生成，本机状态未同步，请重试", icon: "none" });
        return;
      }
      const latest = pendingStore.list().find((item) => item.requestId === localId);
      if (!latest?.share) {
        Taro.showToast({ title: "分享状态尚未保存，请重试", icon: "none" });
        return;
      }
      setDetail({ source: "local", pending: latest, recordingUrl: latest.localPath });
      Taro.showToast({ title: "分享已准备好", icon: "success" });
    } catch (error) {
      logRecordingDiagnostic("share.prepare.failed", { requestId: localId, error });
      if (mountedRef.current && visibleRef.current && shareAttemptRef.current === attempt) Taro.showToast({ title: getShareFailureMessage(error), icon: "none" });
    } finally {
      if (mountedRef.current) setSharing(false);
    }
  };

  const checkShare = async () => {
    if (detail?.source !== "local" || !detail.pending.share || !detail.pending.shareRequestId ||
        sharing || checkingShareRef.current || savingRef.current || !visibleRef.current) return;
    const { share, shareRequestId } = detail.pending;
    checkingShareRef.current = true;
    setCheckingShare(true);
    try {
      const status = await getCheckInShareStatus(share.id, shareRequestId);
      if (!mountedRef.current || !visibleRef.current) return;
      if (status.state === "active") {
        Taro.showToast({ title: "分享仍有效，可发送给朋友", icon: "none" });
        return;
      }
      const invalidated = await pendingStore.markShareExpired(localId, shareRequestId);
      if (!mountedRef.current || !visibleRef.current) return;
      const latest = pendingStore.list().find((item) => item.requestId === localId);
      if (latest) setDetail({ source: "local", pending: latest, recordingUrl: latest.localPath });
      // 晚到核验不得清除另一代新分享；持久化失败仍保留原文件与引用。
      if (invalidated) Taro.showToast({ title: "旧分享已失效，请再次点击分享", icon: "none" });
      else if (latest?.shareRequestId === shareRequestId) Taro.showToast({ title: "本机状态保存失败，请重试", icon: "none" });
    } catch (_error) {
      if (mountedRef.current && visibleRef.current) Taro.showToast({ title: "暂时无法核验，请稍后重试", icon: "none" });
    } finally {
      checkingShareRef.current = false;
      if (mountedRef.current) setCheckingShare(false);
    }
  };

  const renderPage = (content: ReactNode) => (
    <View className='check-in-detail-page'>
      <CheckInNavigation onBack={goBack} />
      {content}
    </View>
  );

  if (loading) {
    return renderPage(
      <View className={`check-in-detail-page__content check-in-state device-layout__content ${layoutClassName}`}>
        <Text className='check-in-state__message'>正在读取录音…</Text>
      </View>,
    );
  }
  if (!detail || !values) {
    return renderPage(
      <View className={`check-in-detail-page__content check-in-state device-layout__content ${layoutClassName}`}>
        <Text className='check-in-state__title'>暂时无法打开这条录音</Text>
        <Text className='check-in-state__message'>{errorMessage}</Text>
      </View>,
    );
  }

  const shareButton = hasValidShare ? (
    <Button className='check-in-actions__share device-touch-target' openType='share'>发送给朋友</Button>
  ) : detail.source === "local" ? (
    <Button className='check-in-actions__share device-touch-target' loading={sharing} disabled={sharing || checkingShare || saving || !detail.pending.recoverable} onClick={prepareShare}>
      {sharing ? "正在准备分享…" : "分享给朋友"}
    </Button>
  ) : (
    <Button className='check-in-actions__share device-touch-target' openType='share'>发送给朋友</Button>
  );

  return renderPage(
    <View className={`check-in-detail-page__content check-in-detail device-layout__content ${layoutClassName}`}>
      <View className='check-in-detail__success'>
        <Text className='check-in-detail__check'>✓</Text>
        <Text className='check-in-detail__title'>完成英语跟读</Text>
        <Text className='check-in-detail__time'>{formatCheckInTime(values.createdAt)}</Text>
      </View>
      <View className='check-in-course-card'>
        <Image className='check-in-course-card__image' src={values.imageUrl} mode='aspectFit' webp />
        <View className='check-in-course-card__content'>
          <Text className='check-in-course-card__book'>{values.bookTitle}</Text>
          <Text className='check-in-course-card__section'>{values.sectionTitle}</Text>
          <Text className='check-in-course-card__meta'>第 {values.practiceIndex + 1} 个训练 · 教材页 {values.pageNumber}</Text>
        </View>
      </View>
      <View className='shared-recording'>
        <Text className='shared-recording__label'>本次跟读录音</Text>
        <Text className='shared-recording__duration'>{formatPlaybackDurationLabel(isPlaying, playbackPositionMs, values.durationMs)}</Text>
        <Button className='shared-recording__play device-touch-target' onClick={toggleRecording}>
          <Text className='shared-recording__play-icon'>{isPlaying ? "■" : "▶"}</Text>
          {isPlaying ? "停止播放" : "播放本次跟读"}
        </Button>
        {detail.source === "local" && !detail.pending.recoverable && (
          <View>
            <Text className='shared-recording__privacy'>录音保存失败，请重试保存；关闭小程序后可能无法恢复</Text>
            <Button className='shared-recording__retry device-touch-target' loading={saving} disabled={saving || sharing} onClick={retrySaveRecording}>重试保存</Button>
          </View>
        )}
        {detail.source === "local" && detail.pending.share && detail.pending.shareRequestId && (
          <Button className='check-in-actions__practice shared-recording__privacy shared-recording__repair device-touch-target' loading={checkingShare} disabled={checkingShare || sharing || saving} onClick={checkShare}>链接打不开？检查分享</Button>
        )}
      </View>
      <View className='check-in-actions device-actions'>
        {shareButton}
        <Button className='check-in-actions__practice device-touch-target' onClick={openPractice}>
          {practiceUrl ? "我也来跟读" : "选择教材"}
        </Button>
      </View>
    </View>,
  );
}
