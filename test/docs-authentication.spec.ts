import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";

async function page(path: string) {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(`http://localhost${path}`), env as Env, context);
  await waitOnExecutionContext(context);
  const html = await response.text();
  const article = html.match(/<div class="docs-content">([\s\S]*?)<\/div>\s*<\/article>/)?.[1] || "";
  const declared = html.match(/data-shiplet-docs-content-sha256="([a-f0-9]{64})"/)?.[1];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(article.replace(/\r\n?/g, "\n").trim()));
  return { status: response.status, html, article, declared, rendered: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
}

describe("choosing how to sign in (docs)", () => {
  it("steers people and agents to OAuth and keeps API keys for automation", async () => {
    const guide = await page("/docs/authentication");
    expect(guide.status).toBe(200);
    expect(guide.article).toContain("shiplet login --device");
    expect(guide.article).toContain("unattended automation");
    expect(guide.article).toContain("Do not give a key to an interactive agent");
    expect(guide.html).toContain('href="/docs/authentication" aria-current="page"');

    const cli = await page("/docs/cli");
    expect(cli.article).toContain("No browser on this computer");
    expect(cli.article).not.toContain("For a remote or headless agent, use a narrowly scoped organization API key");
    for (const path of ["/docs/cli", "/docs/api-keys", "/docs/code-mode-mcp", "/docs/traces"]) {
      expect((await page(path)).article, path).toContain('href="/docs/authentication"');
    }
  });

  it("pins the content digest of every page it changed", async () => {
    for (const path of ["/docs/authentication", "/docs/cli", "/docs/api-keys", "/docs/code-mode-mcp", "/docs/traces", "/docs/embed", "/docs/browser-capture"]) {
      const result = await page(path);
      expect(result.declared, path).toBe(result.rendered);
    }
  });
});
