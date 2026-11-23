// "Toolbar for the public": a connected site can show the public only the
// visitor Feedback button. The site's team still opens the full toolbar by
// adding ?shiplet=review to the page address, which the widget turns into
// team=1 on /embed/review/start. A signed-in reviewer always gets the review
// host. This is a display choice, not access control.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { readEmbedPublicToolbar } from "../src/embed-public-toolbar";
import { embedWidgetScript, EMBED_WIDGET_CSS } from "../src/embed-widget";

type TestEnv = Omit<Env, "SHIPLET_ENABLED_FEATURE_FLAGS"> & { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET?: string };
const testEnv = env as unknown as TestEnv;

const OWNER = { "x-shiplet-user-id": "user_public_toolbar_owner", "x-shiplet-user-email": "public-toolbar-owner@example.com" };
const OUTSIDER = { "x-shiplet-user-id": "user_public_toolbar_outsider", "x-shiplet-user-email": "public-toolbar-outsider@example.com" };
const SITE_ORIGIN = "https://gavel.example.com";

async function request(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(`http://localhost${path}`, init), env as Env, context);
  await waitOnExecutionContext(context);
  return response;
}

function turnstileKeys() {
  testEnv.TURNSTILE_SITE_KEY = "0x4AAAAAAAtest-site-key";
  testEnv.TURNSTILE_SECRET = "test-secret-not-real";
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
  const organization = await request("/api/organizations", json(OWNER, { name: `Public toolbar ${crypto.randomUUID()}` }));
  const organizationId = ((await organization.json()) as { organization: { id: string } }).organization.id;
  const created = await request(
    "/api/shiplets",
    json(OWNER, { name: "Gavel Drop", organization_id: organizationId, subdomain: `public-toolbar-${crypto.randomUUID().slice(0, 8)}`, external_url: `${SITE_ORIGIN}/` }),
  );
  const projectId = ((await created.json()) as { project: { id: string } }).project.id;
  const installed = await request("/embed/install", setupForm(OWNER, { project_id: projectId, site_url: `${SITE_ORIGIN}/` }));
  expect(installed.status).toBe(200);
  const row = await testEnv.DB.prepare("SELECT id FROM embed_installations WHERE project_id = ? AND revoked_on IS NULL").bind(projectId).first<{ id: string }>();
  return { projectId, installationId: row!.id };
}

function savePublicToolbar(projectId: string, installationId: string, value: string | null, headers = OWNER) {
  const fields: Record<string, string> = { project_id: projectId, installation_id: installationId, action: "public_toolbar" };
  if (value !== null) fields.public_toolbar = value;
  return request("/embed/install", setupForm(headers, fields));
}

async function storedPublicToolbar(installationId: string) {
  const row = await testEnv.DB.prepare("SELECT public_toolbar FROM embed_installations WHERE id = ?").bind(installationId).first<{ public_toolbar: string | null }>();
  return row?.public_toolbar ?? null;
}

function startPath(installationId: string, extra: Record<string, string> = {}) {
  return `/embed/review/start?${new URLSearchParams({ installation_id: installationId, return_url: `${SITE_ORIGIN}/lots/`, ...extra })}`;
}

type Toolbar = "full" | "full+feedback" | "feedback" | "hidden";

function toolbarOf(html: string): Toolbar {
  const annotate = html.includes('data-shiplet-embed-action="annotate"');
  const comments = html.includes('data-shiplet-embed-action="comments"');
  const feedback = html.includes("data-shiplet-visitor-url=");
  expect(annotate, "Annotate and Comments come together").toBe(comments);
  if (annotate) return feedback ? "full+feedback" : "full";
  if (feedback) return "feedback";
  return "hidden";
}

// Everything but the per-response nonce.
const withoutNonce = (html: string) => html.replace(/nonce="[^"]*"/g, 'nonce=""');

describe("toolbar for the public: the setting", () => {
  it("lets only an editor choose it, with a status message, and shows the choice on the setup page", async () => {
    const { projectId, installationId } = await connectedSite();
    const page = await (await request(`/embed/install?project_id=${projectId}`, { headers: OWNER })).text();
    expect(page).toContain("<h3>Toolbar for the public</h3>");
    expect(page).toContain('value="public_toolbar"');
    expect(page).toMatch(/<input type="radio" name="public_toolbar" value="full" checked>/);
    expect(page).toMatch(/<input type="radio" name="public_toolbar" value="feedback_only">/);
    expect(page).toContain("Annotate, Comments and Feedback");
    expect(page).toContain("?shiplet=review");

    await request("/api/me", { headers: OUTSIDER });
    expect((await savePublicToolbar(projectId, installationId, "feedback_only", OUTSIDER)).status).toBe(403);
    expect(await storedPublicToolbar(installationId)).toBeNull();

    const crossSite = await request("/embed/install", {
      method: "POST",
      headers: { ...OWNER, Origin: "https://evil.example" },
      body: new URLSearchParams({ project_id: projectId, installation_id: installationId, action: "public_toolbar", public_toolbar: "feedback_only" }),
    });
    expect(crossSite.status).toBe(403);
    expect(await storedPublicToolbar(installationId)).toBeNull();

    const saved = await savePublicToolbar(projectId, installationId, "feedback_only");
    expect(saved.status).toBe(200);
    const savedPage = await saved.text();
    expect(savedPage).toMatch(/role="status"[^>]*>Toolbar for the public: Feedback only\./);
    expect(savedPage).toMatch(/<input type="radio" name="public_toolbar" value="feedback_only" checked>/);
    expect(await storedPublicToolbar(installationId)).toBe("feedback_only");

    const back = await savePublicToolbar(projectId, installationId, "full");
    expect(back.status).toBe(200);
    expect(await back.text()).toMatch(/role="status"[^>]*>Toolbar for the public: Annotate, Comments and Feedback\./);
    expect(await storedPublicToolbar(installationId)).toBeNull();

    // An installation of another project is not this editor's to change.
    const other = await connectedSite();
    expect((await savePublicToolbar(projectId, other.installationId, "feedback_only")).status).toBe(404);
    expect(await storedPublicToolbar(other.installationId)).toBeNull();
  });

  it("refuses any value but the two choices, and changes nothing", async () => {
    const { projectId, installationId } = await connectedSite();
    await savePublicToolbar(projectId, installationId, "feedback_only");
    for (const invalid of [null, "", "FEEDBACK_ONLY", "feedback_only ", " feedback_only", "feedback-only", "Feedback only", "none", "hidden", "null", "full,feedback_only"]) {
      const response = await savePublicToolbar(projectId, installationId, invalid);
      expect(response.status, JSON.stringify(invalid)).toBe(400);
    }
    expect(await storedPublicToolbar(installationId)).toBe("feedback_only");
    // A repeated field is ambiguous, so it is refused too.
    const doubled = await request("/embed/install", {
      method: "POST",
      headers: { ...OWNER, Origin: "http://localhost" },
      body: `project_id=${projectId}&installation_id=${installationId}&action=public_toolbar&public_toolbar=full&public_toolbar=feedback_only`,
    });
    expect(doubled.status).toBe(400);
    expect(await storedPublicToolbar(installationId)).toBe("feedback_only");
  });

  it("explains on the setup page that the public sees nothing while visitor feedback is off", async () => {
    turnstileKeys();
    const { projectId, installationId } = await connectedSite();
    const warning = "the public sees no Shiplet toolbar at all";
    await savePublicToolbar(projectId, installationId, "feedback_only");
    expect(await (await request(`/embed/install?project_id=${projectId}`, { headers: OWNER })).text()).toContain(warning);
    await request("/embed/install", setupForm(OWNER, { project_id: projectId, installation_id: installationId, action: "visitors_on" }));
    expect(await (await request(`/embed/install?project_id=${projectId}`, { headers: OWNER })).text()).not.toContain(warning);
    await savePublicToolbar(projectId, installationId, "full");
    await request("/embed/install", setupForm(OWNER, { project_id: projectId, installation_id: installationId, action: "visitors_off" }));
    expect(await (await request(`/embed/install?project_id=${projectId}`, { headers: OWNER })).text()).not.toContain(warning);
  });

  it("reads only the exact stored value; anything else keeps today's toolbar", () => {
    expect(readEmbedPublicToolbar("feedback_only")).toBe("feedback_only");
    for (const value of [null, undefined, "", "full", "FEEDBACK_ONLY", "feedback_only ", 1, {}]) expect(readEmbedPublicToolbar(value)).toBeNull();
  });
});

describe("toolbar for the public: the signed-out start page", () => {
  const cases: Array<{ setting: "feedback_only" | null; visitors: boolean; team: boolean; expected: Toolbar }> = [
    { setting: null, visitors: true, team: false, expected: "full+feedback" },
    { setting: null, visitors: true, team: true, expected: "full+feedback" },
    { setting: null, visitors: false, team: false, expected: "full" },
    { setting: null, visitors: false, team: true, expected: "full" },
    { setting: "feedback_only", visitors: true, team: false, expected: "feedback" },
    { setting: "feedback_only", visitors: true, team: true, expected: "full+feedback" },
    { setting: "feedback_only", visitors: false, team: false, expected: "hidden" },
    { setting: "feedback_only", visitors: false, team: true, expected: "full" },
  ];
  for (const { setting, visitors, team, expected } of cases) {
    it(`renders ${expected} for setting ${setting ?? "null"}, visitor feedback ${visitors ? "on" : "off"}, ${team ? "team=1" : "no team param"}`, async () => {
      turnstileKeys();
      const { projectId, installationId } = await connectedSite();
      if (visitors) await request("/embed/install", setupForm(OWNER, { project_id: projectId, installation_id: installationId, action: "visitors_on" }));
      if (setting) await savePublicToolbar(projectId, installationId, setting);
      const response = await request(startPath(installationId, team ? { team: "1" } : {}));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(toolbarOf(html)).toBe(expected);
      if (expected === "hidden") {
        expect(html).not.toContain("shiplet-review-launcher-dock");
        expect(html).toContain("/api/embed/auth-bootstrap.js");
      }
      if (expected === "feedback") {
        expect(html).toMatch(/<div class="shiplet-review-launcher-dock"><button type="button" class="shiplet-review-launcher" data-shiplet-visitor-url="[^"]*" aria-label="Leave feedback without an account">Feedback<\/button><\/div>/);
        expect(html).not.toContain("team=1");
      }
      // The team's Feedback button keeps the reveal when the visitor panel closes.
      if (setting && team && visitors) expect(html).toMatch(/data-shiplet-visitor-url="[^"]*team=1/);
    });
  }

  it("keeps today's exact page for a site without the setting, with or without team=1", async () => {
    turnstileKeys();
    const { projectId, installationId } = await connectedSite();
    await request("/embed/install", setupForm(OWNER, { project_id: projectId, installation_id: installationId, action: "visitors_on" }));
    const plain = withoutNonce(await (await request(startPath(installationId))).text());
    const team = withoutNonce(await (await request(startPath(installationId, { team: "1" }))).text());
    expect(team).toBe(plain);
    expect(plain).toContain('<body><div class="shiplet-review-launcher-dock"><button type="button" class="shiplet-review-launcher" data-shiplet-embed-action="annotate"');
    expect(plain).not.toContain("team=1");
  });

  it("only treats team=1 as the team's reveal", async () => {
    turnstileKeys();
    const { projectId, installationId } = await connectedSite();
    await request("/embed/install", setupForm(OWNER, { project_id: projectId, installation_id: installationId, action: "visitors_on" }));
    await savePublicToolbar(projectId, installationId, "feedback_only");
    for (const value of ["0", "true", "", "yes", "11"]) {
      expect(toolbarOf(await (await request(startPath(installationId, { team: value }))).text()), value).toBe("feedback");
    }
  });

  it("carries team=1 from the visitor frame back to the start page", async () => {
    turnstileKeys();
    const { projectId, installationId } = await connectedSite();
    await request("/embed/install", setupForm(OWNER, { project_id: projectId, installation_id: installationId, action: "visitors_on" }));
    await savePublicToolbar(projectId, installationId, "feedback_only");
    const frame = (team: boolean) =>
      request(`/embed/visitor/frame?${new URLSearchParams({ installation_id: installationId, return_url: `${SITE_ORIGIN}/lots/`, ...(team ? { team: "1" } : {}) })}`).then((response) => response.text());
    const backUrl = (html: string) => new URL(html.match(/<a class="visitor-close" href="([^"]+)"/)![1].replace(/&amp;|&#38;/g, "&"));
    expect(backUrl(await frame(true)).searchParams.get("team")).toBe("1");
    expect(backUrl(await frame(false)).searchParams.has("team")).toBe(false);
  });

  it("still gives a signed-in reviewer or an existing review session the review host", async () => {
    turnstileKeys();
    const { projectId, installationId } = await connectedSite();
    await savePublicToolbar(projectId, installationId, "feedback_only");

    const signedIn = await request(startPath(installationId), { headers: OWNER, redirect: "manual" });
    expect(signedIn.status).toBe(302);
    expect(new URL(signedIn.headers.get("location")!).pathname).toBe("/embed/review/host");
    const cookie = signedIn.headers.get("set-cookie")!.split(";", 1)[0];

    // The partitioned embed review session alone, without the Shiplet sign-in.
    const resumed = await request(startPath(installationId), { headers: { Cookie: cookie }, redirect: "manual" });
    expect(resumed.status).toBe(302);
    expect(new URL(resumed.headers.get("location")!).pathname).toBe("/embed/review/host");
  });
});

describe("toolbar for the public: the widget", () => {
  it("passes the reveal to the frame, keeps it for the tab, and can hide its whole surface", () => {
    const script = embedWidgetScript();
    expect(script).toContain('get("shiplet") === "review"');
    expect(script).toContain('"shiplet.embed.team:"');
    expect(script).toContain('start.searchParams.set("team", "1")');
    expect(script).toContain('"hidden"');
    // One button needs less room than the two- and three-button toolbars.
    expect(EMBED_WIDGET_CSS).toContain(".surface[data-single=true]");
  });
});
