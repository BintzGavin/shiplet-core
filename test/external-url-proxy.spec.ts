import { describe, expect, it, vi } from "vitest";

import { EXTERNAL_REWRITE_FAST_PATH_BYTES } from "../src/external-text-rewrite";
import {
  EXTERNAL_RESOURCE_PROXY_PATH,
  createExternalResourceUrlBuilder,
  rewriteExternalCssReferences,
  rewriteExternalHtmlReferences,
  verifiedExternalResourceTarget,
} from "../src/external-url-proxy";

function freshSigningMaterial() {
  return crypto.randomUUID();
}

function absoluteProxyUrl(path: string) {
  return new URL(path, "https://review.example.com");
}

function nonCanonicalBase64UrlAlias(value: string) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const unusedBits =
    value.length % 4 === 2 ? 4 : value.length % 4 === 3 ? 2 : 0;
  expect(unusedBits).toBeGreaterThan(0);
  const lastIndex = alphabet.indexOf(value.at(-1) || "");
  expect(lastIndex & ((1 << unusedBits) - 1)).toBe(0);
  return `${value.slice(0, -1)}${alphabet[lastIndex | 1]}`;
}

function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function tagAttribute(html: string, marker: string, attribute: string) {
  const markerIndex = html.indexOf(marker);
  const tagStart = markerIndex === -1 ? -1 : html.lastIndexOf("<", markerIndex);
  let tagEnd = -1;
  let quote = "";
  for (
    let index = tagStart + 1;
    tagStart !== -1 && index < html.length;
    index += 1
  ) {
    if (quote) {
      if (html[index] === quote) quote = "";
    } else if (html[index] === '"' || html[index] === "'") {
      quote = html[index];
    } else if (html[index] === ">") {
      tagEnd = index;
      break;
    }
  }
  const tag =
    tagStart === -1 || tagEnd === -1
      ? undefined
      : html.slice(tagStart, tagEnd + 1);
  expect(tag).toBeTruthy();
  const value = tag?.match(
    new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"),
  );
  expect(value).toBeTruthy();
  return decodeHtmlAttribute(value?.[1] ?? value?.[2] ?? "");
}

async function signedPath(input: {
  signingMaterial: string;
  projectId: string;
  target: string;
}) {
  const target = new URL(input.target);
  const version = "v1";
  const expiresAt = String(Math.floor(Date.now() / 1_000) + 60 * 60);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.signingMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(
        `${input.projectId}\n${version}\n${expiresAt}\n${target.origin}`,
      ),
    ),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  const encodedSignature = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const encodedOrigin = btoa(target.origin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${EXTERNAL_RESOURCE_PROXY_PATH}/${version}/${expiresAt}/${encodedSignature}/${encodedOrigin}${target.pathname}${target.search}`;
}

describe("external URL resource proxy authority", () => {
  it("issues a reusable versioned path capability that preserves relative module paths and expires after 24 hours", async () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2030-01-02T03:04:05.000Z");
      vi.setSystemTime(now);
      const signingMaterial = freshSigningMaterial();
      const projectId = "project-a";
      const proxyUrlFor = await createExternalResourceUrlBuilder({
        secret: signingMaterial,
        projectId,
        rootAssetPrefix: "/shiplets/project-a/artifact-frame",
      });
      const mainPath = await proxyUrlFor(
        "https://cdn.example.com/app/modules/main.js?mode=review#entry",
      );
      const mainUrl = absoluteProxyUrl(mainPath);
      const capability = mainUrl.pathname.match(
        /\/__shiplet\/external-resource\/v1\/(\d+)\/([A-Za-z0-9_-]{43})\/([A-Za-z0-9_-]+)\/app\/modules\/main\.js$/,
      );
      expect(capability).toBeTruthy();
      expect(Number(capability?.[1])).toBe(
        Math.floor(now.getTime() / 1_000) + 24 * 60 * 60,
      );
      expect(mainUrl.search).toBe("?mode=review");
      expect(mainUrl.hash).toBe("#entry");

      const verify = (url: URL) =>
        verifiedExternalResourceTarget({
          requestUrl: url,
          requestPath: url.pathname,
          secret: signingMaterial,
          projectId,
        });
      await expect(verify(mainUrl)).resolves.toEqual(
        new URL("https://cdn.example.com/app/modules/main.js?mode=review"),
      );
      await expect(verify(mainUrl)).resolves.toEqual(
        new URL("https://cdn.example.com/app/modules/main.js?mode=review"),
      );

      const sibling = new URL("./chunk.js", mainUrl);
      await expect(verify(sibling)).resolves.toEqual(
        new URL("https://cdn.example.com/app/modules/chunk.js"),
      );

      vi.setSystemTime(Number(capability?.[1]) * 1_000 - 1);
      await expect(verify(sibling)).resolves.toEqual(
        new URL("https://cdn.example.com/app/modules/chunk.js"),
      );
      vi.setSystemTime(Number(capability?.[1]) * 1_000);
      await expect(verify(sibling)).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects path capabilities with a tampered version, expiry, origin, or signature", async () => {
    const signingMaterial = freshSigningMaterial();
    const projectId = "project-a";
    const proxyUrlFor = await createExternalResourceUrlBuilder({
      secret: signingMaterial,
      projectId,
      rootAssetPrefix: "",
    });
    const original = absoluteProxyUrl(
      await proxyUrlFor("https://cdn.example.com/app/main.js"),
    );
    const verify = (url: URL) =>
      verifiedExternalResourceTarget({
        requestUrl: url,
        requestPath: url.pathname,
        secret: signingMaterial,
        projectId,
      });
    for (const mutate of [
      (path: string) => path.replace("/v1/", "/v2/"),
      (path: string) =>
        path.replace(
          /\/v1\/(\d+)\//,
          (_match, expiry: string) => `/v1/${Number(expiry) + 1}/`,
        ),
      (path: string) =>
        path.replace(/\/([A-Za-z0-9_-]{43})\//, "/" + "A".repeat(43) + "/"),
      (path: string) =>
        path.replace(
          /\/([A-Za-z0-9_-]+)\/app\//,
          "/aHR0cHM6Ly9vdGhlci5leGFtcGxlLmNvbQ/app/",
        ),
    ]) {
      const tampered = new URL(original);
      tampered.pathname = mutate(tampered.pathname);
      await expect(verify(tampered)).resolves.toBeNull();
    }
  });

  it("rejects non-canonical base64url aliases for a valid signature or origin", async () => {
    const signingMaterial = freshSigningMaterial();
    const projectId = "project-a";
    const proxyUrlFor = await createExternalResourceUrlBuilder({
      secret: signingMaterial,
      projectId,
      rootAssetPrefix: "",
    });
    const original = absoluteProxyUrl(
      await proxyUrlFor("https://cdn.example.com/app/main.js"),
    );
    const capability = original.pathname.match(
      /(\/v1\/\d+\/)([A-Za-z0-9_-]{43})\/([A-Za-z0-9_-]+)(\/.*)/,
    );
    expect(capability).toBeTruthy();

    for (const segment of [2, 3]) {
      const aliased = new URL(original);
      const alias = nonCanonicalBase64UrlAlias(capability?.[segment] || "");
      aliased.pathname = original.pathname.replace(
        capability?.[segment] || "",
        alias,
      );
      await expect(
        verifiedExternalResourceTarget({
          requestUrl: aliased,
          requestPath: aliased.pathname,
          secret: signingMaterial,
          projectId,
        }),
      ).resolves.toBeNull();
    }
  });

  it("preserves an authored double-slash upstream pathname without treating it as a new authority", async () => {
    const signingMaterial = freshSigningMaterial();
    const projectId = "project-a";
    const proxyUrlFor = await createExternalResourceUrlBuilder({
      secret: signingMaterial,
      projectId,
      rootAssetPrefix: "",
    });
    const requestUrl = absoluteProxyUrl(
      await proxyUrlFor("https://cdn.example.com//assets/app.js?mode=test"),
    );

    await expect(
      verifiedExternalResourceTarget({
        requestUrl,
        requestPath: requestUrl.pathname,
        secret: signingMaterial,
        projectId,
      }),
    ).resolves.toEqual(
      new URL("https://cdn.example.com//assets/app.js?mode=test"),
    );
  });

  it("accepts one canonical project-bound capability and rejects unsigned, tampered, duplicated, wrong-project, and wrong-path requests", async () => {
    const signingMaterial = freshSigningMaterial();
    const projectId = "project-a";
    const proxyUrlFor = await createExternalResourceUrlBuilder({
      secret: signingMaterial,
      projectId,
      rootAssetPrefix: "",
    });
    const path = await proxyUrlFor(
      "https://cdn.example.com/assets/app.js#module-entry",
    );
    expect(path.endsWith("#module-entry")).toBe(true);
    const requestUrl = absoluteProxyUrl(path);

    await expect(
      verifiedExternalResourceTarget({
        requestUrl,
        requestPath: requestUrl.pathname,
        secret: signingMaterial,
        projectId,
      }),
    ).resolves.toEqual(new URL("https://cdn.example.com/assets/app.js"));

    const unsigned = new URL(requestUrl);
    unsigned.pathname = unsigned.pathname.replace(
      /\/([A-Za-z0-9_-]{43})\//,
      "/",
    );
    await expect(
      verifiedExternalResourceTarget({
        requestUrl: unsigned,
        requestPath: unsigned.pathname,
        secret: signingMaterial,
        projectId,
      }),
    ).resolves.toBeNull();

    const tamperedSignature = new URL(requestUrl);
    tamperedSignature.pathname = tamperedSignature.pathname.replace(
      /\/([A-Za-z0-9_-]{43})\//,
      (_match, signature: string) =>
        `/${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}/`,
    );
    await expect(
      verifiedExternalResourceTarget({
        requestUrl: tamperedSignature,
        requestPath: tamperedSignature.pathname,
        secret: signingMaterial,
        projectId,
      }),
    ).resolves.toBeNull();

    const duplicated = new URL(requestUrl);
    duplicated.pathname = duplicated.pathname.replace(
      `${EXTERNAL_RESOURCE_PROXY_PATH}/`,
      `${EXTERNAL_RESOURCE_PROXY_PATH}/${EXTERNAL_RESOURCE_PROXY_PATH}/`,
    );
    await expect(
      verifiedExternalResourceTarget({
        requestUrl: duplicated,
        requestPath: duplicated.pathname,
        secret: signingMaterial,
        projectId,
      }),
    ).resolves.toBeNull();

    await expect(
      verifiedExternalResourceTarget({
        requestUrl,
        requestPath: requestUrl.pathname,
        secret: signingMaterial,
        projectId: "project-b",
      }),
    ).resolves.toBeNull();
    await expect(
      verifiedExternalResourceTarget({
        requestUrl,
        requestPath: "/somewhere-else",
        secret: signingMaterial,
        projectId,
      }),
    ).resolves.toBeNull();
  });

  it.each([
    "file:///etc/passwd",
    "ftp://files.example.com/archive.zip",
    "data:text/plain,hello",
    "javascript:alert(1)",
    "https://user:password@cdn.example.com/private",
    "http://localhost/admin",
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1/internal",
    "http://[::1]/internal",
    "http://metadata.google.internal/computeMetadata/v1",
    "https://cdn.example/asset.js",
    "https://cdn.foo.example/asset.js",
    "https://cdn.example.com:8443/asset.js",
  ])(
    "refuses to mint proxy authority for non-public target %s",
    async (target) => {
      const proxyUrlFor = await createExternalResourceUrlBuilder({
        secret: freshSigningMaterial(),
        projectId: "project-a",
        rootAssetPrefix: "/shiplets/project-a/artifact-frame",
      });

      await expect(proxyUrlFor(target)).rejects.toThrow();
    },
  );

  it.each([
    "http://[64:ff9b::808:808]/resource",
    "http://[64:ff9b:1::808:808]/resource",
    "http://[100::1]/resource",
    "http://[2001::1]/resource",
    "http://[2001:1ff::1]/resource",
    "http://[2002:7f00:1::1]/resource",
    "http://[2002:0a00:1::1]/resource",
    "http://[3fff:fff::1]/resource",
    "http://[fec0::1]/resource",
    "http://[feff::1]/resource",
  ])("refuses special or non-global IPv6 target %s", async (target) => {
    const proxyUrlFor = await createExternalResourceUrlBuilder({
      secret: freshSigningMaterial(),
      projectId: "project-a",
      rootAssetPrefix: "",
    });

    await expect(proxyUrlFor(target)).rejects.toThrow();
  });

  it.each([
    "https://[2606:4700:4700::1111]/dns-query",
    "https://[2002:0808:0808::1]/resource",
  ])("preserves public IPv6 target %s", async (target) => {
    const proxyUrlFor = await createExternalResourceUrlBuilder({
      secret: freshSigningMaterial(),
      projectId: "project-a",
      rootAssetPrefix: "",
    });

    await expect(proxyUrlFor(target)).resolves.toContain(
      EXTERNAL_RESOURCE_PROXY_PATH,
    );
  });

  it.each([
    "http://127.0.0.1/internal",
    "http://[64:ff9b::808:808]/internal",
    "http://[2002:7f00:1::1]/internal",
  ])(
    "rejects correctly signed non-public target %s as verifier-side defense in depth",
    async (target) => {
      const signingMaterial = freshSigningMaterial();
      const projectId = "project-a";
      const requestUrl = absoluteProxyUrl(
        await signedPath({
          signingMaterial,
          projectId,
          target,
        }),
      );

      await expect(
        verifiedExternalResourceTarget({
          requestUrl,
          requestPath: requestUrl.pathname,
          secret: signingMaterial,
          projectId,
        }),
      ).resolves.toBeNull();
    },
  );

  it("bounds signed target and signature inputs", async () => {
    const signingMaterial = freshSigningMaterial();
    const projectId = "project-a";
    const proxyUrlFor = await createExternalResourceUrlBuilder({
      secret: signingMaterial,
      projectId,
      rootAssetPrefix: "",
    });
    await expect(
      proxyUrlFor(`https://cdn.example.com/${"a".repeat(8_200)}`),
    ).rejects.toThrow();

    const valid = absoluteProxyUrl(
      await proxyUrlFor("https://cdn.example.com/app.js"),
    );
    valid.pathname = valid.pathname.replace(
      /\/([A-Za-z0-9_-]{43})\//,
      `/${"a".repeat(1_000)}/`,
    );
    await expect(
      verifiedExternalResourceTarget({
        requestUrl: valid,
        requestPath: valid.pathname,
        secret: signingMaterial,
        projectId,
      }),
    ).resolves.toBeNull();
  });

  it("leaves DNS resolution and rebinding enforcement to Wrangler global_fetch_strictly_public", async () => {
    const proxyUrlFor = await createExternalResourceUrlBuilder({
      secret: freshSigningMaterial(),
      projectId: "project-a",
      rootAssetPrefix: "",
    });

    await expect(
      proxyUrlFor("https://public-assets.example.com/app.js"),
    ).resolves.toContain(EXTERNAL_RESOURCE_PROXY_PATH);
  });
});

describe("external CSS rewriting", () => {
  it("keeps adversarial 20KB escape and 100KB identifier scans within a linear substring-copy budget", async () => {
    const samples = [String.raw`\61`.repeat(7_000), "u".repeat(100_000)];
    for (const css of samples) {
      const originalSlice = String.prototype.slice;
      let copiedCharacters = 0;
      const slice = vi
        .spyOn(String.prototype, "slice")
        .mockImplementation(function (
          this: string,
          start?: number,
          end?: number,
        ) {
          const result = originalSlice.call(String(this), start, end);
          if (String(this) === css) {
            copiedCharacters += result.length;
            if (copiedCharacters > css.length * 20) {
              throw new RangeError("CSS scan exceeded its linear work budget");
            }
          }
          return result;
        });
      try {
        await expect(
          rewriteExternalCssReferences({
            sourceUrl: "https://preview.example.com/app.css",
            css,
            proxyUrlFor: async () => "/proxy",
          }),
        ).resolves.toBe(css);
        expect(copiedCharacters).toBeLessThanOrEqual(css.length * 20);
      } finally {
        slice.mockRestore();
      }
    }
  });

  it("resolves nested imports and escaped url() values from each containing stylesheet without touching comments, strings, fragments, or data URLs", async () => {
    const seen: string[] = [];
    const proxyUrlFor = async (target: string) => {
      seen.push(target);
      return `/proxy?target=${encodeURIComponent(target)}`;
    };
    const main = await rewriteExternalCssReferences({
      sourceUrl: "https://preview.example.com/app/styles/main.css",
      proxyUrlFor,
      css: String.raw`
        /* url("ignored-comment.png") */
        .label::before { content: "url(ignored-string.png)"; }
        @import "./theme/colors.css" screen;
        @import url('./print.css') print;
        .hero { background: url(../images/hero\20 wide.png); }
        .local { mask: url(#shape); }
        .inline { background: url(data:image/svg+xml,%3Csvg%3E); }
      `,
    });

    expect(seen).toEqual([
      "https://preview.example.com/app/styles/theme/colors.css",
      "https://preview.example.com/app/styles/print.css",
      "https://preview.example.com/app/images/hero%20wide.png",
    ]);
    expect(main).toContain('content: "url(ignored-string.png)"');
    expect(main).toContain('url("ignored-comment.png")');
    expect(main).toContain("url(#shape)");
    expect(main).toContain("url(data:image/svg+xml,%3Csvg%3E)");

    seen.length = 0;
    await rewriteExternalCssReferences({
      sourceUrl: "https://preview.example.com/app/styles/theme/colors.css",
      proxyUrlFor,
      css: String.raw`@import "../tokens.css"; @font-face { src: url("../../fonts/palette.woff2?v=2"); }`,
    });
    expect(seen).toEqual([
      "https://preview.example.com/app/styles/tokens.css",
      "https://preview.example.com/app/fonts/palette.woff2?v=2",
    ]);
  });

  it("rewrites escaped import and url identifiers while preserving URL-adjacent comments", async () => {
    const seen: string[] = [];
    const css = await rewriteExternalCssReferences({
      sourceUrl: "https://preview.example.com/styles/main.css",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return `/proxy?target=${encodeURIComponent(target)}`;
      },
      css: String.raw`
        @im\70ort /* import-gap */ "theme.css" screen;
        .a { background: u\72l(/* lead */ "images/a.png" /* tail */); }
        .b { background: \75rl(/*left*/images/b.png/*right*/); }
      `,
    });

    expect(seen).toEqual([
      "https://preview.example.com/styles/theme.css",
      "https://preview.example.com/styles/images/a.png",
      "https://preview.example.com/styles/images/b.png",
    ]);
    expect(css).toContain("@im\\70ort /* import-gap */");
    expect(css).toContain("u\\72l(/* lead */");
    expect(css).toContain("/* tail */)");
    expect(css).toContain("\\75rl(/*left*/");
    expect(css).toContain("/*right*/)");
    expect(css).not.toContain("%2F*%20lead%20*%2F");
  });

  it("preserves comments between the url token, parentheses, and internal value", async () => {
    const seen: string[] = [];
    const css = await rewriteExternalCssReferences({
      sourceUrl: "https://preview.example.com/styles/main.css",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return "/proxy/image.png";
      },
      css: `.hero{background:url(/*before*/image.png/*after*/ )}`,
    });

    expect(seen).toEqual(["https://preview.example.com/styles/image.png"]);
    expect(css).toBe(
      `.hero{background:url(/*before*/"/proxy/image.png"/*after*/ )}`,
    );
  });

  it("matches browser URL token validity and rewrites fetchable image-set assets inside nested image functions", async () => {
    const seen: string[] = [];
    const css = await rewriteExternalCssReferences({
      sourceUrl: "https://preview.example.com/styles/main.css",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return `/proxy/${seen.length}`;
      },
      css: `.tail{background:url(foo/*tail*/)}
        .invalid{background:url(foo"bar")}
        .gap{background:url/**/(gap.png)}
        .set{background-image:image-set("one.png" 1x,url(two.png) 2x)}
        .fade{background-image:-webkit-cross-fade(url(three.png),image-set("four.png" 1x),.5)}`,
    });

    expect(seen).toEqual([
      "https://preview.example.com/styles/foo/*tail*/",
      "https://preview.example.com/styles/one.png",
      "https://preview.example.com/styles/two.png",
      "https://preview.example.com/styles/three.png",
      "https://preview.example.com/styles/four.png",
    ]);
    expect(css).toContain('url(foo"bar")');
    expect(css).toContain("url/**/(gap.png)");
  });

  it("treats unquoted URL-token comments as literal content and leaves control or prematurely closed bad URLs untouched", async () => {
    const seen: string[] = [];
    const css = await rewriteExternalCssReferences({
      sourceUrl: "https://preview.example.com/styles/main.css",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return `/proxy/${seen.length}`;
      },
      css: `.lead{background:url(/*lead*/image.png)}
        .control{background:url(foo\u0007bar)}
        .closed{background:url(foo/*)*/bar)}
        .valid{background:url(good.png)}`,
    });

    expect(seen).toEqual([
      "https://preview.example.com/*lead*/image.png",
      "https://preview.example.com/styles/good.png",
    ]);
    expect(css).toContain("url(foo\u0007bar)");
    expect(css).toContain("url(foo/*)*/bar)");
  });

  it("CSS-escapes proxy output so a generated URL cannot break out of url()", async () => {
    const css = await rewriteExternalCssReferences({
      sourceUrl: "https://preview.example.com/app.css",
      css: ".hero{background:url(hero.png)}",
      proxyUrlFor: async () => String.raw`/proxy?value=");color:red;/*\\tail`,
    });

    expect(css).toContain(
      String.raw`url("/proxy?value=\");color:red;/*\\\\tail")`,
    );
    expect(css).not.toContain('url("/proxy?value=");color:red');
  });

  it("accepts the exact buffered fast-path CSS boundary and rejects one byte beyond it", async () => {
    expect(EXTERNAL_REWRITE_FAST_PATH_BYTES).toBe(8 * 1024 * 1024);
    let calls = 0;
    const atBoundary = `/*${"a".repeat(EXTERNAL_REWRITE_FAST_PATH_BYTES - 4)}*/`;
    await expect(
      rewriteExternalCssReferences({
        sourceUrl: "https://preview.example.com/app.css",
        css: atBoundary,
        proxyUrlFor: async () => {
          calls += 1;
          return "/proxy";
        },
      }),
    ).resolves.toBe(atBoundary);
    expect(calls).toBe(0);

    await expect(
      rewriteExternalCssReferences({
        sourceUrl: "https://preview.example.com/app.css",
        css: "a".repeat(EXTERNAL_REWRITE_FAST_PATH_BYTES + 1),
        proxyUrlFor: async () => {
          calls += 1;
          return "/proxy";
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("allows 4,096 stylesheet references and rejects the 4,097th independently of byte size", async () => {
    let calls = 0;
    await expect(
      rewriteExternalCssReferences({
        sourceUrl: "https://preview.example.com/app.css",
        css: Array.from(
          { length: 4_096 },
          (_, index) => `.asset-${index}{src:url(asset-${index}.png)}`,
        ).join(""),
        proxyUrlFor: async () => {
          calls += 1;
          return "/proxy";
        },
      }),
    ).resolves.toContain(".asset-4095");
    expect(calls).toBe(4_096);

    calls = 0;
    await expect(
      rewriteExternalCssReferences({
        sourceUrl: "https://preview.example.com/app.css",
        css: Array.from(
          { length: 4_097 },
          (_, index) => `.asset-${index}{src:url(asset-${index}.png)}`,
        ).join(""),
        proxyUrlFor: async () => {
          calls += 1;
          return "/proxy";
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(4_096);
  });
});

describe("external HTML rewriting", () => {
  it("injects exactly one trusted effective base while template and SVG base elements remain inert", async () => {
    const seen: string[] = [];
    const html = await rewriteExternalHtmlReferences({
      sourceUrl: "https://preview.example.com/releases/current/index.html",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return `/signed/${encodeURIComponent(target)}`;
      },
      html: `<html><head>
        <template><base href="https://template.example.com/"></template>
        <svg><base href="https://svg.example.com/" /></svg>
        <base href="../assets/v8/">
      </head><body><script type="module" src="app/main.js"></script></body></html>`,
    });

    expect(seen[0]).toBe("https://preview.example.com/releases/assets/v8/");
    expect(html.match(/<base\b/gi)).toHaveLength(3);
    expect(html).toContain(
      `<base href="/signed/${encodeURIComponent("https://preview.example.com/releases/assets/v8/")}">`,
    );
    expect(html).toContain(
      '<template><base href="https://template.example.com/"></template>',
    );
    expect(html).toContain(
      '<svg><base href="https://svg.example.com/" /></svg>',
    );
    expect(seen).not.toContain("https://template.example.com/");
    expect(seen).not.toContain("https://svg.example.com/");
  });

  it("honors --!> comment endings and keeps Unicode offsets stable", async () => {
    const seen: string[] = [];
    const html = await rewriteExternalHtmlReferences({
      sourceUrl: "https://preview.example.com/app/index.html",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return `/proxy?target=${encodeURIComponent(target)}`;
      },
      html: `<!-- <base href="https://wrong.example.com/"> --!>
        <p>İstanbul</p><script>const city="İstanbul";</script>
        <img src="after-comment.png">`,
    });

    expect(seen).toEqual([
      "https://preview.example.com/app/index.html",
      "https://preview.example.com/app/after-comment.png",
    ]);
    expect(html).toContain('<script>const city="İstanbul";</script>');
  });

  it("honors the abrupt empty <!---> comment ending before later asset tags", async () => {
    const seen: string[] = [];
    const html = await rewriteExternalHtmlReferences({
      sourceUrl: "https://preview.example.com/app/index.html",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return `/proxy?target=${encodeURIComponent(target)}`;
      },
      html: `<!---><img src="after-empty-comment.png">`,
    });

    expect(seen).toEqual([
      "https://preview.example.com/app/index.html",
      "https://preview.example.com/app/after-empty-comment.png",
    ]);
    expect(html).toContain("<!--->");
  });

  it("does not terminate script raw text at an end tag in the double-escaped state", async () => {
    const seen: string[] = [];
    const html = await rewriteExternalHtmlReferences({
      sourceUrl: "https://preview.example.com/app/index.html",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return `/proxy?target=${encodeURIComponent(target)}`;
      },
      html: `<script><!--<script></script><img src="double-escaped-fake.png"></script>
        <img src="real.png">`,
    });

    expect(seen).toEqual([
      "https://preview.example.com/app/index.html",
      "https://preview.example.com/app/real.png",
    ]);
    expect(html).toContain('<img src="double-escaped-fake.png">');
  });

  it("keeps self-closing SVG style local instead of swallowing following HTML", async () => {
    const seen: string[] = [];
    await rewriteExternalHtmlReferences({
      sourceUrl: "https://preview.example.com/app/index.html",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return `/proxy?target=${encodeURIComponent(target)}`;
      },
      html: `<svg><style /><path d="M0 0" /></svg><img src="outside.svg">`,
    });

    expect(seen).toEqual([
      "https://preview.example.com/app/index.html",
      "https://preview.example.com/app/outside.svg",
    ]);
  });

  it("decodes legacy named references and Windows-1252 numeric references in URL attributes", async () => {
    const seen: string[] = [];
    await rewriteExternalHtmlReferences({
      sourceUrl: "https://preview.example.com/gallery/index.html",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return `/proxy?target=${encodeURIComponent(target)}`;
      },
      html: `<img src="images/copyright-&copy;.png"><img src="images/price-&#x80;.png">`,
    });

    expect(seen).toEqual([
      "https://preview.example.com/gallery/index.html",
      "https://preview.example.com/gallery/images/copyright-%C2%A9.png",
      "https://preview.example.com/gallery/images/price-%E2%82%AC.png",
    ]);
  });

  it("decodes the complete case-sensitive named-reference table without promoting unknown casing into a scheme", async () => {
    const seen: string[] = [];
    await rewriteExternalHtmlReferences({
      sourceUrl: "https://preview.example.com/app/index.html",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return `/proxy?target=${encodeURIComponent(target)}`;
      },
      html: `<img src="caf&eacute;.png"><img src="https&COLON;//cdn.example.com/x.png">`,
    });

    expect(seen).toEqual([
      "https://preview.example.com/app/index.html",
      "https://preview.example.com/app/caf%C3%A9.png",
      "https://preview.example.com/app/https&COLON;//cdn.example.com/x.png",
    ]);
  });

  it("follows malformed tag, abrupt-comment, and unexpected-solidus browser tokenization", async () => {
    const seen: string[] = [];
    const html = await rewriteExternalHtmlReferences({
      sourceUrl: "https://preview.example.com/app/index.html",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return `/proxy?target=${encodeURIComponent(target)}`;
      },
      html: `< base href="https://wrong.example.com/">
        <img/src="solidus.png"><!--><img src="after-comment.png">`,
    });

    expect(seen).toEqual([
      "https://preview.example.com/app/index.html",
      "https://preview.example.com/app/solidus.png",
      "https://preview.example.com/app/after-comment.png",
    ]);
    expect(html).toContain('< base href="https://wrong.example.com/">');
  });

  it("uses a foreignObject HTML base while keeping ordinary SVG and template bases inert", async () => {
    const seen: string[] = [];
    const html = await rewriteExternalHtmlReferences({
      sourceUrl: "https://preview.example.com/builds/current/index.html",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return `/signed/${encodeURIComponent(target)}`;
      },
      html: `<svg><base href="https://svg.example.com/">
          <foreignObject><template><base href="https://template.example.com/"></template>
            <base href="../authored-runtime/"></foreignObject></svg>
        <head></head><script>fetch('./state.json')</script><img src="state.json">`,
    });

    expect(seen).toEqual([
      "https://preview.example.com/builds/authored-runtime/",
      "https://preview.example.com/builds/authored-runtime/state.json",
    ]);
    expect(html.match(/<base\b/gi)).toHaveLength(3);
    expect(html).toContain('<base href="https://svg.example.com/">');
    expect(html).toContain('<base href="https://template.example.com/">');
    expect(html).not.toContain('<base href="../authored-runtime/">');
  });

  it("rewrites imagesrcset and asset-loading markup inside srcdoc", async () => {
    const seen: string[] = [];
    const html = await rewriteExternalHtmlReferences({
      sourceUrl: "https://preview.example.com/app/index.html",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return `/proxy?target=${encodeURIComponent(target)}`;
      },
      html: `<link rel="preload" as="image" imagesrcset="small.png 1x, large.png 2x">
        <iframe srcdoc="&lt;img src=&quot;inside.png&quot;&gt;"></iframe>`,
    });

    expect(seen).toEqual(
      expect.arrayContaining([
        "https://preview.example.com/app/index.html",
        "https://preview.example.com/app/small.png",
        "https://preview.example.com/app/large.png",
        "https://preview.example.com/app/inside.png",
      ]),
    );
    expect(html).toContain("imagesrcset=");
    expect(html).toContain("srcdoc=");
    expect(html).not.toContain("src=&quot;inside.png&quot;");
  });

  it("uses the redirect-final document URL and the first real authored base while preserving root and cross-origin public assets", async () => {
    const seen: string[] = [];
    const html = await rewriteExternalHtmlReferences({
      sourceUrl: "https://preview.example.com/builds/abc/index.html",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return `/proxy?target=${encodeURIComponent(target)}`;
      },
      html: `<!doctype html>
        <script>const fake = '<base href="https://wrong.example.com/">';</script>
        <!-- <base href="https://also-wrong.example.com/"> -->
        <base href="../public/v7/">
        <link id="app-css" rel="stylesheet" href="css/app.css">
        <script id="framework" src="/_next/static/chunks/app.js"></script>
        <img id="cdn" src="https://cdn.example.net/logo.svg">
        <div id="inline" style="background:url('images/card.png')"></div>`,
    });

    expect(html).not.toMatch(/<base\s+href="\.\.\/public\/v7\/">/i);
    expect(html).toContain("const fake = '<base");
    expect(seen).toEqual([
      "https://preview.example.com/builds/public/v7/",
      "https://preview.example.com/builds/public/v7/css/app.css",
      "https://preview.example.com/_next/static/chunks/app.js",
      "https://cdn.example.net/logo.svg",
      "https://preview.example.com/builds/public/v7/images/card.png",
    ]);
  });

  it("treats self-closing script and style syntax as raw text and plaintext as consuming the remainder", async () => {
    const seen: string[] = [];
    const proxyUrlFor = async (target: string) => {
      seen.push(target);
      return `/proxy?target=${encodeURIComponent(target)}`;
    };
    const rawText = await rewriteExternalHtmlReferences({
      sourceUrl: "https://preview.example.com/app/index.html",
      proxyUrlFor,
      html: `<script src="boot.js" />const fake='<img src="script-fake.png">';</script>
        <style />.hero{content:"<img src='style-fake.png'>";background:url(hero.png)}</style>
        <img src="outside.png">`,
    });

    expect(seen).toEqual([
      "https://preview.example.com/app/index.html",
      "https://preview.example.com/app/boot.js",
      "https://preview.example.com/app/hero.png",
      "https://preview.example.com/app/outside.png",
    ]);
    expect(rawText).toContain('<img src="script-fake.png">');
    expect(rawText).toContain("<img src='style-fake.png'>");

    seen.length = 0;
    const plaintext = await rewriteExternalHtmlReferences({
      sourceUrl: "https://preview.example.com/app/index.html",
      proxyUrlFor,
      html: `<plaintext /><base href="https://wrong.example.com/"><img src="plaintext.png">`,
    });
    expect(seen).toEqual(["https://preview.example.com/app/index.html"]);
    expect(plaintext).toContain(
      '<base href="https://wrong.example.com/"><img src="plaintext.png">',
    );
  });

  it("decodes URL named entities and semicolon-optional legacy entities for authored bases and references", async () => {
    const seen: string[] = [];
    const html = await rewriteExternalHtmlReferences({
      sourceUrl: "https://preview.example.com/app/index.html",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return `/proxy?target=${encodeURIComponent(target)}`;
      },
      html: `<base href="https&colon;//assets.example.net/v7/">
        <script src="scripts/app.js?mode=review&amp#entry"></script>
        <img src="https&colon;//cdn.example.org/image.png">`,
    });

    expect(seen).toEqual([
      "https://assets.example.net/v7/",
      "https://assets.example.net/v7/scripts/app.js?mode=review&#entry",
      "https://cdn.example.org/image.png",
    ]);
    expect(html.match(/<base\b/gi)).toHaveLength(1);
  });

  it("rewrites srcset candidates, preserving data URLs, descriptors, fragments, and HTML entity semantics", async () => {
    const seen: string[] = [];
    const html = await rewriteExternalHtmlReferences({
      sourceUrl: "https://preview.example.com/gallery/index.html",
      proxyUrlFor: async (target) => {
        seen.push(target);
        return `/proxy?target=${encodeURIComponent(target)}&proof=ok`;
      },
      html: `<img id="responsive" src="images/a&amp;b.png" srcset="data:image/png;base64,AAAA 1x, images/large.png 2x, #local 3x">
        <div title='href="https://attacker.example/"' data-note="unchanged"></div>
        <a id="encoded-query" title="2 > 1" href="page.html?a=1&amp;b=2">Page</a>`,
    });

    expect(seen).toEqual([
      "https://preview.example.com/gallery/index.html",
      "https://preview.example.com/gallery/images/a&b.png",
      "https://preview.example.com/gallery/images/large.png",
      "https://preview.example.com/gallery/page.html?a=1&b=2",
    ]);
    const src = tagAttribute(html, 'id="responsive"', "src");
    expect(absoluteProxyUrl(src).searchParams.get("target")).toBe(
      "https://preview.example.com/gallery/images/a&b.png",
    );
    const srcset = tagAttribute(html, 'id="responsive"', "srcset");
    expect(srcset).toContain("data:image/png;base64,AAAA 1x");
    expect(srcset).toContain(" 2x");
    expect(srcset).toContain("#local 3x");
    expect(html).toContain(`title='href="https://attacker.example/"'`);
    const encodedQuery = tagAttribute(html, 'id="encoded-query"', "href");
    expect(absoluteProxyUrl(encodedQuery).searchParams.get("target")).toBe(
      "https://preview.example.com/gallery/page.html?a=1&b=2",
    );
    expect(html).not.toContain("&amp;amp;");
    expect(html).toContain('title="2 > 1"');
  });

  it("HTML-escapes proxy output and removes integrity without rewriting attribute-looking text", async () => {
    const html = await rewriteExternalHtmlReferences({
      sourceUrl: "https://preview.example.com/index.html",
      proxyUrlFor: async () =>
        '/proxy?proof="><script>alert(1)</script>&ok=yes',
      html: `<img id="safe" alt='src="do-not-rewrite.png"' src="image.png" integrity="sha384-value">`,
    });

    expect(html).not.toContain("integrity=");
    expect(html).toContain(`alt='src="do-not-rewrite.png"'`);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain(
      "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;ok=yes",
    );
  });

  it("accepts the exact buffered fast-path HTML boundary and rejects one byte beyond it", async () => {
    let calls = 0;
    const atBoundary = "a".repeat(EXTERNAL_REWRITE_FAST_PATH_BYTES);
    await expect(
      rewriteExternalHtmlReferences({
        sourceUrl: "https://preview.example.com/index.html",
        html: atBoundary,
        proxyUrlFor: async () => {
          calls += 1;
          return "/proxy";
        },
      }),
    ).resolves.toContain(atBoundary);
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      rewriteExternalHtmlReferences({
        sourceUrl: "https://preview.example.com/index.html",
        html: "a".repeat(EXTERNAL_REWRITE_FAST_PATH_BYTES + 1),
        proxyUrlFor: async () => {
          calls += 1;
          return "/proxy";
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("allows 4,096 authored document references and rejects the 4,097th independently of byte size", async () => {
    let calls = 0;
    await expect(
      rewriteExternalHtmlReferences({
        sourceUrl: "https://preview.example.com/index.html",
        html: Array.from(
          { length: 4_096 },
          (_, index) => `<img src="asset-${index}.png">`,
        ).join(""),
        proxyUrlFor: async () => {
          calls += 1;
          return "/proxy";
        },
      }),
    ).resolves.toContain('<img src="/proxy">');
    expect(calls).toBe(4_097);

    calls = 0;
    await expect(
      rewriteExternalHtmlReferences({
        sourceUrl: "https://preview.example.com/index.html",
        html: Array.from(
          { length: 4_097 },
          (_, index) => `<img src="asset-${index}.png">`,
        ).join(""),
        proxyUrlFor: async () => {
          calls += 1;
          return "/proxy";
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(4_097);
  });
});
