import { describe, expect, it, vi } from "vitest";

import {
  compileManagedRuntimeBundle,
  createManagedRuntimeKernelHandler,
  compileManagedRuntimeRevision,
  type ManagedRuntimeInvocationMetadata,
} from "../src/managed-runtime/wrapper";
import {
  digestShipletPackage,
  parseShipletPackage,
  type ShipletPackageFile,
  type ValidatedShipletPackage,
} from "../src/self-owned/package";

/*
Behavioral specification

Given an immutable dynamic Shiplet package, when Shiplet prepares it for a
Workers for Platforms namespace, then the upload is deterministic, contains a
kernel-owned main module, and contains no bindings. The kernel-owned module
must answer the reserved health route itself from exact invocation-local
identity, and must invoke package code for every other request with a frozen
empty environment. Static packages produce no managed-runtime upload.

Given package-controlled module names or import specifiers, when any name can
collide with the kernel or any specifier escapes the package module graph, then
compilation fails closed before upload.
*/

const SHIPLET_ID = "shiplet_managed_a";
const REVISION_ID = "revision_managed_a";

async function sha256(bytes: Uint8Array) {
  const digestBytes = new Uint8Array(bytes.byteLength);
  digestBytes.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestBytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function utf8File(
  path: string,
  mediaType: string,
  content: string,
): Promise<ShipletPackageFile> {
  const bytes = new TextEncoder().encode(content);
  return {
    path,
    mediaType,
    encoding: "utf8",
    content,
    sha256: await sha256(bytes),
    size: bytes.byteLength,
  };
}

async function dynamicPackage(input?: {
  entrySource?: string;
  extraArtifactFiles?: ShipletPackageFile[];
  entryPath?: string;
  staticFirst?: boolean;
  requestedCapabilities?: string[];
}): Promise<ValidatedShipletPackage> {
  const entryPath = input?.entryPath ?? "artifact/index.mjs";
  const entrySource =
    input?.entrySource ??
    "export default { async fetch(request, env) { return new Response(String(Object.keys(env).length)); } };\n";
  const files = [
    await utf8File("AGENTS.md", "text/markdown", "# Runtime agent\n"),
    await utf8File(entryPath, "text/javascript", entrySource),
    ...(input?.extraArtifactFiles ?? []),
    await utf8File(
      "widget/index.html",
      "text/html",
      "<!doctype html><button>Review</button>\n",
    ),
    await utf8File(
      "workflow/schema.json",
      "application/json",
      '{"schemaVersion":"shiplet.workflow/v1","statuses":[],"fields":[]}\n',
    ),
    await utf8File(
      "mcp/manifest.json",
      "application/json",
      '{"schemaVersion":"shiplet.mcp/v1","tools":[]}\n',
    ),
    await utf8File(
      "validation/manifest.json",
      "application/json",
      `{"schemaVersion":"shiplet.validation/v1","checks":[{"kind":"file-exists","path":"${entryPath}"}]}\n`,
    ),
    await utf8File(
      "provenance.json",
      "application/json",
      '{"schemaVersion":"shiplet.provenance/v1","source":{"kind":"test"},"lineage":{"parentRevisionId":null}}\n',
    ),
  ];
  return parseShipletPackage({
    mediaType: "application/vnd.shiplet.package+json;version=1",
    manifest: {
      schemaVersion: "shiplet.package/v1",
      runtimeCompatibility: "shiplet.runtime/v1",
      entrypoints: {
        artifact: entryPath,
        widget: "widget/index.html",
        workflow: "workflow/schema.json",
        mcp: "mcp/manifest.json",
        agentInstructions: "AGENTS.md",
        validation: "validation/manifest.json",
        provenance: "provenance.json",
      },
      requestedCapabilities:
        input?.staticFirst === true
          ? []
          : ["runtime.worker", ...(input?.requestedCapabilities ?? [])],
      limits: {
        fileCount: 64,
        fileBytes: 1024 * 1024,
        packageBytes: 4 * 1024 * 1024,
      },
      staticFirst: input?.staticFirst === true,
    },
    files,
  });
}

async function compile(packageEnvelope: ValidatedShipletPackage) {
  return await compileManagedRuntimeRevision({
    shipletId: SHIPLET_ID,
    revisionId: REVISION_ID,
    packageDigest: `sha256:${await digestShipletPackage(packageEnvelope)}`,
    package: packageEnvelope,
  });
}

async function rejectedCode(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error instanceof Error && "code" in error
      ? String((error as Error & { code: unknown }).code)
      : "unexpected_error";
  }
  return "did_not_reject";
}

describe("managed runtime wrapper compiler", () => {
  it("Given a dynamic revision, When compiled twice from different file order, Then its binding-free bytes and digest are deterministic", async () => {
    const firstPackage = await dynamicPackage({
      entrySource:
        'import { value } from "./lib.mjs"; export default { fetch() { return new Response(value); } };\n',
      extraArtifactFiles: [
        await utf8File(
          "artifact/lib.mjs",
          "application/javascript",
          'export const value = "ok";\n',
        ),
      ],
    });
    const secondPackage = await parseShipletPackage({
      ...firstPackage,
      files: [...firstPackage.files].reverse(),
    });

    const first = await compile(firstPackage);
    const second = await compile(secondPackage);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: "shiplet.managed-runtime-upload/v1",
      mainModule: "__shiplet_runtime.mjs",
      bindings: [],
      shipletId: SHIPLET_ID,
      revisionId: REVISION_ID,
      packageDigest: `sha256:${await digestShipletPackage(firstPackage)}`,
    });
    expect(first?.bundleDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first?.modules.map((module) => module.name)).toEqual([
      "__shiplet_runtime.mjs",
      "index.mjs",
      "lib.mjs",
    ]);
    expect(first?.modules.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(first?.modules)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("Given a static package, When managed compilation is requested, Then it remains on the static path without generated modules", async () => {
    const packageEnvelope = await dynamicPackage({
      staticFirst: true,
      entrySource: 'import "cloudflare:workers"; export default {};\n',
    });
    const before = JSON.stringify(packageEnvelope);

    await expect(compile(packageEnvelope)).resolves.toBeNull();
    expect(JSON.stringify(packageEnvelope)).toBe(before);
  });

  it("Given a package digest mismatch, When compilation runs, Then no upload plan is produced", async () => {
    const packageEnvelope = await dynamicPackage();
    await expect(
      compileManagedRuntimeRevision({
        shipletId: SHIPLET_ID,
        revisionId: REVISION_ID,
        packageDigest: `sha256:${"0".repeat(64)}`,
        package: packageEnvelope,
      }),
    ).rejects.toMatchObject({ code: "managed_package_digest_mismatch" });
  });

  it.each([
    [
      "platform builtin",
      'import "cloudflare:workers"; export default { fetch() { return new Response("bad"); } };',
    ],
    [
      "Node builtin",
      'import "node:fs"; export default { fetch() { return new Response("bad"); } };',
    ],
    [
      "absolute URL",
      'import "https://example.com/code.mjs"; export default { fetch() { return new Response("bad"); } };',
    ],
    [
      "package escape",
      'import "../outside.mjs"; export default { fetch() { return new Response("bad"); } };',
    ],
    [
      "computed dynamic import",
      'const name = "./lib.mjs"; import(name); export default { fetch() { return new Response("bad"); } };',
    ],
  ])(
    "Given a %s import, When dynamic compilation runs, Then the specifier is rejected",
    async (_label, entrySource) => {
      const packageEnvelope = await dynamicPackage({ entrySource });
      expect(await rejectedCode(() => compile(packageEnvelope))).toBe(
        "managed_module_specifier_forbidden",
      );
    },
  );

  it("Given a package module in the kernel namespace, When compilation runs, Then it cannot shadow the wrapper", async () => {
    const reserved = await utf8File(
      "artifact/__shiplet_runtime.mjs",
      "application/javascript",
      'export const shadow = true;\n',
    );
    const packageEnvelope = await dynamicPackage({
      entrySource:
        'import "./__shiplet_runtime.mjs"; export default { fetch() { return new Response("bad"); } };',
      extraArtifactFiles: [reserved],
    });
    expect(await rejectedCode(() => compile(packageEnvelope))).toBe(
      "managed_module_name_reserved",
    );
  });

  it("Given a normalized-path escape in a prebuilt bundle, When wrapped, Then it is rejected before upload", async () => {
    expect(
      await rejectedCode(() =>
        compileManagedRuntimeBundle({
          shipletId: SHIPLET_ID,
          revisionId: REVISION_ID,
          packageDigest: `sha256:${"a".repeat(64)}`,
          mainModule: "index.mjs",
          modules: [
            {
              name: "index.mjs",
              mediaType: "application/javascript+module",
              content: "export default { fetch() { return new Response(); } };",
            },
            {
              name: "nested/../escape.mjs",
              mediaType: "application/javascript+module",
              content: "export const escaped = true;",
            },
          ],
        }),
      ),
    ).toBe("managed_module_invalid");
  });
});

describe("managed runtime kernel handler", () => {
  const identity = Object.freeze({
    shipletId: SHIPLET_ID,
    revisionId: REVISION_ID,
    packageDigest: `sha256:${"a".repeat(64)}`,
  });
  const metadata: ManagedRuntimeInvocationMetadata = Object.freeze({
    ...identity,
    activationGeneration: 7,
  });

  it("Given exact invocation identity, When health is requested, Then the kernel returns the bounded canonical envelope without invoking package code", async () => {
    const packageFetch = vi.fn(async () => new Response("hostile"));
    const handler = createManagedRuntimeKernelHandler(identity, {
      fetch: packageFetch,
    });
    const response = await handler.fetch(
      new Request("https://runtime.invalid/__shiplet/health"),
      { SHIPLET_RUNTIME: metadata, PLATFORM_AUTHORITY: { kind: "d1" } },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    await expect(response.json()).resolves.toEqual({
      ok: true,
      shipletId: SHIPLET_ID,
      revisionId: REVISION_ID,
      packageDigest: identity.packageDigest,
      activationGeneration: 7,
    });
    expect(Number(response.headers.get("content-length"))).toBeLessThan(1024);
    expect(packageFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["missing metadata", undefined],
    ["wrong Shiplet", { ...metadata, shipletId: "shiplet_other" }],
    ["wrong revision", { ...metadata, revisionId: "revision_other" }],
    [
      "wrong package",
      { ...metadata, packageDigest: `sha256:${"b".repeat(64)}` },
    ],
    ["zero generation", { ...metadata, activationGeneration: 0 }],
    ["fractional generation", { ...metadata, activationGeneration: 1.5 }],
    ["extra authority", { ...metadata, unexpectedField: "ambient" }],
  ])(
    "Given %s, When health is requested, Then the kernel fails closed",
    async (_label, invocationMetadata) => {
      const packageFetch = vi.fn(async () => new Response("hostile"));
      const handler = createManagedRuntimeKernelHandler(identity, {
        fetch: packageFetch,
      });
      const response = await handler.fetch(
        new Request("https://runtime.invalid/__shiplet/health"),
        { SHIPLET_RUNTIME: invocationMetadata },
        {} as ExecutionContext,
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ ok: false });
      expect(packageFetch).not.toHaveBeenCalled();
    },
  );

  it("Given ambient invocation bindings, When package fetch runs, Then package code receives a distinct frozen empty environment", async () => {
    const invocationEnvironment = {
      SHIPLET_RUNTIME: metadata,
      PLATFORM_AUTHORITY: { kind: "d1" },
      DB: { authority: true },
    };
    const packageFetch = vi.fn(
      async (_request: Request, packageEnvironment: Record<string, unknown>) => {
        return Response.json({
          sameObject: packageEnvironment === invocationEnvironment,
          frozen: Object.isFrozen(packageEnvironment),
          keys: Object.keys(packageEnvironment),
          acceptedMutation: Reflect.set(packageEnvironment, "grant", "bad"),
        });
      },
    );
    const handler = createManagedRuntimeKernelHandler(identity, {
      fetch: packageFetch,
    });
    const response = await handler.fetch(
      new Request("https://runtime.invalid/application"),
      invocationEnvironment,
      {} as ExecutionContext,
    );

    await expect(response.json()).resolves.toEqual({
      sameObject: false,
      frozen: true,
      keys: [],
      acceptedMutation: false,
    });
    expect(packageFetch).toHaveBeenCalledOnce();
  });

  it("Given declared read/write state capabilities, When package code invokes the frozen helper, Then it receives only bounded operations over the reserved outbound origin", async () => {
    const outbound: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      outbound.push({ url: request.url, body: await request.json() });
      return Response.json({
        schemaVersion: "shiplet.managed-state-response/v1",
        ok: true,
        operation: "get",
        found: true,
        value: { count: 4 },
        version: 2,
      });
    });
    try {
      const packageFetch = vi.fn(
        async (_request: Request, packageEnvironment: Record<string, unknown>) => {
          const state = packageEnvironment.SHIPLET_STATE as {
            get(key: string): Promise<unknown>;
            put(key: string, value: unknown): Promise<unknown>;
            delete(key: string): Promise<unknown>;
          };
          return Response.json({
            envKeys: Object.keys(packageEnvironment),
            stateKeys: Object.keys(state).sort(),
            stateFrozen: Object.isFrozen(state),
            get: await state.get("counter"),
          });
        },
      );
      const handler = createManagedRuntimeKernelHandler(
        identity,
        { fetch: packageFetch },
        ["read", "write"],
      );
      const response = await handler.fetch(
        new Request("https://runtime.invalid/application"),
        { SHIPLET_RUNTIME: metadata, DB: { forbidden: true } },
        {} as ExecutionContext,
      );

      await expect(response.json()).resolves.toEqual({
        envKeys: ["SHIPLET_STATE"],
        stateKeys: ["delete", "get", "put"],
        stateFrozen: true,
        get: { found: true, value: { count: 4 }, version: 2 },
      });
      expect(outbound).toEqual([
        {
          url: "https://shiplet-state.invalid/v1",
          body: {
            schemaVersion: "shiplet.managed-state-request/v1",
            operation: "get",
            sequence: 1,
            key: "counter",
          },
        },
      ]);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("Given no state declaration, When package code runs, Then the environment remains empty and direct reserved-origin fetch carries no ambient authority", async () => {
    const packageEnvelope = await dynamicPackage();
    const plan = await compile(packageEnvelope);
    expect(plan).not.toBeNull();
    expect(plan?.statePermissions).toEqual([]);
    const source = plan?.modules.find(
      (module) => module.name === "__shiplet_runtime.mjs",
    )?.content;
    expect(source).toContain('const STATE_PERMISSIONS = Object.freeze([])');
    expect(source).not.toContain("RUNTIME_DB");
    expect(source).not.toContain("D1Database");
  });

  it("Given package state declarations, When compiled, Then only recognized state capability names become deterministic state permissions", async () => {
    const read = await compile(
      await dynamicPackage({ requestedCapabilities: ["state.read"] }),
    );
    const write = await compile(
      await dynamicPackage({ requestedCapabilities: ["state.write"] }),
    );
    const both = await compile(
      await dynamicPackage({
        requestedCapabilities: ["state.write", "state.read:review"],
      }),
    );
    expect(read?.statePermissions).toEqual(["read"]);
    expect(write?.statePermissions).toEqual(["write"]);
    expect(both?.statePermissions).toEqual(["read", "write"]);
  });

  it("Given a warm Worker handles separate requests, When each uses state, Then replay sequence is invocation-local rather than isolate-global", async () => {
    const sequences: number[] = [];
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = (await new Request(input, init).json()) as { sequence: number };
      sequences.push(body.sequence);
      return Response.json({
        schemaVersion: "shiplet.managed-state-response/v1",
        ok: true,
        operation: "get",
        found: false,
      });
    });
    try {
      const handler = createManagedRuntimeKernelHandler(
        identity,
        {
          async fetch(_request, environment) {
            const state = environment.SHIPLET_STATE as {
              get(key: string): Promise<unknown>;
            };
            await state.get("counter");
            return new Response("ok");
          },
        },
        ["read"],
      );
      await handler.fetch(
        new Request("https://runtime.invalid/first"),
        { SHIPLET_RUNTIME: metadata },
        {} as ExecutionContext,
      );
      await handler.fetch(
        new Request("https://runtime.invalid/second"),
        { SHIPLET_RUNTIME: metadata },
        {} as ExecutionContext,
      );
      expect(sequences).toEqual([1, 1]);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });
});
