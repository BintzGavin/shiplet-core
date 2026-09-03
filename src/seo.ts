import { BRAND_ASSETS } from "./generated-brand-assets";

export const DEFAULT_SITE_URL = "https://shiplet.cc";
export const SITE_NAME = "Shiplet";
export const SITE_TITLE = "Shiplet | Review Builds, Files, and Live URLs";
export const SITE_DESCRIPTION =
  "Add a trusted review layer to builds, files, and live URLs for contextual feedback and agent handoff.";
export const SITE_KEYWORDS =
  "shiplets, build review, website annotation, contextual feedback, secure sharing, Code Mode MCP";
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

export const SHIPLET_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Shiplet" shape-rendering="geometricPrecision">
	<rect x="6" y="6" width="116" height="116" rx="26" fill="#fbf9f4" stroke="#20293a" stroke-width="7"/>
	<g transform="translate(0 -8)">
		<rect x="62" y="20" width="4" height="42" rx="2" fill="#20293a"/>
		<path d="M66 18l26 11-26 11z" fill="#c2502f"/>
		<rect x="40" y="62" width="21" height="20" rx="2" fill="#2f6e88"/>
		<rect x="67" y="62" width="21" height="20" rx="2" fill="#c2502f"/>
		<path d="M28 86h72l-13 24H41z" fill="#20293a"/>
		<path d="M29 118q7-7 14 0t14 0t14 0t14 0t14 0" fill="none" stroke="#2f6e88" stroke-width="5" stroke-linecap="round"/>
	</g>
</svg>`;

type BrandAssetKey = keyof typeof BRAND_ASSETS;

const assetCache: Partial<Record<BrandAssetKey, Uint8Array>> = {};

export function normalizeAppUrl(appUrl?: string) {
  return (appUrl || DEFAULT_SITE_URL).replace(/\/+$/, "");
}

export function absoluteSiteUrl(appUrl: string | undefined, path = "/") {
  const baseUrl = normalizeAppUrl(appUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

export function htmlAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function scriptJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function assetBytes(key: BrandAssetKey) {
  if (!assetCache[key]) {
    assetCache[key] = decodeBase64(BRAND_ASSETS[key]);
  }
  return assetCache[key]!;
}

export function brandAssetResponse(
  key: BrandAssetKey,
  contentType = "image/png",
) {
  const bytes = assetBytes(key);
  return new Response(bytes.slice(), {
    headers: {
      "cache-control": ASSET_CACHE_CONTROL,
      "content-length": String(bytes.byteLength),
      "content-type": contentType,
      "x-content-type-options": "nosniff",
    },
  });
}

export function faviconSvgResponse() {
  return new Response(SHIPLET_FAVICON_SVG, {
    headers: {
      "cache-control": ASSET_CACHE_CONTROL,
      "content-type": "image/svg+xml; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export function siteManifest(appUrl?: string) {
  return JSON.stringify({
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f7f5ef",
    theme_color: "#20293a",
    icons: [
      {
        src: "/brand/logo.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any maskable",
      },
      {
        src: "/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
    related_applications: [],
    url: absoluteSiteUrl(appUrl, "/"),
  });
}

export function manifestResponse(appUrl?: string) {
  return new Response(siteManifest(appUrl), {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": "application/manifest+json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export function robotsTxt(appUrl?: string) {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    `Sitemap: ${absoluteSiteUrl(appUrl, "/sitemap.xml")}`,
    "",
  ].join("\n");
}

export function robotsResponse(appUrl?: string) {
  return new Response(robotsTxt(appUrl), {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export function sitemapXml(appUrl?: string) {
  const urls = [
    { path: "/", priority: "1.0" },
    { path: "/docs", priority: "0.9" },
    { path: "/docs/why-shiplet", priority: "0.8" },
    { path: "/docs/quickstart", priority: "0.8" },
    { path: "/docs/access-control", priority: "0.7" },
    { path: "/docs/api-keys", priority: "0.7" },
    { path: "/docs/code-mode-mcp", priority: "0.8" },
    { path: "/docs/api-surface", priority: "0.7" },
    { path: "/docs/extensions", priority: "0.8" },
    { path: "/docs/security", priority: "0.8" },
    { path: "/docs/publishing", priority: "0.8" },
    { path: "/docs/review-feedback", priority: "0.8" },
    { path: "/docs/wordpress", priority: "0.8" },
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (url) => `  <url>
    <loc>${absoluteSiteUrl(appUrl, url.path)}</loc>
    <changefreq>weekly</changefreq>
    <priority>${url.priority}</priority>
  </url>`,
  )
  .join("\n")}
</urlset>
`;
}

export function sitemapResponse(appUrl?: string) {
  return new Response(sitemapXml(appUrl), {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": "application/xml; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export function llmsTxt(appUrl?: string) {
  const baseUrl = normalizeAppUrl(appUrl);
  return `# Shiplet

Add a trusted review layer to builds, files, and live URLs for contextual feedback and agent handoff.

## Core capabilities

- Prepare build outputs, static exports, and files for review.
- Manage organizations, teams, user invites, and project access.
- Collect in-context review feedback directly on artifacts.
- Keep the artifact separate from Shiplet's trusted review layer.
- Customize the review layer with a sandboxed widget when the built-in toolbar does not fit the team's process.
- Hand review artifacts and feedback to agents through Code Mode MCP or documented REST operations.

## Machine-readable resources

- Website: ${absoluteSiteUrl(baseUrl, "/")}
- Documentation: ${absoluteSiteUrl(baseUrl, "/docs")}
- Why Shiplet: ${absoluteSiteUrl(baseUrl, "/docs/why-shiplet")}
- Review artifacts: ${absoluteSiteUrl(baseUrl, "/docs/publishing")}
- Review layer: ${absoluteSiteUrl(baseUrl, "/docs/extensions")}
- Security and isolation: ${absoluteSiteUrl(baseUrl, "/docs/security")}
- OpenAPI: ${absoluteSiteUrl(baseUrl, "/openapi.json")}
- Code Mode MCP: ${absoluteSiteUrl(baseUrl, "/api/mcp")}
- Review client: ${absoluteSiteUrl(baseUrl, "/api/review/client.js")}

## Access model

Public discovery files describe Shiplet. Preparing review artifacts, organization management, API access, and MCP execution require authenticated access or an organization API token.
`;
}

export function llmsResponse(appUrl?: string) {
  return new Response(llmsTxt(appUrl), {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export function structuredData(appUrl?: string) {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    url: absoluteSiteUrl(appUrl, "/"),
    image: absoluteSiteUrl(appUrl, "/og-image.png"),
    description: SITE_DESCRIPTION,
    publisher: {
      "@type": "Organization",
      name: SITE_NAME,
      url: absoluteSiteUrl(appUrl, "/"),
      logo: absoluteSiteUrl(appUrl, "/brand/logo.png"),
    },
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    potentialAction: {
      "@type": "CreateAction",
      name: "Prepare a review",
      target: {
        "@type": "EntryPoint",
        urlTemplate: absoluteSiteUrl(appUrl, "/auth/login"),
      },
    },
  };
}
