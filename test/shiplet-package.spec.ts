import { describe, expect, it } from "vitest";

import {
  parseShipletPackage,
  serializeShipletPackage,
} from "../src/self-owned/package";
import completePackageFixture from "./fixtures/packages/complete-v1.json";

type JsonObject = Record<string, unknown>;

type PackageFile = {
  path: string;
  mediaType: string;
  encoding: "utf8" | "base64";
  content: string;
  sha256: string;
  size: number;
};

type PackageEnvelope = {
  mediaType: string;
  manifest: JsonObject & {
    entrypoints: Record<string, string>;
  };
  files: PackageFile[];
};

const COMPLETE_PACKAGE = completePackageFixture as PackageEnvelope;

function clonePackage(): PackageEnvelope {
  return structuredClone(COMPLETE_PACKAGE);
}

function comparePaths(a: PackageFile, b: PackageFile) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

async function sha256Hex(bytes: Uint8Array) {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function replaceFileContent(
  candidate: PackageEnvelope,
  path: string,
  content: string,
  encoding: "utf8" | "base64" = "utf8",
) {
  const file = candidate.files.find((entry) => entry.path === path);
  if (!file) throw new Error(`fixture is missing ${path}`);
  const bytes =
    encoding === "utf8"
      ? new TextEncoder().encode(content)
      : Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
  file.content = content;
  file.encoding = encoding;
  file.size = bytes.byteLength;
  file.sha256 = await sha256Hex(bytes);
  return file;
}

async function addUtf8File(
  candidate: PackageEnvelope,
  path: string,
  content: string,
  mediaType: string,
) {
  const bytes = new TextEncoder().encode(content);
  candidate.files.push({
    path,
    mediaType,
    encoding: "utf8",
    content,
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  });
  candidate.files.sort(comparePaths);
}

async function expectPackageFailure(
  operation: () => unknown | Promise<unknown>,
  expected: { code: string; path?: string },
  secretSentinel?: string,
) {
  let observed: unknown;
  try {
    await operation();
  } catch (error) {
    observed = error;
  }

  expect(observed, "the invalid package should be rejected").toBeTruthy();
  expect(observed).toMatchObject(expected);
  if (secretSentinel) {
    const observableFailure =
      observed instanceof Error
        ? {
            name: observed.name,
            message: observed.message,
            ...(observed as unknown as Record<string, unknown>),
          }
        : observed;
    expect(JSON.stringify(observableFailure)).not.toContain(secretSentinel);
  }
}

describe("portable Shiplet package v1", () => {
  it("round-trips every application surface as one deterministic package", async () => {
    const parsed = await parseShipletPackage(clonePackage());

    expect(parsed.mediaType).toBe(
      "application/vnd.shiplet.package+json;version=1",
    );
    expect(parsed.manifest).toMatchObject({
      schemaVersion: "shiplet.package/v1",
      runtimeCompatibility: "shiplet.runtime/v1",
      staticFirst: true,
      entrypoints: {
        artifact: "artifact/index.html",
        widget: "widget/index.html",
        workflow: "workflow/schema.json",
        mcp: "mcp/manifest.json",
        agentInstructions: "AGENTS.md",
        validation: "validation/manifest.json",
        provenance: "provenance.json",
      },
      requestedCapabilities: ["state.read:review", "workflow.event:create"],
      limits: {
        fileCount: 32,
        fileBytes: 16_384,
        packageBytes: 65_536,
      },
    });
    expect(parsed.files.map((file: PackageFile) => file.path)).toEqual([
      "AGENTS.md",
      "artifact/app.js",
      "artifact/icon.bin",
      "artifact/index.html",
      "mcp/handlers/summarize.js",
      "mcp/manifest.json",
      "provenance.json",
      "validation/manifest.json",
      "widget/index.html",
      "widget/widget.js",
      "workflow/schema.json",
    ]);

    const firstExport = await serializeShipletPackage(parsed);
    const secondExport = await serializeShipletPackage(
      await parseShipletPackage(JSON.parse(firstExport)),
    );

    expect(secondExport).toBe(firstExport);
    expect(
      JSON.parse(firstExport).files.map((file: PackageFile) => file.path),
    ).toEqual(
      [...parsed.files]
        .sort(comparePaths)
        .map((file: PackageFile) => file.path),
    );
  });

  it("accepts the explicit custom MCP runtime and effect contract used by the compiler", async () => {
    const candidate = clonePackage();
    const file = candidate.files.find(
      (entry) => entry.path === "mcp/manifest.json",
    );
    expect(file).toBeTruthy();
    if (!file) return;
    const manifest = JSON.parse(file.content) as JsonObject & {
      tools: JsonObject[];
    };
    manifest.runtimeCompatibility = "shiplet.runtime/v1";
    manifest.tools[0].effect = "read";
    await replaceFileContent(
      candidate,
      "mcp/manifest.json",
      `${JSON.stringify(manifest)}\n`,
    );

    await expect(parseShipletPackage(candidate)).resolves.toMatchObject({
      manifest: { runtimeCompatibility: "shiplet.runtime/v1" },
    });
  });

  it.each(COMPLETE_PACKAGE.files.map((file) => file.path))(
    "digest-verifies declared file %s",
    async (path) => {
      const candidate = clonePackage();
      const file = candidate.files.find((entry) => entry.path === path);
      expect(file).toBeTruthy();
      if (!file) return;

      if (file.encoding === "base64") {
        file.content = "AAED";
      } else {
        file.content += "x";
        file.size = new TextEncoder().encode(file.content).byteLength;
      }

      await expectPackageFailure(() => parseShipletPackage(candidate), {
        code: "digest_mismatch",
        path,
      });
    },
  );

  it.each([
    "/artifact/index.html",
    "../artifact/index.html",
    "artifact/../widget/index.html",
    "artifact/./index.html",
    "artifact//index.html",
    "artifact\\index.html",
    "artifact/\u0000index.html",
  ])("rejects non-portable or traversal path %j", async (path) => {
    const candidate = clonePackage();
    candidate.files[1].path = path;

    await expectPackageFailure(() => parseShipletPackage(candidate), {
      code: "invalid_path",
      path,
    });
  });

  it.each([
    ["artifact/Logo.bin", "artifact/logo.bin"],
    ["artifact/caf\u00e9.bin", "artifact/cafe\u0301.bin"],
  ])(
    "rejects file paths that collide after portable normalization (%s, %s)",
    async (firstPath, secondPath) => {
      const candidate = clonePackage();
      const source = candidate.files[2];
      candidate.files.push(
        { ...source, path: firstPath },
        { ...source, path: secondPath },
      );
      candidate.files.sort(comparePaths);

      await expectPackageFailure(() => parseShipletPackage(candidate), {
        code: "path_collision",
      });
    },
  );

  it.each([
    ["schemaVersion", "shiplet.package/v999"],
    ["runtimeCompatibility", "shiplet.runtime/v999"],
  ])("fails closed for unsupported %s", async (field, value) => {
    const candidate = clonePackage();
    candidate.manifest[field] = value;

    await expectPackageFailure(() => parseShipletPackage(candidate), {
      code: "unsupported_version",
      path: `manifest.${field}`,
    });
  });

  it("requires every declared application entrypoint to resolve to a file", async () => {
    const candidate = clonePackage();
    candidate.files = candidate.files.filter(
      (file) => file.path !== "AGENTS.md",
    );

    await expectPackageFailure(() => parseShipletPackage(candidate), {
      code: "missing_entrypoint",
      path: "manifest.entrypoints.agentInstructions",
    });
  });

  it("requires entrypoints to match package file paths with exact casing", async () => {
    const candidate = clonePackage();
    candidate.manifest.entrypoints.artifact = "artifact/INDEX.html";

    await expectPackageFailure(() => parseShipletPackage(candidate), {
      code: "missing_entrypoint",
      path: "manifest.entrypoints.artifact",
    });
  });

  it("rejects an ES-module widget graph that cannot resolve inside an opaque credentialless frame", async () => {
    const candidate = clonePackage();
    await replaceFileContent(
      candidate,
      "widget/index.html",
      '<!doctype html><script type="module" src="./main.js"></script>',
    );
    await addUtf8File(
      candidate,
      "widget/main.js",
      'import { label } from "./chunk.js"; document.body.textContent = label;',
      "text/javascript; charset=utf-8",
    );
    await addUtf8File(
      candidate,
      "widget/chunk.js",
      'export const label = "module graph";',
      "text/javascript; charset=utf-8",
    );

    await expectPackageFailure(() => parseShipletPackage(candidate), {
      code: "unsupported_widget_dependency",
      path: "widget/index.html",
    });
  });

  it("rejects dynamic widget imports before a revision can be validated", async () => {
    const candidate = clonePackage();
    await replaceFileContent(
      candidate,
      "widget/widget.js",
      'import("./lazy.js").then(({ run }) => run());',
    );
    await addUtf8File(
      candidate,
      "widget/lazy.js",
      "export function run() {}",
      "text/javascript; charset=utf-8",
    );

    await expectPackageFailure(() => parseShipletPackage(candidate), {
      code: "unsupported_widget_dependency",
      path: "widget/widget.js",
    });
  });

  it("rejects malformed widget JavaScript before a revision can be validated", async () => {
    const candidate = clonePackage();
    await replaceFileContent(candidate, "widget/widget.js", "const broken = ;");

    await expectPackageFailure(() => parseShipletPackage(candidate), {
      code: "unsupported_widget_dependency",
      path: "widget/widget.js",
    });
  });

  it.each([
    'const Background = Worker; new Background("data:text/javascript,postMessage(true)");',
    'new globalThis.Worker("data:text/javascript,postMessage(true)");',
  ])(
    "rejects Worker aliases and member access before widget persistence",
    async (source) => {
      const candidate = clonePackage();
      await replaceFileContent(candidate, "widget/widget.js", source);

      await expectPackageFailure(() => parseShipletPackage(candidate), {
        code: "unsupported_widget_dependency",
        path: "widget/widget.js",
      });
    },
  );

  it.each([
    ['@import "./theme.css";', "widget/widget.css"],
    ['.hero { background-image: url("./image.png"); }', "widget/widget.css"],
  ])(
    "rejects a linked widget stylesheet dependency that would lose its opaque base",
    async (css, expectedPath) => {
      const candidate = clonePackage();
      await replaceFileContent(
        candidate,
        "widget/index.html",
        '<!doctype html><link rel="stylesheet" href="./widget.css"><script src="./widget.js"></script>',
      );
      await addUtf8File(
        candidate,
        "widget/widget.css",
        css,
        "text/css; charset=utf-8",
      );

      await expectPackageFailure(() => parseShipletPackage(candidate), {
        code: "unsupported_widget_dependency",
        path: expectedPath,
      });
    },
  );

  it.each([
    '<img srcset="./small.png 1x, ./large.png 2x" alt="">',
    '<link rel="modulepreload" href="./chunk.js">',
    '<script type="importmap">{"imports":{}}</script>',
    '<img src="./missing.png" alt="">',
    '<img src="./bad%zz.png" alt="">',
    '<script src="../artifact/app.js"></script>',
    '<button onclick="import(\'data:text/javascript,export default true\')">Run</button>',
    '<script src="data:text/javascript,import(\'data:text/javascript,export default true\')"></script>',
    '<svg><script href="./widget.js"></script></svg>',
    '<svg><script xlink:href="./widget.js"></script></svg>',
  ])(
    "fails closed for an unsupported or unresolved widget HTML dependency",
    async (html) => {
      const candidate = clonePackage();
      await replaceFileContent(candidate, "widget/index.html", html);

      await expectPackageFailure(() => parseShipletPackage(candidate), {
        code: "unsupported_widget_dependency",
        path: "widget/index.html",
      });
    },
  );

  it.each([
    `artifact/${"a".repeat(256)}.html`,
    `artifact/${"a".repeat(1_017)}`,
  ])("rejects package paths beyond portable segment or total byte bounds", async (path) => {
    const candidate = clonePackage();
    const artifact = candidate.files.find(
      (file) => file.path === "artifact/index.html",
    );
    expect(artifact).toBeTruthy();
    if (!artifact) return;
    artifact.path = path;
    candidate.manifest.entrypoints.artifact = path;

    await expectPackageFailure(() => parseShipletPackage(candidate), {
      code: "invalid_path",
      path,
    });
  });

  it.each([
    "credentials",
    "apiKey",
    "clientSecret",
    "accessToken",
    "privateKey",
    "accessGrants",
    "customerState",
    "auditHistory",
    "oauth",
    "claimUrl",
    "sessions",
  ])(
    "rejects nested package authority at manifest.%s without echoing it",
    async (key) => {
      const sentinel = `must-not-echo-${key}`;
      const candidate = clonePackage();
      candidate.manifest[key] = { value: sentinel };

      await expectPackageFailure(
        () => parseShipletPackage(candidate),
        { code: "forbidden_authority", path: `manifest.${key}` },
        sentinel,
      );
    },
  );

  it.each([
    "credentials/platform.json",
    "grants/review.json",
    "state/runtime.json",
    "audit/history.json",
    "oauth/cloudflare.json",
    "claims/temporary.json",
    "sessions/reviewer.json",
  ])("rejects forbidden authority file %s before persistence", async (path) => {
    const candidate = clonePackage();
    candidate.files.push({ ...candidate.files[2], path });
    candidate.files.sort(comparePaths);

    await expectPackageFailure(() => parseShipletPackage(candidate), {
      code: "forbidden_authority",
      path,
    });
  });

  it("refuses to serialize runtime-owned data mixed into a validated package", async () => {
    const sentinel = "runtime-state-must-not-export";
    const parsed = await parseShipletPackage(clonePackage());
    const contaminated = structuredClone(parsed) as unknown as JsonObject;
    contaminated.state = { private: sentinel };

    await expectPackageFailure(
      () => serializeShipletPackage(contaminated),
      { code: "forbidden_authority", path: "state" },
      sentinel,
    );
  });

  it.each([
    ["artifact", "widget/index.html"],
    ["widget", "artifact/index.html"],
    ["workflow", "provenance.json"],
    ["mcp", "workflow/schema.json"],
    ["agentInstructions", "provenance.json"],
    ["validation", "workflow/schema.json"],
    ["provenance", "validation/manifest.json"],
  ])(
    "rejects required %s entrypoint aliasing unrelated file %s",
    async (entrypoint, path) => {
      const candidate = clonePackage();
      candidate.manifest.entrypoints[entrypoint] = path;

      await expectPackageFailure(() => parseShipletPackage(candidate), {
        code: "entrypoint_mismatch",
        path: `manifest.entrypoints.${entrypoint}`,
      });
    },
  );

  it.each([
    [
      "workflow/schema.json",
      JSON.stringify({
        schemaVersion: "shiplet.workflow/v1",
        statuses: "not-an-array",
        fields: [],
      }),
    ],
    [
      "mcp/manifest.json",
      JSON.stringify({
        schemaVersion: "shiplet.mcp/v1",
        tools: [{ name: "missing-handler-and-schema" }],
      }),
    ],
    [
      "validation/manifest.json",
      JSON.stringify({
        schemaVersion: "shiplet.validation/v1",
        checks: [{ kind: "unknown-executable-check" }],
      }),
    ],
    [
      "provenance.json",
      JSON.stringify({
        schemaVersion: "shiplet.provenance/v1",
        source: "not-an-object",
        lineage: [],
      }),
    ],
  ])(
    "rejects structurally invalid package contract %s",
    async (path, content) => {
      const candidate = clonePackage();
      await replaceFileContent(candidate, path, `${content}\n`);

      await expectPackageFailure(() => parseShipletPackage(candidate), {
        code: "invalid_schema",
        path,
      });
    },
  );

  it.each([
    ["fileCount", 0],
    ["fileBytes", 0],
    ["packageBytes", 0],
  ])("rejects unusable zero manifest limit %s", async (limit, value) => {
    const candidate = clonePackage();
    (candidate.manifest.limits as JsonObject)[limit] = value;

    await expectPackageFailure(() => parseShipletPackage(candidate), {
      code: "invalid_limits",
      path: `manifest.limits.${limit}`,
    });
  });

  it("rejects limits whose package budget is smaller than the file budget", async () => {
    const candidate = clonePackage();
    (candidate.manifest.limits as JsonObject).fileBytes = 4096;
    (candidate.manifest.limits as JsonObject).packageBytes = 2048;

    await expectPackageFailure(() => parseShipletPackage(candidate), {
      code: "invalid_limits",
      path: "manifest.limits.packageBytes",
    });
  });

  it.each([
    ["fileCount", 10],
    ["fileBytes", 2],
    ["packageBytes", 100],
  ])(
    "enforces declared %s against decoded package contents",
    async (limit, value) => {
      const candidate = clonePackage();
      (candidate.manifest.limits as JsonObject)[limit] = value;

      await expectPackageFailure(() => parseShipletPackage(candidate), {
        code: "limit_exceeded",
        path: `manifest.limits.${limit}`,
      });
    },
  );

  it.each([
    "artifact/CON",
    "artifact/con.txt",
    "artifact/AUX.html",
    "artifact/COM1.js",
    "artifact/lpt9",
    "artifact/trailing.",
    "artifact/trailing ",
  ])("rejects Windows-reserved portable path %s", async (path) => {
    const candidate = clonePackage();
    candidate.files[1].path = path;

    await expectPackageFailure(() => parseShipletPackage(candidate), {
      code: "invalid_path",
      path,
    });
  });

  it("decodes base64 structured package files before schema validation", async () => {
    const candidate = clonePackage();
    const workflow = candidate.files.find(
      (file) => file.path === "workflow/schema.json",
    );
    expect(workflow).toBeTruthy();
    if (!workflow) return;
    const base64 = btoa(workflow.content);
    await replaceFileContent(candidate, workflow.path, base64, "base64");

    await expect(parseShipletPackage(candidate)).resolves.toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({
          path: "workflow/schema.json",
          encoding: "base64",
        }),
      ]),
    });
  });

  it("rejects non-enumerable toJSON hooks instead of validating a different snapshot", async () => {
    const sentinel = "to-json-authority-smuggle";
    const candidate = clonePackage();
    Object.defineProperty(candidate, "toJSON", {
      enumerable: false,
      value: () => ({ ...candidate, state: { private: sentinel } }),
    });

    await expectPackageFailure(
      () => parseShipletPackage(candidate),
      { code: "non_plain_data", path: "toJSON" },
      sentinel,
    );
  });

  it("bounds raw object width before walking untrusted manifest data", async () => {
    const candidate = clonePackage();
    candidate.manifest.limits = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`limit_${index}`, 1]),
    );

    await expectPackageFailure(() => parseShipletPackage(candidate), {
      code: "tree_width_exceeded",
      path: "manifest.limits",
    });
  });

  it("bounds the total raw node budget before hashing a wide package", async () => {
    const candidate = clonePackage();
    const source = candidate.files.find(
      (file) => file.path === "artifact/icon.bin",
    );
    expect(source).toBeTruthy();
    if (!source) return;
    for (let index = 0; index < 700; index += 1) {
      candidate.files.push({
        ...source,
        path: `artifact/generated-${index.toString().padStart(4, "0")}.bin`,
      });
    }
    (candidate.manifest.limits as JsonObject).fileCount = 1_000;

    await expectPackageFailure(() => parseShipletPackage(candidate), {
      code: "tree_node_limit",
      path: "$",
    });
  });

  it.each([
    [
      "workflow/schema.json",
      "workflow/schema.json.defaults.authorizationHeader",
      (value: JsonObject) => {
        value.defaults = {
          authorizationHeader: "credential-marker-workflow",
        };
      },
    ],
    [
      "mcp/manifest.json",
      "mcp/manifest.json.tools[0].transport.apiCredential",
      (value: JsonObject) => {
        ((value.tools as JsonObject[])[0] as JsonObject).transport = {
          apiCredential: "credential-marker-mcp",
        };
      },
    ],
    [
      "validation/manifest.json",
      "validation/manifest.json.checks[0].provider.bearerToken",
      (value: JsonObject) => {
        ((value.checks as JsonObject[])[0] as JsonObject).provider = {
          bearerToken: "credential-marker-validation",
        };
      },
    ],
    [
      "provenance.json",
      "provenance.json.source.connection.cloudflareApiToken",
      (value: JsonObject) => {
        (value.source as JsonObject).connection = {
          cloudflareApiToken: "credential-marker-provenance",
        };
      },
    ],
  ] as const)(
    "rejects nested credential-authority aliases in %s",
    async (path, expectedPath, mutate) => {
      const candidate = clonePackage();
      const file = candidate.files.find((entry) => entry.path === path);
      expect(file).toBeTruthy();
      if (!file) return;
      const structured = JSON.parse(file.content) as JsonObject;
      mutate(structured);
      await replaceFileContent(
        candidate,
        path,
        `${JSON.stringify(structured)}\n`,
      );

      await expectPackageFailure(
        () => parseShipletPackage(candidate),
        { code: "forbidden_authority", path: expectedPath },
        "credential-marker",
      );
    },
  );

  it.each([
    [
      "workflow/schema.json",
      (value: JsonObject) => {
        value.unexpectedKernelField = true;
      },
    ],
    [
      "mcp/manifest.json",
      (value: JsonObject) => {
        ((value.tools as JsonObject[])[0] as JsonObject).unexpectedKernelField =
          true;
      },
    ],
    [
      "validation/manifest.json",
      (value: JsonObject) => {
        (
          (value.checks as JsonObject[])[0] as JsonObject
        ).unexpectedKernelField = true;
      },
    ],
    [
      "provenance.json",
      (value: JsonObject) => {
        (value.lineage as JsonObject).unexpectedKernelField = true;
      },
    ],
  ] as const)(
    "uses a closed structured schema for %s",
    async (path, mutate) => {
      const candidate = clonePackage();
      const file = candidate.files.find((entry) => entry.path === path);
      expect(file).toBeTruthy();
      if (!file) return;
      const structured = JSON.parse(file.content) as JsonObject;
      mutate(structured);
      await replaceFileContent(
        candidate,
        path,
        `${JSON.stringify(structured)}\n`,
      );

      await expectPackageFailure(() => parseShipletPackage(candidate), {
        code: "invalid_schema",
        path,
      });
    },
  );

  it("allows authorization vocabulary inside arbitrary code and instruction bytes", async () => {
    const candidate = clonePackage();
    await replaceFileContent(
      candidate,
      "artifact/app.js",
      "const authorization = request.headers.get('authorization');\n",
    );
    await replaceFileContent(
      candidate,
      "mcp/handlers/summarize.js",
      "export default ({ apiKeyFieldName }) => ({ apiKeyFieldName });\n",
    );
    await replaceFileContent(
      candidate,
      "AGENTS.md",
      "Never request an API credential or bearer token from the reviewer.\n",
    );

    await expect(parseShipletPackage(candidate)).resolves.toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({ path: "artifact/app.js" }),
        expect.objectContaining({ path: "mcp/handlers/summarize.js" }),
        expect.objectContaining({ path: "AGENTS.md" }),
      ]),
    });
  });

  it("counts the complete canonical serialized envelope against packageBytes", async () => {
    const candidate = clonePackage();
    (candidate.manifest.limits as JsonObject).fileBytes = 2_000;
    (candidate.manifest.limits as JsonObject).packageBytes = 3_000;
    expect(
      new TextEncoder().encode(JSON.stringify(candidate)).byteLength,
    ).toBeGreaterThan(3_000);

    await expectPackageFailure(() => parseShipletPackage(candidate), {
      code: "limit_exceeded",
      path: "manifest.limits.packageBytes",
    });
  });

  it("bounds serialized string input before JSON parsing", async () => {
    const oversizedInput = " ".repeat(32 * 1024 * 1024 + 1);

    await expectPackageFailure(() => parseShipletPackage(oversizedInput), {
      code: "input_too_large",
      path: "$",
    });
  });

  it("rejects array index accessors without invoking them", async () => {
    const candidate = clonePackage();
    const firstFile = candidate.files[0];
    let accessorExecutions = 0;
    Object.defineProperty(candidate.files, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorExecutions += 1;
        return firstFile;
      },
    });

    const [attempt] = await Promise.allSettled([
      parseShipletPackage(candidate),
    ]);
    expect.soft(attempt).toMatchObject({
      status: "rejected",
      reason: { code: "non_plain_data", path: "files[0]" },
    });
    expect.soft(accessorExecutions).toBe(0);
  });

  it("rejects proxies without executing user-controlled traps", async () => {
    let trapExecutions = 0;
    const candidate = new Proxy(clonePackage(), {
      get(target, property, receiver) {
        trapExecutions += 1;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        trapExecutions += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      getPrototypeOf(target) {
        trapExecutions += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        trapExecutions += 1;
        return Reflect.ownKeys(target);
      },
    });

    const [attempt] = await Promise.allSettled([
      parseShipletPackage(candidate),
    ]);
    expect.soft(attempt).toMatchObject({
      status: "rejected",
      reason: { code: "non_plain_data", path: "$" },
    });
    expect.soft(trapExecutions).toBe(0);
  });

  it.each(["object", "serialized"] as const)(
    "preserves and rejects enumerable __proto__ authority from %s input",
    async (inputKind) => {
      const candidate = clonePackage();
      Object.defineProperty(candidate.manifest, "__proto__", {
        configurable: true,
        enumerable: true,
        value: {
          authorizationHeader: "credential-marker-prototype-pollution",
        },
        writable: true,
      });
      const input =
        inputKind === "serialized" ? JSON.stringify(candidate) : candidate;
      if (inputKind === "serialized") {
        expect(input).toContain('"__proto__"');
      }

      await expectPackageFailure(
        () => parseShipletPackage(input),
        {
          code: "forbidden_authority",
          path: "manifest.__proto__.authorizationHeader",
        },
        "credential-marker-prototype-pollution",
      );
    },
  );

  it("enforces a cumulative UTF-8 budget while traversing object input", async () => {
    const candidate = clonePackage();
    const oneMiB = "x".repeat(1024 * 1024);
    candidate.manifest.padding = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`chunk_${index}`, oneMiB]),
    );

    await expectPackageFailure(() => parseShipletPackage(candidate), {
      code: "input_too_large",
      path: "$",
    });
  });
});
