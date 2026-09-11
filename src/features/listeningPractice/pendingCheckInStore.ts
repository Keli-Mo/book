export const PENDING_CHECK_IN_STORAGE_KEY = "pending-check-ins-v1";
export const MAX_PENDING_COUNT = 500;
export const MAX_PENDING_FILE_BYTES = 100 * 1024 * 1024;

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
  set(key: string, value: PendingCheckIn[]): void | Promise<void>;
};

export type SavedPendingRecordingFile = {
  savedFilePath: string;
  fileSizeBytes?: number;
  contentSha1?: string;
};

export type PendingCheckInFileAdapter = {
  save(tempFilePath: string):
    | SavedPendingRecordingFile
    | Promise<SavedPendingRecordingFile>;
  exists(filePath: string): boolean | Promise<boolean>;
  remove(filePath: string): void | Promise<void>;
};

export type PendingCheckInAdapters = {
  storage: PendingCheckInStorageAdapter;
  file: PendingCheckInFileAdapter;
  clock: { now(): number };
  random: { hex(): string };
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
  ...(item.contentSha1 ? { contentSha1: item.contentSha1.toLowerCase() } : {}),
});

const isQuotaFailure = (error: unknown) => {
  const details = error as { code?: unknown; errMsg?: unknown; message?: unknown };
  const text = `${details?.code || ""} ${details?.errMsg || ""} ${details?.message || ""}`;
  return /quota|storage.?full|space/i.test(text);
};

const capacityMessage = (countExceeded: boolean) =>
  countExceeded
    ? "本地录音已满（最多 500 条），请清理历史录音"
    : "本地录音已满（总计最多 100MiB），请清理历史录音";

/**
 * 待上传项只持久化已由 saveFile 移入本地文件系统的路径；临时路径只在本次会话内保留。
 */
export const createPendingCheckInStore = (adapters: PendingCheckInAdapters) => {
  let persistedItems: PendingCheckIn[] = [];
  const temporaryItems = new Map<string, PendingCheckIn>();
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
          persistedItems = Array.isArray(raw)
            ? raw.reduce<PendingCheckIn[]>((items, item) => {
                if (
                  isPendingCheckIn(item) &&
                  !items.some((current) => current.requestId === item.requestId)
                ) {
                  items.push(cloneItem(item));
                }
                return items;
              }, [])
            : [];
          metadataReadable = true;
        })
        .catch(() => {
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
    await adapters.storage.set(
      PENDING_CHECK_IN_STORAGE_KEY,
      nextItems.map(cloneItem),
    );
  };

  const flushDirtyMetadata = async () => {
    if (!metadataDirty) return true;
    try {
      await persistItems(persistedItems);
      metadataDirty = false;
      return true;
    } catch (_error) {
      return false;
    }
  };

  const cleanupInternal = async () => {
    await ready();
    if (!metadataReadable) return;
    const removableIds = new Set<string>();

    for (const item of persistedItems) {
      let exists = false;
      try {
        exists = await adapters.file.exists(item.localPath);
      } catch (_error) {
        continue;
      }
      // 未提交录音不按时间自动删除；这里只清理已确认不存在的文件引用。
      if (exists) continue;
      removableIds.add(item.requestId);
    }

    if (removableIds.size > 0) {
      // 文件已不存在就移除无效引用，持久化失败由 dirty 标记在后续 mutation 补写。
      persistedItems = persistedItems.filter(
        (item) => !removableIds.has(item.requestId),
      );
      metadataDirty = true;
    }
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
        persistedItems.some((item) => item.requestId === candidate) ||
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

  const hasCapacityFor = (fileSizeBytes: number) => {
    const recoverableItems = persistedItems.filter((item) => item.recoverable);
    const bytes = recoverableItems.reduce(
      (total, item) => total + item.fileSizeBytes,
      0,
    );
    return {
      countExceeded: recoverableItems.length >= MAX_PENDING_COUNT,
      byteExceeded: bytes + fileSizeBytes > MAX_PENDING_FILE_BYTES,
    };
  };

  const saveRecordingInternal = async (
    input: SavePendingRecordingInput,
  ): Promise<SavePendingRecordingResult> => {
    // 先校验原生录音结果，避免为了“修复”无效数据而猜测时长或文件大小。
    validateRecordingInput(input);
    await cleanupInternal();
    if (!metadataReadable) {
      const item = createItem(input, input.tempFilePath, false);
      return createTemporaryResult(item, "无法读取本地录音索引，请重试，现有录音不会被覆盖", "failed");
    }
    const initialItem = createItem(input, input.tempFilePath, false);

    const capacity = hasCapacityFor(input.fileSizeBytes);
    if (capacity.countExceeded || capacity.byteExceeded) {
      return createTemporaryResult(
        initialItem,
        capacityMessage(capacity.countExceeded),
      );
    }

    let saved: SavedPendingRecordingFile;
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

    const { savedFilePath } = saved;
    if (!isText(savedFilePath) || savedFilePath === input.tempFilePath) {
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
    const actualCapacity = hasCapacityFor(item.fileSizeBytes);
    try {
      const nextItems = [...persistedItems, item];
      await persistItems(nextItems);
      persistedItems = nextItems;
      metadataDirty = false;
      // 已保存文件因实测修正而越限时仍保留恢复信息，后续录音按实际累计大小限制保存。
      return {
        item: freezeItem(item),
        persisted: true,
        message: actualCapacity.byteExceeded ? capacityMessage(false) : "",
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
      if (expectedShareRequestId && persistedItems[persistedIndex].shareRequestId !== expectedShareRequestId) return null;
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
      if (candidate !== requestId && candidate !== current.shareRequestId) { shareRequestId = candidate; break; }
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
    if (expectedShareRequestId && persistedItems[index].shareRequestId !== expectedShareRequestId) return null;
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
    } catch (_error) {
      return null;
    }
  };

  const markShareExpiredInternal = async (requestId: string, expectedShareRequestId: string) => {
    if (!isRequestId(requestId) || !isRequestId(expectedShareRequestId)) return false;
    await ready();
    if (!metadataReadable) return false;
    const index = persistedItems.findIndex((item) => item.requestId === requestId);
    if (index < 0 || persistedItems[index].shareRequestId !== expectedShareRequestId) return false;
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
    await ready();
    await flushDirtyMetadata();
    const temporaryItem = temporaryItems.get(requestId);
    const item =
      temporaryItem ||
      persistedItems.find((current) => current.requestId === requestId);
    if (!item) return false;
    try {
      if (await adapters.file.exists(item.localPath)) {
        await adapters.file.remove(item.localPath);
      }
    } catch (_error) {
      return false;
    }

    if (temporaryItem) {
      temporaryItems.delete(requestId);
      return true;
    }

    persistedItems = persistedItems.filter(
      (current) => current.requestId !== requestId,
    );
    metadataDirty = true;
    return flushDirtyMetadata();
  };

  const cleanup = () => enqueueMutation(cleanupInternal);
  const saveRecording = (input: SavePendingRecordingInput) =>
    enqueueMutation(() => saveRecordingInternal(input));
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
    list,
    cleanup,
    saveRecording,
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
