export const PENDING_CHECK_IN_STORAGE_KEY = "pending-check-ins-v1";
export const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MS = 7 * DAY_MS;
export const MAX_PENDING_COUNT = 3;
export const MAX_PENDING_FILE_BYTES = 8 * 1024 * 1024;

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
  cloudFileId: string;
  status: PendingCheckInStatus;
  updatedAtMs: number;
};

export type PendingCheckInStorageAdapter = {
  get(key: string): unknown | Promise<unknown>;
  set(key: string, value: PendingCheckIn[]): void | Promise<void>;
};

export type PendingCheckInFileAdapter = {
  save(tempFilePath: string):
    | { savedFilePath: string }
    | Promise<{ savedFilePath: string }>;
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

const isPositiveFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

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
    typeof item.cloudFileId === "string" &&
    isStatus(item.status) &&
    isNonNegativeInteger(item.updatedAtMs)
  );
};

const freezeItem = (item: PendingCheckIn): PendingCheckIn =>
  Object.freeze({
    ...item,
    context: Object.freeze({ ...item.context }),
  }) as PendingCheckIn;

const freezeList = (items: readonly PendingCheckIn[]) =>
  Object.freeze(items.map(freezeItem)) as readonly PendingCheckIn[];

const cloneItem = (item: PendingCheckIn): PendingCheckIn => ({
  ...item,
  context: { ...item.context },
});

const isQuotaFailure = (error: unknown) => {
  const details = error as { code?: unknown; errMsg?: unknown; message?: unknown };
  const text = `${details?.code || ""} ${details?.errMsg || ""} ${details?.message || ""}`;
  return /quota|storage.?full|space/i.test(text);
};

const capacityMessage = (countExceeded: boolean) =>
  countExceeded
    ? "离线录音已满（最多 3 条），请清理历史录音或联网提交"
    : "离线录音已满（最多 8MiB），请清理历史录音或联网提交";

/**
 * 待上传项只持久化已由 saveFile 移入本地文件系统的路径；临时路径只在本次会话内保留。
 */
export const createPendingCheckInStore = (adapters: PendingCheckInAdapters) => {
  let persistedItems: PendingCheckIn[] = [];
  const temporaryItems = new Map<string, PendingCheckIn>();
  let readyPromise: Promise<void> | null = null;
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
      readyPromise = Promise.resolve(adapters.storage.get(PENDING_CHECK_IN_STORAGE_KEY))
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
        })
        .catch(() => {
          // 持久化数据损坏或读取失败时从空队列恢复，不能让训练页白屏。
          persistedItems = [];
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
    const nowMs = adapters.clock.now();
    const removableIds = new Set<string>();

    for (const item of persistedItems) {
      const expired = nowMs - item.updatedAtMs >= RETENTION_MS;
      let exists = false;
      try {
        exists = await adapters.file.exists(item.localPath);
      } catch (_error) {
        continue;
      }
      if (!expired && exists) continue;

      if (exists) {
        try {
          await adapters.file.remove(item.localPath);
        } catch (_error) {
          // 文件删除失败时元数据必须保留，下一次启动仍可继续清理。
          continue;
        }
      }
      removableIds.add(item.requestId);
    }

    if (removableIds.size > 0) {
      // 文件已经删除就立刻从当前可见队列移除，持久化失败由 dirty 标记在后续 mutation 补写。
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
    const initialItem = createItem(input, input.tempFilePath, false);

    const capacity = hasCapacityFor(input.fileSizeBytes);
    if (capacity.countExceeded || capacity.byteExceeded) {
      return createTemporaryResult(
        initialItem,
        capacityMessage(capacity.countExceeded),
      );
    }

    let savedFilePath: string;
    try {
      const saved = await adapters.file.save(input.tempFilePath);
      savedFilePath = saved.savedFilePath;
    } catch (error) {
      if (isQuotaFailure(error)) {
        await cleanupInternal();
        try {
          const saved = await adapters.file.save(input.tempFilePath);
          savedFilePath = saved.savedFilePath;
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

    if (!isText(savedFilePath) || savedFilePath === input.tempFilePath) {
      return createTemporaryResult(
        initialItem,
        "录音保存路径无效，关闭小程序后可能无法恢复",
        "failed",
      );
    }

    const item = { ...initialItem, localPath: savedFilePath, recoverable: true };
    try {
      const nextItems = [...persistedItems, item];
      await persistItems(nextItems);
      persistedItems = nextItems;
      metadataDirty = false;
      return { item: freezeItem(item), persisted: true, message: "" };
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
    patch: Pick<Partial<PendingCheckIn>, "cloudFileId" | "status">,
  ): Promise<PendingCheckIn | null> => {
    await ready();
    await flushDirtyMetadata();
    if (!isRequestId(requestId)) return null;
    if (patch.status !== undefined && !isStatus(patch.status)) return null;
    if (patch.cloudFileId !== undefined && typeof patch.cloudFileId !== "string") {
      return null;
    }
    const nowMs = adapters.clock.now();
    if (!isNonNegativeInteger(nowMs)) throw new Error("clock.now 必须返回有效时间");

    const updateItem = (item: PendingCheckIn) => ({
      ...item,
      ...patch,
      updatedAtMs: nowMs,
    });
    const persistedIndex = persistedItems.findIndex(
      (item) => item.requestId === requestId,
    );
    if (persistedIndex >= 0) {
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

  const markUploaded = (requestId: string, cloudFileId: string) => {
    if (!isText(cloudFileId)) return Promise.resolve(null);
    return update(requestId, { status: "uploaded", cloudFileId });
  };

  const markFailed = (requestId: string) => update(requestId, { status: "failed" });

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
    patch: Pick<Partial<PendingCheckIn>, "cloudFileId" | "status">,
  ) => enqueueMutation(() => updateInternal(requestId, patch));
  const remove = (requestId: string) => enqueueMutation(() => removeInternal(requestId));
  const complete = (requestId: string, committed: boolean) =>
    committed ? remove(requestId) : Promise.resolve(false);

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
  };
};
