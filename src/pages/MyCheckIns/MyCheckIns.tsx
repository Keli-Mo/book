import { Button, Image, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, useUnload } from "@tarojs/taro";
import { useCallback, useMemo, useRef, useState } from "react";
import { buildDeviceLayoutClassName } from "@/features/layout/deviceLayout";
import { getPendingCheckInStore, logRecordingDiagnostic } from "@/features/listeningPractice/pendingCheckInRuntime";
import { mergeRecordingLibrary } from "@/features/listeningPractice/recordingLibraryView";
import { getCheckInSubmissionCoordinator } from "@/features/listeningPractice/checkInSubmissionRuntime";
import { listMyCheckIns, removeCheckIn, type CheckInSummary } from "@/services/cloudCheckIn";
import { formatCheckInTime, formatRecordingDuration } from "@/utils/checkInFormat";
import { useDeviceLayout } from "@/hooks/useDeviceLayout";
import "./MyCheckIns.scss";

const pendingStore = getPendingCheckInStore();
const submissionCoordinator = getCheckInSubmissionCoordinator();

export default function MyCheckIns() {
  const layoutClassName = buildDeviceLayoutClassName(useDeviceLayout());
  const [localRecords, setLocalRecords] = useState([...pendingStore.list()]);
  const [cloudRecords, setCloudRecords] = useState<CheckInSummary[]>([]);
  const [cloudNotice, setCloudNotice] = useState("");
  const visibleRef = useRef(false);
  const deletingLocalRef = useRef(new Set<string>());
  const deletingCloudRef = useRef(new Set<string>());
  const deletedCloudRef = useRef(new Set<string>());
  const pageEpochRef = useRef(0);
  const refreshRef = useRef(0);
  const libraryRecords = useMemo(
    () => mergeRecordingLibrary(localRecords, cloudRecords),
    [cloudRecords, localRecords],
  );

  const loadRecords = useCallback(async () => {
    const epoch = pageEpochRef.current;
    const refresh = ++refreshRef.current;
    const isCurrent = () => visibleRef.current && pageEpochRef.current === epoch && refreshRef.current === refresh;
    await pendingStore.ready();
    await pendingStore.cleanup();
    if (!isCurrent()) return;
    // 本地先落屏；云端失败只影响旧记录补充，不能遮住本机录音。
    setLocalRecords([...pendingStore.list()]);
    try {
      const cloud = await listMyCheckIns();
      if (isCurrent()) {
        setCloudRecords(cloud.filter(record => !deletedCloudRef.current.has(record.id)));
        setCloudNotice("");
      }
    } catch (_error) {
      if (isCurrent()) setCloudNotice("云端历史暂时无法刷新，本机录音仍可使用");
    }
  }, []);

  useDidShow(() => {
    visibleRef.current = true;
    void loadRecords();
  });
  useDidHide(() => { visibleRef.current = false; pageEpochRef.current += 1; });
  useUnload(() => { visibleRef.current = false; pageEpochRef.current += 1; });

  const deleteLocal = async (localId: string) => {
    if (!visibleRef.current) return;
    const epoch = pageEpochRef.current;
    const isCurrent = () => visibleRef.current && pageEpochRef.current === epoch;
    if (deletingLocalRef.current.has(localId)) {
      logRecordingDiagnostic("delete.duplicate_ignored", { requestId: localId });
      return;
    }
    if (submissionCoordinator.isSubmitting(localId)) {
      logRecordingDiagnostic("delete.blocked_sharing", { requestId: localId });
      Taro.showToast({ title: "分享处理中，暂时不能删除", icon: "none" });
      return;
    }
    deletingLocalRef.current.add(localId);
    try {
      const confirmation = await Taro.showModal({
        title: "删除本机录音？",
        content: "只删除本机文件；已经发出的云端分享不受影响。此操作无法撤销。",
        confirmText: "删除",
        confirmColor: "#d9573f",
      });
      if (!confirmation.confirm || !isCurrent()) {
        logRecordingDiagnostic("delete.cancelled", { requestId: localId });
        return;
      }
      if (submissionCoordinator.isSubmitting(localId)) {
        logRecordingDiagnostic("delete.blocked_sharing", { requestId: localId });
        return;
      }
      if (!await pendingStore.remove(localId)) {
        if (isCurrent()) Taro.showToast({ title: "删除失败，请稍后重试", icon: "none" });
        return;
      }
      if (isCurrent()) setLocalRecords((items) => items.filter((item) => item.requestId !== localId));
    } catch (error) {
      logRecordingDiagnostic("delete.unexpected.failed", { requestId: localId, error });
      if (isCurrent()) Taro.showToast({ title: "删除失败，请稍后重试", icon: "none" });
    } finally {
      deletingLocalRef.current.delete(localId);
    }
  };

  const deleteCloud = async (record: CheckInSummary) => {
    if (!visibleRef.current || deletingCloudRef.current.has(record.id)) return;
    deletingCloudRef.current.add(record.id);
    const epoch = pageEpochRef.current;
    const isCurrent = () => visibleRef.current && pageEpochRef.current === epoch;
    try {
      const confirmation = await Taro.showModal({
        title: "删除云端录音？",
        content: "云端录音和旧分享链接会失效；本机保存的录音不会删除。",
        confirmText: "删除",
        confirmColor: "#d9573f",
      });
      if (!confirmation.confirm || !isCurrent()) return;
      await removeCheckIn(record.id);
      deletedCloudRef.current.add(record.id);
      if (isCurrent()) setCloudRecords((items) => items.filter((item) => item.id !== record.id));
    } catch (_error) {
      if (isCurrent()) {
        Taro.showToast({ title: "云端删除失败，请重试", icon: "none" });
        void loadRecords();
      }
    } finally {
      deletingCloudRef.current.delete(record.id);
    }
  };

  return (
    <View className={`my-check-ins device-layout__content ${layoutClassName}`}>
      <View className='my-check-ins__intro'>
        <Text className='my-check-ins__title'>我的录音</Text>
        <Text className='my-check-ins__tip'>共 {libraryRecords.length} 次</Text>
        {cloudNotice && <Text className='my-check-ins__tip'>{cloudNotice}</Text>}
      </View>
      {libraryRecords.length === 0 ? (
        <View className='my-check-ins-state'>
          <Text className='my-check-ins-state__title'>还没有录音</Text>
        </View>
      ) : (
        <View className='my-check-ins__list'>
          {libraryRecords.map((item) => {
            const local = item.kind === "local" ? item.pending : null;
            const cloud = item.kind === "cloud" ? item.cloud : null;
            const context = local?.context;
            const detailUrl = local
              ? `/pages/CheckInDetail/CheckInDetail?localId=${encodeURIComponent(local.requestId)}`
              : `/pages/CheckInDetail/CheckInDetail?id=${encodeURIComponent(cloud!.id)}&token=${encodeURIComponent(cloud!.shareToken)}`;
            return <View className='check-in-list-card' key={local?.requestId || cloud!.id}>
              <View className='check-in-list-card__preview'>
                <Image className='check-in-list-card__image' src={context?.imageUrl || cloud!.imageUrl} mode='aspectFit' webp />
              </View>
              <View className='check-in-list-card__content'>
                <Text className='check-in-list-card__section'>{context?.sectionTitle || cloud!.sectionTitle}</Text>
                <Text className='check-in-list-card__book'>{context?.bookTitle || cloud!.bookTitle}</Text>
                <Text className='check-in-list-card__meta'>
                  教材页 {context?.pageNumber ?? cloud!.pageNumber} · {formatRecordingDuration(local?.durationMs ?? cloud!.durationMs)} · {formatCheckInTime(local?.completedAtMs ?? local?.createdAtMs ?? local?.updatedAtMs ?? cloud!.createdAt)}
                </Text>
                {!local?.recoverable && local && (
                  <Text className='pending-check-in-status__warning'>临时文件，关闭小程序后可能无法恢复</Text>
                )}
                <View className='check-in-list-card__actions'>
                  <Button className='check-in-list-card__open device-touch-target' disabled={cloud?.status === "deletePending"} onClick={() => cloud?.status !== "deletePending" && Taro.navigateTo({ url: detailUrl })}>{cloud?.status === "deletePending" ? "待删除" : "回听 / 分享"}</Button>
                  <Button className='check-in-list-card__delete device-touch-target' onClick={() => local ? deleteLocal(local.requestId) : deleteCloud(cloud!)}>{cloud?.status === "deletePending" ? "重试" : "删除"}</Button>
                </View>
              </View>
            </View>;
          })}
        </View>
      )}
    </View>
  );
}
