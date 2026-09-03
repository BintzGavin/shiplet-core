import type {
  ExternalRewriteSpool,
  ExternalRewriteSpoolStore,
} from "./external-text-rewrite";
import { EXTERNAL_REWRITE_SPOOL_PART_BYTES } from "./external-text-rewrite";

export const EXTERNAL_REWRITE_SPOOL_PREFIX = "_internal/external-rewrite/v1/";
export const EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS = 15 * 60 * 1_000;
export const EXTERNAL_REWRITE_SPOOL_MAX_AGE_MS =
  EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS;

const SPOOL_PART_KEY_WIDTH = 6;
const SPOOL_LEASE_KEY = "lease";
const SPOOL_LEASE_REFRESH_MS = 5 * 60 * 1_000;
const R2_DELETE_BATCH_SIZE = 1_000;

type HeartbeatWait = (delayMs: number, signal: AbortSignal) => Promise<void>;

function waitForHeartbeat(delayMs: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delayMs);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function activeLeaseMetadata(
  contentType: "html" | "css",
  createdAt: number,
  refreshedAt: number,
) {
  return {
    contentType,
    createdAt: String(createdAt),
    leaseRefreshedAt: String(refreshedAt),
    leaseState: "active",
    shipletExternalRewriteSpool: "v1",
  };
}

function sweepFenceMetadata(fencedAt: number) {
  return {
    leaseState: "sweeping",
    shipletExternalRewriteSpool: "v1",
    sweepFencedAt: String(fencedAt),
  };
}

function leaseGenerationBody(state: "active" | "sweeping", at: number) {
  return `${state}:${at}:${crypto.randomUUID()}`;
}

function safeKeyComponent(value: string) {
  const normalized = value.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 256);
  return normalized || "unknown";
}

function randomSpoolId() {
  return crypto.randomUUID();
}

function spoolPartKey(baseKey: string, index: number) {
  return `${baseKey}/part-${String(index).padStart(SPOOL_PART_KEY_WIDTH, "0")}`;
}

function spoolLeaseKey(baseKey: string) {
  return `${baseKey}/${SPOOL_LEASE_KEY}`;
}

async function deleteR2Keys(bucket: R2Bucket, keys: string[]) {
  for (let index = 0; index < keys.length; index += R2_DELETE_BATCH_SIZE) {
    await bucket.delete(keys.slice(index, index + R2_DELETE_BATCH_SIZE));
  }
}

async function deleteR2KeyGroups(bucket: R2Bucket, groups: string[][]) {
  let batch: string[] = [];
  for (const group of groups) {
    if (group.length > R2_DELETE_BATCH_SIZE) {
      throw new RangeError("External rewrite spool group is too large");
    }
    if (batch.length + group.length > R2_DELETE_BATCH_SIZE) {
      await bucket.delete(batch);
      batch = [];
    }
    batch.push(...group);
  }
  if (batch.length > 0) await bucket.delete(batch);
}

class CloudflareExternalRewriteSpool implements ExternalRewriteSpool {
  private readonly partKeys: string[] = [];
  private completed = false;
  private disposed = false;
  private disposeRequested = false;
  private writeFailed = false;
  private leaseOwnershipLost = false;
  private lastLeaseRefresh = Number.NEGATIVE_INFINITY;
  private leaseEtag: string | null = null;
  private readonly heartbeatAbort = new AbortController();
  private heartbeatError: unknown = null;
  private heartbeatTask: Promise<void> | null = null;
  private exclusiveTail: Promise<void> = Promise.resolve();
  private leaseTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly bucket: R2Bucket,
    private readonly baseKey: string,
    private readonly contentType: "html" | "css",
    private readonly createdAt: number,
    private readonly now: () => number,
    private readonly heartbeatWait: HeartbeatWait,
  ) {}

  private runExclusive<T>(operation: () => Promise<T>) {
    const result = this.exclusiveTail.then(operation, operation);
    this.exclusiveTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private refreshLease() {
    const result = this.leaseTail.then(async () => {
      if (this.disposed || this.disposeRequested) {
        throw new TypeError("External rewrite spool is unavailable");
      }
      const refreshedAt = this.now();
      if (!Number.isSafeInteger(refreshedAt) || refreshedAt < 0) {
        throw new TypeError("Invalid external rewrite spool clock");
      }
      if (this.heartbeatError) throw this.heartbeatError;
      if (this.leaseOwnershipLost) {
        throw new TypeError("External rewrite spool lease ownership was lost");
      }
      if (refreshedAt - this.lastLeaseRefresh < SPOOL_LEASE_REFRESH_MS) {
        return;
      }
      const lease = await this.bucket.put(
        spoolLeaseKey(this.baseKey),
        leaseGenerationBody("active", refreshedAt),
        {
          ...(this.leaseEtag
            ? { onlyIf: { etagMatches: this.leaseEtag } }
            : {}),
          httpMetadata: { contentType: "application/octet-stream" },
          customMetadata: activeLeaseMetadata(
            this.contentType,
            this.createdAt,
            refreshedAt,
          ),
        },
      );
      if (!lease) {
        this.leaseOwnershipLost = true;
        throw new TypeError("External rewrite spool lease ownership was lost");
      }
      this.leaseEtag = lease.etag;
      const completedAt = this.now();
      if (!Number.isSafeInteger(completedAt) || completedAt < 0) {
        throw new TypeError("Invalid external rewrite spool clock");
      }
      this.lastLeaseRefresh = completedAt;
      this.startHeartbeat();
    });
    this.leaseTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private startHeartbeat() {
    if (
      this.heartbeatTask ||
      this.disposed ||
      this.disposeRequested ||
      this.heartbeatAbort.signal.aborted
    ) {
      return;
    }
    this.heartbeatTask = this.runHeartbeat();
  }

  private async runHeartbeat() {
    const signal = this.heartbeatAbort.signal;
    try {
      while (!signal.aborted) {
        await this.heartbeatWait(SPOOL_LEASE_REFRESH_MS, signal);
        if (signal.aborted) break;
        await this.refreshLease();
      }
    } catch (error) {
      this.writeFailed = true;
      this.heartbeatError = error;
    }
  }

  private async stopHeartbeat() {
    this.heartbeatAbort.abort();
    await this.heartbeatTask;
  }

  async append(part: Uint8Array) {
    return this.runExclusive(async () => {
      if (
        this.completed ||
        this.disposed ||
        this.disposeRequested ||
        this.writeFailed
      ) {
        throw new TypeError("External rewrite spool is not writable");
      }
      if (part.byteLength === 0) return;
      if (part.byteLength > EXTERNAL_REWRITE_SPOOL_PART_BYTES) {
        throw new RangeError(
          "External rewrite spool part exceeds the part limit",
        );
      }
      try {
        await this.refreshLease();
        const key = spoolPartKey(this.baseKey, this.partKeys.length);
        // Track the deterministic key before the put. A rejected put can still
        // have reached R2, so cleanup must treat the key as possibly present.
        this.partKeys.push(key);
        await this.bucket.put(key, part, {
          httpMetadata: { contentType: "application/octet-stream" },
          customMetadata: {
            contentType: this.contentType,
            createdAt: String(this.createdAt),
            shipletExternalRewriteSpool: "v1",
          },
        });
        await this.refreshLease();
      } catch (error) {
        this.writeFailed = true;
        throw error;
      }
    });
  }

  async complete() {
    return this.runExclusive(async () => {
      if (this.disposed || this.disposeRequested) {
        throw new TypeError("External rewrite spool has been disposed");
      }
      if (this.writeFailed) {
        throw new TypeError("External rewrite spool write failed");
      }
      if (this.completed) return;
      if (this.partKeys.length === 0) {
        throw new TypeError("External rewrite spool is empty");
      }
      await this.refreshLease();
      this.completed = true;
    });
  }

  async open() {
    await this.exclusiveTail;
    if (
      !this.completed ||
      this.disposed ||
      this.disposeRequested ||
      this.writeFailed
    ) {
      throw new TypeError("External rewrite spool is unavailable");
    }
    await this.refreshLease();
    const bucket = this.bucket;
    const partKeys = [...this.partKeys];
    let partIndex = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          await this.refreshLease();
          while (partIndex < partKeys.length) {
            if (!reader) {
              const object = await bucket.get(partKeys[partIndex]);
              if (!object) {
                throw new Error("External rewrite spool part is unavailable");
              }
              reader = object.body.getReader();
            }
            const result = await reader.read();
            if (!result.done) {
              if (result.value.byteLength > 0) controller.enqueue(result.value);
              return;
            }
            reader.releaseLock();
            reader = null;
            partIndex += 1;
          }
          controller.close();
        } catch (error) {
          try {
            await reader?.cancel(error);
          } catch {
            // The read failure remains authoritative.
          } finally {
            try {
              reader?.releaseLock();
            } catch {
              // An errored R2 body can already have released its lock.
            }
            reader = null;
          }
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader?.cancel(reason);
        } finally {
          reader?.releaseLock();
          reader = null;
        }
      },
    });
  }

  async dispose() {
    return this.runExclusive(async () => {
      if (this.disposed) return;
      this.disposeRequested = true;
      try {
        await this.stopHeartbeat();
        await this.leaseTail;
        await deleteR2Keys(this.bucket, [
          spoolLeaseKey(this.baseKey),
          ...this.partKeys,
        ]);
        this.disposed = true;
        this.partKeys.length = 0;
      } catch (error) {
        // A failed deletion remains retryable; the known keys stay intact.
        throw error;
      }
    });
  }
}

export function createCloudflareExternalRewriteSpoolStore(
  bucket: R2Bucket,
  options: {
    heartbeatWait?: HeartbeatWait;
    now?: () => number;
    randomId?: () => string;
  } = {},
): ExternalRewriteSpoolStore {
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? randomSpoolId;
  const heartbeatWait = options.heartbeatWait ?? waitForHeartbeat;
  return {
    async create(input) {
      const createdAt = now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new TypeError("Invalid external rewrite spool clock");
      }
      const timeComponent = String(createdAt).padStart(13, "0");
      const projectComponent = safeKeyComponent(input.projectId);
      const idComponent = safeKeyComponent(randomId());
      const baseKey = `${EXTERNAL_REWRITE_SPOOL_PREFIX}${timeComponent}/${projectComponent}/${idComponent}`;
      return new CloudflareExternalRewriteSpool(
        bucket,
        baseKey,
        input.contentType,
        createdAt,
        now,
        heartbeatWait,
      );
    },
  };
}

type ListedSpoolGroup = {
  keys: string[];
  latestUpload: number;
  name: string;
};

function listedSpoolGroupName(key: string) {
  if (!key.startsWith(EXTERNAL_REWRITE_SPOOL_PREFIX)) return null;
  const components = key.slice(EXTERNAL_REWRITE_SPOOL_PREFIX.length).split("/");
  if (components.length < 4) return key;
  return `${EXTERNAL_REWRITE_SPOOL_PREFIX}${components.slice(0, 3).join("/")}`;
}

export async function sweepStaleExternalRewriteSpools(
  bucket: R2Bucket,
  options: {
    now?: number;
    maxAgeMs?: number;
    maxObjects?: number;
  } = {},
) {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? EXTERNAL_REWRITE_SPOOL_MAX_AGE_MS;
  const maxObjects = options.maxObjects ?? 1_000;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS ||
    !Number.isSafeInteger(maxObjects) ||
    maxObjects < 1 ||
    maxObjects > 10_000
  ) {
    throw new TypeError("Invalid external rewrite spool sweep options");
  }

  const staleGroups: ListedSpoolGroup[] = [];
  let staleObjectCount = 0;
  let pendingGroup: ListedSpoolGroup | null = null;
  let objectBudgetReached = false;
  const considerPendingGroup = () => {
    if (!pendingGroup) return;
    if (pendingGroup.latestUpload <= now - maxAgeMs) {
      if (staleObjectCount + pendingGroup.keys.length <= maxObjects) {
        staleGroups.push(pendingGroup);
        staleObjectCount += pendingGroup.keys.length;
      } else {
        objectBudgetReached = true;
      }
    }
    pendingGroup = null;
  };
  let cursor: string | undefined;
  while (!objectBudgetReached && staleObjectCount < maxObjects) {
    const page = await bucket.list({
      prefix: EXTERNAL_REWRITE_SPOOL_PREFIX,
      cursor,
      limit: 1_000,
    });
    for (const object of page.objects) {
      const groupName = listedSpoolGroupName(object.key);
      if (!groupName) continue;
      if (pendingGroup && pendingGroup.name !== groupName) {
        considerPendingGroup();
        if (objectBudgetReached) break;
      }
      const uploadedAt = object.uploaded.getTime();
      pendingGroup ??= {
        keys: [],
        latestUpload: Number.POSITIVE_INFINITY,
        name: groupName,
      };
      pendingGroup.keys.push(object.key);
      pendingGroup.latestUpload = Number.isFinite(uploadedAt)
        ? Math.max(
            pendingGroup.latestUpload === Number.POSITIVE_INFINITY
              ? uploadedAt
              : pendingGroup.latestUpload,
            uploadedAt,
          )
        : Number.POSITIVE_INFINITY;
    }
    if (objectBudgetReached || !page.truncated) {
      if (!objectBudgetReached) considerPendingGroup();
      break;
    }
    cursor = page.cursor;
  }
  const fencedGroups: string[][] = [];
  for (const group of staleGroups) {
    const leaseKey = `${group.name}/${SPOOL_LEASE_KEY}`;
    const currentLease = await bucket.head(leaseKey);
    const currentLeaseUpload = currentLease?.uploaded.getTime();
    if (
      currentLeaseUpload !== undefined &&
      (!Number.isFinite(currentLeaseUpload) ||
        currentLeaseUpload > now - maxAgeMs)
    ) {
      continue;
    }
    // A valid writer creates its lease before its first part. A part-only
    // abandoned group therefore has no live owner to fence, and creating a
    // marker here would double the cleanup object count for leaked parts.
    if (!currentLease) {
      fencedGroups.push(group.keys);
      continue;
    }
    const fence = await bucket.put(
      leaseKey,
      leaseGenerationBody("sweeping", now),
      {
        onlyIf: { etagMatches: currentLease.etag },
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: sweepFenceMetadata(now),
      },
    );
    if (!fence) continue;
    fencedGroups.push(group.keys);
  }
  if (fencedGroups.length > 0) {
    await deleteR2KeyGroups(bucket, fencedGroups);
  }
  return fencedGroups.reduce((total, keys) => total + keys.length, 0);
}
