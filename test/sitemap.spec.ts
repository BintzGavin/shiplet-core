import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { sitemapXml } from "../src/seo";
import type { Env } from "../src/env";

async function request(path: string, appUrl = "https://shiplet.cc") {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(`http://localhost${path}`), {
    ...(env as unknown as Env),
    SHIPLET_APP_URL: appUrl,
  } as unknown as Env, context);
  await waitOnExecutionContext(context);
  return response;
}

function locations(xml: string) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
}

describe("public sitemap", () => {
  it("discovers exactly the homepage and every current guide in the public navigation", async () => {
    const html = await (await request("/docs")).text();
    const nav = html.match(/<nav\b[^>]*aria-label="Documentation sections"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
    expect(nav).toBeTruthy();
    const guidePaths = [...nav!.matchAll(/href="(\/docs(?:\/[^"?#]+)?)"/g)].map((match) => match[1]);
    expect(guidePaths).toContain("/docs/embed");
    expect(guidePaths).toContain("/docs/browser-capture");
    const urls = locations(await (await request("/sitemap.xml")).text());
    expect(urls).toHaveLength(new Set(urls).size);
    expect(urls.sort()).toEqual(["/", ...guidePaths].map((path) => `https://shiplet.cc${path}`).sort());
  });

  it("lists only successful, indexable HTML pages with matching canonical URLs", async () => {
    const response = await request("/sitemap.xml");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/xml");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const xml = await response.text();
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    const urls = locations(xml);
    expect(urls.length).toBeGreaterThan(1);
    for (const url of urls) {
      const target = new URL(url);
      expect(target.origin).toBe("https://shiplet.cc");
      expect(target.search).toBe("");
      expect(target.hash).toBe("");
      const page = await request(target.pathname);
      expect(page.status, url).toBe(200);
      expect(page.headers.get("content-type"), url).toContain("text/html");
      expect(page.headers.get("x-robots-tag") ?? "", url).not.toContain("noindex");
      const html = await page.text();
      expect(html, url).toContain(`<link rel="canonical" href="${url}">`);
      const directives = html.match(/<meta name="robots" content="([^"]+)">/)?.[1].split(",");
      expect(directives, url).toEqual(expect.arrayContaining(["index", "follow"]));
      expect(directives, url).not.toContain("noindex");
    }
  });

  it("excludes aliases, retired guides, private work and non-HTML resources", async () => {
    const paths = locations(await (await request("/sitemap.xml")).text()).map((url) => new URL(url).pathname);
    for (const path of ["/docs/introduction", "/docs/wordpress", "/docs/cli", "/docs/deployment", "/docs/external-setup", "/docs/packages-revisions", "/capture", "/downloads/shiplet-browser-companion.zip", "/workspace", "/auth/login", "/api/shiplets", "/shiplets", "/play", "/llms.txt", "/openapi.json"]) {
      expect(paths).not.toContain(path);
    }
  });

  it("advertises the same canonical deployment origin in robots and every sitemap location", async () => {
    const origin = "https://reviews.example";
    const robots = await request("/robots.txt", `${origin}/`);
    expect(robots.status).toBe(200);
    expect(await robots.text()).toContain(`Sitemap: ${origin}/sitemap.xml`);
    const urls = locations(await (await request("/sitemap.xml", `${origin}/`)).text());
    expect(urls.length).toBeGreaterThan(1);
    expect(urls.every((url) => url.startsWith(`${origin}/`))).toBe(true);
  });

  it("escapes XML locations and omits invented update metadata", () => {
    const xml = sitemapXml("https://reviews.example/work&notes");
    expect(xml).toContain("<loc>https://reviews.example/work&amp;notes/</loc>");
    expect(xml).not.toContain("work&notes");
    expect(xml).not.toMatch(/<(lastmod|changefreq|priority)>/);
  });
});
