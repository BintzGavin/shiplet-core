export const MAX_EXTERNAL_METADATA_BYTES = 256 * 1024;

const MAX_EXTERNAL_METADATA_REDIRECTS = 5;
const MAX_EXTERNAL_METADATA_NAME_LENGTH = 120;

export type ExternalUrlMetadataSource =
  | "og:title"
  | "twitter:title"
  | "title"
  | "application-name"
  | "og:site_name"
  | "url";

export type ExternalUrlMetadata = {
  finalUrl: string;
  name: string;
  source: ExternalUrlMetadataSource;
  subdomain: string;
};

type MetadataFetcher = (request: Request) => Promise<Response>;

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  copy: "©",
  eacute: "é",
  gt: ">",
  hellip: "…",
  laquo: "«",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  raquo: "»",
  reg: "®",
  trade: "™",
};

function decodeHtmlEntities(value: string) {
  return value.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/gi,
    (match, entity: string) => {
      const normalized = entity.toLowerCase();
      if (normalized.startsWith("#x")) {
        const codePoint = Number.parseInt(normalized.slice(2), 16);
        return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : "";
      }
      if (normalized.startsWith("#")) {
        const codePoint = Number.parseInt(normalized.slice(1), 10);
        return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : "";
      }
      return NAMED_HTML_ENTITIES[normalized] ?? match;
    },
  );
}

function validCodePoint(value: number) {
  return (
    Number.isInteger(value) &&
    value > 0 &&
    value <= 0x10ffff &&
    !(value >= 0xd800 && value <= 0xdfff)
  );
}

function boundedMetadataName(value: string) {
  return decodeHtmlEntities(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EXTERNAL_METADATA_NAME_LENGTH)
    .trim();
}

export function externalMetadataSubdomain(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

function parseTagAttributes(tag: string) {
  const attributes: Record<string, string> = {};
  const body = tag.replace(/^<\s*\/?\s*[^\s/>]+|\/?>$/g, "");
  const pattern =
    /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    const name = match[1].toLowerCase();
    if (!(name in attributes)) {
      attributes[name] = match[2] ?? match[3] ?? match[4] ?? "";
    }
  }
  return attributes;
}

function metadataCandidates(html: string) {
  const withoutExecutableText = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(?:script|style|template|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|template|noscript)\s*>/gi,
      " ",
    );
  const headEnd = withoutExecutableText.search(/<\/head\s*>/i);
  const head =
    headEnd >= 0
      ? withoutExecutableText.slice(0, headEnd)
      : withoutExecutableText;
  const values = new Map<string, string>();

  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseTagAttributes(match[0]);
    const key = (
      attributes.property ||
      attributes.name ||
      attributes.itemprop ||
      ""
    ).toLowerCase();
    const content = boundedMetadataName(attributes.content || "");
    if (key && content && !values.has(key)) values.set(key, content);
  }

  const title = boundedMetadataName(
    head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || "",
  );
  if (title) values.set("title", title);
  return values;
}

function fallbackNameForUrl(url: URL) {
  const labels = url.hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".");
  const label = labels[0] || "shiplet";
  const words = label.split(/[-_]+/).filter(Boolean);
  const name = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return boundedMetadataName(name || "Shiplet") || "Shiplet";
}

export function fallbackExternalUrlMetadata(url: URL): ExternalUrlMetadata {
  const name = fallbackNameForUrl(url);
  return {
    finalUrl: url.toString(),
    name,
    source: "url",
    subdomain: externalMetadataSubdomain(name) || "shiplet",
  };
}

function metadataFromHtml(html: string, url: URL): ExternalUrlMetadata {
  const values = metadataCandidates(html);
  const priorities: Array<[ExternalUrlMetadataSource, string]> = [
    ["og:title", "og:title"],
    ["twitter:title", "twitter:title"],
    ["title", "title"],
    ["application-name", "application-name"],
    ["og:site_name", "og:site_name"],
  ];
  for (const [source, key] of priorities) {
    const name = values.get(key);
    if (!name) continue;
    const subdomain = externalMetadataSubdomain(name);
    if (subdomain) return { finalUrl: url.toString(), name, source, subdomain };
  }
  return fallbackExternalUrlMetadata(url);
}

async function boundedMetadataText(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (!result.value?.byteLength) continue;
    const remaining = MAX_EXTERNAL_METADATA_BYTES - total;
    if (remaining <= 0) {
      await reader.cancel();
      break;
    }
    if (result.value.byteLength > remaining) {
      chunks.push(result.value.slice(0, remaining));
      total += remaining;
      await reader.cancel();
      break;
    }
    chunks.push(result.value);
    total += result.value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function isRedirect(status: number) {
  return [301, 302, 303, 307, 308].includes(status);
}

export async function inspectExternalUrlMetadata(input: {
  url: URL;
  isAllowedUrl: (url: URL) => boolean;
  fetcher?: MetadataFetcher;
}): Promise<ExternalUrlMetadata> {
  const fetcher = input.fetcher ?? ((request: Request) => fetch(request));
  let currentUrl = new URL(input.url);
  if (!input.isAllowedUrl(currentUrl)) {
    throw new Error("External URL metadata request denied");
  }
  const visited = new Set<string>();

  for (
    let redirectCount = 0;
    redirectCount <= MAX_EXTERNAL_METADATA_REDIRECTS;
    redirectCount += 1
  ) {
    if (visited.has(currentUrl.href)) {
      throw new Error("External URL metadata redirect denied");
    }
    visited.add(currentUrl.href);
    const response = await fetcher(
      new Request(currentUrl.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9",
          "user-agent": "Shiplet metadata preview",
        },
      }),
    );

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirectCount === MAX_EXTERNAL_METADATA_REDIRECTS) {
        throw new Error("External URL metadata redirect denied");
      }
      let redirectUrl: URL;
      try {
        redirectUrl = new URL(location, currentUrl);
      } catch {
        throw new Error("External URL metadata redirect denied");
      }
      if (!input.isAllowedUrl(redirectUrl)) {
        throw new Error("External URL metadata redirect denied");
      }
      currentUrl = redirectUrl;
      continue;
    }

    const contentType =
      response.headers.get("content-type")?.toLowerCase() || "";
    if (
      !response.ok ||
      (contentType &&
        !contentType.includes("text/html") &&
        !contentType.includes("application/xhtml+xml"))
    ) {
      response.body?.cancel().catch(() => undefined);
      return fallbackExternalUrlMetadata(currentUrl);
    }
    return metadataFromHtml(await boundedMetadataText(response), currentUrl);
  }

  throw new Error("External URL metadata redirect denied");
}
