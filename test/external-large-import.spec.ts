import { describe, expect, it } from "vitest";

import {
  EXTERNAL_REWRITE_CIRCUIT_BREAKER_BYTES,
  EXTERNAL_REWRITE_FAST_PATH_BYTES,
  EXTERNAL_REWRITE_MAX_HTML_ATTRIBUTE_CHARS,
  EXTERNAL_REWRITE_SPOOL_PART_BYTES,
  rewriteExternalTextResponse,
} from "../src/external-text-rewrite";
import {
  rewriteExternalCssReferences,
  rewriteExternalHtmlReferences,
} from "../src/external-url-proxy";

const MIB = 1024 * 1024;
const ORIGIN_CHUNK_BYTES = 256 * 1024;
const MAX_FIRST_OUTPUT_WORK_BYTES = 1 * MIB;

type TextKind = "html" | "css";

type StreamTelemetry = {
  cancelled: number;
  maxChunkBytes: number;
  pulledBytes: number;
  pulls: number;
};

type SpoolOpenTelemetry = StreamTelemetry & {
  done: boolean;
};

type SpoolTelemetry = {
  appendCalls: number;
  completeCalls: number;
  createCalls: number;
  disposeCalls: number;
  maxAppendBytes: number;
  openPasses: SpoolOpenTelemetry[];
  totalAppendedBytes: number;
};

type ExternalRewriteSpool = {
  append(part: Uint8Array): Promise<void>;
  complete(): Promise<void>;
  dispose(): Promise<void>;
  open(): Promise<ReadableStream<Uint8Array>>;
};

type ExternalRewriteSpoolStore = {
  create(input: {
    contentType: TextKind;
    projectId: string;
  }): Promise<ExternalRewriteSpool>;
};

function fakeSpoolStore() {
  const telemetry: SpoolTelemetry = {
    appendCalls: 0,
    completeCalls: 0,
    createCalls: 0,
    disposeCalls: 0,
    maxAppendBytes: 0,
    openPasses: [],
    totalAppendedBytes: 0,
  };
  let completed = false;
  let disposed = false;
  let parts: Uint8Array[] = [];

  const spool: ExternalRewriteSpool = {
    async append(part) {
      expect(completed).toBe(false);
      expect(disposed).toBe(false);
      telemetry.appendCalls += 1;
      telemetry.totalAppendedBytes += part.byteLength;
      telemetry.maxAppendBytes = Math.max(
        telemetry.maxAppendBytes,
        part.byteLength,
      );
      // Retaining immutable chunks models persisted parts without making another
      // test-side copy of every multi-megabyte fixture.
      parts.push(part);
    },
    async complete() {
      expect(completed).toBe(false);
      expect(disposed).toBe(false);
      completed = true;
      telemetry.completeCalls += 1;
    },
    async open() {
      expect(completed).toBe(true);
      expect(disposed).toBe(false);
      const pass: SpoolOpenTelemetry = {
        cancelled: 0,
        done: false,
        maxChunkBytes: 0,
        pulledBytes: 0,
        pulls: 0,
      };
      telemetry.openPasses.push(pass);
      let partIndex = 0;
      let partOffset = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          while (partIndex < parts.length) {
            const part = parts[partIndex];
            if (partOffset >= part.byteLength) {
              partIndex += 1;
              partOffset = 0;
              continue;
            }
            const length = Math.min(
              ORIGIN_CHUNK_BYTES,
              part.byteLength - partOffset,
            );
            const chunk = part.subarray(partOffset, partOffset + length);
            partOffset += length;
            pass.pulls += 1;
            pass.pulledBytes += chunk.byteLength;
            pass.maxChunkBytes = Math.max(pass.maxChunkBytes, chunk.byteLength);
            controller.enqueue(chunk);
            return;
          }
          pass.done = true;
          controller.close();
        },
        cancel() {
          pass.cancelled += 1;
        },
      });
    },
    async dispose() {
      telemetry.disposeCalls += 1;
      if (disposed) return;
      disposed = true;
      parts = [];
    },
  };

  const store: ExternalRewriteSpoolStore = {
    async create(input) {
      expect(input.projectId).toBe("project-large-import");
      expect(["html", "css"]).toContain(input.contentType);
      telemetry.createCalls += 1;
      return spool;
    },
  };

  return { store, telemetry };
}

function exactTextBody(input: {
  prefix: string;
  suffix: string;
  totalBytes: number;
  failAfterBytes?: number;
}) {
  const prefix = new TextEncoder().encode(input.prefix);
  const suffix = new TextEncoder().encode(input.suffix);
  if (prefix.byteLength + suffix.byteLength > input.totalBytes) {
    throw new RangeError("Fixture framing exceeds its requested byte length");
  }
  const fillerBytes = input.totalBytes - prefix.byteLength - suffix.byteLength;
  const filler = new Uint8Array(ORIGIN_CHUNK_BYTES).fill(0x20);
  const telemetry: StreamTelemetry = {
    cancelled: 0,
    maxChunkBytes: 0,
    pulledBytes: 0,
    pulls: 0,
  };
  let phase: "prefix" | "filler" | "suffix" | "done" = "prefix";
  let fillerOffset = 0;

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (
        input.failAfterBytes !== undefined &&
        telemetry.pulledBytes >= input.failAfterBytes
      ) {
        controller.error(new Error("fixture upstream stream failed"));
        phase = "done";
        return;
      }
      let chunk: Uint8Array | undefined;
      if (phase === "prefix") {
        chunk = prefix;
        phase = "filler";
      } else if (phase === "filler" && fillerOffset < fillerBytes) {
        const length = Math.min(ORIGIN_CHUNK_BYTES, fillerBytes - fillerOffset);
        chunk = filler.subarray(0, length);
        fillerOffset += length;
        if (fillerOffset >= fillerBytes) phase = "suffix";
      } else if (phase === "suffix") {
        chunk = suffix;
        phase = "done";
      } else {
        controller.close();
        return;
      }
      telemetry.pulls += 1;
      telemetry.pulledBytes += chunk.byteLength;
      telemetry.maxChunkBytes = Math.max(
        telemetry.maxChunkBytes,
        chunk.byteLength,
      );
      controller.enqueue(chunk);
    },
    cancel() {
      telemetry.cancelled += 1;
      phase = "done";
    },
  });

  return { body, telemetry };
}

function streamedTextResponse(input: {
  contentLength: "exact" | "missing" | number;
  kind: TextKind;
  prefix: string;
  suffix: string;
  totalBytes: number;
  failAfterBytes?: number;
}) {
  const streamed = exactTextBody(input);
  const headers = new Headers({
    "content-type":
      input.kind === "html"
        ? "text/html; charset=utf-8"
        : "text/css; charset=utf-8",
  });
  if (input.contentLength !== "missing") {
    headers.set(
      "content-length",
      String(
        input.contentLength === "exact"
          ? input.totalBytes
          : input.contentLength,
      ),
    );
  }
  const response = new Response(streamed.body, { headers });

  // Large imports must consume the stream. These traps make a whole-response
  // convenience aggregation fail deterministically, independent of wall time.
  Object.defineProperties(response, {
    arrayBuffer: {
      value: () => {
        throw new Error("large rewrite used Response.arrayBuffer()");
      },
    },
    blob: {
      value: () => {
        throw new Error("large rewrite used Response.blob()");
      },
    },
    text: {
      value: () => {
        throw new Error("large rewrite used Response.text()");
      },
    },
  });
  return { response, telemetry: streamed.telemetry };
}

function proxyReference(target: string) {
  return `/__test_external__/${encodeURIComponent(target)}`;
}

function latestTransformPass(telemetry: SpoolTelemetry) {
  const pass = telemetry.openPasses.at(-1);
  expect(pass).toBeTruthy();
  return pass!;
}

async function readTextEvidence(
  response: Response,
  needles: string[],
  firstChunk?: ReadableStreamReadResult<Uint8Array>,
) {
  expect(response.body).toBeTruthy();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const found = new Map(needles.map((needle) => [needle, false]));
  const carryLength = Math.max(0, ...needles.map((needle) => needle.length));
  let carry = "";
  let maxChunkBytes = 0;
  let totalBytes = 0;

  async function inspect(result: ReadableStreamReadResult<Uint8Array>) {
    if (result.done) return false;
    maxChunkBytes = Math.max(maxChunkBytes, result.value.byteLength);
    totalBytes += result.value.byteLength;
    const text = carry + decoder.decode(result.value, { stream: true });
    for (const needle of needles) {
      if (text.includes(needle)) found.set(needle, true);
    }
    carry = text.slice(-carryLength);
    return true;
  }

  if (firstChunk && (await inspect(firstChunk))) {
    // The caller already caused exactly one output read for demand telemetry.
  }
  while (await inspect(await reader.read())) {
    // Evidence is accumulated incrementally to avoid a second full-size string.
  }
  const finalText = carry + decoder.decode();
  for (const needle of needles) {
    if (finalText.includes(needle)) found.set(needle, true);
  }
  return { found, maxChunkBytes, totalBytes };
}

async function rewriteFixture(input: {
  contentLength: "exact" | "missing" | number;
  kind: TextKind;
  prefix: string;
  suffix: string;
  totalBytes: number;
}) {
  const streamed = streamedTextResponse(input);
  const spool = fakeSpoolStore();
  const targets: string[] = [];
  const proxyUrlFor = async (target: string) => {
    targets.push(target);
    return proxyReference(target);
  };
  const response = await rewriteExternalTextResponse({
    kind: input.kind,
    projectId: "project-large-import",
    proxyUrlFor,
    response: streamed.response,
    rewriteCssText: async (css, sourceUrl, scopedProxyUrlFor) =>
      rewriteExternalCssReferences({
        css,
        proxyUrlFor: scopedProxyUrlFor,
        sourceUrl,
      }),
    rewriteHtmlText: async (html, sourceUrl, scopedProxyUrlFor) =>
      rewriteExternalHtmlReferences({
        html,
        proxyUrlFor: scopedProxyUrlFor,
        sourceUrl,
      }),
    sourceUrl:
      input.kind === "html"
        ? "https://origin.example.com/releases/current/index.html"
        : "https://origin.example.com/assets/css/app.css",
    spoolStore: spool.store,
  });
  return {
    response,
    spoolTelemetry: spool.telemetry,
    targets,
    upstreamTelemetry: streamed.telemetry,
  };
}

describe("large external URL import rewriting", () => {
  it("freezes 8 MiB as an optimization threshold and 64 MiB as the actual-byte emergency boundary", () => {
    expect(EXTERNAL_REWRITE_FAST_PATH_BYTES).toBe(8 * MIB);
    expect(EXTERNAL_REWRITE_SPOOL_PART_BYTES).toBe(8 * MIB);
    expect(EXTERNAL_REWRITE_CIRCUIT_BREAKER_BYTES).toBe(64 * MIB);
    expect(EXTERNAL_REWRITE_MAX_HTML_ATTRIBUTE_CHARS).toBe(8 * MIB);
  });

  for (const fixture of [
    { bytes: 8 * MIB, contentLength: "exact" as const },
    { bytes: 16 * MIB, contentLength: "missing" as const },
    { bytes: 32 * MIB, contentLength: 1024 },
  ]) {
    it(`rewrites a ${fixture.bytes / MIB} MiB HTML document faithfully with its base and late references`, async () => {
      const baseTarget = "https://origin.example.com/static/v7/";
      const earlyTarget = "https://origin.example.com/static/v7/css/early.css";
      const lateTarget = "https://origin.example.com/static/v7/images/late.png";
      const result = await rewriteFixture({
        contentLength: fixture.contentLength,
        kind: "html",
        prefix:
          '<!doctype html><html><head><base href="/static/v7/"><link id="early" rel="stylesheet" href="css/early.css"></head><body>BEGIN-LARGE-HTML',
        suffix:
          '<img id="late" src="images/late.png">END-LARGE-HTML</body></html>',
        totalBytes: fixture.bytes,
      });

      const failureText =
        result.response.status === 200
          ? ""
          : await result.response.clone().text();
      expect(result.response.status, failureText).toBe(200);
      expect(result.response.headers.get("content-type")).toContain(
        "text/html",
      );
      expect(result.response.headers.get("content-length")).toBeNull();
      expect(result.upstreamTelemetry.pulledBytes).toBe(fixture.bytes);

      if (fixture.bytes > EXTERNAL_REWRITE_FAST_PATH_BYTES) {
        expect(result.spoolTelemetry.maxAppendBytes).toBeLessThanOrEqual(
          EXTERNAL_REWRITE_SPOOL_PART_BYTES,
        );
        const reader = result.response.body!.getReader();
        const first = await reader.read();
        const transform = latestTransformPass(result.spoolTelemetry);
        expect(transform.pulledBytes).toBeLessThanOrEqual(
          MAX_FIRST_OUTPUT_WORK_BYTES,
        );
        reader.releaseLock();
        const evidence = await readTextEvidence(
          result.response,
          [
            proxyReference(baseTarget),
            proxyReference(earlyTarget),
            proxyReference(lateTarget),
            "BEGIN-LARGE-HTML",
            "END-LARGE-HTML",
            'href="css/early.css"',
            'src="images/late.png"',
          ],
          first,
        );
        expect(evidence.maxChunkBytes).toBeLessThanOrEqual(
          MAX_FIRST_OUTPUT_WORK_BYTES,
        );
        expect(evidence.totalBytes).toBeGreaterThan(fixture.bytes - MIB);
        expect(evidence.found.get('href="css/early.css"')).toBe(false);
        expect(evidence.found.get('src="images/late.png"')).toBe(false);
        for (const needle of [
          proxyReference(baseTarget),
          proxyReference(earlyTarget),
          proxyReference(lateTarget),
          "BEGIN-LARGE-HTML",
          "END-LARGE-HTML",
        ]) {
          expect(evidence.found.get(needle), needle).toBe(true);
        }
      } else {
        const evidence = await readTextEvidence(result.response, [
          proxyReference(baseTarget),
          proxyReference(earlyTarget),
          proxyReference(lateTarget),
          'href="css/early.css"',
          'src="images/late.png"',
        ]);
        expect(evidence.found.get('href="css/early.css"')).toBe(false);
        expect(evidence.found.get('src="images/late.png"')).toBe(false);
        expect(evidence.found.get(proxyReference(baseTarget))).toBe(true);
        expect(evidence.found.get(proxyReference(earlyTarget))).toBe(true);
        expect(evidence.found.get(proxyReference(lateTarget))).toBe(true);
      }

      expect(result.targets).toEqual(
        expect.arrayContaining([baseTarget, earlyTarget, lateTarget]),
      );
      if (result.spoolTelemetry.createCalls > 0) {
        expect(result.spoolTelemetry.completeCalls).toBe(1);
        expect(result.spoolTelemetry.disposeCalls).toBe(1);
      }
    });
  }

  for (const fixture of [
    {
      bytes: 8 * MIB,
      contentLength: EXTERNAL_REWRITE_CIRCUIT_BREAKER_BYTES + MIB,
    },
    { bytes: 16 * MIB, contentLength: "exact" as const },
    { bytes: 32 * MIB, contentLength: "missing" as const },
  ]) {
    it(`rewrites a ${fixture.bytes / MIB} MiB stylesheet including imports and a late asset`, async () => {
      const importTarget =
        "https://origin.example.com/assets/css/theme/base.css";
      const lateTarget = "https://origin.example.com/assets/images/late.png";
      const result = await rewriteFixture({
        contentLength: fixture.contentLength,
        kind: "css",
        prefix: '@import "./theme/base.css";/*BEGIN-LARGE-CSS*/',
        suffix:
          '.late{background-image:url("../images/late.png")}/*END-LARGE-CSS*/',
        totalBytes: fixture.bytes,
      });

      const failureText =
        result.response.status === 200
          ? ""
          : await result.response.clone().text();
      expect(result.response.status, failureText).toBe(200);
      expect(result.response.headers.get("content-type")).toContain("text/css");
      expect(result.response.headers.get("content-length")).toBeNull();
      expect(result.upstreamTelemetry.pulledBytes).toBe(fixture.bytes);

      let evidence;
      if (fixture.bytes > EXTERNAL_REWRITE_FAST_PATH_BYTES) {
        expect(result.spoolTelemetry.maxAppendBytes).toBeLessThanOrEqual(
          EXTERNAL_REWRITE_SPOOL_PART_BYTES,
        );
        const reader = result.response.body!.getReader();
        const first = await reader.read();
        const transform = latestTransformPass(result.spoolTelemetry);
        expect(transform.pulledBytes).toBeLessThanOrEqual(
          MAX_FIRST_OUTPUT_WORK_BYTES,
        );
        reader.releaseLock();
        evidence = await readTextEvidence(
          result.response,
          [
            proxyReference(importTarget),
            proxyReference(lateTarget),
            "BEGIN-LARGE-CSS",
            "END-LARGE-CSS",
            '"./theme/base.css"',
            '"../images/late.png"',
          ],
          first,
        );
        expect(evidence.maxChunkBytes).toBeLessThanOrEqual(
          MAX_FIRST_OUTPUT_WORK_BYTES,
        );
      } else {
        evidence = await readTextEvidence(result.response, [
          proxyReference(importTarget),
          proxyReference(lateTarget),
          '"./theme/base.css"',
          '"../images/late.png"',
        ]);
      }
      expect(evidence.totalBytes).toBeGreaterThan(fixture.bytes - MIB);
      expect(evidence.found.get('"./theme/base.css"')).toBe(false);
      expect(evidence.found.get('"../images/late.png"')).toBe(false);
      expect(evidence.found.get(proxyReference(importTarget))).toBe(true);
      expect(evidence.found.get(proxyReference(lateTarget))).toBe(true);
      expect(result.targets).toEqual(
        expect.arrayContaining([importTarget, lateTarget]),
      );
      if (result.spoolTelemetry.createCalls > 0) {
        expect(result.spoolTelemetry.completeCalls).toBe(1);
        expect(result.spoolTelemetry.disposeCalls).toBe(1);
      }
    });
  }

  it("shares the 4,096-reference budget across every streamed CSS segment", async () => {
    for (const referenceCount of [4_096, 4_097]) {
      const cssReferences = Array.from(
        { length: referenceCount },
        (_, index) => `.asset-${index}{src:url("asset-${index}.png")}`,
      ).join("");
      const result = await rewriteFixture({
        contentLength: "missing",
        kind: "css",
        prefix: cssReferences,
        suffix: "/*END-REFERENCE-BUDGET*/",
        totalBytes: EXTERNAL_REWRITE_FAST_PATH_BYTES + 1,
      });

      expect(result.response.status).toBe(referenceCount === 4_096 ? 200 : 502);
      if (referenceCount === 4_096) {
        await result.response.body?.cancel(
          "reference budget sentinel complete",
        );
      } else {
        expect(await result.response.text()).not.toContain(
          "END-REFERENCE-BUDGET",
        );
      }
      expect(result.spoolTelemetry.disposeCalls).toBe(1);
    }
  });

  it("recognizes a CSS comment terminator split across staged replay chunks and still rewrites the following URL", async () => {
    const boundaryPrefix = `/*${"a".repeat(ORIGIN_CHUNK_BYTES - 3)}*/`;
    const target = "https://cdn.example.com/assets/after-comment.png";
    const result = await rewriteFixture({
      contentLength: "missing",
      kind: "css",
      prefix: `${boundaryPrefix}.after{background:url("${target}")}`,
      suffix: "/*END-SPLIT-COMMENT*/",
      totalBytes: EXTERNAL_REWRITE_FAST_PATH_BYTES + 1,
    });

    expect(result.response.status).toBe(200);
    const evidence = await readTextEvidence(result.response, [
      proxyReference(target),
      target,
      "END-SPLIT-COMMENT",
    ]);
    expect(evidence.found.get(proxyReference(target))).toBe(true);
    expect(evidence.found.get(target)).toBe(false);
    expect(evidence.found.get("END-SPLIT-COMMENT")).toBe(true);
    expect(result.spoolTelemetry.disposeCalls).toBe(1);
  });

  it("preserves a one-megabyte inline data URL in staged CSS and still rewrites a later network asset", async () => {
    const target = "https://cdn.example.com/assets/after-inline-data.png";
    const inlineMarker = "INLINE-DATA-URL-SURVIVES";
    const inlineData = `data:image/png;base64,${"a".repeat(MIB)}${inlineMarker}`;
    const result = await rewriteFixture({
      contentLength: "missing",
      kind: "css",
      prefix: `.inline{background-image:url("${inlineData}")}.after{background-image:url("${target}")}`,
      suffix: "/*END-LONG-DATA-URL*/",
      totalBytes: EXTERNAL_REWRITE_FAST_PATH_BYTES + 1,
    });

    expect(result.response.status).toBe(200);
    const evidence = await readTextEvidence(result.response, [
      inlineMarker,
      proxyReference(target),
      target,
      "END-LONG-DATA-URL",
    ]);
    expect(evidence.found.get(inlineMarker)).toBe(true);
    expect(evidence.found.get(proxyReference(target))).toBe(true);
    expect(evidence.found.get(target)).toBe(false);
    expect(evidence.found.get("END-LONG-DATA-URL")).toBe(true);
    expect(result.spoolTelemetry.maxAppendBytes).toBeLessThanOrEqual(
      EXTERNAL_REWRITE_SPOOL_PART_BYTES,
    );
    expect(result.spoolTelemetry.disposeCalls).toBe(1);
  });

  it("streams nine-megabyte data URLs and quoted custom properties faithfully before rewriting a later asset", async () => {
    const target = "https://cdn.example.com/assets/after-long-tokens.png";
    const dataMarker = "<svg>&LONG-DATA-PROBE</svg>";
    const unquotedMarker = "UNQUOTED-DATA-PROBE";
    const customStart = "LONG-CUSTOM-PROPERTY-START";
    const customEnd = "LONG-CUSTOM-PROPERTY-END";
    const inlineData = `data:image/svg+xml,${dataMarker}${"a".repeat(9 * MIB)}`;
    const customValue = `${customStart}${"b".repeat(9 * MIB)}${customEnd}`;
    const result = await rewriteFixture({
      contentLength: "missing",
      kind: "css",
      prefix: `.inline{background-image:url("${inlineData}")}.unquoted{background-image:url(data:image/png;base64,${unquotedMarker}${"c".repeat(9 * MIB)})}:root{--embedded:"${customValue}"}`,
      suffix: `.after{background-image:url("${target}")}/*END-NINE-MEG-TOKENS*/`,
      totalBytes: 32 * MIB,
    });

    const failureText =
      result.response.status === 200
        ? ""
        : await result.response.clone().text();
    expect(result.response.status, failureText).toBe(200);
    const evidence = await readTextEvidence(result.response, [
      dataMarker,
      unquotedMarker,
      customStart,
      customEnd,
      proxyReference(target),
      target,
      "END-NINE-MEG-TOKENS",
    ]);
    expect(evidence.found.get(dataMarker)).toBe(true);
    expect(evidence.found.get(unquotedMarker)).toBe(true);
    expect(evidence.found.get(customStart)).toBe(true);
    expect(evidence.found.get(customEnd)).toBe(true);
    expect(evidence.found.get(proxyReference(target))).toBe(true);
    expect(evidence.found.get(target)).toBe(false);
    expect(evidence.found.get("END-NINE-MEG-TOKENS")).toBe(true);
    expect(evidence.maxChunkBytes).toBeLessThanOrEqual(
      MAX_FIRST_OUTPUT_WORK_BYTES,
    );
    expect(result.spoolTelemetry.disposeCalls).toBe(1);
  });

  it("streams a nine-megabyte unquoted custom-property identifier and still rewrites a later asset", async () => {
    const customTarget =
      "https://cdn.example.com/assets/in-unquoted-custom-property.png";
    const lateTarget =
      "https://cdn.example.com/assets/after-unquoted-token.png";
    const tokenStart = "LONG-UNQUOTED-TOKEN-START";
    const tokenEnd = "LONG-UNQUOTED-TOKEN-END";
    const result = await rewriteFixture({
      contentLength: "missing",
      kind: "css",
      prefix: `:root{--payload:${tokenStart}${"a".repeat(9 * MIB)}${tokenEnd} url("${customTarget}");}`,
      suffix: `.after{background-image:url("${lateTarget}")}/*END-UNQUOTED-CUSTOM-PROPERTY*/`,
      totalBytes: 17 * MIB,
    });

    const failureText =
      result.response.status === 200
        ? ""
        : await result.response.clone().text();
    expect(result.response.status, failureText).toBe(200);
    const evidence = await readTextEvidence(result.response, [
      tokenStart,
      tokenEnd,
      proxyReference(customTarget),
      proxyReference(lateTarget),
      customTarget,
      lateTarget,
      "END-UNQUOTED-CUSTOM-PROPERTY",
    ]);
    expect(evidence.found.get(tokenStart)).toBe(true);
    expect(evidence.found.get(tokenEnd)).toBe(true);
    expect(evidence.found.get(proxyReference(customTarget))).toBe(true);
    expect(evidence.found.get(proxyReference(lateTarget))).toBe(true);
    expect(evidence.found.get(customTarget)).toBe(false);
    expect(evidence.found.get(lateTarget)).toBe(false);
    expect(evidence.found.get("END-UNQUOTED-CUSTOM-PROPERTY")).toBe(true);
    expect(evidence.maxChunkBytes).toBeLessThanOrEqual(
      MAX_FIRST_OUTPUT_WORK_BYTES,
    );
    expect(result.spoolTelemetry.disposeCalls).toBe(1);
  });

  it("keeps a long safe CSS URL bounded when its scheme, escape, and closing delimiters cross spool parts", async () => {
    const partBytes = EXTERNAL_REWRITE_SPOOL_PART_BYTES;
    const declaration = '.inline{background-image:url("';
    const leadLength = partBytes - 2 - declaration.length;
    const lead = `/*${"p".repeat(leadLength - 4)}*/`;
    let prefix = `${lead}${declaration}data:`;
    prefix += "a".repeat(2 * partBytes - 1 - prefix.length);
    prefix += "\\A";
    prefix += "b".repeat(3 * partBytes - 1 - prefix.length);
    prefix += '")}.after{background-image:url("./after-boundaries.png")}';

    expect(prefix.indexOf("data:")).toBe(partBytes - 2);
    expect(prefix.indexOf("\\A")).toBe(2 * partBytes - 1);
    expect(prefix.indexOf('")}')).toBe(3 * partBytes - 1);

    const target = "https://origin.example.com/assets/css/after-boundaries.png";
    const result = await rewriteFixture({
      contentLength: "missing",
      kind: "css",
      prefix,
      suffix: "/*END-SPOOL-BOUNDARY-TOKENS*/",
      totalBytes: 32 * MIB,
    });

    const failureText =
      result.response.status === 200
        ? ""
        : await result.response.clone().text();
    expect(result.response.status, failureText).toBe(200);
    const evidence = await readTextEvidence(result.response, [
      "data:",
      "\\A",
      proxyReference(target),
      "./after-boundaries.png",
      "END-SPOOL-BOUNDARY-TOKENS",
    ]);
    expect(evidence.found.get("data:")).toBe(true);
    expect(evidence.found.get("\\A")).toBe(true);
    expect(evidence.found.get(proxyReference(target))).toBe(true);
    expect(evidence.found.get("./after-boundaries.png")).toBe(false);
    expect(evidence.found.get("END-SPOOL-BOUNDARY-TOKENS")).toBe(true);
    expect(evidence.maxChunkBytes).toBeLessThanOrEqual(
      MAX_FIRST_OUTPUT_WORK_BYTES,
    );
    expect(result.spoolTelemetry.disposeCalls).toBe(1);
  });

  it("fails closed instead of streaming an oversized ambiguous or HTTP CSS URL raw", async () => {
    for (const value of [
      `https://cdn.example.com/${"h".repeat(9 * MIB)}`,
      `${"r".repeat(9 * MIB)}.png`,
    ]) {
      const rawMarker = "RAW-OVERSIZED-CSS-URL";
      const result = await rewriteFixture({
        contentLength: "missing",
        kind: "css",
        prefix: `.unsafe{background:url("${value}${rawMarker}")}`,
        suffix: ".late{background:url(./must-not-escape.png)}",
        totalBytes: 17 * MIB,
      });

      expect(result.response.status).toBe(502);
      expect(await result.response.text()).not.toContain(rawMarker);
      expect(result.spoolTelemetry.disposeCalls).toBe(1);
    }
  });

  it("does not let a giant unrelated HTML attribute interfere with rewriting a later source", async () => {
    const target =
      "https://origin.example.com/releases/current/images/after-state.png";
    const result = await rewriteFixture({
      contentLength: "missing",
      kind: "html",
      prefix: `<html><body><div data-state="GIANT-STATE-START${"s".repeat(MIB)}GIANT-STATE-END"></div>`,
      suffix: '<img src="images/after-state.png">END-GIANT-STATE</body></html>',
      totalBytes: 17 * MIB,
    });

    const failureText =
      result.response.status === 200
        ? ""
        : await result.response.clone().text();
    expect(result.response.status, failureText).toBe(200);
    const evidence = await readTextEvidence(result.response, [
      "GIANT-STATE-START",
      "GIANT-STATE-END",
      proxyReference(target),
      'src="images/after-state.png"',
      "END-GIANT-STATE",
    ]);
    expect(evidence.found.get("GIANT-STATE-START")).toBe(true);
    expect(evidence.found.get("GIANT-STATE-END")).toBe(true);
    expect(evidence.found.get(proxyReference(target))).toBe(true);
    expect(evidence.found.get('src="images/after-state.png"')).toBe(false);
    expect(evidence.found.get("END-GIANT-STATE")).toBe(true);
    expect(result.spoolTelemetry.disposeCalls).toBe(1);
  });

  it("preserves literal raw-text CSS characters in large HTML while rewriting a later style asset", async () => {
    const target =
      "https://origin.example.com/releases/current/images/style-late.png";
    const literal = 'content:"<&>"';
    const dataMarker = "<svg>&probe</svg>";
    const result = await rewriteFixture({
      contentLength: "missing",
      kind: "html",
      prefix: `<html><head><style>.literal::before{${literal}}.inline{background:url("data:image/svg+xml,${dataMarker}")}`,
      suffix:
        '.late{background:url("images/style-late.png")}</style></head><body>END-STYLE-LITERALS</body></html>',
      totalBytes: EXTERNAL_REWRITE_FAST_PATH_BYTES + 1,
    });

    const failureText =
      result.response.status === 200
        ? ""
        : await result.response.clone().text();
    expect(result.response.status, failureText).toBe(200);
    const evidence = await readTextEvidence(result.response, [
      literal,
      dataMarker,
      proxyReference(target),
      "&lt;",
      "&amp;probe",
      "END-STYLE-LITERALS",
    ]);
    expect(evidence.found.get(literal)).toBe(true);
    expect(evidence.found.get(dataMarker)).toBe(true);
    expect(evidence.found.get(proxyReference(target))).toBe(true);
    expect(evidence.found.get("&lt;")).toBe(false);
    expect(evidence.found.get("&amp;probe")).toBe(false);
    expect(evidence.found.get("END-STYLE-LITERALS")).toBe(true);
    expect(result.spoolTelemetry.disposeCalls).toBe(1);
  });

  it("fails closed on oversized HTML style, srcdoc, and srcset attributes", async () => {
    for (const attribute of [
      `style="--payload:${"a".repeat(EXTERNAL_REWRITE_MAX_HTML_ATTRIBUTE_CHARS)}RAW-LONG-STYLE"`,
      `srcdoc="${"b".repeat(EXTERNAL_REWRITE_MAX_HTML_ATTRIBUTE_CHARS)}RAW-LONG-SRCDOC"`,
      `srcset="${"c".repeat(EXTERNAL_REWRITE_MAX_HTML_ATTRIBUTE_CHARS)}RAW-LONG-SRCSET"`,
    ]) {
      const result = await rewriteFixture({
        contentLength: "missing",
        kind: "html",
        prefix: `<html><body><iframe ${attribute}></iframe>`,
        suffix: "RAW-ATTRIBUTE-TAIL</body></html>",
        totalBytes: 10 * MIB,
      });

      expect(result.response.status).toBe(502);
      const failure = await result.response.text();
      expect(failure).not.toContain("RAW-LONG-");
      expect(failure).not.toContain("RAW-ATTRIBUTE-TAIL");
      expect(result.spoolTelemetry.disposeCalls).toBe(1);
    }
  });

  it("preserves bodyless 204, 205, and 304 external text responses instead of manufacturing a rewrite error body", async () => {
    for (const status of [204, 205, 304]) {
      const spool = fakeSpoolStore();
      const response = await rewriteExternalTextResponse({
        kind: "css",
        projectId: "project-large-import",
        proxyUrlFor: async (target) => proxyReference(target),
        response: new Response(null, {
          status,
          headers: {
            "content-type": "text/css; charset=utf-8",
            etag: '"bodyless"',
          },
        }),
        rewriteCssText: async (css, sourceUrl, scopedProxyUrlFor) =>
          rewriteExternalCssReferences({
            css,
            proxyUrlFor: scopedProxyUrlFor,
            sourceUrl,
          }),
        sourceUrl: "https://origin.example.com/assets/app.css",
        spoolStore: spool.store,
      });

      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(response.headers.get("etag")).toBe('"bodyless"');
      expect(spool.telemetry.createCalls).toBe(0);
    }
  });

  it("rejects a partial 206 HTML/CSS response without returning incomplete raw text", async () => {
    const source = exactTextBody({
      prefix: '/*RAW-PARTIAL*/.hero{background:url("hero.png")}',
      suffix: "",
      totalBytes: 1024,
    });
    const spool = fakeSpoolStore();
    const response = await rewriteExternalTextResponse({
      kind: "css",
      projectId: "project-large-import",
      proxyUrlFor: async (target) => proxyReference(target),
      response: new Response(source.body, {
        status: 206,
        headers: {
          "content-range": "bytes 0-1023/4096",
          "content-type": "text/css; charset=utf-8",
        },
      }),
      rewriteCssText: async (css, sourceUrl, scopedProxyUrlFor) =>
        rewriteExternalCssReferences({
          css,
          proxyUrlFor: scopedProxyUrlFor,
          sourceUrl,
        }),
      sourceUrl: "https://origin.example.com/assets/app.css",
      spoolStore: spool.store,
    });

    expect(response.status).toBe(502);
    expect(response.headers.get("content-range")).toBeNull();
    expect(await response.text()).not.toContain("RAW-PARTIAL");
    expect(spool.telemetry.createCalls).toBe(0);
  });

  it("rejects actual bytes as soon as they cross 64 MiB, cancels the unread upstream tail, and never returns raw HTML", async () => {
    const totalBytes = EXTERNAL_REWRITE_CIRCUIT_BREAKER_BYTES + MIB;
    const streamed = streamedTextResponse({
      contentLength: 1,
      kind: "html",
      prefix: '<!doctype html><base href="/static/"><body>RAW-BOUNDARY-START',
      suffix: '<img src="late.png">RAW-BOUNDARY-END</body>',
      totalBytes,
    });
    const spool = fakeSpoolStore();
    const proxyUrlFor = async (target: string) => proxyReference(target);
    const response = await rewriteExternalTextResponse({
      kind: "html",
      projectId: "project-large-import",
      proxyUrlFor,
      response: streamed.response,
      rewriteCssText: async (css, sourceUrl) =>
        rewriteExternalCssReferences({ css, proxyUrlFor, sourceUrl }),
      rewriteHtmlText: async (html, sourceUrl) =>
        rewriteExternalHtmlReferences({ html, proxyUrlFor, sourceUrl }),
      sourceUrl: "https://origin.example.com/index.html",
      spoolStore: spool.store,
    });

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const error = await response.text();
    expect(error.toLowerCase()).toMatch(/external|import|rewrite/);
    expect(error.toLowerCase()).toMatch(/large|limit|exceed/);
    expect(error).not.toContain("RAW-BOUNDARY-START");
    expect(error).not.toContain("RAW-BOUNDARY-END");
    expect(streamed.telemetry.pulledBytes).toBeGreaterThan(
      EXTERNAL_REWRITE_CIRCUIT_BREAKER_BYTES,
    );
    expect(streamed.telemetry.pulledBytes).toBeLessThan(totalBytes);
    expect(streamed.telemetry.cancelled).toBe(1);
    expect(spool.telemetry.totalAppendedBytes).toBeLessThanOrEqual(
      EXTERNAL_REWRITE_CIRCUIT_BREAKER_BYTES,
    );
    expect(spool.telemetry.openPasses).toHaveLength(0);
    expect(spool.telemetry.disposeCalls).toBe(1);
  });

  it("disposes staged data exactly once when upstream streaming fails before validation", async () => {
    const streamed = streamedTextResponse({
      contentLength: "missing",
      failAfterBytes: 9 * MIB,
      kind: "css",
      prefix: '/*RAW-ERROR-START*/@import "theme.css";',
      suffix: "/*RAW-ERROR-END*/",
      totalBytes: 16 * MIB,
    });
    const spool = fakeSpoolStore();
    const proxyUrlFor = async (target: string) => proxyReference(target);
    const response = await rewriteExternalTextResponse({
      kind: "css",
      projectId: "project-large-import",
      proxyUrlFor,
      response: streamed.response,
      rewriteCssText: async (css, sourceUrl) =>
        rewriteExternalCssReferences({ css, proxyUrlFor, sourceUrl }),
      sourceUrl: "https://origin.example.com/assets/app.css",
      spoolStore: spool.store,
    });

    expect(response.status).toBe(502);
    const error = await response.text();
    expect(error).not.toContain("RAW-ERROR-START");
    expect(error).not.toContain("RAW-ERROR-END");
    expect(spool.telemetry.openPasses).toHaveLength(0);
    expect(spool.telemetry.disposeCalls).toBe(1);
  });

  it("cancels the transform pass and disposes staged data once when the downstream response is abandoned", async () => {
    const result = await rewriteFixture({
      contentLength: "missing",
      kind: "css",
      prefix: '@import "theme.css";/*CANCEL-START*/',
      suffix: '.late{background:url("late.png")}/*CANCEL-END*/',
      totalBytes: 16 * MIB,
    });
    const failureText =
      result.response.status === 200
        ? ""
        : await result.response.clone().text();
    expect(result.response.status, failureText).toBe(200);
    const reader = result.response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    const transform = latestTransformPass(result.spoolTelemetry);
    expect(transform.pulledBytes).toBeLessThanOrEqual(
      MAX_FIRST_OUTPUT_WORK_BYTES,
    );
    await reader.cancel("consumer abandoned large import");

    expect(transform.cancelled).toBe(1);
    expect(result.spoolTelemetry.disposeCalls).toBe(1);
  });
});
