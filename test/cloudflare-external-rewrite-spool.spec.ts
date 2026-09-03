import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS,
  EXTERNAL_REWRITE_SPOOL_PREFIX,
  createCloudflareExternalRewriteSpoolStore,
  sweepStaleExternalRewriteSpools,
} from "../src/cloudflare-external-rewrite-spool";

const testEnv = env as Env;

type StoredObject = {
  bytes: Uint8Array;
  customMetadata?: Record<string, string>;
  etag: string;
  uploaded: Date;
};

type PutCall = {
  byteLength: number;
  key: string;
  time: number;
};

type HeartbeatWait = (delayMs: number, signal: AbortSignal) => Promise<void>;

class ControlledPause {
  private releasePause!: () => void;
  private startPause!: () => void;
  readonly released = new Promise<void>((resolve) => {
    this.releasePause = resolve;
  });
  readonly started = new Promise<void>((resolve) => {
    this.startPause = resolve;
  });

  async pause() {
    this.startPause();
    await this.released;
  }

  release() {
    this.releasePause();
  }
}

class ControlledHeartbeatWaiter {
  private readonly pending: Array<() => void> = [];

  readonly wait: HeartbeatWait = (_delayMs, signal) => {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", finish);
        const index = this.pending.indexOf(finish);
        if (index >= 0) this.pending.splice(index, 1);
        resolve();
      };
      signal.addEventListener("abort", finish, { once: true });
      this.pending.push(finish);
    });
  };

  get pendingCount() {
    return this.pending.length;
  }

  releaseNext() {
    const next = this.pending[0];
    next?.();
    return Boolean(next);
  }
}

const passiveHeartbeatWait: HeartbeatWait = (_delayMs, signal) =>
  new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

function bodyDerivedEtag(bytes: Uint8Array) {
  if (bytes.byteLength === 0) return "d41d8cd98f00b204e9800998ecf8427e";
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fake-${bytes.byteLength}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

class FakeR2Bucket {
  afterNextHead: ((key: string) => Promise<void>) | null = null;
  afterNextList: (() => void) | null = null;
  afterNextPartPut: (() => void) | null = null;
  pauseNextGet: ControlledPause | null = null;
  pauseNextBodyRead: ControlledPause | null = null;
  pauseNextLeasePut: ControlledPause | null = null;
  pauseNextPartPut: ControlledPause | null = null;
  readonly deleteBatches: string[][] = [];
  readonly objects = new Map<string, StoredObject>();
  readonly putCalls: PutCall[] = [];
  failDeleteCalls = 0;
  pageSize = 1_000;
  persistThenFailKeySuffixes = new Set<string>();

  constructor(readonly clock: { now: number }) {}

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ) {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value === null
          ? new Uint8Array()
          : ArrayBuffer.isView(value)
            ? new Uint8Array(
                value.buffer,
                value.byteOffset,
                value.byteLength,
              ).slice()
            : new Uint8Array(value).slice();
    this.putCalls.push({
      byteLength: bytes.byteLength,
      key,
      time: this.clock.now,
    });
    if (key.endsWith("/lease") && this.pauseNextLeasePut) {
      const pause = this.pauseNextLeasePut;
      this.pauseNextLeasePut = null;
      await pause.pause();
    }
    if (/\/part-\d+$/.test(key) && this.pauseNextPartPut) {
      const pause = this.pauseNextPartPut;
      this.pauseNextPartPut = null;
      await pause.pause();
    }
    // Yield once so concurrent append probes deterministically overlap an
    // implementation that chooses a key before its put resolves.
    await Promise.resolve();
    const existing = this.objects.get(key);
    const conditional = options?.onlyIf;
    if (
      conditional &&
      !(conditional instanceof Headers) &&
      ((conditional.etagMatches !== undefined &&
        existing?.etag !== conditional.etagMatches) ||
        (conditional.etagDoesNotMatch !== undefined &&
          (conditional.etagDoesNotMatch === "*"
            ? existing !== undefined
            : existing?.etag === conditional.etagDoesNotMatch)))
    ) {
      return null;
    }
    this.objects.set(key, {
      bytes,
      customMetadata: options?.customMetadata,
      etag: bodyDerivedEtag(bytes),
      uploaded: new Date(this.clock.now),
    });
    if (/\/part-\d+$/.test(key)) {
      const afterPartPut = this.afterNextPartPut;
      this.afterNextPartPut = null;
      afterPartPut?.();
    }
    if (
      [...this.persistThenFailKeySuffixes].some((suffix) =>
        key.endsWith(suffix),
      )
    ) {
      throw new Error("indeterminate R2 put failure");
    }
    return this.objectMetadata(key);
  }

  async get(key: string) {
    if (this.pauseNextGet) {
      const pause = this.pauseNextGet;
      this.pauseNextGet = null;
      await pause.pause();
    }
    const object = this.objects.get(key);
    if (!object) return null;
    const bodyPause = this.pauseNextBodyRead;
    this.pauseNextBodyRead = null;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await bodyPause?.pause();
        if (offset >= object.bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(object.bytes.subarray(offset, offset + 1));
        offset += 1;
      },
    });
    return { body } as R2ObjectBody;
  }

  async head(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    const snapshot = this.objectMetadata(key);
    const afterHead = this.afterNextHead;
    this.afterNextHead = null;
    await afterHead?.(key);
    return snapshot;
  }

  async delete(keys: string | string[]) {
    const batch = Array.isArray(keys) ? [...keys] : [keys];
    this.deleteBatches.push(batch);
    if (this.failDeleteCalls > 0) {
      this.failDeleteCalls -= 1;
      throw new Error("transient R2 delete failure");
    }
    for (const key of batch) this.objects.delete(key);
  }

  async list(options: R2ListOptions = {}) {
    const prefix = options.prefix || "";
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
    const offset = Number(options.cursor || "0");
    const limit = Math.min(options.limit || 1_000, this.pageSize);
    const selected = keys.slice(offset, offset + limit);
    const nextOffset = offset + selected.length;
    const result = {
      cursor: String(nextOffset),
      delimitedPrefixes: [],
      objects: selected.map((key) => ({
        key,
        uploaded: this.objects.get(key)!.uploaded,
      })),
      truncated: nextOffset < keys.length,
    } as unknown as R2Objects;
    const afterList = this.afterNextList;
    this.afterNextList = null;
    afterList?.();
    return result;
  }

  putFixture(key: string, uploadedAt: number, value = "fixture") {
    const bytes = new TextEncoder().encode(value);
    this.objects.set(key, {
      bytes,
      etag: bodyDerivedEtag(bytes),
      uploaded: new Date(uploadedAt),
    });
  }

  private objectMetadata(key: string) {
    const object = this.objects.get(key)!;
    return {
      customMetadata: object.customMetadata,
      etag: object.etag,
      key,
      uploaded: new Date(object.uploaded),
    } as R2Object;
  }

  reservedKeys() {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(EXTERNAL_REWRITE_SPOOL_PREFIX))
      .sort();
  }

  leasePutTimes() {
    return this.putCalls
      .filter(({ key }) => key.endsWith("/lease"))
      .map(({ time }) => time);
  }
}

function spoolStore(
  bucket: FakeR2Bucket,
  clock: { now: number },
  heartbeatWait: HeartbeatWait = passiveHeartbeatWait,
) {
  let id = 0;
  return createCloudflareExternalRewriteSpoolStore(
    bucket as unknown as R2Bucket,
    {
      heartbeatWait,
      now: () => clock.now,
      randomId: () => `spool-${String(id++).padStart(4, "0")}`,
    } as Parameters<typeof createCloudflareExternalRewriteSpoolStore>[1],
  );
}

function staleGroupKey(group: string, leaf: string) {
  return `${EXTERNAL_REWRITE_SPOOL_PREFIX}0000000000000/project/${group}/${leaf}`;
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function releaseHeartbeatAt(
  waiter: ControlledHeartbeatWaiter,
  bucket: FakeR2Bucket,
  clock: { now: number },
  time: number,
) {
  clock.now = time;
  if (!waiter.releaseNext()) return;
  for (let index = 0; index < 50; index += 1) {
    if (bucket.leasePutTimes().includes(time) && waiter.pendingCount > 0) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Heartbeat did not settle and schedule its next interval");
}

describe("Cloudflare external rewrite spool operations", () => {
  it("Given upstream accumulation pauses after a part, When more than one idle lease passes without another append, Then recurring heartbeats keep the spool out of a stale sweep", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    const heartbeats = new ControlledHeartbeatWaiter();
    const spool = await spoolStore(bucket, clock, heartbeats.wait).create({
      projectId: "project",
      contentType: "html",
    });
    await spool.append(new Uint8Array([1]));
    const heartbeatMs = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS / 3;

    await releaseHeartbeatAt(heartbeats, bucket, clock, heartbeatMs);
    await releaseHeartbeatAt(heartbeats, bucket, clock, heartbeatMs * 2);
    await releaseHeartbeatAt(heartbeats, bucket, clock, heartbeatMs * 3);
    clock.now = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS + 1;
    const deleted = await sweepStaleExternalRewriteSpools(
      bucket as unknown as R2Bucket,
      { now: clock.now },
    );

    await spool.dispose();
    expect(deleted).toBe(0);
    expect(bucket.leasePutTimes()).toEqual([
      0,
      heartbeatMs,
      heartbeatMs * 2,
      heartbeatMs * 3,
    ]);
  });

  it("Given a part put remains in flight longer than the idle lease, When sweeping overlaps it, Then recurring heartbeats preserve the group and the append completes", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    const heartbeats = new ControlledHeartbeatWaiter();
    const partPause = new ControlledPause();
    bucket.pauseNextPartPut = partPause;
    const spool = await spoolStore(bucket, clock, heartbeats.wait).create({
      projectId: "project",
      contentType: "css",
    });
    const append = spool.append(new Uint8Array([1]));
    await partPause.started;
    const heartbeatMs = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS / 3;

    await releaseHeartbeatAt(heartbeats, bucket, clock, heartbeatMs);
    await releaseHeartbeatAt(heartbeats, bucket, clock, heartbeatMs * 2);
    await releaseHeartbeatAt(heartbeats, bucket, clock, heartbeatMs * 3);
    clock.now = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS + 1;
    const deleted = await sweepStaleExternalRewriteSpools(
      bucket as unknown as R2Bucket,
      { now: clock.now },
    );
    partPause.release();
    const appendResult = await append.then(
      () => "completed" as const,
      () => "failed" as const,
    );
    await spool.dispose();

    expect(deleted).toBe(0);
    expect(appendResult).toBe("completed");
  });

  it("Given an R2 get remains in flight longer than the idle lease, When sweeping overlaps the pending read, Then recurring heartbeats preserve the part until it is read", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    const heartbeats = new ControlledHeartbeatWaiter();
    const spool = await spoolStore(bucket, clock, heartbeats.wait).create({
      projectId: "project",
      contentType: "html",
    });
    await spool.append(new Uint8Array([7]));
    await spool.complete();
    const getPause = new ControlledPause();
    bucket.pauseNextGet = getPause;
    const reader = (await spool.open()).getReader();
    const read = reader.read();
    await getPause.started;
    const heartbeatMs = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS / 3;

    await releaseHeartbeatAt(heartbeats, bucket, clock, heartbeatMs);
    await releaseHeartbeatAt(heartbeats, bucket, clock, heartbeatMs * 2);
    await releaseHeartbeatAt(heartbeats, bucket, clock, heartbeatMs * 3);
    clock.now = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS + 1;
    const deleted = await sweepStaleExternalRewriteSpools(
      bucket as unknown as R2Bucket,
      { now: clock.now },
    );
    getPause.release();
    const readResult = await read.then(
      (result) => result.value?.[0],
      () => undefined,
    );
    try {
      await reader.cancel();
    } catch {
      // A failed overlapping read can already have errored the stream.
    }
    await spool.dispose();

    expect(deleted).toBe(0);
    expect(readResult).toBe(7);
  });

  it("Given an R2 body read remains in flight longer than the idle lease, When sweeping overlaps the pending byte, Then recurring heartbeats preserve the group through consumption", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    const heartbeats = new ControlledHeartbeatWaiter();
    const spool = await spoolStore(bucket, clock, heartbeats.wait).create({
      projectId: "project",
      contentType: "html",
    });
    await spool.append(new Uint8Array([9]));
    await spool.complete();
    const bodyPause = new ControlledPause();
    bucket.pauseNextBodyRead = bodyPause;
    const reader = (await spool.open()).getReader();
    const read = reader.read();
    await bodyPause.started;
    const heartbeatMs = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS / 3;

    await releaseHeartbeatAt(heartbeats, bucket, clock, heartbeatMs);
    await releaseHeartbeatAt(heartbeats, bucket, clock, heartbeatMs * 2);
    await releaseHeartbeatAt(heartbeats, bucket, clock, heartbeatMs * 3);
    clock.now = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS + 1;
    const deleted = await sweepStaleExternalRewriteSpools(
      bucket as unknown as R2Bucket,
      { now: clock.now },
    );
    bodyPause.release();
    const readResult = await read;
    await reader.cancel();
    await spool.dispose();

    expect(deleted).toBe(0);
    expect(readResult.value?.[0]).toBe(9);
  });

  it("Given a heartbeat lease put is still in flight, When disposal starts, Then deletion waits until that heartbeat settles", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    const heartbeats = new ControlledHeartbeatWaiter();
    const spool = await spoolStore(bucket, clock, heartbeats.wait).create({
      projectId: "project",
      contentType: "css",
    });
    await spool.append(new Uint8Array([1]));
    const leasePause = new ControlledPause();
    bucket.pauseNextLeasePut = leasePause;
    clock.now = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS / 3;
    expect(heartbeats.releaseNext()).toBe(true);
    await leasePause.started;

    const disposal = spool.dispose();
    await Promise.resolve();
    expect(bucket.deleteBatches).toEqual([]);
    leasePause.release();
    await disposal;

    expect(bucket.deleteBatches).toHaveLength(1);
    expect(bucket.reservedKeys()).toEqual([]);
  });

  it("Given a background heartbeat has an indeterminate put failure, When the caller resumes, Then the spool stays failed without another lease write", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    const heartbeats = new ControlledHeartbeatWaiter();
    const spool = await spoolStore(bucket, clock, heartbeats.wait).create({
      projectId: "project",
      contentType: "html",
    });
    await spool.append(new Uint8Array([1]));
    bucket.persistThenFailKeySuffixes.add("/lease");
    clock.now = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS / 3;
    expect(heartbeats.releaseNext()).toBe(true);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    const leasePutTimes = bucket.leasePutTimes();

    const openError = await spool.open().then(
      () => null,
      (error: unknown) => error,
    );
    expect(openError).toBeInstanceOf(TypeError);
    expect((openError as Error).message).toBe(
      "External rewrite spool is unavailable",
    );
    expect(bucket.leasePutTimes()).toEqual(leasePutTimes);
    bucket.persistThenFailKeySuffixes.delete("/lease");
    await spool.dispose();
  });

  it("Given an initial lease put itself lasts one heartbeat, When it completes, Then completion time prevents an immediate same-key rewrite", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    const heartbeats = new ControlledHeartbeatWaiter();
    const leasePause = new ControlledPause();
    bucket.pauseNextLeasePut = leasePause;
    const spool = await spoolStore(bucket, clock, heartbeats.wait).create({
      projectId: "project",
      contentType: "css",
    });
    const append = spool.append(new Uint8Array([1]));
    await leasePause.started;

    clock.now = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS / 3;
    leasePause.release();
    await append;
    const leasePutTimes = bucket.leasePutTimes();
    await spool.dispose();

    expect(leasePutTimes).toEqual([0]);
  });

  it("Given append, complete, and open finish inside one heartbeat window, When the spool stays active, Then its lease key is written once until the next five-minute heartbeat", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    const spool = await spoolStore(bucket, clock).create({
      projectId: "project",
      contentType: "html",
    });

    await spool.append(new Uint8Array([1]));
    await spool.complete();
    await (await spool.open()).cancel();
    expect(bucket.leasePutTimes()).toEqual([0]);
    expect(
      bucket.putCalls
        .filter(({ key }) => key.endsWith("/lease"))
        .every(({ byteLength }) => byteLength > 0),
    ).toBe(true);

    const heartbeatMs = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS / 3;
    clock.now = heartbeatMs;
    await (await spool.open()).cancel();
    await (await spool.open()).cancel();
    expect(bucket.leasePutTimes()).toEqual([0, heartbeatMs]);

    clock.now += heartbeatMs - 1;
    await (await spool.open()).cancel();
    expect(bucket.leasePutTimes()).toEqual([0, heartbeatMs]);
  });

  it("Given an append itself spans a heartbeat interval, When its part finishes, Then one trailing heartbeat renews the lease without a rapid duplicate", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    const spool = await spoolStore(bucket, clock).create({
      projectId: "project",
      contentType: "css",
    });
    const heartbeatMs = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS / 3;
    bucket.afterNextPartPut = () => {
      clock.now = heartbeatMs;
    };

    await spool.append(new Uint8Array([1]));
    await spool.complete();
    await (await spool.open()).cancel();

    expect(bucket.leasePutTimes()).toEqual([0, heartbeatMs]);
  });

  it("Given a live spool older than the cleanup threshold, When open and pull renew its lease, Then sweeping preserves the whole group until its bounded idle lease expires", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    const spool = await spoolStore(bucket, clock).create({
      projectId: "project/live",
      contentType: "html",
    });
    await spool.append(new Uint8Array([1, 2, 3]));
    await spool.complete();

    clock.now = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS - 1;
    const reader = (await spool.open()).getReader();
    expect((await reader.read()).done).toBe(false);
    await Promise.resolve();

    clock.now = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS + 1;
    expect(
      await sweepStaleExternalRewriteSpools(bucket as unknown as R2Bucket, {
        now: clock.now,
      }),
    ).toBe(0);
    expect(bucket.reservedKeys().some((key) => key.endsWith("/lease"))).toBe(
      true,
    );

    await reader.cancel();
    clock.now += EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS + 1;
    expect(
      await sweepStaleExternalRewriteSpools(bucket as unknown as R2Bucket, {
        now: clock.now,
      }),
    ).toBeGreaterThan(0);
    expect(bucket.reservedKeys()).toEqual([]);
  });

  it("Given a long-running writer, When append renews its lease, Then an older first part is not removed from the active group", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    const spool = await spoolStore(bucket, clock).create({
      projectId: "project",
      contentType: "css",
    });
    await spool.append(new Uint8Array([1]));
    clock.now = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS - 1;
    await spool.append(new Uint8Array([2]));
    clock.now = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS + 1;

    expect(
      await sweepStaleExternalRewriteSpools(bucket as unknown as R2Bucket, {
        now: clock.now,
      }),
    ).toBe(0);
    await spool.complete();
    expect([...(await readAll(await spool.open()))]).toEqual([1, 2]);
  });

  it("Given a backpressured reader remains inside the idle window, When a later pull resumes it, Then that pull renews the group lease", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    const spool = await spoolStore(bucket, clock).create({
      projectId: "project",
      contentType: "html",
    });
    await spool.append(new Uint8Array([1, 2, 3]));
    await spool.complete();
    const reader = (await spool.open()).getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));

    clock.now = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS - 1;
    expect((await reader.read()).value).toEqual(new Uint8Array([2]));
    await Promise.resolve();
    await Promise.resolve();
    const lease = [...bucket.objects.entries()].find(([key]) =>
      key.endsWith("/lease"),
    )?.[1];
    expect(lease?.uploaded.getTime()).toBe(clock.now);

    clock.now = EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS + 1;
    expect(
      await sweepStaleExternalRewriteSpools(bucket as unknown as R2Bucket, {
        now: clock.now,
      }),
    ).toBe(0);
    await reader.cancel();
  });

  it("Given one transient delete failure, When dispose is retried, Then it deletes every part and lease exactly once successfully", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    const spool = await spoolStore(bucket, clock).create({
      projectId: "project",
      contentType: "html",
    });
    await spool.append(new Uint8Array([1]));
    await spool.complete();
    bucket.failDeleteCalls = 1;

    await expect(spool.dispose()).rejects.toThrow(
      "transient R2 delete failure",
    );
    expect(bucket.reservedKeys().length).toBeGreaterThan(0);
    await expect(spool.dispose()).resolves.toBeUndefined();
    expect(bucket.reservedKeys()).toEqual([]);
    expect(bucket.deleteBatches).toHaveLength(2);
  });

  it("Given two concurrent appends, When they settle, Then their distinct ordered parts can be read without corruption", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    const spool = await spoolStore(bucket, clock).create({
      projectId: "project",
      contentType: "html",
    });

    await Promise.all([
      spool.append(new Uint8Array([1])),
      spool.append(new Uint8Array([2])),
    ]);
    await spool.complete();
    expect([...(await readAll(await spool.open()))]).toEqual([1, 2]);
    const partKeys = bucket
      .reservedKeys()
      .filter((key) => /\/part-\d+$/.test(key));
    expect(new Set(partKeys).size).toBe(2);
  });

  it("Given an indeterminate part put, When cleanup follows the rejection, Then the possibly persisted key remains tracked and is deleted", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    bucket.persistThenFailKeySuffixes.add("/part-000001");
    const spool = await spoolStore(bucket, clock).create({
      projectId: "project",
      contentType: "css",
    });
    await spool.append(new Uint8Array([1]));
    await expect(spool.append(new Uint8Array([2]))).rejects.toThrow(
      "indeterminate R2 put failure",
    );
    expect(
      bucket.reservedKeys().some((key) => key.endsWith("part-000001")),
    ).toBe(true);

    await spool.dispose();
    expect(bucket.reservedKeys()).toEqual([]);
  });
});

describe("R2 lease generation semantics", () => {
  it("confirms Miniflare gives equal ETags to equal empty bodies and lets only the first contender replace a unique generation", async () => {
    const key = `_internal/test/external-rewrite-etag/${crypto.randomUUID()}`;
    try {
      const emptyOne = await testEnv.REVIEW_ASSETS.put(key, null);
      const emptyTwo = await testEnv.REVIEW_ASSETS.put(key, null);
      if (!emptyOne || !emptyTwo) {
        throw new Error("Unconditional Miniflare R2 put returned null");
      }
      expect(emptyTwo.etag).toBe(emptyOne.etag);

      const owner = await testEnv.REVIEW_ASSETS.put(
        key,
        new TextEncoder().encode(`owner:${crypto.randomUUID()}`),
      );
      if (!owner) {
        throw new Error("Unconditional Miniflare R2 put returned null");
      }
      const renewal = await testEnv.REVIEW_ASSETS.put(
        key,
        new TextEncoder().encode(`renewal:${crypto.randomUUID()}`),
        { onlyIf: { etagMatches: owner.etag } },
      );
      expect(renewal).not.toBeNull();
      expect(renewal?.etag).not.toBe(owner.etag);

      const staleFence = await testEnv.REVIEW_ASSETS.put(
        key,
        new TextEncoder().encode(`fence:${crypto.randomUUID()}`),
        { onlyIf: { etagMatches: owner.etag } },
      );
      expect(staleFence).toBeNull();
    } finally {
      await testEnv.REVIEW_ASSETS.delete(key);
    }
  });
});

describe("Cloudflare external rewrite spool sweeping", () => {
  it("Given active and abandoned groups split across list pages, When sweeping runs, Then it removes only complete abandoned groups and preserves unrelated keys", async () => {
    const clock = { now: 10 * EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS };
    const bucket = new FakeR2Bucket(clock);
    bucket.pageSize = 1;
    const staleAt = 0;
    const activeAt = clock.now;
    const abandonedKeys = [
      staleGroupKey("abandoned", "lease"),
      staleGroupKey("abandoned", "part-000000"),
      staleGroupKey("abandoned", "part-000001"),
    ];
    const activeKeys = [
      staleGroupKey("active", "lease"),
      staleGroupKey("active", "part-000000"),
      staleGroupKey("active", "part-000001"),
    ];
    for (const key of abandonedKeys) bucket.putFixture(key, staleAt);
    bucket.putFixture(activeKeys[0], activeAt);
    bucket.putFixture(activeKeys[1], staleAt);
    bucket.putFixture(activeKeys[2], staleAt);
    const lookalike = `_internal/external-rewrite/v1-lookalike/keep`;
    const unrelated = "projects/review/keep.png";
    bucket.putFixture(lookalike, staleAt);
    bucket.putFixture(unrelated, staleAt);

    expect(
      await sweepStaleExternalRewriteSpools(bucket as unknown as R2Bucket, {
        maxObjects: 10_000,
        now: clock.now,
      }),
    ).toBe(abandonedKeys.length);
    expect(bucket.reservedKeys()).toEqual(activeKeys.sort());
    expect(bucket.objects.has(lookalike)).toBe(true);
    expect(bucket.objects.has(unrelated)).toBe(true);
  });

  it("Given a lease is renewed after its stale list entry is observed, When deletion begins, Then the group is revalidated and preserved", async () => {
    const clock = { now: 10 * EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS };
    const bucket = new FakeR2Bucket(clock);
    const leaseKey = staleGroupKey("renewed-during-sweep", "lease");
    const partKey = staleGroupKey("renewed-during-sweep", "part-000000");
    bucket.putFixture(leaseKey, 0);
    bucket.putFixture(partKey, 0);
    bucket.afterNextList = () => {
      bucket.objects.get(leaseKey)!.uploaded = new Date(clock.now);
    };

    expect(
      await sweepStaleExternalRewriteSpools(bucket as unknown as R2Bucket, {
        now: clock.now,
      }),
    ).toBe(0);
    expect(bucket.reservedKeys()).toEqual([leaseKey, partKey].sort());
  });

  it("Given the live owner renews after the sweeper reads the final stale lease generation, When deletion would begin, Then the stale sweep loses its fence and preserves the whole group", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    const spool = await spoolStore(bucket, clock).create({
      projectId: "project",
      contentType: "html",
    });
    await spool.append(new Uint8Array([1, 2, 3]));
    await spool.complete();
    const beforeSweep = bucket.reservedKeys();
    let renewalCompleted = false;

    clock.now = 10 * EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS;
    bucket.afterNextHead = async (key) => {
      expect(key.endsWith("/lease")).toBe(true);
      await spool.open();
      renewalCompleted = true;
    };

    expect(
      await sweepStaleExternalRewriteSpools(bucket as unknown as R2Bucket, {
        now: clock.now,
      }),
    ).toBe(0);
    expect(renewalCompleted).toBe(true);
    expect(bucket.reservedKeys()).toEqual(beforeSweep);
  });

  it("Given the sweeper wins the lease fence but deletion fails, When the expired owner later tries to renew, Then it cannot overwrite the cleanup generation", async () => {
    const clock = { now: 0 };
    const bucket = new FakeR2Bucket(clock);
    const spool = await spoolStore(bucket, clock).create({
      projectId: "project",
      contentType: "css",
    });
    await spool.append(new Uint8Array([1]));
    await spool.complete();

    clock.now = 10 * EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS;
    bucket.failDeleteCalls = 1;
    await expect(
      sweepStaleExternalRewriteSpools(bucket as unknown as R2Bucket, {
        now: clock.now,
      }),
    ).rejects.toThrow("transient R2 delete failure");
    const leaseEntry = [...bucket.objects.entries()].find(([key]) =>
      key.endsWith("/lease"),
    );
    expect(leaseEntry?.[1].customMetadata?.leaseState).toBe("sweeping");
    const fenceEtag = leaseEntry?.[1].etag;

    await expect(spool.open()).rejects.toThrow(
      "External rewrite spool lease ownership was lost",
    );
    expect(
      [...bucket.objects.entries()].find(([key]) => key.endsWith("/lease"))?.[1]
        .etag,
    ).toBe(fenceEtag);
  });

  it("Given more than one R2 delete limit of abandoned objects, When maxObjects is 10000, Then every delete batch stays at or below 1000", async () => {
    const clock = { now: 10 * EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS };
    const bucket = new FakeR2Bucket(clock);
    bucket.pageSize = 137;
    const count = 2_105;
    for (let index = 0; index < count; index += 1) {
      bucket.putFixture(
        staleGroupKey(`group-${String(index).padStart(5, "0")}`, "part-000000"),
        0,
      );
    }

    expect(
      await sweepStaleExternalRewriteSpools(bucket as unknown as R2Bucket, {
        maxObjects: 10_000,
        now: clock.now,
      }),
    ).toBe(count);
    expect(bucket.deleteBatches.map((batch) => batch.length)).toEqual([
      1_000, 1_000, 105,
    ]);
    expect(bucket.reservedKeys()).toEqual([]);
  });

  it("Given the object budget ends inside an abandoned group, When sweeping runs, Then it leaves that whole group for a later pass", async () => {
    const clock = { now: 10 * EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS };
    const bucket = new FakeR2Bucket(clock);
    bucket.pageSize = 1;
    const groupKeys = [
      staleGroupKey("whole-group", "lease"),
      staleGroupKey("whole-group", "part-000000"),
      staleGroupKey("whole-group", "part-000001"),
    ];
    for (const key of groupKeys) bucket.putFixture(key, 0);

    expect(
      await sweepStaleExternalRewriteSpools(bucket as unknown as R2Bucket, {
        maxObjects: 2,
        now: clock.now,
      }),
    ).toBe(0);
    expect(bucket.reservedKeys()).toEqual(groupKeys.sort());
    expect(
      await sweepStaleExternalRewriteSpools(bucket as unknown as R2Bucket, {
        maxObjects: 10,
        now: clock.now,
      }),
    ).toBe(3);
    expect(bucket.reservedKeys()).toEqual([]);
  });

  it("rejects a configured stale age shorter than the spool's renewable idle lease", async () => {
    const clock = { now: EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS };
    const bucket = new FakeR2Bucket(clock);

    await expect(
      sweepStaleExternalRewriteSpools(bucket as unknown as R2Bucket, {
        maxAgeMs: EXTERNAL_REWRITE_SPOOL_IDLE_LEASE_MS - 1,
        now: clock.now,
      }),
    ).rejects.toThrow("Invalid external rewrite spool sweep options");
  });
});
