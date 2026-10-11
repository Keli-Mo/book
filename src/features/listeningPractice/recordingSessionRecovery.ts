import { getPendingCheckInStore, logRecordingDiagnostic } from "@/features/listeningPractice/pendingCheckInRuntime";
import { parseNativeRecordingResult } from "@/features/listeningPractice/recordingInteraction";
import { getRecorderCoordinator, type RecorderNativeStopResult } from "@/features/listeningPractice/recorderCoordinator";
import { getRecordingSessionJournal, type RecordingSessionEntry } from "@/features/listeningPractice/recordingSessionJournal";

const EXIT_STOP_GRACE_MS = 1500;
// saveFile 自身有 15 秒超时；它正在落盘时不能让下一段覆盖同一个临时文件。
const EXIT_SAVE_GRACE_MS = 17000;

const discardSession = (sessionId: string, force = false): boolean => {
  const coordinator = getRecorderCoordinator();
  if (coordinator.getEntryRecoveryStatus() === "saving" && !force) return false;
  const journal = getRecordingSessionJournal();
  try {
    const entry = journal.read();
    if (!entry || entry.id !== sessionId) return true;
    // 撤销原生回调归属后再清会话记录；迟到 onStop 不得另存成旧页录音。
    if ((coordinator.getEntryRecoveryStatus() !== "none" || coordinator.getPhase() !== "idle") &&
      !coordinator.abandonUnconfirmedRecording({ force })) return false;
    const store = getPendingCheckInStore();
    let alreadyPersisted = true;
    try { alreadyPersisted = store.list().some((item) => item.requestId === entry.id && item.recoverable); }
    catch (error) { logRecordingDiagnostic("session.persisted.check.failed", { error }); }
    if (!journal.markAbandoned(entry.id) || !journal.clear(entry.id)) return false;
    if (!alreadyPersisted) {
      // remove 与 saveRecording 共用同一队列：即使保存恰在放弃后才返回，也会清掉旧文件。
      void store.remove(entry.id).catch((error) => {
        logRecordingDiagnostic("session.discard.file.failed", { error });
      });
    }
    return true;
  } catch (error) {
    logRecordingDiagnostic("session.discard.failed", { error });
    return false;
  }
};

/** 页面或小程序退出后给原生 onStop 一个短暂保存机会，之后自动放弃未结束的录音。 */
export const scheduleExitedRecordingSettlement = (sessionId: string, onDiscarded?: () => void) => {
  const settle = (afterSave: boolean) => {
    let entry: RecordingSessionEntry | null;
    try { entry = getRecordingSessionJournal().read(); }
    catch (error) { logRecordingDiagnostic("session.read.failed", { error }); return; }
    if (!entry || entry.id !== sessionId) return;
    if (entry.stage === "terminal" && !afterSave &&
      (getRecorderCoordinator().getPhase() !== "idle" ||
        getRecorderCoordinator().getEntryRecoveryStatus() === "saving")) {
      setTimeout(() => settle(true), EXIT_SAVE_GRACE_MS);
      return;
    }
    if (discardSession(sessionId, afterSave)) onDiscarded?.();
  };
  setTimeout(() => settle(false), EXIT_STOP_GRACE_MS);
};

/** 冷启动自动保存已取得的文件；没有结束结果时短暂尝试 stop，随后放弃。 */
export const ensureUnfinishedRecordingRecovery = () => {
  const journal = getRecordingSessionJournal();
  let entry: RecordingSessionEntry | null;
  try { entry = journal.read(); }
  catch (error) {
    logRecordingDiagnostic("session.read.failed", { error });
    try {
      journal.discardUnreadable();
      // 曾因损坏记录而锁住的协调器，在存储恢复后也要一并释放。
      const coordinator = getRecorderCoordinator();
      if (coordinator.getEntryRecoveryStatus() !== "none") coordinator.abandonUnconfirmedRecording();
    }
    catch (discardError) {
      logRecordingDiagnostic("session.discard.failed", { error: discardError });
      getRecorderCoordinator().beginEntryRecovery({ recover: () => false });
    }
    return;
  }
  if (!entry) return;
  if (entry.stage === "abandoned") {
    try { journal.clear(entry.id); }
    catch (error) { logRecordingDiagnostic("session.clear.failed", { error }); }
    return;
  }

  const coordinator = getRecorderCoordinator();
  const recover = async (result: RecorderNativeStopResult): Promise<boolean> => {
    // onStart 未确认时，原生结束事件可能属于另一段录音。
    if (entry.stage === "starting") return false;
    const nativeResult = entry.stage === "terminal"
      ? { tempFilePath: entry.terminal.tempFilePath, duration: entry.terminal.durationMs, fileSize: entry.terminal.fileSizeBytes }
      : result;
    const parsed = parseNativeRecordingResult(nativeResult);
    if (!parsed.ok) return false;
    try {
      if (entry.stage === "confirmed" && !journal.recordTerminal(entry.id, nativeResult)) return false;
      const store = getPendingCheckInStore();
      const saved = await store.saveRecording({
        tempFilePath: parsed.tempFilePath,
        durationMs: parsed.durationMs,
        fileSizeBytes: parsed.fileSizeBytes,
        context: entry.context,
        recordingSessionId: entry.id,
      });
      if (!saved.persisted) {
        // 随后的 discardSession 将清理本次临时文件，避免重复排队删除。
        return false;
      }
      return journal.clear(entry.id);
    } catch (error) {
      logRecordingDiagnostic("session.recover.failed", { error });
      return false;
    }
  };

  if (!coordinator.beginEntryRecovery({
    ...(entry.stage === "terminal" ? {
      terminalResult: { tempFilePath: entry.terminal.tempFilePath, duration: entry.terminal.durationMs, fileSize: entry.terminal.fileSizeBytes },
    } : {}),
    recover,
  })) return;

  if (entry.stage === "starting") {
    discardSession(entry.id);
    return;
  }
  if (entry.stage === "terminal") {
    void coordinator.retryEntryRecovery().then((saved) => {
      if (!saved) discardSession(entry.id);
    });
    setTimeout(() => discardSession(entry.id, true), EXIT_SAVE_GRACE_MS);
    return;
  }
  // confirmed: stop() 的返回值不证明结束；只有收到有效 onStop 才会保存。
  void coordinator.retryEntryRecovery();
  const settle = (afterSave: boolean) => {
    let latest: RecordingSessionEntry | null;
    try { latest = journal.read(); }
    catch (error) { logRecordingDiagnostic("session.read.failed", { error }); return; }
    if (!latest || latest.id !== entry.id) return;
    if (coordinator.getEntryRecoveryStatus() === "saving" && !afterSave) {
      setTimeout(() => settle(true), EXIT_SAVE_GRACE_MS);
      return;
    }
    discardSession(entry.id, afterSave);
  };
  setTimeout(() => settle(false), EXIT_STOP_GRACE_MS);
};

export const resumeUnfinishedRecordingOnLaunch = ensureUnfinishedRecordingRecovery;
