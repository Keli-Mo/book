export const PENDING_CHECK_IN_STORAGE_KEY = "pending-check-ins-v1";
export const PENDING_CHECK_IN_BACKUP_KEY = "pending-check-ins-v1-upgrade-backup";
export const MAX_PENDING_FILE_BYTES = 100 * 1024 * 1024;
export const RECORDING_CAPACITY_RESERVE_BYTES = 10 * 1024 * 1024;
export const MAX_RECORDING_FILE_BYTES = 8 * 1024 * 1024;
export const PENDING_RECORDING_BYTES = MAX_PENDING_FILE_BYTES - RECORDING_CAPACITY_RESERVE_BYTES;
export const RECORDING_START_USED_BYTES = PENDING_RECORDING_BYTES - MAX_RECORDING_FILE_BYTES;

export type RecordingShare = {
  id: string;
  shareToken: string;
  expiresAtMs: number;
};

export type CheckInContext = {
  bookId: string;
  bookTitle: string;
  practiceId: string;
  practiceIndex: number;
  pageNumber: number;
  imageUrl: string;
  sectionTitle: string;
};

export type PendingCheckInStatus = "local" | "uploaded" | "creating" | "failed";

export type PendingCheckIn = {
  requestId: string;
  localPath: string;
  recoverable: boolean;
  fileAvailability?: "available" | "missing" | "unavailable";
  context: CheckInContext;
  durationMs: number;
  fileSizeBytes: number;
  /** 旧版本录音可能没有指纹；首次提交时读取实际文件建立基准。 */
  contentSha1?: string;
  cloudFileId: string;
  status: PendingCheckInStatus;
  updatedAtMs: number;
  createdAtMs?: number;
  completedAtMs?: number;
  shareRequestId?: string;
  share?: RecordingShare;
};

export type PendingCheckInStorageAdapter = {
  get(key: string): unknown | Promise<unknown>;
  set(key: string, value: unknown): void | Promise<void>;
};

export type SavedPendingRecordingFile = {
  savedFilePath: string;
  fileSizeBytes?: number;
  contentSha1?: string;
};

export type PendingCheckInFileAdapter = {
  info?(filePath: string): Promise<{ fileSizeBytes: number; contentSha1: string }>;
  usageBytes(): number | Promise<number>;
  save(tempFilePath: string):
    | SavedPendingRecordingFile
    | Promise<SavedPendingRecordingFile>;
  exists(filePath: string): boolean | Promise<boolean>;
  remove(filePath: string, kind: "saved" | "temporary"): void | Promise<void>;
};

export type PendingCheckInAdapters = {
  storage: PendingCheckInStorageAdapter;
  file: PendingCheckInFileAdapter;
  clock: { now(): number };
  random: { hex(): string };
  diagnose?(stage: string, details?: { requestId?: string; error?: unknown }): void;
};

export type SavePendingRecordingInput = {
  tempFilePath: string;
  context: CheckInContext;
  durationMs: number;
  fileSizeBytes: number;
};

export type SavePendingRecordingResult = {
  item: PendingCheckIn;
  persisted: boolean;
  message: string;
};

const isRequestId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/i.test(value);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isContentSha1 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);

const isPositiveFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isRecordingShare = (value: unknown): value is RecordingShare => {
  if (!value || typeof value !== "object") return false;
  const share = value as Partial<RecordingShare>;
  return isText(share.id) && isText(share.shareToken) && isNonNegativeInteger(share.expiresAtMs);
};

const isContext = (value: unknown): value is CheckInContext => {
  if (!value || typeof value !== "object") return false;
  const context = value as Partial<CheckInContext>;
  return (
    isText(context.bookId) &&
    isText(context.bookTitle) &&
    isText(context.practiceId) &&
    isNonNegativeInteger(context.practiceIndex) &&
    isNonNegativeInteger(context.pageNumber) &&
    isText(context.imageUrl) &&
    isText(context.sectionTitle)
  );
};

const isStatus = (value: unknown): value is PendingCheckInStatus =>
  value === "local" ||
  value === "uploaded" ||
  value === "creating" ||
  value === "failed";

const isPendingCheckIn = (value: unknown): value is PendingCheckIn => {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PendingCheckIn>;
  return (
    isRequestId(item.requestId) &&
    isText(item.localPath) &&
    typeof item.recoverable === "boolean" &&
    isContext(item.context) &&
    isPositiveFiniteNumber(item.durationMs) &&
    isPositiveInteger(item.fileSizeBytes) &&
    (item.contentSha1 === undefined || isContentSha1(item.contentSha1)) &&
    typeof item.cloudFileId === "string" &&
    isStatus(item.status) &&
    isNonNegativeInteger(item.updatedAtMs) &&
    (item.createdAtMs === undefined || isNonNegativeInteger(item.createdAtMs)) &&
    (item.completedAtMs === undefined || isNonNegativeInteger(item.completedAtMs)) &&
    (item.shareRequestId === undefined || isRequestId(item.shareRequestId)) &&
    (item.share === undefined || isRecordingShare(item.share))
  );
};

const freezeItem = (item: PendingCheckIn): PendingCheckIn =>
  Object.freeze({
    ...item,
    context: Object.freeze({ ...item.context }),
    ...(item.share ? { share: Object.freeze({ ...item.share }) } : {}),
  }) as PendingCheckIn;

const freezeList = (items: readonly PendingCheckIn[]) =>
  Object.freeze(items.map(freezeItem)) as readonly PendingCheckIn[];

const cloneItem = (item: PendingCheckIn): PendingCheckIn => ({
  ...item,
  context: { ...item.context },
  ...(item.share ? { share: { ...item.share } } : {}),
});

const isQuotaFailure = (error: unknown) => {
  const details = error as { code?: unknown; errMsg?: unknown; message?: unknown };
  const text = `${details?.code || ""} ${details?.errMsg || ""} ${details?.message || ""}`;
  return /quota|storage.?full|space/i.test(text);
};

const capacityMessage = () => "本地录音空间不足，请先整理历史录音";
const capacityUnknownMessage = "无法检查本地录音空间，请稍后重试";
const capacityCalibrationUnknownMessage = "录音已保存，但无法核实本地录音空间，请先整理历史录音";

/**
 * 待上传项只持久化已由 saveFile 移入本地文件系统的路径；临时路径只在本次会话内保留。
 */
export const createPendingCheckInStore = (adapters: PendingCheckInAdapters) => {
  // 诊断不能影响保存、删除结果；不向页面传播底层错误。
  const diagnose = (stage: string, details?: { requestId?: string; error?: unknown }) => {
    try { adapters.diagnose?.(stage, details); } catch (_error) { /* 日志故障不阻断录音操作。 */ }
  };
  let persistedItems: PendingCheckIn[] = [];
  // 原始项是索引的事实来源；无法识别或 ID 有歧义的项不能因读写有效项而丢失。
  let rawItems: unknown[] = [];
  let managedIds = new Set<string>();
  let existingIndex = false;
  let backupChecked = false;
  const temporaryItems = new Map<string, PendingCheckIn>();
  // 文件移动成功与索引写入成功是两个阶段；会话内牢记前者，避免重试移动失效路径。
  const savedTemporaryIds = new Set<string>();
  // 仅会话内的两阶段恢复记录；写索引失败不能再次移动原下载临时路径。
  const recoverySaves = new Map<string, { snapshot: PendingCheckIn; savedFilePath: string; info: { fileSizeBytes: number; contentSha1: string; expiresAtMs?: number } }>();
  let readyPromise: Promise<void> | null = null;
  let metadataReadable = false;
  let metadataDirty = false;
  let mutationTail: Promise<void> = Promise.resolve();

  /** 每个变更共享同一队列，失败只影响当前操作，不能让后续操作永久卡住。 */
  const enqueueMutation = <Result>(operation: () => Promise<Result>) => {
    const current = mutationTail.then(operation, operation);
    mutationTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };

  const ready = () => {
    if (!readyPromise) {
      readyPromise = Promise.resolve().then(() => adapters.storage.get(PENDING_CHECK_IN_STORAGE_KEY))
        .then((raw) => {
          if (!Array.isArray(raw) && raw !== undefined && raw !== null && raw !== "") {
            throw new Error("invalid recording index");
          }
          existingIndex = Array.isArray(raw);
          rawItems = existingIndex ? raw as unknown[] : [];
          const counts = new Map<string, number>();
          for (const entry of rawItems) {
            const id = (entry as Partial<PendingCheckIn> | null)?.requestId;
            if (isRequestId(id)) counts.set(id.toLowerCase(), (counts.get(id.toLowerCase()) || 0) + 1);
          }
          persistedItems = rawItems.filter((item): item is PendingCheckIn =>
            isPendingCheckIn(item) && counts.get(item.requestId.toLowerCase()) === 1,
          ).map(cloneItem);
          if (persistedItems.length !== rawItems.length) diagnose("metadata.entries.quarantined");
          managedIds = new Set(persistedItems.map(item => item.requestId));
          metadataReadable = true;
        })
        .catch((error) => {
          diagnose("metadata.read.failed", { error });
          // 列表保持可用，但不允许把“读取失败”误当成空库后覆盖旧索引；下次操作会重试读取。
          persistedItems = [];
          metadataReadable = false;
          readyPromise = null;
        });
    }
    return readyPromise;
  };

  const list = (): readonly PendingCheckIn[] =>
    freezeList([...persistedItems, ...temporaryItems.values()]);

  const persistItems = async (nextItems: PendingCheckIn[]) => {
    if (!metadataReadable) throw new Error("recording index unavailable");
    if (existingIndex && !backupChecked) {
      try {
        const backup = await adapters.storage.get(PENDING_CHECK_IN_BACKUP_KEY);
        if (backup === undefined || backup === null || backup === "") {
          await adapters.storage.set(PENDING_CHECK_IN_BACKUP_KEY, rawItems);
        } else if (!Array.isArray(backup)) {
          throw new Error("invalid recording index backup");
        }
        backupChecked = true;
      } catch (error) {
        diagnose("metadata.backup.failed", { error });
        throw error;
      }
    }
    const remaining = new Map(nextItems.map(item => [item.requestId, item]));
    const nextRaw: unknown[] = [];
    for (const entry of rawItems) {
      if (isPendingCheckIn(entry) && managedIds.has(entry.requestId)) {
        const replacement = remaining.get(entry.requestId);
        if (replacement) nextRaw.push(cloneItem(replacement));
        remaining.delete(entry.requestId);
      } else {
        nextRaw.push(entry);
      }
    }
    nextRaw.push(...Array.from(remaining.values()).map(cloneItem));
    await adapters.storage.set(
      PENDING_CHECK_IN_STORAGE_KEY,
      nextRaw,
    );
    rawItems = nextRaw;
    managedIds = new Set(nextItems.map(item => item.requestId));
    existingIndex = true;
  };

  const flushDirtyMetadata = async () => {
    if (!metadataDirty) return true;
    try {
      await persistItems(persistedItems);
      metadataDirty = false;
      return true;
    } catch (error) {
      diagnose("metadata.write.failed", { error });
      return false;
    }
  };

  const cleanupInternal = async () => {
    await ready();
    if (!metadataReadable) return;
    for (const item of persistedItems) {
      try {
        const exists = await adapters.file.exists(item.localPath);
        item.fileAvailability = exists ? "available" : "missing";
        if (!exists) diagnose("cleanup.file.missing", { requestId: item.requestId });
      } catch (error) {
        item.fileAvailability = "unavailable";
        diagnose("cleanup.file.unavailable", { requestId: item.requestId, error });
      }
    }
    // 检查结果先留在内存；读库不触发索引升级写入，后续实际变更会一并持久化。
    await flushDirtyMetadata();
  };

  const validateRecordingInput = (input: SavePendingRecordingInput) => {
    if (!isText(input.tempFilePath)) throw new Error("tempFilePath 必须为有效路径");
    if (!isContext(input.context)) throw new Error("context 必须是完整训练上下文");
    if (!isPositiveFiniteNumber(input.durationMs)) {
      throw new Error("durationMs 必须为有效原生时长");
    }
    if (!isPositiveInteger(input.fileSizeBytes)) {
      throw new Error("fileSizeBytes 必须为有效原生文件大小");
    }
  };

  const createItem = (
    input: SavePendingRecordingInput,
    localPath: string,
    recoverable: boolean,
  ): PendingCheckIn => {
    validateRecordingInput(input);
    if (!isText(localPath)) throw new Error("localPath 必须为有效路径");

    let requestId = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = adapters.random.hex();
      if (!isRequestId(candidate)) {
        throw new Error("requestId 必须是 32 位十六进制随机值");
      }
      const exists =
        rawItems.some((entry) => {
          const id = (entry as Partial<PendingCheckIn> | null)?.requestId;
          return isRequestId(id) && id.toLowerCase() === candidate.toLowerCase();
        }) ||
        temporaryItems.has(candidate);
      if (!exists) {
        requestId = candidate;
        break;
      }
    }
    if (!requestId) throw new Error("requestId 重复，无法创建待上传录音");
    const updatedAtMs = adapters.clock.now();
    if (!isNonNegativeInteger(updatedAtMs)) throw new Error("clock.now 必须返回有效时间");

    return {
      requestId,
      localPath,
      recoverable,
      context: { ...input.context },
      durationMs: input.durationMs,
      fileSizeBytes: input.fileSizeBytes,
      cloudFileId: "",
      status: "local",
      updatedAtMs,
      createdAtMs: updatedAtMs,
    };
  };

  const createTemporaryResult = (
    sourceItem: PendingCheckIn,
    message: string,
    status: PendingCheckInStatus = "local",
  ): SavePendingRecordingResult => {
    const item = { ...sourceItem, recoverable: false, status };
    temporaryItems.set(item.requestId, item);
    return { item: freezeItem(item), persisted: false, message };
  };

  const readUsageBytes = async () => {
    const bytes = await adapters.file.usageBytes();
    if (!isNonNegativeInteger(bytes)) throw new Error("invalid recording usage");
    return bytes;
  };

  const checkCanStartRecording = async () => {
    try {
      return await readUsageBytes() <= RECORDING_START_USED_BYTES
        ? { allowed: true, message: "" }
        : { allowed: false, message: capacityMessage() };
    } catch (error) {
      diagnose("capacity.read.failed", { error });
      return { allowed: false, message: capacityUnknownMessage };
    }
  };

  const saveRecordingInternal = async (
    input: SavePendingRecordingInput,
    retryItem?: PendingCheckIn,
  ): Promise<SavePendingRecordingResult> => {
    // 先校验原生录音结果，避免为了“修复”无效数据而猜测时长或文件大小。
    validateRecordingInput(input);
    await cleanupInternal();
    if (!metadataReadable) {
      const item = retryItem || createItem(input, input.tempFilePath, false);
      return createTemporaryResult(item, "无法读取本地录音索引，请重试，现有录音不会被覆盖", "failed");
    }
    const initialItem = retryItem || createItem(input, input.tempFilePath, false);

    const alreadySaved = savedTemporaryIds.has(initialItem.requestId);
    // saveFile 已成功的重试只补写索引，不新增持久文件；保存前容量门闩仅限制会增加占用的操作。
    if (!alreadySaved) {
      let usageBytes: number;
      try {
        usageBytes = await readUsageBytes();
      } catch (error) {
        diagnose("capacity.read.failed", { requestId: initialItem.requestId, error });
        return createTemporaryResult(initialItem, capacityUnknownMessage, "failed");
      }
      if (usageBytes + input.fileSizeBytes > PENDING_RECORDING_BYTES) {
        return createTemporaryResult(
          initialItem,
          capacityMessage(),
        );
      }
    }

    let saved: SavedPendingRecordingFile;
    if (alreadySaved) {
      saved = { savedFilePath: initialItem.localPath, fileSizeBytes: initialItem.fileSizeBytes, contentSha1: initialItem.contentSha1 };
    } else {
      try {
        saved = await adapters.file.save(input.tempFilePath);
      } catch (error) {
        if (isQuotaFailure(error)) {
          await cleanupInternal();
          try {
            saved = await adapters.file.save(input.tempFilePath);
          } catch (_retryError) {
            return createTemporaryResult(
              initialItem,
              "录音无法持久保存，关闭小程序后可能无法恢复",
            );
          }
        } else {
          return createTemporaryResult(
            initialItem,
            "录音无法持久保存，关闭小程序后可能无法恢复",
          );
        }
      }
    }

    const { savedFilePath } = saved;
    if (!isText(savedFilePath) || (!savedTemporaryIds.has(initialItem.requestId) && savedFilePath === input.tempFilePath)) {
      return createTemporaryResult(
        initialItem,
        "录音保存路径无效，关闭小程序后可能无法恢复",
        "failed",
      );
    }

    // onStop 的大小只作初步容量判断；最终保存文件的实测大小与摘要才是内容基准。
    const actualMetadata = isPositiveInteger(saved.fileSizeBytes) && isContentSha1(saved.contentSha1)
      ? { fileSizeBytes: saved.fileSizeBytes, contentSha1: saved.contentSha1.toLowerCase() }
      : {};
    const item = { ...initialItem, ...actualMetadata, localPath: savedFilePath, recoverable: true };
    // 先保存移动后的真实路径；后续索引失败也不能丢失阶段和内容基准。
    savedTemporaryIds.add(item.requestId);
    temporaryItems.set(item.requestId, { ...item, recoverable: false });
    let actualCapacityMessage = "";
    try {
      if (await readUsageBytes() > PENDING_RECORDING_BYTES) actualCapacityMessage = capacityMessage();
    } catch (error) {
      diagnose("capacity.calibration.failed", { requestId: item.requestId, error });
      actualCapacityMessage = capacityCalibrationUnknownMessage;
    }
    try {
      const nextItems = [...persistedItems, item];
      await persistItems(nextItems);
      persistedItems = nextItems;
      temporaryItems.delete(item.requestId);
      savedTemporaryIds.delete(item.requestId);
      metadataDirty = false;
      // 已保存文件因实测修正而越限时仍保留恢复信息，后续录音按实际累计大小限制保存。
      return {
        item: freezeItem(item),
        persisted: true,
        message: actualCapacityMessage,
      };
    } catch (_error) {
      // 已移动的文件仍可用于当前会话，不把未写入元数据的路径伪装成可恢复记录。
      return createTemporaryResult(
        item,
        "录音元数据保存失败，关闭小程序后可能无法恢复",
      );
    }
  };

  const updateInternal = async (
    requestId: string,
    patch: Pick<Partial<PendingCheckIn>, "cloudFileId" | "status" | "fileSizeBytes" | "contentSha1">,
    expectedShareRequestId?: string,
  ): Promise<PendingCheckIn | null> => {
    await ready();
    if (!metadataReadable) return null;
    await flushDirtyMetadata();
    if (!isRequestId(requestId)) return null;
    if (patch.status !== undefined && !isStatus(patch.status)) return null;
    if (patch.cloudFileId !== undefined && typeof patch.cloudFileId !== "string") {
      return null;
    }
    if (patch.fileSizeBytes !== undefined && !isPositiveInteger(patch.fileSizeBytes)) return null;
    if (patch.contentSha1 !== undefined && !isContentSha1(patch.contentSha1)) return null;
    const nowMs = adapters.clock.now();
    if (!isNonNegativeInteger(nowMs)) throw new Error("clock.now 必须返回有效时间");

    const updateItem = (item: PendingCheckIn) => ({
      ...item,
      ...(patch.cloudFileId !== undefined ? { cloudFileId: patch.cloudFileId } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.fileSizeBytes !== undefined ? { fileSizeBytes: patch.fileSizeBytes } : {}),
      ...(patch.contentSha1 !== undefined ? { contentSha1: patch.contentSha1.toLowerCase() } : {}),
      updatedAtMs: nowMs,
    });
    const persistedIndex = persistedItems.findIndex(
      (item) => item.requestId === requestId,
    );
    if (persistedIndex >= 0) {
      if (expectedShareRequestId && persistedItems[persistedIndex].shareRequestId?.toLowerCase() !== expectedShareRequestId.toLowerCase()) return null;
      const nextItem = updateItem(persistedItems[persistedIndex]);
      const nextItems = [...persistedItems];
      nextItems[persistedIndex] = nextItem;
      try {
        await persistItems(nextItems);
        persistedItems = nextItems;
        metadataDirty = false;
        return freezeItem(nextItem);
      } catch (_error) {
        return null;
      }
    }

    const temporaryItem = temporaryItems.get(requestId);
    if (!temporaryItem) return null;
    const nextItem = updateItem(temporaryItem);
    temporaryItems.set(requestId, nextItem);
    return freezeItem(nextItem);
  };

  const markUploaded = (requestId: string, cloudFileId: string, expectedShareRequestId?: string) => {
    if (!isText(cloudFileId)) return Promise.resolve(null);
    return update(requestId, { status: "uploaded", cloudFileId }, expectedShareRequestId);
  };

  const markFailed = (requestId: string, expectedShareRequestId?: string) => update(requestId, { status: "failed" }, expectedShareRequestId);

  const completeInternal = async (requestId: string, committed: boolean) => {
    if (!committed || !isRequestId(requestId)) return false;
    await ready();
    if (!metadataReadable) return false;
    await flushDirtyMetadata();
    const index = persistedItems.findIndex((item) => item.requestId === requestId);
    if (index < 0) return false;
    const completedAtMs = adapters.clock.now();
    if (!isNonNegativeInteger(completedAtMs)) throw new Error("clock.now 必须返回有效时间");
    const nextItem = { ...persistedItems[index], completedAtMs, updatedAtMs: completedAtMs };
    const nextItems = [...persistedItems];
    nextItems[index] = nextItem;
    try {
      await persistItems(nextItems);
      persistedItems = nextItems;
      metadataDirty = false;
      return true;
    } catch (_error) {
      return false;
    }
  };

  const beginShareInternal = async (requestId: string): Promise<PendingCheckIn | null> => {
    if (!isRequestId(requestId)) return null;
    await ready();
    if (!metadataReadable) return null;
    await flushDirtyMetadata();
    const index = persistedItems.findIndex((item) => item.requestId === requestId);
    if (index < 0) return null;
    const current = persistedItems[index];
    const nowMs = adapters.clock.now();
    if (!isNonNegativeInteger(nowMs)) throw new Error("clock.now 必须返回有效时间");
    // 尚未拿到服务端期限，或链接仍有效时，失败与不确定结果都必须复用原代。
    if (current.shareRequestId && (!current.share || current.share.expiresAtMs > nowMs)) {
      return freezeItem(current);
    }
    let shareRequestId = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = adapters.random.hex();
      if (!isRequestId(candidate)) throw new Error("shareRequestId 必须是 32 位十六进制随机值");
      const normalizedCandidate = candidate.toLowerCase();
      if (normalizedCandidate !== requestId.toLowerCase() && normalizedCandidate !== current.shareRequestId?.toLowerCase()) {
        shareRequestId = normalizedCandidate;
        break;
      }
    }
    if (!shareRequestId) throw new Error("无法生成新的分享代次");
    const nextItem = {
      ...current,
      shareRequestId,
      share: undefined,
      cloudFileId: "",
      status: "local" as PendingCheckInStatus,
      updatedAtMs: nowMs,
    };
    const nextItems = [...persistedItems];
    nextItems[index] = nextItem;
    try {
      await persistItems(nextItems);
      persistedItems = nextItems;
      metadataDirty = false;
      return freezeItem(nextItem);
    } catch (_error) {
      return null;
    }
  };

  const markSharedInternal = async (requestId: string, share: RecordingShare, expectedShareRequestId?: string): Promise<PendingCheckIn | null> => {
    if (!isRequestId(requestId) || !isRecordingShare(share)) return null;
    await ready();
    if (!metadataReadable) return null;
    await flushDirtyMetadata();
    const index = persistedItems.findIndex((item) => item.requestId === requestId);
    if (index < 0 || !persistedItems[index].shareRequestId) return null;
    if (expectedShareRequestId && persistedItems[index].shareRequestId?.toLowerCase() !== expectedShareRequestId.toLowerCase()) return null;
    const nowMs = adapters.clock.now();
    if (!isNonNegativeInteger(nowMs)) throw new Error("clock.now 必须返回有效时间");
    const nextItem = { ...persistedItems[index], share: { ...share }, status: "local" as PendingCheckInStatus, updatedAtMs: nowMs };
    const nextItems = [...persistedItems];
    nextItems[index] = nextItem;
    try {
      await persistItems(nextItems);
      persistedItems = nextItems;
      metadataDirty = false;
      return freezeItem(nextItem);
    } catch (error) {
      diagnose("share.metadata.write.failed", { requestId, error });
      return null;
    }
  };

  const markShareExpiredInternal = async (requestId: string, expectedShareRequestId: string) => {
    if (!isRequestId(requestId) || !isRequestId(expectedShareRequestId)) return false;
    await ready();
    if (!metadataReadable) return false;
    const index = persistedItems.findIndex((item) => item.requestId === requestId);
    if (index < 0 || persistedItems[index].shareRequestId?.toLowerCase() !== expectedShareRequestId.toLowerCase()) return false;
    const nowMs = adapters.clock.now();
    const nextItem = { ...persistedItems[index], shareRequestId: undefined, share: undefined, cloudFileId: "", status: "local" as PendingCheckInStatus, updatedAtMs: nowMs };
    const nextItems = [...persistedItems];
    nextItems[index] = nextItem;
    try {
      await persistItems(nextItems);
      persistedItems = nextItems;
      return true;
    } catch (_error) {
      return false;
    }
  };

  const removeInternal = async (requestId: string): Promise<boolean> => {
    diagnose("delete.start", { requestId });
    await ready();
    const temporaryItem = temporaryItems.get(requestId);
    if (!metadataReadable && !temporaryItem) {
      diagnose("delete.metadata.unavailable.failed", { requestId });
      return false;
    }
    await flushDirtyMetadata();
    const item =
      temporaryItem ||
      persistedItems.find((current) => current.requestId === requestId);
    if (!item) {
      diagnose("delete.already_removed", { requestId });
      return true;
    }
    let exists: boolean;
    try {
      exists = await adapters.file.exists(item.localPath);
    } catch (error) {
      diagnose("delete.access.failed", { requestId, error });
      return false;
    }
    try {
      if (exists) {
        // recoverable=false 也可能已完成 saveFile，仅索引写入失败，不能当作临时文件删除。
        const kind = !temporaryItem || savedTemporaryIds.has(requestId) ? "saved" : "temporary";
        await adapters.file.remove(item.localPath, kind);
      }
    } catch (error) {
      diagnose("delete.file.failed", { requestId, error });
      return false;
    }
    diagnose(exists ? "delete.file.success" : "delete.file.already_missing", { requestId });

    if (temporaryItem) {
      temporaryItems.delete(requestId);
      savedTemporaryIds.delete(requestId);
      diagnose("delete.success", { requestId });
      return true;
    }

    persistedItems = persistedItems.filter(
      (current) => current.requestId !== requestId,
    );
    metadataDirty = true;
    const written = await flushDirtyMetadata();
    diagnose(written ? "delete.success" : "delete.metadata.pending", { requestId });
    // 文件已确认删除，页面应移除失效卡片；索引失败保留 dirty 标记，后续 cleanup/mutation 补写。
    return true;
  };

  const matchesRecoverySnapshot = (snapshot: PendingCheckIn) => {
    const current = persistedItems.find(item => item.requestId === snapshot.requestId);
    if (!current) return false;
    // access 探针只更新 fileAvailability，不构成身份变更。
    const identity = ({ fileAvailability: _availability, ...item }: PendingCheckIn) => JSON.stringify(item);
    return identity(current) === identity(snapshot);
  };

  const restoreRecordingInternal = async (
    snapshot: PendingCheckIn,
    tempFilePath: string,
    info: { fileSizeBytes: number; contentSha1: string; expiresAtMs?: number },
  ): Promise<PendingCheckIn | null> => {
    await ready();
    if (!metadataReadable || !matchesRecoverySnapshot(snapshot)) {
      recoverySaves.delete(snapshot.requestId);
      return null;
    }
    const checkInfo = (actual: { fileSizeBytes: number; contentSha1: string }) => {
      if (!isPositiveInteger(actual.fileSizeBytes) || actual.fileSizeBytes > MAX_RECORDING_FILE_BYTES ||
          !isContentSha1(actual.contentSha1) || actual.fileSizeBytes !== info.fileSizeBytes ||
          actual.contentSha1.toLowerCase() !== info.contentSha1.toLowerCase() ||
          (snapshot.contentSha1 && (snapshot.fileSizeBytes !== actual.fileSizeBytes || snapshot.contentSha1.toLowerCase() !== actual.contentSha1.toLowerCase()))) {
        throw Object.assign(new Error("恢复文件校验失败，原录音已保留"), { code: "RECOVERY_VERIFY_FAILED" });
      }
      if (info.expiresAtMs !== undefined && info.expiresAtMs <= adapters.clock.now()) throw Object.assign(new Error("恢复来源已过期，原录音已保留"), { code: "SHARE_EXPIRED" });
    };
    checkInfo(info);
    if (!adapters.file.info) throw new Error("无法校验恢复文件");
    let saved = recoverySaves.get(snapshot.requestId);
    if (!saved) {
      if (tempFilePath === snapshot.localPath || !isText(tempFilePath)) throw new Error("恢复路径无效");
      checkInfo(await adapters.file.info(tempFilePath));
      if (await readUsageBytes() + info.fileSizeBytes > PENDING_RECORDING_BYTES) throw Object.assign(new Error(capacityMessage()), { code: "RECOVERY_CAPACITY" });
      let result: SavedPendingRecordingFile;
      try { result = await adapters.file.save(tempFilePath); }
      catch (error) { if (isQuotaFailure(error)) throw Object.assign(new Error(capacityMessage()), { code: "RECOVERY_CAPACITY" }); throw error; }
      if (!isText(result.savedFilePath) || result.savedFilePath === snapshot.localPath || result.savedFilePath === tempFilePath) throw new Error("恢复保存路径无效");
      saved = { snapshot: cloneItem(snapshot), savedFilePath: result.savedFilePath, info: { ...info } };
      recoverySaves.set(snapshot.requestId, saved);
    }
    // saveFile 成功后必须重新核实；失败仍记住保存路径，下一次只重试校验/写索引。
    checkInfo(await adapters.file.info(saved.savedFilePath));
    if (await readUsageBytes() > PENDING_RECORDING_BYTES) throw Object.assign(new Error(capacityMessage()), { code: "RECOVERY_CAPACITY" });
    if (!matchesRecoverySnapshot(snapshot)) return null;
    const nextItem: PendingCheckIn = { ...snapshot, localPath: saved.savedFilePath, recoverable: true,
      fileAvailability: "available", fileSizeBytes: info.fileSizeBytes, contentSha1: info.contentSha1.toLowerCase(), updatedAtMs: adapters.clock.now() };
    const nextItems = persistedItems.map(item => item.requestId === snapshot.requestId ? nextItem : item);
    try { await persistItems(nextItems); }
    catch (_error) { throw Object.assign(new Error("恢复索引写入失败"), { code: "PENDING_PERSIST_FAILED" }); }
    persistedItems = nextItems;
    recoverySaves.delete(snapshot.requestId);
    return freezeItem(nextItem);
  };
  const restoreRecording = (snapshot: PendingCheckIn, tempFilePath: string, info: { fileSizeBytes: number; contentSha1: string; expiresAtMs?: number }) =>
    enqueueMutation(() => restoreRecordingInternal(snapshot, tempFilePath, info));
  const retryRestoreRecording = (requestId: string) => enqueueMutation(async () => {
    const saved = recoverySaves.get(requestId);
    return saved ? restoreRecordingInternal(saved.snapshot, saved.savedFilePath, saved.info) : undefined;
  });

  const cleanup = () => enqueueMutation(cleanupInternal);
  const saveRecording = (input: SavePendingRecordingInput) =>
    enqueueMutation(() => saveRecordingInternal(input));
  const retrySave = (requestId: string) => enqueueMutation(async (): Promise<SavePendingRecordingResult | null> => {
    await ready();
    const item = temporaryItems.get(requestId);
    if (!item) {
      const persisted = persistedItems.find((current) => current.requestId === requestId);
      return persisted ? { item: freezeItem(persisted), persisted: true, message: "" } : null;
    }
    return saveRecordingInternal({ tempFilePath: item.localPath, context: item.context, durationMs: item.durationMs, fileSizeBytes: item.fileSizeBytes }, item);
  });
  const update = (
    requestId: string,
    patch: Pick<Partial<PendingCheckIn>, "cloudFileId" | "status" | "fileSizeBytes" | "contentSha1">,
    expectedShareRequestId?: string,
  ) => enqueueMutation(() => updateInternal(requestId, patch, expectedShareRequestId));
  const remove = (requestId: string) => enqueueMutation(() => removeInternal(requestId));
  const complete = (requestId: string, committed: boolean) =>
    enqueueMutation(() => completeInternal(requestId, committed));
  const beginShare = (requestId: string) => enqueueMutation(() => beginShareInternal(requestId));
  const markShared = (requestId: string, share: RecordingShare, expectedShareRequestId?: string) =>
    enqueueMutation(() => markSharedInternal(requestId, share, expectedShareRequestId));
  const markShareExpired = (requestId: string, expectedShareRequestId: string) =>
    enqueueMutation(() => markShareExpiredInternal(requestId, expectedShareRequestId));

  return {
    ready,
    restoreRecording,
    retryRestoreRecording,
    list,
    cleanup,
    saveRecording,
    retrySave,
    checkCanStartRecording,
    update,
    remove,
    markUploaded,
    markFailed,
    complete,
    beginShare,
    markShared,
    markShareExpired,
  };
};
