import { parse } from "acorn";

export type RuntimeV1WidgetFile = {
  path: string;
  mediaType: string;
  bytes: Uint8Array;
};

export class UnsupportedWidgetDependencyError extends Error {
  readonly code = "unsupported_widget_dependency";
  readonly path: string;

  constructor(path: string) {
    super(`unsupported_widget_dependency at ${path}`);
    this.name = "UnsupportedWidgetDependencyError";
    this.path = path;
  }
}

type HtmlElement = {
  name: string;
  attributes: Map<string, HtmlAttribute>;
  content: string;
  start: number;
  end: number;
};

type HtmlAttribute = {
  value: string;
  valueStart: number;
  valueEnd: number;
  quote: string;
};

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const JAVASCRIPT_TYPES = new Set([
  "",
  "application/ecmascript",
  "application/javascript",
  "text/ecmascript",
  "text/javascript",
]);

function unsupported(path: string): never {
  throw new UnsupportedWidgetDependencyError(path);
}

function decodeText(file: RuntimeV1WidgetFile) {
  try {
    return utf8Decoder.decode(file.bytes);
  } catch {
    return unsupported(file.path);
  }
}

function parseAttributes(source: string, path: string, sourceOffset: number) {
  const attributes = new Map<string, HtmlAttribute>();
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] || "")) cursor += 1;
    if (cursor >= source.length || source[cursor] === "/") break;
    const nameStart = cursor;
    while (cursor < source.length && !/[\s=/>]/.test(source[cursor])) {
      cursor += 1;
    }
    if (cursor === nameStart) unsupported(path);
    const name = source.slice(nameStart, cursor).toLowerCase();
    while (/\s/.test(source[cursor] || "")) cursor += 1;
    let value = "";
    let valueStart = cursor;
    let valueEnd = cursor;
    let valueQuote = "";
    if (source[cursor] === "=") {
      cursor += 1;
      while (/\s/.test(source[cursor] || "")) cursor += 1;
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        valueQuote = quote;
        cursor += 1;
        valueStart = cursor;
        while (cursor < source.length && source[cursor] !== quote) cursor += 1;
        if (cursor >= source.length) unsupported(path);
        value = source.slice(valueStart, cursor);
        valueEnd = cursor;
        cursor += 1;
      } else {
        valueStart = cursor;
        while (cursor < source.length && !/[\s>]/.test(source[cursor])) {
          cursor += 1;
        }
        value = source.slice(valueStart, cursor);
        valueEnd = cursor;
      }
    }
    if (attributes.has(name)) unsupported(path);
    attributes.set(name, {
      value,
      valueStart: sourceOffset + valueStart,
      valueEnd: sourceOffset + valueEnd,
      quote: valueQuote,
    });
  }
  return attributes;
}

function scanHtml(source: string, path: string) {
  const elements: HtmlElement[] = [];
  const lower = source.toLowerCase();
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open < 0) break;
    if (source.startsWith("<!--", open)) {
      const close = source.indexOf("-->", open + 4);
      if (close < 0) unsupported(path);
      cursor = close + 3;
      continue;
    }
    const marker = source[open + 1] || "";
    if (marker === "/" || marker === "!" || marker === "?") {
      const close = source.indexOf(">", open + 2);
      if (close < 0) unsupported(path);
      cursor = close + 1;
      continue;
    }
    let nameEnd = open + 1;
    while (/[A-Za-z0-9:-]/.test(source[nameEnd] || "")) nameEnd += 1;
    if (nameEnd === open + 1) {
      cursor = open + 1;
      continue;
    }
    const name = source.slice(open + 1, nameEnd).toLowerCase();
    let tagEnd = nameEnd;
    let quote = "";
    for (; tagEnd < source.length; tagEnd += 1) {
      const character = source[tagEnd];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (tagEnd >= source.length || quote) unsupported(path);
    const attributes = parseAttributes(
      source.slice(nameEnd, tagEnd),
      path,
      nameEnd,
    );
    let content = "";
    let elementEnd = tagEnd + 1;
    cursor = tagEnd + 1;
    if (name === "script" || name === "style") {
      const closeStart = lower.indexOf(`</${name}`, cursor);
      if (closeStart < 0) unsupported(path);
      const closeEnd = source.indexOf(">", closeStart + name.length + 2);
      if (closeEnd < 0) unsupported(path);
      content = source.slice(cursor, closeStart);
      cursor = closeEnd + 1;
      elementEnd = cursor;
    }
    elements.push({
      name,
      attributes,
      content,
      start: open,
      end: elementEnd,
    });
  }
  return elements;
}

function walkJavaScript(node: unknown, path: string, seen = new Set<object>()) {
  if (!node || typeof node !== "object") return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) walkJavaScript(child, path, seen);
    return;
  }
  const record = node as Record<string, unknown>;
  if (
    record.type === "Identifier" &&
    (record.name === "Worker" ||
      record.name === "SharedWorker" ||
      record.name === "importScripts")
  ) {
    unsupported(path);
  }
  if (record.type === "ImportExpression" || record.type === "MetaProperty") {
    unsupported(path);
  }
  if (record.type === "NewExpression") {
    const callee = record.callee as Record<string, unknown> | undefined;
    if (
      callee?.type === "Identifier" &&
      (callee.name === "Worker" || callee.name === "SharedWorker")
    ) {
      unsupported(path);
    }
  }
  if (record.type === "CallExpression") {
    const callee = record.callee as Record<string, unknown> | undefined;
    if (callee?.type === "Identifier" && callee.name === "importScripts") {
      unsupported(path);
    }
  }
  for (const child of Object.values(record)) walkJavaScript(child, path, seen);
}

function assertClassicJavaScript(source: string, path: string) {
  let program: unknown;
  try {
    program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowHashBang: true,
    });
  } catch {
    return unsupported(path);
  }
  walkJavaScript(program, path);
}

function assertTerminalCss(source: string, path: string) {
  if (/@import(?:\s|url|["'])/i.test(source)) unsupported(path);
  const urlPattern = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
  for (const match of source.matchAll(urlPattern)) {
    const reference = String(match[2] || "").trim();
    if (!/^(?:data:|blob:|#)/i.test(reference)) unsupported(path);
  }
}

function packageReferencePath(
  reference: string,
  entryPath: string,
  ownerPath: string,
) {
  const value = reference.trim();
  if (!value || value.startsWith("#")) return null;
  if (value.includes("&")) unsupported(ownerPath);
  if (/^(?:data:|blob:)/i.test(value)) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value)) unsupported(ownerPath);
  let resolved: URL;
  try {
    resolved = new URL(value, new URL(entryPath, "https://package.invalid/"));
  } catch {
    return unsupported(ownerPath);
  }
  let path: string;
  try {
    path = decodeURIComponent(resolved.pathname).replace(/^\/+/, "");
  } catch {
    return unsupported(ownerPath);
  }
  const entryDirectory = entryPath.slice(0, entryPath.lastIndexOf("/") + 1);
  if (!path.startsWith(entryDirectory) || !path.startsWith("widget/")) {
    unsupported(ownerPath);
  }
  return path;
}

export function validateRuntimeV1Widget(input: {
  entryPath: string;
  files: RuntimeV1WidgetFile[];
}) {
  const files = new Map(input.files.map((file) => [file.path, file]));
  const entry = files.get(input.entryPath);
  if (!entry || !entry.mediaType.toLowerCase().includes("text/html")) {
    unsupported(input.entryPath);
  }
  const checkedScripts = new Set<string>();
  const checkedStyles = new Set<string>();
  const requireFile = (reference: string, ownerPath: string) => {
    const path = packageReferencePath(reference, input.entryPath, ownerPath);
    if (!path) return null;
    const file = files.get(path);
    if (!file) unsupported(ownerPath);
    return file;
  };
  const checkScript = (file: RuntimeV1WidgetFile) => {
    if (checkedScripts.has(file.path)) return;
    checkedScripts.add(file.path);
    if (!/(?:javascript|ecmascript)/i.test(file.mediaType)) {
      unsupported(file.path);
    }
    assertClassicJavaScript(decodeText(file), file.path);
  };
  const checkStyle = (file: RuntimeV1WidgetFile) => {
    if (checkedStyles.has(file.path)) return;
    checkedStyles.add(file.path);
    if (!file.mediaType.toLowerCase().includes("text/css")) {
      unsupported(file.path);
    }
    assertTerminalCss(decodeText(file), file.path);
  };

  for (const element of scanHtml(decodeText(entry), entry.path)) {
    const type = (element.attributes.get("type")?.value || "")
      .trim()
      .toLowerCase();
    const rel = new Set(
      (element.attributes.get("rel")?.value || "")
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean),
    );
    if (
      Array.from(element.attributes).some(
        ([name, attribute]) => name.startsWith("on") && attribute.value,
      )
    ) {
      unsupported(entry.path);
    }
    if (element.attributes.has("srcset")) unsupported(entry.path);
    const inlineStyle = element.attributes.get("style")?.value;
    if (inlineStyle) assertTerminalCss(inlineStyle, entry.path);

    if (element.name === "script") {
      if (type === "module" || type === "importmap") unsupported(entry.path);
      const src = element.attributes.get("src")?.value;
      if (
        element.attributes.has("href") ||
        Array.from(element.attributes).some(([name]) => name.endsWith(":href"))
      ) {
        unsupported(entry.path);
      }
      if (!JAVASCRIPT_TYPES.has(type)) {
        if (src) unsupported(entry.path);
        continue;
      }
      if (src) {
        const file = requireFile(src, entry.path);
        if (!file) unsupported(entry.path);
        checkScript(file);
      } else if (element.content.trim()) {
        assertClassicJavaScript(element.content, entry.path);
      }
      continue;
    }
    if (element.name === "style") {
      assertTerminalCss(element.content, entry.path);
      continue;
    }
    if (element.name === "link") {
      if (rel.has("modulepreload")) unsupported(entry.path);
      const href = element.attributes.get("href")?.value;
      if (href) {
        const file = requireFile(href, entry.path);
        if (file && rel.has("stylesheet")) checkStyle(file);
      }
      continue;
    }
    const src = element.attributes.get("src")?.value;
    if (src) {
      if (element.name === "iframe" || element.name === "frame") {
        unsupported(entry.path);
      }
      requireFile(src, entry.path);
    }
    const poster = element.attributes.get("poster")?.value;
    if (poster) requireFile(poster, entry.path);
    const href = element.attributes.get("href")?.value;
    if (href && element.name !== "a" && element.name !== "area") {
      requireFile(href, entry.path);
    } else if (href && !href.trim().startsWith("#")) {
      unsupported(entry.path);
    }
  }
}

export function rewriteRuntimeV1WidgetReferences(input: {
  entryPath: string;
  html: string;
  dataUrls: ReadonlyMap<string, string>;
}) {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const element of scanHtml(input.html, input.entryPath)) {
    for (const name of ["src", "href", "poster"]) {
      const attribute = element.attributes.get(name);
      if (!attribute?.value) continue;
      const path = packageReferencePath(
        attribute.value,
        input.entryPath,
        input.entryPath,
      );
      if (!path) continue;
      const dataUrl = input.dataUrls.get(path);
      if (!dataUrl) unsupported(input.entryPath);
      replacements.push({
        start: attribute.valueStart,
        end: attribute.valueEnd,
        value: attribute.quote ? dataUrl : `"${dataUrl}"`,
      });
    }
  }
  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce(
      (html, replacement) =>
        `${html.slice(0, replacement.start)}${replacement.value}${html.slice(replacement.end)}`,
      input.html,
    );
}

export function compileRuntimeV1Widget(input: {
  entryPath: string;
  files: RuntimeV1WidgetFile[];
  dataUrls: ReadonlyMap<string, string>;
}) {
  validateRuntimeV1Widget(input);
  const files = new Map(input.files.map((file) => [file.path, file]));
  const entry = files.get(input.entryPath);
  if (!entry) unsupported(input.entryPath);
  const html = decodeText(entry);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const scripts: string[] = [];
  for (const element of scanHtml(html, input.entryPath)) {
    if (element.name === "script") {
      const type = (element.attributes.get("type")?.value || "")
        .trim()
        .toLowerCase();
      if (JAVASCRIPT_TYPES.has(type)) {
        const source = element.attributes.get("src")?.value;
        if (source) {
          const path = packageReferencePath(
            source,
            input.entryPath,
            input.entryPath,
          );
          const file = path ? files.get(path) : null;
          if (!file) unsupported(input.entryPath);
          scripts.push(decodeText(file));
        } else if (element.content.trim()) {
          scripts.push(element.content);
        }
      }
      replacements.push({ start: element.start, end: element.end, value: "" });
      continue;
    }
    for (const name of ["src", "href", "poster"]) {
      const attribute = element.attributes.get(name);
      if (!attribute?.value) continue;
      const path = packageReferencePath(
        attribute.value,
        input.entryPath,
        input.entryPath,
      );
      if (!path) continue;
      const dataUrl = input.dataUrls.get(path);
      if (!dataUrl) unsupported(input.entryPath);
      replacements.push({
        start: attribute.valueStart,
        end: attribute.valueEnd,
        value: attribute.quote ? dataUrl : `"${dataUrl}"`,
      });
    }
  }
  return {
    templateHtml: replacements
      .sort((left, right) => right.start - left.start)
      .reduce(
        (value, replacement) =>
          `${value.slice(0, replacement.start)}${replacement.value}${value.slice(replacement.end)}`,
        html,
      ),
    scriptSource: scripts.join("\n;\n"),
  };
}
