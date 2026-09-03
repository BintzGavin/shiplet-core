export const EXTERNAL_REWRITE_FAST_PATH_BYTES = 8 * 1024 * 1024;
export const EXTERNAL_REWRITE_SPOOL_PART_BYTES = 8 * 1024 * 1024;
export const EXTERNAL_REWRITE_CIRCUIT_BREAKER_BYTES = 64 * 1024 * 1024;
// Ambiguous or network-bearing CSS tokens remain bounded and fail closed.
// Confirmed non-network strings and URL values stream through separately, so
// this is not a product-size ceiling for valid inlined assets or custom data.
export const EXTERNAL_REWRITE_MAX_CSS_SEGMENT_CHARS =
  EXTERNAL_REWRITE_FAST_PATH_BYTES;
// Native HTMLRewriter materializes an attribute before invoking handlers.
// Embedded text and candidate-list attributes therefore keep an explicit
// per-attribute safety boundary independent of the response body limit.
export const EXTERNAL_REWRITE_MAX_HTML_ATTRIBUTE_CHARS =
  EXTERNAL_REWRITE_FAST_PATH_BYTES;

const EXTERNAL_REWRITE_CSS_PASSTHROUGH_CHARS = 256 * 1024;

export type ExternalRewriteContentKind = "html" | "css";
export type ExternalResourceUrlBuilder = (targetUrl: string) => Promise<string>;

export interface ExternalRewriteSpool {
  append(part: Uint8Array): Promise<void>;
  complete(): Promise<void>;
  open(): Promise<ReadableStream<Uint8Array>>;
  dispose(): Promise<void>;
}

export interface ExternalRewriteSpoolStore {
  create(input: {
    projectId: string;
    contentType: ExternalRewriteContentKind;
  }): Promise<ExternalRewriteSpool>;
}

export type ExternalTextRewriteInput = {
  response: Response;
  kind: ExternalRewriteContentKind;
  sourceUrl: string;
  projectId: string;
  proxyUrlFor: ExternalResourceUrlBuilder;
  spoolStore: ExternalRewriteSpoolStore;
  rewriteHtmlText?: (
    html: string,
    sourceUrl: string,
    proxyUrlFor: ExternalResourceUrlBuilder,
  ) => Promise<string>;
  rewriteCssText: (
    css: string,
    sourceUrl: string,
    proxyUrlFor: ExternalResourceUrlBuilder,
  ) => Promise<string>;
  htmlHeadEndContent?: string;
  waitUntil?: (promise: Promise<unknown>) => void;
};

const MAX_EXTERNAL_REWRITE_REFERENCES = 4_096;
const MAX_EXTERNAL_REWRITE_URL_CHARS = 8_192;
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const URL_ATTRIBUTES = new Set([
  "action",
  "data",
  "formaction",
  "href",
  "poster",
  "src",
  "xlink:href",
]);

type StagedExternalText =
  | { kind: "small"; bytes: Uint8Array }
  | { kind: "spooled"; spool: ExternalRewriteSpool };

function rewrittenResponseHeaders(
  response: Response,
  kind: ExternalRewriteContentKind,
) {
  const headers = new Headers(response.headers);
  for (const name of [
    "accept-ranges",
    "content-encoding",
    "content-length",
    "content-md5",
    "content-range",
    "digest",
    "etag",
    "last-modified",
  ]) {
    headers.delete(name);
  }
  if (!headers.has("content-type")) {
    headers.set(
      "content-type",
      kind === "html" ? "text/html; charset=utf-8" : "text/css; charset=utf-8",
    );
  }
  return headers;
}

function externalRewriteFailureResponse(message: string) {
  return new Response(message, {
    status: 502,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "text/plain; charset=utf-8",
      "referrer-policy": "no-referrer",
    },
  });
}

function concatenateBytes(chunks: Uint8Array[], totalBytes: number) {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function stageExternalText(
  response: Response,
  input: ExternalTextRewriteInput,
): Promise<StagedExternalText> {
  if (!response.body) return { kind: "small", bytes: new Uint8Array() };

  const reader = response.body.getReader();
  const pendingChunks: Uint8Array[] = [];
  let pendingBytes = 0;
  let totalBytes = 0;
  let spool: ExternalRewriteSpool | null = null;

  const flushPart = async (force: boolean) => {
    if (!spool) return;
    while (
      pendingBytes >= EXTERNAL_REWRITE_SPOOL_PART_BYTES ||
      (force && pendingBytes > 0)
    ) {
      const partBytes = Math.min(
        pendingBytes,
        EXTERNAL_REWRITE_SPOOL_PART_BYTES,
      );
      const part = new Uint8Array(partBytes);
      let offset = 0;
      while (offset < partBytes) {
        const first = pendingChunks[0];
        const take = Math.min(first.byteLength, partBytes - offset);
        part.set(first.subarray(0, take), offset);
        offset += take;
        if (take === first.byteLength) pendingChunks.shift();
        else pendingChunks[0] = first.subarray(take);
      }
      pendingBytes -= partBytes;
      await spool.append(part);
    }
  };

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!result.value || result.value.byteLength === 0) continue;
      if (
        result.value.byteLength >
        EXTERNAL_REWRITE_CIRCUIT_BREAKER_BYTES - totalBytes
      ) {
        throw new RangeError(
          "External text response exceeds the rewrite safety limit",
        );
      }
      pendingChunks.push(result.value);
      pendingBytes += result.value.byteLength;
      totalBytes += result.value.byteLength;

      if (!spool && totalBytes > EXTERNAL_REWRITE_FAST_PATH_BYTES) {
        spool = await input.spoolStore.create({
          projectId: input.projectId,
          contentType: input.kind,
        });
      }
      if (spool) await flushPart(false);
    }
    if (!spool) {
      return {
        kind: "small",
        bytes: concatenateBytes(pendingChunks, pendingBytes),
      };
    }
    await flushPart(true);
    await spool.complete();
    return { kind: "spooled", spool };
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Best effort; the original error is authoritative.
    }
    await spool?.dispose().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function resolveRewritableUrl(value: string, baseUrl: string) {
  if (value.length > MAX_EXTERNAL_REWRITE_URL_CHARS) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  try {
    const target = new URL(trimmed, baseUrl);
    return target.protocol === "http:" || target.protocol === "https:"
      ? target.toString()
      : null;
  } catch {
    return null;
  }
}

type ExternalRewriteReferenceState = {
  exceeded: boolean;
  references: number;
};

function countedProxyUrlFor(
  proxyUrlFor: ExternalResourceUrlBuilder,
  state: ExternalRewriteReferenceState,
): ExternalResourceUrlBuilder {
  return (targetUrl) => {
    state.references += 1;
    if (state.references > MAX_EXTERNAL_REWRITE_REFERENCES) {
      state.exceeded = true;
      // Validation output is discarded. Resolve a same-origin placeholder so
      // nested async parser callbacks can finish without surfacing a transient
      // unhandled rejection; the shared budget is asserted immediately after
      // the validation pass and before any response bytes are released.
      return Promise.resolve("/__shiplet/external-reference-limit__");
    }
    return proxyUrlFor(targetUrl);
  };
}

function assertReferenceBudget(state: ExternalRewriteReferenceState) {
  if (state.exceeded) {
    throw new RangeError("External text response has too many references");
  }
}

async function rewriteSrcset(
  value: string,
  baseUrl: string,
  proxyUrlFor: ExternalResourceUrlBuilder,
) {
  if (value.length > EXTERNAL_REWRITE_MAX_HTML_ATTRIBUTE_CHARS) {
    throw new RangeError("External HTML srcset attribute is too large");
  }
  const candidates: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (
      index < value.length &&
      (value[index] === "," || /\s/.test(value[index]))
    ) {
      index += 1;
    }
    if (index >= value.length) break;
    const start = index;
    while (index < value.length && !/\s/.test(value[index])) index += 1;
    let url = value.slice(start, index);
    const separated = /,+$/.test(url);
    if (separated) url = url.replace(/,+$/, "");
    let descriptor = "";
    if (!separated) {
      while (/\s/.test(value[index] || "")) index += 1;
      const descriptorStart = index;
      let parentheses = 0;
      while (index < value.length) {
        if (value[index] === "(") parentheses += 1;
        else if (value[index] === ")" && parentheses > 0) parentheses -= 1;
        else if (value[index] === "," && parentheses === 0) break;
        index += 1;
      }
      descriptor = value.slice(descriptorStart, index).trim();
      if (value[index] === ",") index += 1;
    }
    if (!url) continue;
    const target = resolveRewritableUrl(url, baseUrl);
    const rewritten = target ? await proxyUrlFor(target) : url;
    candidates.push(descriptor ? `${rewritten} ${descriptor}` : rewritten);
  }
  return candidates.join(", ");
}

function injectSmallHtmlContent(html: string, content: string) {
  if (!content) return html;
  const headEnd = html.search(/<\/head\s*>/i);
  if (headEnd >= 0)
    return `${html.slice(0, headEnd)}${content}${html.slice(headEnd)}`;
  const bodyStart = html.search(/<body(?:\s[^>]*)?>/i);
  if (bodyStart >= 0) {
    return `${html.slice(0, bodyStart)}${content}${html.slice(bodyStart)}`;
  }
  return `${content}${html}`;
}

function cssUrlFunctionStartBefore(source: string, openingParenthesis: number) {
  const start = openingParenthesis - 3;
  if (
    start < 0 ||
    source.slice(start, openingParenthesis).toLowerCase() !== "url"
  ) {
    return null;
  }
  const previous = source[start - 1];
  return previous && /[A-Za-z0-9_-]/.test(previous) ? null : start;
}

function cssPrefixCouldStartAtRule(source: string) {
  let index = 0;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return true;
      index = end + 2;
      continue;
    }
    return source[index] === "@";
  }
  return false;
}

function isConfirmedNonNetworkCssUrlPrefix(source: string) {
  let value = source.trimStart();
  if (value[0] === '"' || value[0] === "'") {
    value = value.slice(1).trimStart();
  }
  return value.startsWith("#") || /^(?:data|blob):/i.test(value);
}

function simpleCustomPropertyIdentifierValueStart(source: string) {
  const declaration = /^\s*--[-_A-Za-z0-9]+\s*:\s*/.exec(source);
  if (!declaration) return null;
  return /^[-_A-Za-z0-9]+$/.test(source.slice(declaration[0].length))
    ? declaration[0].length
    : null;
}

function isSimpleCssIdentifierContinuation(value: string) {
  return /^[-_A-Za-z0-9]$/.test(value);
}

class CssSegmentAccumulator {
  private buffer = "";
  private index = 0;
  private quote = "";
  private inComment = false;
  private commentIsRaw = false;
  private escaped = false;
  private parentheses = 0;
  private brackets = 0;
  private bufferHasNonWhitespace = false;
  private quoteStart = -1;
  private quoteCanStream = false;
  private activeUrl: {
    depth: number;
    start: number;
    valueStart: number;
  } | null = null;
  private passthrough:
    | { kind: "string" }
    | { kind: "url"; depth: number }
    | { kind: "identifier" }
    | null = null;

  private retainFrom(index: number) {
    this.buffer = this.buffer.slice(index);
    this.index = 0;
    // The retained suffix has not been scanned yet. Its lexical state must be
    // derived as the scanner advances, not from future characters.
    this.bufferHasNonWhitespace = false;
  }

  private startPassthrough(
    segments: Array<{ text: string; rewrite: boolean }>,
    start: number,
    passthrough: NonNullable<CssSegmentAccumulator["passthrough"]>,
  ) {
    if (start > 0) {
      segments.push({ text: this.buffer.slice(0, start), rewrite: true });
    }
    if (this.index > start) {
      segments.push({
        text: this.buffer.slice(start, this.index),
        rewrite: false,
      });
    }
    this.buffer = this.buffer.slice(this.index);
    this.index = 0;
    this.bufferHasNonWhitespace = false;
    this.quoteStart = -1;
    this.quoteCanStream = false;
    this.activeUrl = null;
    this.passthrough = passthrough;
  }

  private flushPassthrough(
    segments: Array<{ text: string; rewrite: boolean }>,
  ) {
    if (this.index > 0) {
      segments.push({
        text: this.buffer.slice(0, this.index),
        rewrite: false,
      });
      this.retainFrom(this.index);
    }
  }

  push(value: string, final = false) {
    this.buffer += value;
    const segments: Array<{ text: string; rewrite: boolean }> = [];
    while (this.index < this.buffer.length) {
      const current = this.buffer[this.index];
      const next = this.buffer[this.index + 1];
      const quoteBefore = this.quote;
      if (this.passthrough?.kind === "identifier") {
        if (isSimpleCssIdentifierContinuation(current)) {
          this.index += 1;
          if (this.index >= EXTERNAL_REWRITE_CSS_PASSTHROUGH_CHARS) {
            this.flushPassthrough(segments);
          }
          continue;
        }
        // Stop before the first non-identifier byte. Delimiters, whitespace,
        // functions, and later URL candidates return to the full scanner.
        this.flushPassthrough(segments);
        this.passthrough = null;
        continue;
      }
      if (this.inComment) {
        // Keep a possible comment terminator intact until the next replay
        // chunk arrives. Consuming the trailing `*` here would make a split
        // `*/` invisible and leave every following declaration inside the
        // comment.
        if (current === "*" && next === undefined && !final) break;
        if (current === "*" && next === "/") {
          this.index += 2;
          this.inComment = false;
          if (this.commentIsRaw) {
            segments.push({
              text: this.buffer.slice(0, this.index),
              rewrite: false,
            });
            this.retainFrom(this.index);
          }
          this.commentIsRaw = false;
          continue;
        }
        this.index += 1;
        if (
          this.index > EXTERNAL_REWRITE_CSS_PASSTHROUGH_CHARS &&
          this.commentIsRaw &&
          this.parentheses === 0 &&
          this.brackets === 0
        ) {
          const flushEnd = Math.max(0, this.index - 2);
          segments.push({
            text: this.buffer.slice(0, flushEnd),
            rewrite: false,
          });
          this.retainFrom(flushEnd);
        }
        continue;
      }
      if (this.quote) {
        if (this.escaped) this.escaped = false;
        else if (current === "\\") this.escaped = true;
        else if (current === this.quote) this.quote = "";
        this.index += 1;
      } else if (current === "/" && next === undefined && !final) {
        // A comment opener may also straddle replay chunks.
        break;
      } else if (current === "/" && next === "*") {
        this.commentIsRaw =
          this.parentheses === 0 &&
          this.brackets === 0 &&
          !this.bufferHasNonWhitespace;
        this.bufferHasNonWhitespace = true;
        this.inComment = true;
        this.index += 2;
      } else if (current === '"' || current === "'") {
        this.bufferHasNonWhitespace = true;
        this.quoteStart = this.index;
        this.quoteCanStream =
          this.activeUrl === null &&
          this.parentheses === 0 &&
          !cssPrefixCouldStartAtRule(this.buffer.slice(0, this.index));
        this.quote = current;
        this.index += 1;
      } else if (current === "\\") {
        this.bufferHasNonWhitespace = true;
        if (next === undefined && !final) break;
        this.index += Math.min(2, this.buffer.length - this.index);
      } else {
        if (!/\s/.test(current)) this.bufferHasNonWhitespace = true;
        if (current === "(") {
          this.parentheses += 1;
          const urlStart = cssUrlFunctionStartBefore(this.buffer, this.index);
          if (urlStart !== null) {
            this.activeUrl = {
              depth: this.parentheses,
              start: urlStart,
              valueStart: this.index + 1,
            };
          }
        } else if (current === ")" && this.parentheses > 0) {
          this.parentheses -= 1;
        } else if (current === "[") this.brackets += 1;
        else if (current === "]" && this.brackets > 0) this.brackets -= 1;
        this.index += 1;
        if (
          this.parentheses === 0 &&
          this.brackets === 0 &&
          (current === ";" || current === "{" || current === "}")
        ) {
          segments.push({
            text: this.buffer.slice(0, this.index),
            rewrite: true,
          });
          this.retainFrom(this.index);
          this.activeUrl = null;
          this.quoteStart = -1;
          this.quoteCanStream = false;
        }
      }

      if (this.passthrough) {
        const finished =
          (this.passthrough.kind === "string" &&
            Boolean(quoteBefore) &&
            !this.quote) ||
          (this.passthrough.kind === "url" &&
            this.parentheses < this.passthrough.depth);
        if (finished || this.index >= EXTERNAL_REWRITE_CSS_PASSTHROUGH_CHARS) {
          this.flushPassthrough(segments);
        }
        if (finished) this.passthrough = null;
        continue;
      }

      if (
        this.index === EXTERNAL_REWRITE_CSS_PASSTHROUGH_CHARS &&
        !this.inComment &&
        !this.quote &&
        this.parentheses === 0 &&
        this.brackets === 0
      ) {
        const valueStart = simpleCustomPropertyIdentifierValueStart(
          this.buffer.slice(0, this.index),
        );
        if (valueStart !== null) {
          this.startPassthrough(segments, valueStart, { kind: "identifier" });
          continue;
        }
      }

      if (
        this.activeUrl &&
        this.activeUrl.depth === 1 &&
        this.parentheses >= this.activeUrl.depth &&
        this.index - this.activeUrl.valueStart <= 128 &&
        isConfirmedNonNetworkCssUrlPrefix(
          this.buffer.slice(this.activeUrl.valueStart, this.index),
        )
      ) {
        const activeUrl = this.activeUrl;
        this.startPassthrough(segments, activeUrl.start, {
          kind: "url",
          depth: activeUrl.depth,
        });
        continue;
      }
      if (this.activeUrl && this.parentheses < this.activeUrl.depth) {
        this.activeUrl = null;
      }
      if (
        this.quote &&
        this.quoteCanStream &&
        this.quoteStart >= 0 &&
        this.index - this.quoteStart >= EXTERNAL_REWRITE_CSS_PASSTHROUGH_CHARS
      ) {
        this.startPassthrough(segments, this.quoteStart, { kind: "string" });
        continue;
      }
      if (quoteBefore && !this.quote) {
        this.quoteStart = -1;
        this.quoteCanStream = false;
      }
      if (
        !this.inComment &&
        !this.quote &&
        this.parentheses === 0 &&
        this.brackets === 0 &&
        this.index >= 64 * 1024 &&
        !this.bufferHasNonWhitespace
      ) {
        segments.push({
          text: this.buffer.slice(0, this.index),
          rewrite: false,
        });
        this.retainFrom(this.index);
      }
      if (this.index > EXTERNAL_REWRITE_MAX_CSS_SEGMENT_CHARS) {
        throw new RangeError(
          "External stylesheet contains an oversized lexical segment",
        );
      }
    }
    if (final && this.buffer) {
      segments.push({
        text: this.buffer,
        rewrite: !this.inComment && this.passthrough === null,
      });
    }
    if (final) {
      this.buffer = "";
      this.index = 0;
      this.quote = "";
      this.inComment = false;
      this.commentIsRaw = false;
      this.escaped = false;
      this.parentheses = 0;
      this.brackets = 0;
      this.bufferHasNonWhitespace = false;
      this.quoteStart = -1;
      this.quoteCanStream = false;
      this.activeUrl = null;
      this.passthrough = null;
    }
    return segments;
  }
}

async function processCssStream(input: {
  stream: ReadableStream<Uint8Array>;
  sourceUrl: string;
  rewriteCssText: ExternalTextRewriteInput["rewriteCssText"];
  proxyUrlFor: ExternalResourceUrlBuilder;
  emit?: (value: Uint8Array) => void;
}) {
  const reader = input.stream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const segments = new CssSegmentAccumulator();
  const processSegments = async (
    values: Array<{ text: string; rewrite: boolean }>,
  ) => {
    for (const value of values) {
      const rewritten = value.rewrite
        ? await input.rewriteCssText(
            value.text,
            input.sourceUrl,
            input.proxyUrlFor,
          )
        : value.text;
      if (input.emit && rewritten) input.emit(encoder.encode(rewritten));
    }
  };
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      await processSegments(
        segments.push(decoder.decode(result.value, { stream: true })),
      );
    }
    await processSegments(segments.push(decoder.decode(), true));
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The rewrite failure is authoritative; source cancellation is cleanup.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function validateLargeCss(
  spool: ExternalRewriteSpool,
  input: ExternalTextRewriteInput,
) {
  const referenceState: ExternalRewriteReferenceState = {
    exceeded: false,
    references: 0,
  };
  await processCssStream({
    stream: await spool.open(),
    sourceUrl: input.sourceUrl,
    rewriteCssText: input.rewriteCssText,
    proxyUrlFor: countedProxyUrlFor(input.proxyUrlFor, referenceState),
  });
  assertReferenceBudget(referenceState);
}

function largeCssResponseBody(
  spool: ExternalRewriteSpool,
  input: ExternalTextRewriteInput,
) {
  const referenceState: ExternalRewriteReferenceState = {
    exceeded: false,
    references: 0,
  };
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const segments = new CssSegmentAccumulator();
  const pending: Uint8Array[] = [];
  let sourceReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let sourceReaderPromise: Promise<
    ReadableStreamDefaultReader<Uint8Array>
  > | null = null;
  let sourceDone = false;
  let cancelled = false;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const promise = spool.dispose();
    if (input.waitUntil) input.waitUntil(promise);
    else void promise.catch(() => undefined);
  };
  const getSourceReader = () => {
    sourceReaderPromise ??= spool.open().then((stream) => {
      sourceReader = stream.getReader();
      return sourceReader;
    });
    return sourceReaderPromise;
  };
  const releaseSourceReader = (
    active: ReadableStreamDefaultReader<Uint8Array>,
  ) => {
    if (sourceReader !== active) return;
    try {
      active.releaseLock();
    } catch {
      // A concurrent downstream cancellation may already release the lock.
    }
    sourceReader = null;
  };
  const rewriteSegments = async (
    values: Array<{ text: string; rewrite: boolean }>,
  ) => {
    for (const value of values) {
      const rewritten = value.rewrite
        ? await input.rewriteCssText(
            value.text,
            input.sourceUrl,
            countedProxyUrlFor(input.proxyUrlFor, referenceState),
          )
        : value.text;
      if (rewritten) pending.push(encoder.encode(rewritten));
    }
  };
  const fillPending = async () => {
    const active = await getSourceReader();
    while (!cancelled && pending.length === 0 && !sourceDone) {
      const result = await active.read();
      if (!result.done) {
        await rewriteSegments(
          segments.push(decoder.decode(result.value, { stream: true })),
        );
        continue;
      }
      sourceDone = true;
      await rewriteSegments(segments.push(decoder.decode(), true));
      releaseSourceReader(active);
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        await fillPending();
        if (cancelled) return;
        const next = pending.shift();
        if (next) {
          controller.enqueue(next);
          return;
        }
        if (sourceDone) {
          controller.close();
          dispose();
        }
      } catch (error) {
        if (!cancelled) controller.error(error);
        dispose();
      }
    },
    async cancel(reason) {
      cancelled = true;
      try {
        const active = await getSourceReader();
        await active.cancel(reason).catch(() => undefined);
        releaseSourceReader(active);
      } finally {
        pending.length = 0;
        dispose();
      }
    },
  });
}

function cleanupResponseStream(
  streamPromise: Promise<ReadableStream<Uint8Array>>,
  spool: ExternalRewriteSpool,
  waitUntil?: (promise: Promise<unknown>) => void,
) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let readerPromise: Promise<ReadableStreamDefaultReader<Uint8Array>> | null =
    null;
  let disposed = false;
  let cancelled = false;
  const activeReader = () => {
    readerPromise ??= streamPromise.then((stream) => {
      reader = stream.getReader();
      return reader;
    });
    return readerPromise;
  };
  const releaseReader = (active: ReadableStreamDefaultReader<Uint8Array>) => {
    if (reader !== active) return;
    try {
      active.releaseLock();
    } catch {
      // A concurrent cancellation may already have released the lock.
    }
    reader = null;
  };
  const isCancellationError = (error: unknown) =>
    error instanceof Error && /\bcancell?ed\b/i.test(error.message);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const promise = spool.dispose();
    if (waitUntil) waitUntil(promise);
    else void promise.catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let active: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        active = await activeReader();
        let readWasCancelled = false;
        const result = await active.read().catch((error: unknown) => {
          if (!isCancellationError(error)) throw error;
          readWasCancelled = true;
          return { done: true as const, value: undefined };
        });
        if (readWasCancelled) {
          cancelled = true;
          releaseReader(active);
          dispose();
          return;
        }
        if (cancelled) return;
        if (!result.done) {
          controller.enqueue(result.value);
          return;
        }
        releaseReader(active);
        controller.close();
        dispose();
      } catch (error) {
        if (isCancellationError(error)) cancelled = true;
        if (!cancelled) controller.error(error);
        dispose();
      }
    },
    async cancel() {
      cancelled = true;
      const active = await activeReader();
      // Workerd's native HTMLRewriter can surface an unhandled internal
      // rejection when its output reader is cancelled. The input is already
      // staged and capped, so finish draining it to a discard sink instead.
      const drain = (async () => {
        try {
          while (!(await active.read()).done) {
            // Discard validated transformed bytes after downstream departure.
          }
        } catch {
          // A transform failure after downstream cancellation is not observable.
        } finally {
          releaseReader(active);
          dispose();
        }
      })();
      if (waitUntil) waitUntil(drain);
      else await drain;
    },
  });
}

const HTML_RAW_TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "textarea",
  "title",
]);

class HtmlAttributeSafetyScanner {
  private state:
    | "data"
    | "tag-open"
    | "tag-name"
    | "before-attribute"
    | "attribute-name"
    | "after-attribute-name"
    | "before-value"
    | "quoted-value"
    | "unquoted-value"
    | "declaration" = "data";
  private closingTag = false;
  private tagName = "";
  private tagNameTruncated = false;
  private attributeName = "";
  private attributeNameTruncated = false;
  private attributeLength = 0;
  private quote = "";
  private declarationPrefix = "";
  private declarationIsComment = false;
  private declarationTail = "";
  private rawTextTag = "";
  private rawTextMatch = 0;

  private appendTagName(value: string) {
    if (this.tagName.length < 32) this.tagName += value.toLowerCase();
    else this.tagNameTruncated = true;
  }

  private appendAttributeName(value: string) {
    if (this.attributeName.length < 32) {
      this.attributeName += value.toLowerCase();
    } else {
      this.attributeNameTruncated = true;
    }
  }

  private beginAttribute(value: string) {
    this.attributeName = "";
    this.attributeNameTruncated = false;
    this.appendAttributeName(value);
    this.state = "attribute-name";
  }

  private beginValue(quote = "") {
    this.attributeLength = 0;
    this.quote = quote;
    this.state = quote ? "quoted-value" : "unquoted-value";
  }

  private countAttributeCharacter() {
    this.attributeLength += 1;
    if (this.attributeLength > EXTERNAL_REWRITE_MAX_HTML_ATTRIBUTE_CHARS) {
      const name = this.attributeNameTruncated
        ? "attribute"
        : `${this.attributeName || "attribute"} attribute`;
      throw new RangeError(`External HTML ${name} is too large`);
    }
  }

  private finishTag() {
    if (
      !this.closingTag &&
      !this.tagNameTruncated &&
      HTML_RAW_TEXT_ELEMENTS.has(this.tagName)
    ) {
      this.rawTextTag = this.tagName;
      this.rawTextMatch = 0;
    }
    this.state = "data";
    this.closingTag = false;
    this.tagName = "";
    this.tagNameTruncated = false;
    this.attributeName = "";
    this.attributeNameTruncated = false;
  }

  private scanRawTextCharacter(value: string) {
    const target = `</${this.rawTextTag}`;
    const normalized = value.toLowerCase();
    if (normalized === target[this.rawTextMatch]) {
      this.rawTextMatch += 1;
      if (this.rawTextMatch === target.length) {
        this.rawTextTag = "";
        this.rawTextMatch = 0;
        this.closingTag = true;
        this.tagName = target.slice(2);
        this.tagNameTruncated = false;
        this.state = "before-attribute";
      }
      return;
    }
    this.rawTextMatch = normalized === "<" ? 1 : 0;
  }

  push(value: string) {
    for (const current of value) {
      if (this.rawTextTag) {
        this.scanRawTextCharacter(current);
        continue;
      }
      if (this.state === "data") {
        if (current === "<") this.state = "tag-open";
        continue;
      }
      if (this.state === "tag-open") {
        if (current === "!") {
          this.state = "declaration";
          this.declarationPrefix = "";
          this.declarationIsComment = false;
          this.declarationTail = "";
        } else if (current === "?") {
          this.state = "declaration";
          this.declarationPrefix = "?";
          this.declarationIsComment = false;
          this.declarationTail = "";
        } else if (current === "/") {
          this.closingTag = true;
          this.tagName = "";
          this.tagNameTruncated = false;
          this.state = "tag-name";
        } else if (/[A-Za-z]/.test(current)) {
          this.closingTag = false;
          this.tagName = "";
          this.tagNameTruncated = false;
          this.appendTagName(current);
          this.state = "tag-name";
        } else {
          this.state = "data";
        }
        continue;
      }
      if (this.state === "declaration") {
        this.declarationTail = `${this.declarationTail}${current}`.slice(-3);
        if (this.declarationPrefix.length < 2) {
          this.declarationPrefix += current;
          if (this.declarationPrefix === "--") {
            this.declarationIsComment = true;
          }
        }
        if (
          (this.declarationIsComment && this.declarationTail === "-->") ||
          (!this.declarationIsComment && current === ">")
        ) {
          this.state = "data";
        }
        continue;
      }
      if (this.state === "tag-name") {
        if (/\s/.test(current)) this.state = "before-attribute";
        else if (current === ">") this.finishTag();
        else if (current === "/") this.state = "before-attribute";
        else this.appendTagName(current);
        continue;
      }
      if (this.state === "before-attribute") {
        if (/\s/.test(current) || current === "/") continue;
        if (current === ">") this.finishTag();
        else this.beginAttribute(current);
        continue;
      }
      if (this.state === "attribute-name") {
        if (/\s/.test(current)) this.state = "after-attribute-name";
        else if (current === "=") this.state = "before-value";
        else if (current === ">") this.finishTag();
        else if (current === "/") this.state = "before-attribute";
        else this.appendAttributeName(current);
        continue;
      }
      if (this.state === "after-attribute-name") {
        if (/\s/.test(current)) continue;
        if (current === "=") this.state = "before-value";
        else if (current === ">") this.finishTag();
        else if (current === "/") this.state = "before-attribute";
        else this.beginAttribute(current);
        continue;
      }
      if (this.state === "before-value") {
        if (/\s/.test(current)) continue;
        if (current === '"' || current === "'") this.beginValue(current);
        else if (current === ">") this.finishTag();
        else {
          this.beginValue();
          this.countAttributeCharacter();
        }
        continue;
      }
      if (this.state === "quoted-value") {
        if (current === this.quote) this.state = "before-attribute";
        else this.countAttributeCharacter();
        continue;
      }
      if (this.state === "unquoted-value") {
        if (/\s/.test(current)) this.state = "before-attribute";
        else if (current === ">") this.finishTag();
        else this.countAttributeCharacter();
      }
    }
  }
}

async function validateLargeHtmlAttributeSizes(spool: ExternalRewriteSpool) {
  const stream = await spool.open();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const scanner = new HtmlAttributeSafetyScanner();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      scanner.push(decoder.decode(result.value, { stream: true }));
    }
    scanner.push(decoder.decode());
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

type LargeHtmlMetadata = {
  effectiveBaseUrl: string;
  hasActiveElement: boolean;
  hasHead: boolean;
  hasHtml: boolean;
};

function htmlElementName(element: Element) {
  return element.tagName.toLowerCase();
}

function isHtmlElement(element: Element) {
  return element.namespaceURI === HTML_NAMESPACE;
}

async function drainResponse(response: Response) {
  if (!response.body) return;
  await response.body.pipeTo(
    new WritableStream<Uint8Array>({
      write() {
        // A native HTMLRewriter only invokes handlers while its output drains.
      },
    }),
  );
}

async function scanLargeHtmlMetadata(
  spool: ExternalRewriteSpool,
  input: ExternalTextRewriteInput,
) {
  const metadata: LargeHtmlMetadata = {
    effectiveBaseUrl: input.sourceUrl,
    hasActiveElement: false,
    hasHead: false,
    hasHtml: false,
  };
  let templateDepth = 0;
  let baseChosen = false;
  const rewriter = new HTMLRewriter().on("*", {
    async element(element) {
      const name = htmlElementName(element);
      const htmlElement = isHtmlElement(element);
      const active = htmlElement && templateDepth === 0;
      if (active) {
        metadata.hasActiveElement = true;
        if (name === "html") metadata.hasHtml = true;
        if (name === "head") metadata.hasHead = true;
        if (name === "base" && !baseChosen) {
          const href = element.getAttribute("href");
          if (href === null) return;
          baseChosen = true;
          const target = href
            ? resolveRewritableUrl(href, input.sourceUrl)
            : null;
          if (target) {
            try {
              await input.proxyUrlFor(target);
              metadata.effectiveBaseUrl = target;
            } catch {
              metadata.effectiveBaseUrl = input.sourceUrl;
            }
          }
        }
      }
      if (htmlElement && name === "template") {
        templateDepth += 1;
        element.onEndTag(() => {
          templateDepth = Math.max(0, templateDepth - 1);
        });
      }
    },
  });
  const stream = await spool.open();
  await drainResponse(
    rewriter.transform(
      new Response(stream, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ),
  );
  return metadata;
}

async function rewriteElementAttributes(input: {
  element: Element;
  sourceUrl: string;
  proxyUrlFor: ExternalResourceUrlBuilder;
  rewriteInput: ExternalTextRewriteInput;
  mutate: boolean;
}) {
  if (input.element.getAttribute("integrity") !== null && input.mutate) {
    input.element.removeAttribute("integrity");
  }
  const attributeNames = [
    ...URL_ATTRIBUTES,
    "srcset",
    "imagesrcset",
    "style",
    "srcdoc",
  ];
  for (const name of attributeNames) {
    const value = input.element.getAttribute(name);
    if (value === null) continue;
    let rewritten: string | null = null;
    if (URL_ATTRIBUTES.has(name)) {
      const target = resolveRewritableUrl(value, input.sourceUrl);
      if (target) rewritten = await input.proxyUrlFor(target);
    } else if (name === "srcset" || name === "imagesrcset") {
      rewritten = await rewriteSrcset(
        value,
        input.sourceUrl,
        input.proxyUrlFor,
      );
    } else if (name === "style") {
      if (value.length > EXTERNAL_REWRITE_MAX_HTML_ATTRIBUTE_CHARS) {
        throw new RangeError("External HTML style attribute is too large");
      }
      rewritten = await input.rewriteInput.rewriteCssText(
        value,
        input.sourceUrl,
        input.proxyUrlFor,
      );
    } else if (name === "srcdoc") {
      if (!input.rewriteInput.rewriteHtmlText) {
        throw new TypeError("External HTML fragment rewriting is unavailable");
      }
      if (value.length > EXTERNAL_REWRITE_MAX_HTML_ATTRIBUTE_CHARS) {
        throw new RangeError("External HTML srcdoc attribute is too large");
      }
      rewritten = await input.rewriteInput.rewriteHtmlText(
        value,
        input.sourceUrl,
        input.proxyUrlFor,
      );
    }
    if (input.mutate && rewritten !== null) {
      input.element.setAttribute(name, rewritten);
    }
  }
}

function registerLargeHtmlHandlers(input: {
  rewriter: HTMLRewriter;
  metadata: LargeHtmlMetadata;
  rewriteInput: ExternalTextRewriteInput;
  proxyUrlFor: ExternalResourceUrlBuilder;
  mutate: boolean;
  trustedBaseTag?: string;
}) {
  let templateDepth = 0;
  let injectionComplete = false;
  const styleSegments = new CssSegmentAccumulator();
  const bridge = input.rewriteInput.htmlHeadEndContent || "";
  const headDocument = `${input.trustedBaseTag || ""}${bridge}`;

  input.rewriter.on("*", {
    async element(element) {
      const name = htmlElementName(element);
      const htmlElement = isHtmlElement(element);
      const active = htmlElement && templateDepth === 0;
      if (input.mutate && active && !injectionComplete) {
        if (input.metadata.hasHead && name === "head") {
          if (input.trustedBaseTag) {
            element.prepend(input.trustedBaseTag, { html: true });
          }
          if (bridge) element.append(bridge, { html: true });
          injectionComplete = true;
        } else if (
          !input.metadata.hasHead &&
          input.metadata.hasHtml &&
          name === "html"
        ) {
          element.prepend(`<head>${headDocument}</head>`, { html: true });
          injectionComplete = true;
        } else if (!input.metadata.hasHead && !input.metadata.hasHtml) {
          element.before(`<head>${headDocument}</head>`, { html: true });
          injectionComplete = true;
        }
      }
      if (name === "base") {
        if (active && input.mutate) element.remove();
      } else {
        await rewriteElementAttributes({
          element,
          sourceUrl: input.metadata.effectiveBaseUrl,
          proxyUrlFor: input.proxyUrlFor,
          rewriteInput: input.rewriteInput,
          mutate: input.mutate,
        });
      }
      if (htmlElement && name === "template") {
        templateDepth += 1;
        element.onEndTag(() => {
          templateDepth = Math.max(0, templateDepth - 1);
        });
      }
    },
  });

  input.rewriter.on("style", {
    async text(text) {
      const pieces = styleSegments.push(text.text, text.lastInTextNode);
      let output = "";
      for (const piece of pieces) {
        output += piece.rewrite
          ? await input.rewriteInput.rewriteCssText(
              piece.text,
              input.metadata.effectiveBaseUrl,
              input.proxyUrlFor,
            )
          : piece.text;
      }
      if (!input.mutate) return;
      if (output) text.replace(output, { html: true });
      else text.remove();
    },
  });
}

async function validateLargeHtml(
  spool: ExternalRewriteSpool,
  metadata: LargeHtmlMetadata,
  input: ExternalTextRewriteInput,
) {
  const referenceState: ExternalRewriteReferenceState = {
    exceeded: false,
    references: 0,
  };
  const rewriter = new HTMLRewriter();
  registerLargeHtmlHandlers({
    rewriter,
    metadata,
    rewriteInput: input,
    proxyUrlFor: countedProxyUrlFor(input.proxyUrlFor, referenceState),
    mutate: false,
  });
  await drainResponse(
    rewriter.transform(
      new Response(await spool.open(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ),
  );
  assertReferenceBudget(referenceState);
}

async function largeHtmlResponseBody(
  spool: ExternalRewriteSpool,
  metadata: LargeHtmlMetadata,
  input: ExternalTextRewriteInput,
) {
  const referenceState: ExternalRewriteReferenceState = {
    exceeded: false,
    references: 0,
  };
  const proxyUrlFor = countedProxyUrlFor(input.proxyUrlFor, referenceState);
  const trustedBaseUrl = await input.proxyUrlFor(metadata.effectiveBaseUrl);
  const trustedBaseTag = `<base href="${trustedBaseUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
  const rewriter = new HTMLRewriter();
  registerLargeHtmlHandlers({
    rewriter,
    metadata,
    rewriteInput: input,
    proxyUrlFor,
    mutate: true,
    trustedBaseTag,
  });
  let output = rewriter.transform(
    new Response(await spool.open(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  ).body!;
  if (!metadata.hasActiveElement) {
    const prefix = new TextEncoder().encode(
      `${trustedBaseTag}${input.htmlHeadEndContent || ""}`,
    );
    const source = output;
    let prefixed = false;
    output = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(prefix);
        prefixed = true;
      },
      async pull(controller) {
        const reader = source.getReader();
        try {
          const result = await reader.read();
          if (result.done) controller.close();
          else controller.enqueue(result.value);
        } finally {
          reader.releaseLock();
        }
      },
      async cancel(reason) {
        if (prefixed) await source.cancel(reason);
      },
    }) as unknown as typeof output;
  }
  return cleanupResponseStream(Promise.resolve(output), spool, input.waitUntil);
}

export async function rewriteExternalTextResponse(
  input: ExternalTextRewriteInput,
): Promise<Response> {
  if (
    !input.projectId ||
    !input.sourceUrl ||
    (input.kind !== "html" && input.kind !== "css") ||
    typeof input.proxyUrlFor !== "function" ||
    typeof input.rewriteCssText !== "function" ||
    (input.kind === "html" && typeof input.rewriteHtmlText !== "function")
  ) {
    throw new TypeError("Invalid external text rewrite configuration");
  }

  // Rewriting a byte range would publish a syntactically incomplete HTML or
  // stylesheet response while removing the range metadata that describes it.
  // Fail closed before staging or exposing any of the partial source bytes.
  if (input.response.status === 206) {
    await input.response.body?.cancel().catch(() => undefined);
    return externalRewriteFailureResponse(
      "External partial text response cannot be rewritten safely",
    );
  }

  // Fetch forbids response bodies on these statuses. They contain no text to
  // rewrite, so preserve their status and validators without touching R2.
  if (input.response.body === null) {
    return new Response(null, {
      status: input.response.status,
      statusText: input.response.statusText,
      headers: new Headers(input.response.headers),
    });
  }

  let staged: StagedExternalText;
  try {
    staged = await stageExternalText(input.response, input);
  } catch (error) {
    const message =
      error instanceof RangeError
        ? error.message
        : "External text response could not be staged for rewriting";
    return externalRewriteFailureResponse(message);
  }

  const headers = rewrittenResponseHeaders(input.response, input.kind);
  if (staged.kind === "small") {
    try {
      const text = new TextDecoder().decode(staged.bytes);
      const rewritten =
        input.kind === "html"
          ? injectSmallHtmlContent(
              await input.rewriteHtmlText!(
                text,
                input.sourceUrl,
                input.proxyUrlFor,
              ),
              input.htmlHeadEndContent || "",
            )
          : await input.rewriteCssText(
              text,
              input.sourceUrl,
              input.proxyUrlFor,
            );
      return new Response(rewritten, {
        status: input.response.status,
        statusText: input.response.statusText,
        headers,
      });
    } catch {
      return externalRewriteFailureResponse(
        "External text response could not be rewritten safely",
      );
    }
  }

  try {
    if (input.kind === "css") {
      await validateLargeCss(staged.spool, input);
      return new Response(largeCssResponseBody(staged.spool, input), {
        status: input.response.status,
        statusText: input.response.statusText,
        headers,
      });
    }
    await validateLargeHtmlAttributeSizes(staged.spool);
    const metadata = await scanLargeHtmlMetadata(staged.spool, input);
    await validateLargeHtml(staged.spool, metadata, input);
    return new Response(
      await largeHtmlResponseBody(staged.spool, metadata, input),
      {
        status: input.response.status,
        statusText: input.response.statusText,
        headers,
      },
    );
  } catch (error) {
    await staged.spool.dispose().catch(() => undefined);
    const detail = error instanceof Error ? `: ${error.message}` : "";
    return externalRewriteFailureResponse(
      `External text response could not be rewritten safely${detail}`,
    );
  }
}
