import { Button, Image, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, useUnload } from "@tarojs/taro";
import { useCallback, useRef, useState } from "react";
import {
  CheckInSummary,
  getReadableCloudError,
  listMyCheckIns,
  removeCheckIn,
} from "@/services/cloudCheckIn";
import {
  formatCheckInTime,
  formatRecordingDuration,
} from "@/utils/checkInFormat";
import { buildDeviceLayoutClassName } from "@/features/layout/deviceLayout";
import { DEFAULT_BOOK_ID } from "@/features/listeningPractice/bookPractice";
import { getCheckInSubmissionCoordinator } from "@/features/listeningPractice/checkInSubmissionRuntime";
import type { CheckInSubmissionHandle } from "@/features/listeningPractice/checkInSubmissionCoordinator";
import { getPendingCheckInStore } from "@/features/listeningPractice/pendingCheckInRuntime";
import type {
  PendingCheckIn,
  PendingCheckInStatus,
} from "@/features/listeningPractice/pendingCheckInStore";
import { useDeviceLayout } from "@/hooks/useDeviceLayout";

import "./MyCheckIns.scss";

type PendingProgress = {
  percent: number | null;
  uncertain: boolean;
  cancelling: boolean;
};

const pendingStore = getPendingCheckInStore();
const submissionCoordinator = getCheckInSubmissionCoordinator();

const getPendingStatus = (status: PendingCheckInStatus) => {
  if (status === "failed") {
    return { label: "提交失败", detail: "录音仍保存在本机，可以重新提交。" };
  }
  if (status === "uploaded" || status === "creating") {
    return { label: "已上传待确认", detail: "录音已上传，继续提交可完成打卡确认。" };
  }
  return { label: "本地待提交", detail: "录音已保存在本机，尚未使用网络。" };
};

export default function MyCheckIns() {
  const layout = useDeviceLayout();
  const layoutClassName = buildDeviceLayoutClassName(layout);
  const [records, setRecords] = useState<CheckInSummary[]>([]);
  const [pendingRecords, setPendingRecords] = useState<PendingCheckIn[]>([]);
  const [pendingProgress, setPendingProgress] = useState<Record<string, PendingProgress>>({});
  const [loading, setLoading] = useState(true);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const pageVisibleRef = useRef(false);
  const activeSubmissionsRef = useRef(new Map<string, CheckInSubmissionHandle>());

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setErrorMessage("");
    try {
      setRecords(await listMyCheckIns());
    } catch (error) {
      setErrorMessage(getReadableCloudError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshPendingRecords = useCallback(async () => {
    setPendingLoading(true);
    try {
      // 先恢复持久化队列并清理过期文件，再把仍可管理的录音交给页面。
      await pendingStore.ready();
      await pendingStore.cleanup();
      if (pageVisibleRef.current) {
        setPendingRecords([...pendingStore.list()]);
      }
    } finally {
      if (pageVisibleRef.current) setPendingLoading(false);
    }
  }, []);

  const cancelActiveSubmissions = useCallback(() => {
    // 协调器只会在上传或退避期接受取消；已进入云端确认的任务继续收敛结果。
    activeSubmissionsRef.current.forEach((handle) => handle.cancel());
  }, []);

  useDidShow(() => {
    pageVisibleRef.current = true;
    // 隐藏期间已完成取消的 handle 不再展示为“正在提交”。
    setPendingProgress((current) =>
      Object.entries(current).reduce<Record<string, PendingProgress>>(
        (visible, [requestId, progress]) => {
          if (activeSubmissionsRef.current.has(requestId)) {
            visible[requestId] = progress;
          }
          return visible;
        },
        {},
      ),
    );
    void refreshPendingRecords();
    void loadRecords();
  });

  useDidHide(() => {
    pageVisibleRef.current = false;
    cancelActiveSubmissions();
  });

  useUnload(() => {
    pageVisibleRef.current = false;
    cancelActiveSubmissions();
  });

  const openRecord = (record: CheckInSummary) => {
    Taro.navigateTo({
      url: `/pages/CheckInDetail/CheckInDetail?id=${encodeURIComponent(
        record.id,
      )}&token=${encodeURIComponent(record.shareToken)}`,
    });
  };

  const submitPendingRecord = async (pending: PendingCheckIn) => {
    if (activeSubmissionsRef.current.has(pending.requestId)) return;

    // 只有这个用户手势会启动 prepare / upload / commit 网络流水线。
    const handle = submissionCoordinator.submit(pending, {
      onProgress: ({ percent, uncertain }) => {
        if (!pageVisibleRef.current) return;
        setPendingProgress((current) => ({
          ...current,
          [pending.requestId]: { percent, uncertain, cancelling: false },
        }));
      },
    });
    activeSubmissionsRef.current.set(pending.requestId, handle);
    setPendingProgress((current) => ({
      ...current,
      [pending.requestId]: { percent: null, uncertain: true, cancelling: false },
    }));

    const result = await handle.promise;
    activeSubmissionsRef.current.delete(pending.requestId);
    if (pageVisibleRef.current) {
      setPendingProgress((current) => {
        const next = { ...current };
        delete next[pending.requestId];
        return next;
      });
      await refreshPendingRecords();
    }

    if (result.state === "committed") {
      // 云端列表刷新失败也不影响进入刚创建的详情；返回本页会再次自动加载。
      if (!pageVisibleRef.current) return;
      void loadRecords();
      Taro.showToast({ title: "打卡成功", icon: "success" });
      try {
        await Taro.navigateTo({
          url: `/pages/CheckInDetail/CheckInDetail?id=${encodeURIComponent(
            result.id,
          )}&token=${encodeURIComponent(result.shareToken)}`,
        });
      } catch (_navigationError) {
        Taro.showToast({ title: "请在已完成打卡中查看", icon: "none" });
      }
      return;
    }

    if (!pageVisibleRef.current) return;
    if (result.state === "cancelled") {
      Taro.showToast({ title: "已取消，录音仍保存在本机", icon: "none" });
      return;
    }
    Taro.showModal({
      title: "提交失败",
      content: getReadableCloudError(result.error),
      showCancel: false,
    });
  };

  const cancelPendingSubmission = (pending: PendingCheckIn) => {
    const handle = activeSubmissionsRef.current.get(pending.requestId);
    if (!handle) return;
    if (!handle.cancel()) {
      Taro.showToast({ title: "正在确认打卡，暂时无法取消", icon: "none" });
      return;
    }
    setPendingProgress((current) => ({
      ...current,
      [pending.requestId]: {
        ...(current[pending.requestId] || { percent: null, uncertain: true }),
        cancelling: true,
      },
    }));
  };

  const deletePendingRecord = async (pending: PendingCheckIn) => {
    const confirmation = await Taro.showModal({
      title: "删除本地录音？",
      content: "删除后无法继续提交或恢复这段录音，此操作无法撤销。",
      confirmText: "删除",
      confirmColor: "#d9573f",
    });
    if (!confirmation.confirm) return;

    const removed = await pendingStore.remove(pending.requestId);
    if (!removed) {
      Taro.showToast({ title: "删除失败，请稍后重试", icon: "none" });
      return;
    }
    setPendingRecords((current) =>
      current.filter((item) => item.requestId !== pending.requestId),
    );
    Taro.showToast({ title: "本地录音已删除", icon: "success" });
  };

  const deleteRecord = async (record: CheckInSummary) => {
    const confirmation = await Taro.showModal({
      title: "删除这次打卡？",
      content: "删除后，云端录音和分享链接都会失效，且无法恢复。",
      confirmText: "删除",
      confirmColor: "#d9573f",
    });
    if (!confirmation.confirm) return;

    Taro.showLoading({ title: "正在删除", mask: true });
    try {
      await removeCheckIn(record.id);
      setRecords((current) => current.filter((item) => item.id !== record.id));
      Taro.hideLoading();
      Taro.showToast({ title: "已删除", icon: "success" });
    } catch (error) {
      Taro.hideLoading();
      Taro.showModal({
        title: "删除失败",
        content: getReadableCloudError(error),
        showCancel: false,
      });
    }
  };

  if ((loading || pendingLoading) && records.length === 0 && pendingRecords.length === 0) {
    return (
      <View className={`my-check-ins-state device-layout__content ${layoutClassName}`}>
        正在读取我的打卡…
      </View>
    );
  }

  if (errorMessage && pendingRecords.length === 0 && records.length === 0) {
    return (
      <View className={`my-check-ins-state device-layout__content ${layoutClassName}`}>
        <Text className='my-check-ins-state__title'>暂时无法读取打卡</Text>
        <Text className='my-check-ins-state__text'>{errorMessage}</Text>
        <Button
          className='my-check-ins-state__button device-touch-target'
          onClick={loadRecords}
        >
          重新加载
        </Button>
      </View>
    );
  }

  if (records.length === 0 && pendingRecords.length === 0) {
    return (
      <View className={`my-check-ins-state device-layout__content ${layoutClassName}`}>
        <Text className='my-check-ins-state__title'>还没有跟读打卡</Text>
        <Text className='my-check-ins-state__text'>完成一段录音并确认上传后，会显示在这里。</Text>
        <Button
          className='my-check-ins-state__button device-touch-target'
          onClick={() =>
            Taro.navigateTo({
              url: `/pages/Practice/Practice?bookId=${DEFAULT_BOOK_ID}&practice=0`,
            })
          }
        >
          开始第一次跟读
        </Button>
      </View>
    );
  }

  return (
    <View className={`my-check-ins device-layout__content ${layoutClassName}`}>
      <View className='my-check-ins__intro'>
        <Text className='my-check-ins__title'>我的录音打卡</Text>
        <Text className='my-check-ins__tip'>
          {records.length} 次已完成 · {pendingRecords.length} 条待提交
        </Text>
      </View>

      {errorMessage && (
        <View className='my-check-ins__notice'>
          <View className='my-check-ins__notice-copy'>
            <Text className='my-check-ins__notice-title'>云端记录暂时无法读取</Text>
            <Text className='my-check-ins__notice-text'>{errorMessage}</Text>
          </View>
          <Button
            className='my-check-ins__notice-button device-touch-target'
            onClick={loadRecords}
          >
            重试
          </Button>
        </View>
      )}

      {pendingRecords.length > 0 && (
        <View className='my-check-ins__section'>
          <View className='my-check-ins__section-heading'>
            <Text className='my-check-ins__section-title'>待上传录音</Text>
            <Text className='my-check-ins__section-tip'>只有继续提交时才会联网</Text>
          </View>
          <View className='my-check-ins__list'>
            {pendingRecords.map((pending) => {
              const progress = pendingProgress[pending.requestId];
              const status = getPendingStatus(pending.status);
              return (
                <View
                  className='check-in-list-card check-in-list-card--pending'
                  key={pending.requestId}
                >
                  <View className='check-in-list-card__preview'>
                    <Image
                      className='check-in-list-card__image'
                      src={pending.context.imageUrl}
                      mode='aspectFit'
                      webp
                      lazyLoad
                    />
                  </View>
                  <View className='check-in-list-card__content'>
                    <Text className='check-in-list-card__section'>
                      {pending.context.sectionTitle}
                    </Text>
                    <Text className='check-in-list-card__book'>
                      {pending.context.bookTitle}
                    </Text>
                    <Text className='check-in-list-card__meta'>
                      第 {pending.context.pageNumber} 页 · {formatRecordingDuration(pending.durationMs)}
                    </Text>
                    <View className='pending-check-in-status'>
                      <Text className='pending-check-in-status__label'>
                        {progress ? "正在提交" : status.label}
                      </Text>
                      <Text className='pending-check-in-status__detail'>
                        {progress
                          ? progress.cancelling
                            ? "正在取消，录音会继续保存在本机"
                            : progress.uncertain || progress.percent === null
                              ? "进度暂不可用，请保持网络连接"
                              : `上传进度 ${progress.percent}%`
                          : status.detail}
                      </Text>
                      {!pending.recoverable && !progress && (
                        <Text className='pending-check-in-status__warning'>
                          仅本次打开可继续处理，退出后可能无法恢复
                        </Text>
                      )}
                    </View>
                    <View className='check-in-list-card__actions device-actions'>
                      {progress ? (
                        <Button
                          className='check-in-list-card__cancel device-touch-target'
                          disabled={progress.cancelling}
                          onClick={() => cancelPendingSubmission(pending)}
                        >
                          取消提交
                        </Button>
                      ) : (
                        <>
                          <Button
                            className='check-in-list-card__submit device-touch-target'
                            onClick={() => submitPendingRecord(pending)}
                          >
                            继续提交
                          </Button>
                          <Button
                            className='check-in-list-card__delete-local device-touch-target'
                            onClick={() => deletePendingRecord(pending)}
                          >
                            删除本地录音
                          </Button>
                        </>
                      )}
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {records.length > 0 && (
        <View className='my-check-ins__section'>
          <View className='my-check-ins__section-heading'>
            <Text className='my-check-ins__section-title'>已完成打卡</Text>
            {loading && <Text className='my-check-ins__section-tip'>正在刷新…</Text>}
          </View>
          <View className='my-check-ins__list'>
            {records.map((record) => (
              <View className='check-in-list-card' key={record.id}>
                <View className='check-in-list-card__preview'>
                  {/* 使用打卡记录中的教材内页，老师可直接确认学生练习的位置。 */}
                  <Image
                    className='check-in-list-card__image'
                    src={record.imageUrl}
                    mode='aspectFit'
                    webp
                    lazyLoad
                  />
                </View>
                <View className='check-in-list-card__content'>
                  <Text className='check-in-list-card__section'>{record.sectionTitle}</Text>
                  <Text className='check-in-list-card__book'>{record.bookTitle}</Text>
                  <Text className='check-in-list-card__meta'>
                    第 {record.pageNumber} 页 · {formatCheckInTime(record.createdAt)} · {formatRecordingDuration(record.durationMs)}
                  </Text>
                  <View className='check-in-list-card__actions device-actions'>
                    <Button
                      className='check-in-list-card__open device-touch-target'
                      onClick={() => openRecord(record)}
                    >
                      回听与分享
                    </Button>
                    <Button
                      className='check-in-list-card__delete device-touch-target'
                      onClick={() => deleteRecord(record)}
                    >
                      删除
                    </Button>
                  </View>
                </View>
              </View>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}
