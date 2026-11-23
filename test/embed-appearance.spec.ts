// Per-site Appearance for the website widget. An editor chooses a theme, an
// accent color and a default corner on "Connect a website"; every Shiplet page
// inside the widget then links /api/embed/theme.css for that installation.
// With no appearance the stylesheet is empty and nothing looks different.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import app from "../src/index";
import {
  contrastRatio,
  EMBED_THEME_PALETTES,
  embedThemeCss,
  onAccentColor,
  readEmbedAppearance,
} from "../src/embed-appearance";
import { embedWidgetScript, EMBED_WIDGET_CSS } from "../src/embed-widget";

type TestEnv = Omit<Env, "SHIPLET_ENABLED_FEATURE_FLAGS"> & { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET?: string };
const testEnv = env as unknown as TestEnv;

const OWNER = { "x-shiplet-user-id": "user_appearance_owner", "x-shiplet-user-email": "appearance-owner@example.com" };
const OUTSIDER = { "x-shiplet-user-id": "user_appearance_outsider", "x-shiplet-user-email": "appearance-outsider@example.com" };
const SITE_ORIGIN = "https://gavel.example.com";

async function request(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(`http://localhost${path}`, init), env as Env, context);
  await waitOnExecutionContext(context);
  return response;
}

afterEach(() => {
  delete testEnv.TURNSTILE_SITE_KEY;
  delete testEnv.TURNSTILE_SECRET;
});

const json = (headers: Record<string, string>, body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

function setupForm(headers: Record<string, string>, fields: Record<string, string>): RequestInit {
  return { method: "POST", headers: { ...headers, Origin: "http://localhost" }, body: new URLSearchParams(fields) };
}

async function connectedSite() {
  const organization = await request("/api/organizations", json(OWNER, { name: `Appearance ${crypto.randomUUID()}` }));
  const organizationId = ((await organization.json()) as { organization: { id: string } }).organization.id;
  const created = await request(
    "/api/shiplets",
    json(OWNER, { name: "Gavel Drop", organization_id: organizationId, subdomain: `appearance-${crypto.randomUUID().slice(0, 8)}`, external_url: `${SITE_ORIGIN}/` }),
  );
  const projectId = ((await created.json()) as { project: { id: string } }).project.id;
  const installed = await request("/embed/install", setupForm(OWNER, { project_id: projectId, site_url: `${SITE_ORIGIN}/` }));
  expect(installed.status).toBe(200);
  const row = await testEnv.DB.prepare("SELECT id FROM embed_installations WHERE project_id = ? AND revoked_on IS NULL").bind(projectId).first<{ id: string }>();
  return { projectId, installationId: row!.id };
}

function saveAppearance(projectId: string, installationId: string, fields: Record<string, string>, headers = OWNER) {
  return request("/embed/install", setupForm(headers, { project_id: projectId, installation_id: installationId, action: "appearance_save", ...fields }));
}

async function storedAppearance(installationId: string) {
  const row = await testEnv.DB.prepare("SELECT appearance FROM embed_installations WHERE id = ?").bind(installationId).first<{ appearance: string | null }>();
  return row?.appearance ?? null;
}

const GAVEL = { theme: "dark", accent: "#f4b740", position: "bottom-left" };

function themeLink(html: string) {
  const match = html.match(/<link rel="stylesheet" href="([^"]*\/api\/embed\/theme\.css\?[^"]*)">/);
  return match ? new URL(match[1].replace(/&amp;|&#38;/g, "&")) : null;
}

function expectNoInlineStyles(html: string) {
  expect(html).not.toMatch(/<style[\s>]/i);
  expect(html).not.toMatch(/\sstyle=/i);
}

describe("widget appearance", () => {
  it("lets only an editor save an appearance, and resets it to Shiplet's default", async () => {
    const { projectId, installationId } = await connectedSite();
    const page = await (await request(`/embed/install?project_id=${projectId}`, { headers: OWNER })).text();
    expect(page).toContain("<h3>Appearance</h3>");
    expect(page).toContain('value="appearance_save"');
    expect(page).toContain('type="color"');
    expect(page).toContain("Match the visitor&#39;s system");

    await request("/api/me", { headers: OUTSIDER });
    const refused = await saveAppearance(projectId, installationId, GAVEL, OUTSIDER);
    expect(refused.status).toBe(403);
    expect(await storedAppearance(installationId)).toBeNull();

    const crossSite = await request("/embed/install", {
      method: "POST",
      headers: { ...OWNER, Origin: "https://evil.example" },
      body: new URLSearchParams({ project_id: projectId, installation_id: installationId, action: "appearance_save", ...GAVEL }),
    });
    expect(crossSite.status).toBe(403);
    expect(await storedAppearance(installationId)).toBeNull();

    const saved = await saveAppearance(projectId, installationId, GAVEL);
    expect(saved.status).toBe(200);
    const savedPage = await saved.text();
    expect(savedPage).toContain("Appearance saved.");
    expect(savedPage).toContain('value="#f4b740"');
    expect(readEmbedAppearance(await storedAppearance(installationId))).toEqual(GAVEL);

    const reset = await request("/embed/install", setupForm(OWNER, { project_id: projectId, installation_id: installationId, action: "appearance_reset" }));
    expect(reset.status).toBe(200);
    expect(await reset.text()).toContain("Appearance reset to Shiplet&#39;s default.");
    expect(await storedAppearance(installationId)).toBeNull();

    // An installation of another project is not this editor's to style.
    const other = await connectedSite();
    expect((await saveAppearance(projectId, other.installationId, GAVEL)).status).toBe(404);
    expect(await storedAppearance(other.installationId)).toBeNull();
  });

  it("refuses an invalid theme, accent or position", async () => {
    const { projectId, installationId } = await connectedSite();
    for (const invalid of [
      { ...GAVEL, theme: "sepia" },
      { ...GAVEL, theme: "" },
      { ...GAVEL, accent: "#F4B740" },
      { ...GAVEL, accent: "#fff" },
      { ...GAVEL, accent: "f4b740" },
      { ...GAVEL, accent: "#f4b740;color:red" },
      { ...GAVEL, accent: "red" },
      { ...GAVEL, position: "center" },
      { ...GAVEL, position: "bottom-left " },
      { theme: "dark", accent: "#f4b740" },
    ]) {
      const response = await saveAppearance(projectId, installationId, invalid as Record<string, string>);
      expect(response.status, JSON.stringify(invalid)).toBe(400);
    }
    expect(await storedAppearance(installationId)).toBeNull();
  });

  it("serves theme.css: empty when unset, tokens for each theme, versioned by the appearance", async () => {
    const { projectId, installationId } = await connectedSite();
    const unset = await request(`/api/embed/theme.css?installation_id=${installationId}`);
    expect(unset.status).toBe(200);
    expect(unset.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(unset.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await unset.text()).toBe("");
    const unsetVersion = unset.headers.get("etag");
    expect(unsetVersion).toBeTruthy();

    expect((await request("/api/embed/theme.css?installation_id=embed_installation_missing")).status).toBe(404);
    expect((await request("/api/embed/theme.css?installation_id=%3Cscript%3E")).status).toBe(404);

    await saveAppearance(projectId, installationId, GAVEL);
    const start = await (await request(`/embed/review/start?${new URLSearchParams({ installation_id: installationId, return_url: `${SITE_ORIGIN}/lots/` })}`)).text();
    const link = themeLink(start)!;
    const version = link.searchParams.get("v")!;
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    expect(`"${version}"`).not.toBe(unsetVersion);

    // The exact version is immutable; anything else revalidates, so a change shows at once.
    const pinned = await request(`${link.pathname}${link.search}`);
    expect(pinned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const css = await pinned.text();
    expect(css).toContain("color-scheme:dark");
    expect(css).toContain("--shiplet-surface:#111a33");
    expect(css).toContain("--shiplet-action:#f4b740");
    expect(css).toContain("--shiplet-on-action:#111827");
    expect(css).toContain(":host(:not([data-dock]))");
    const unversioned = await request(`/api/embed/theme.css?installation_id=${installationId}`);
    expect(unversioned.headers.get("cache-control")).toBe("no-cache");
    expect(unversioned.headers.get("etag")).toBe(`"${version}"`);
    expect(await unversioned.text()).toBe(css);
    const stale = await request(`/api/embed/theme.css?installation_id=${installationId}&v=0000000000000000`);
    expect(stale.headers.get("cache-control")).toBe("no-cache");

    await saveAppearance(projectId, installationId, { ...GAVEL, accent: "#3355cc" });
    const changed = themeLink(await (await request(`/embed/review/start?${new URLSearchParams({ installation_id: installationId, return_url: `${SITE_ORIGIN}/lots/` })}`)).text())!;
    expect(changed.searchParams.get("v")).not.toBe(version);
    expect(await (await request(`${changed.pathname}${changed.search}`)).text()).toContain("--shiplet-on-action:#ffffff");
  });

  it("derives token sets for light, dark and auto, with readable text on any accent", () => {
    expect(embedThemeCss(null)).toBe("");

    const light = embedThemeCss({ theme: "light", accent: "#b44729", position: "bottom-right" });
    expect(light).toContain("color-scheme:light;");
    expect(light).toContain("--shiplet-surface:#fbf9f4");
    expect(light).toContain("--shiplet-raised:#ffffff");
    expect(light).not.toContain("prefers-color-scheme");
    expect(light).not.toContain("#111a33");
    // The default corner adds no position rules a site has not asked for beyond its own corner.
    expect(light).toContain(":host(:not([data-dock])){bottom:0;top:auto;right:0;left:auto}");

    const dark = embedThemeCss({ theme: "dark", accent: "#f4b740", position: "top-left" });
    expect(dark).toContain("color-scheme:dark;");
    expect(dark).toContain("iframe{color-scheme:dark}");
    expect(dark).not.toContain("prefers-color-scheme");
    expect(dark).toContain(".overlay-toggle{top:80px;bottom:auto}");
    expect(dark).toContain(".overlay-toggle{left:8px;right:auto}");
    expect(dark).toContain(".shiplet-review-launcher-dock:not([data-review-dock]){top:max(12px,env(safe-area-inset-top));bottom:auto;left:max(12px,env(safe-area-inset-left));right:auto}");

    const auto = embedThemeCss({ theme: "auto", accent: "#f4b740", position: "bottom-right" });
    const [beforeMedia, insideMedia] = auto.split("@media (prefers-color-scheme:dark){");
    expect(beforeMedia).toContain("--shiplet-surface:#fbf9f4");
    expect(insideMedia).toContain("--shiplet-surface:#111a33");
    expect(auto).toContain("color-scheme:light dark");

    // A light accent gets near-black text, a dark accent white, and both read at AA.
    expect(onAccentColor("#f4b740")).toBe("#111827");
    expect(onAccentColor("#1d3b8f")).toBe("#ffffff");
    for (const accent of ["#f4b740", "#1d3b8f", "#b44729", "#00ff00", "#777777", "#ffffff", "#000000"]) {
      const on = onAccentColor(accent);
      expect(contrastRatio(accent, on), accent).toBeGreaterThanOrEqual(4.5);
      const css = embedThemeCss({ theme: "dark", accent, position: "bottom-right" });
      const hover = css.match(/--shiplet-action-hover:(#[0-9a-f]{6})/)![1];
      expect(contrastRatio(hover, on), `${accent} hover`).toBeGreaterThanOrEqual(contrastRatio(accent, on) - 0.01);
    }
    expect(embedThemeCss({ theme: "dark", accent: "#f4b740", position: "bottom-right" })).toContain("--shiplet-on-action:#111827");
    expect(embedThemeCss({ theme: "dark", accent: "#1d3b8f", position: "bottom-right" })).toContain("--shiplet-on-action:#ffffff");
  });

  it("keeps every dark-theme text color at WCAG AA on every dark background", () => {
    const dark = EMBED_THEME_PALETTES.dark;
    for (const text of ["ink", "ink-soft", "muted", "accent", "info", "danger"] as const) {
      for (const background of ["surface", "raised", "tint", "wash", "chip", "mark"] as const) {
        expect(contrastRatio(dark[text], dark[background]), `${text} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrastRatio(dark.danger, dark["danger-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.ink, dark.select)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.ink, dark["warn-bg"])).toBeGreaterThanOrEqual(4.5);
  });

  it("links theme.css from every Shiplet page inside the widget, with no inline styles", async () => {
    testEnv.TURNSTILE_SITE_KEY = "0x4AAAAAAAtest-site-key";
    testEnv.TURNSTILE_SECRET = "test-secret-not-real";
    const { projectId, installationId } = await connectedSite();
    await request("/embed/install", setupForm(OWNER, { project_id: projectId, action: "visitors_on", installation_id: installationId }));
    await saveAppearance(projectId, installationId, GAVEL);
    const startPath = `/embed/review/start?${new URLSearchParams({ installation_id: installationId, return_url: `${SITE_ORIGIN}/lots/` })}`;

    // Signed out: the bootstrap toolbar.
    const start = await request(startPath);
    const startHtml = await start.text();
    const startLink = themeLink(startHtml)!;
    expect(startLink.searchParams.get("installation_id")).toBe(installationId);
    expect(startHtml.indexOf("/api/review/host.css")).toBeLessThan(startHtml.indexOf("/api/embed/theme.css"));
    expect(start.headers.get("content-security-policy")).toContain("style-src 'self'");
    expect(start.headers.get("content-security-policy")).toContain("style-src-attr 'none'");
    expectNoInlineStyles(startHtml);

    // The visitor frame.
    const visitor = await request(`/embed/visitor/frame?installation_id=${installationId}&return_url=${encodeURIComponent(`${SITE_ORIGIN}/lots/`)}`);
    const visitorHtml = await visitor.text();
    expect(themeLink(visitorHtml)?.searchParams.get("v")).toBe(startLink.searchParams.get("v"));
    expect(visitorHtml.indexOf("/api/embed/visitor.css")).toBeLessThan(visitorHtml.indexOf("/api/embed/theme.css"));
    expect(visitor.headers.get("content-security-policy")).toContain("style-src 'self'");
    expectNoInlineStyles(visitorHtml);

    // Signed in: the review host, which also carries the Agents panel.
    const signedIn = await request(startPath, { headers: OWNER, redirect: "manual" });
    expect(signedIn.status).toBe(302);
    const host = await request(new URL(signedIn.headers.get("location")!).pathname + new URL(signedIn.headers.get("location")!).search, {
      headers: { Cookie: signedIn.headers.get("set-cookie")!.split(";", 1)[0] },
    });
    expect(host.status).toBe(200);
    const hostHtml = await host.text();
    expect(themeLink(hostHtml)?.searchParams.get("v")).toBe(startLink.searchParams.get("v"));
    expect(hostHtml.indexOf("/api/review/host.css")).toBeLessThan(hostHtml.indexOf("/api/embed/theme.css"));
    expect(hostHtml).toContain('data-review-site-dock="bottom-left"');
    expect(host.headers.get("content-security-policy")).toContain("style-src http://localhost");
    expectNoInlineStyles(hostHtml);

    // The widget's shadow root on the site links the theme after its own stylesheet.
    const script = embedWidgetScript();
    expect(script).toContain('"/api/embed/theme.css?installation_id="');
    expect(script).toContain('<link rel="stylesheet"><link rel="stylesheet">');
    const widgetClass = script.slice(script.indexOf("class ShipletFeedback"));
    expect(widgetClass).not.toMatch(/setAttribute\("style"|\.style\.cssText|<style|style=/);
  });

  it("changes nothing for a site without an appearance", async () => {
    const { installationId } = await connectedSite();
    const startHtml = await (await request(`/embed/review/start?${new URLSearchParams({ installation_id: installationId, return_url: `${SITE_ORIGIN}/` })}`)).text();
    const link = themeLink(startHtml)!;
    expect(await (await request(`${link.pathname}${link.search}`)).text()).toBe("");
    expect(startHtml).not.toContain("data-review-dock");
    expect(startHtml).toContain('<div class="shiplet-review-launcher-dock">');
  });
});

describe("widget stylesheet", () => {
  it("defaults its tokens to today's light look and keeps the overlay toggle off open panels", () => {
    expect(EMBED_WIDGET_CSS).toContain("--shiplet-surface:#fbf9f4");
    expect(EMBED_WIDGET_CSS).toContain("--shiplet-pin:#a73f28");
    // Every color in the widget stylesheet comes from a token defined on :host.
    const rules = EMBED_WIDGET_CSS.replace(/:host\{[^}]*\}/, "");
    expect(rules).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    for (const dock of ["top-left", "top-right"]) expect(EMBED_WIDGET_CSS).toContain(`:host([data-dock=${dock}]) .overlay-toggle`);
    const script = embedWidgetScript();
    expect(script).toContain("syncOverlayToggle");
  });
});
