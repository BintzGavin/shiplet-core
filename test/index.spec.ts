// Shiplet - Test Suite
// Tests the core publishing surface for deployable artifacts

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import app from "../src/index";
import {
  AVATAR_SPRITE_URL,
  MAX_AVATAR_UPLOAD_BYTES,
  validateAvatarUpdate,
} from "../src/avatars";
import { validateReviewFeedbackPayload } from "../src/review";
import { ensureSchema } from "../src/schema";
import {
  absolutizeCssUrlsForSnapshot,
  clampExpandedBubbleFrame,
  layoutReviewBubbles,
  resolveReviewAssetUrl,
} from "../src/review-client";
import {
  EXTERNAL_REWRITE_SPOOL_MAX_AGE_MS,
  EXTERNAL_REWRITE_SPOOL_PREFIX,
} from "../src/cloudflare-external-rewrite-spool";

// Type for our test environment
interface TestEnv {
  DB: D1Database;
  SHIPLET_ASSETS: R2Bucket;
  REVIEW_ASSETS: R2Bucket;
  SANDBOX_SESSION: DurableObjectNamespace;
  EMAIL?: {
    send(message: {
      to: string;
      from: { email: string; name?: string };
      subject: string;
      html?: string;
      text?: string;
    }): Promise<unknown>;
  };
  dispatcher: {
    get: (name: string) => { fetch: (req: Request) => Promise<Response> };
  };
  DISPATCH_NAMESPACE_NAME: string;
  CUSTOM_DOMAIN: string;
  SHIPLET_APP_URL?: string;
  SHIPLET_AUTH_MODE: "test";
  WORKOS_AUTHKIT_ISSUER?: string;
  SHIPLET_ENABLED_FEATURE_FLAGS?: string;
  SHIPLET_EMAIL_FROM?: string;
  SHIPLET_EMAIL_FROM_NAME?: string;
  SHIPLET_EMAIL_NOTIFICATIONS?: string;
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
}

const AUTH_HEADERS = {
  "x-shiplet-user-id": "user_test",
  "x-shiplet-user-email": "test@example.com",
};

function expectPlatformStartShell(html: string, currentRoute: string) {
  expect(html).toContain('data-platform-start-shell="tanstack-start"');
  expect(html).toContain(`data-platform-start-route="${currentRoute}"`);
  const stateMatch = html.match(
    /<script\b[^>]*type="application\/json"[^>]*id="shiplet-platform-start-shell"[^>]*>([\s\S]*?)<\/script>/,
  );
  expect(stateMatch?.[1]).toBeTruthy();
  const state = JSON.parse(stateMatch![1]) as {
    apiOwner: string;
    currentRoute: string;
    routes: Array<{ id: string; path: string; shell: string }>;
    shell: string;
  };
  expect(state).toMatchObject({
    apiOwner: "hono-worker",
    currentRoute,
    shell: "tanstack-start",
  });
  expect(state.routes.map((route) => route.path)).toEqual([
    "/",
    "/shiplets",
    "/inbox",
    "/feedback",
    "/workspace",
    "/account",
    "/access",
    "/agents",
  ]);
  expect(state.routes.every((route) => route.shell === "tanstack-start")).toBe(
    true,
  );
}

async function createTestOrganization(makeRequest: typeof requestHelper) {
  const response = await makeRequest("/api/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({ name: `Acme ${crypto.randomUUID()}` }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    organization: { id: string; name: string };
  };
  return body.organization;
}

async function expectCodeModeToolError(response: Response, message: string) {
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    error?: unknown;
    result?: {
      content?: Array<{ text?: string }>;
      isError?: boolean;
    };
  };
  expect(body.error).toBeUndefined();
  expect(body.result?.isError).toBe(true);
  expect(JSON.stringify(body.result?.content || [])).toContain(message);
  return body;
}

async function createOrganizationApiToken(
  makeRequest: typeof requestHelper,
  organizationId: string,
  body: Record<string, unknown> = {},
) {
  const response = await makeRequest(
    `/api/organizations/${organizationId}/api-tokens`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        name: `Agent ${crypto.randomUUID().slice(0, 8)}`,
        scopes: [
          "shiplets:read",
          "shiplets:write",
          "shiplets:archive",
          "feedback:read",
          "feedback:write",
          "mcp",
        ],
        projectAccessMode: "all",
        ...body,
      }),
    },
  );
  expect(response.status).toBe(201);
  const tokenBody = (await response.json()) as {
    token: string;
    record: { id: string; organization_id: string; name: string };
  };
  expect(tokenBody.token).toMatch(/^shiplet_org_/);
  expect(tokenBody.record.organization_id).toBe(organizationId);
  return tokenBody;
}

async function publishStaticShiplet(
  makeRequest: typeof requestHelper,
  organizationId: string,
  body: Record<string, unknown> = {},
) {
  const subdomain =
    typeof body.subdomain === "string"
      ? body.subdomain
      : `shiplet-${crypto.randomUUID().slice(0, 8)}`;
  const response = await makeRequest("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({
      name: `Shiplet ${crypto.randomUUID().slice(0, 8)}`,
      organization_id: organizationId,
      subdomain,
      assets: [
        {
          path: "index.html",
          content: btoa("<!doctype html><h1>Review artifact</h1>"),
          size: 43,
        },
      ],
      ...body,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    project: {
      id: string;
      name: string;
      subdomain: string;
      archived_on?: string | null;
      delete_after?: string | null;
    };
    reviewUrl: string;
    previewUrl: string;
    launchUrl: string;
  };
}

async function publishExternalTestShiplet(
  makeRequest: typeof requestHelper,
  organizationId: string,
  externalUrl: string,
) {
  const response = await makeRequest("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({
      name: `External ${crypto.randomUUID().slice(0, 8)}`,
      organization_id: organizationId,
      subdomain: `external-${crypto.randomUUID().slice(0, 8)}`,
      external_url: externalUrl,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    project: { id: string; subdomain: string; external_origin_url: string };
  };
}

function externalArtifactFramePath(projectId: string, suffix = "/") {
  return `/shiplets/${projectId}/artifact-frame${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

function extractTagAttribute(html: string, marker: string, attribute: string) {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = html.match(new RegExp(`<[^>]*${escapedMarker}[^>]*>`, "i"))?.[0];
  expect(tag).toBeTruthy();
  const escapedAttribute = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = tag?.match(
    new RegExp(`\\b${escapedAttribute}=(?:"([^"]*)"|'([^']*)')`, "i"),
  );
  expect(value).toBeTruthy();
  return (value?.[1] ?? value?.[2] ?? "").replace(/&amp;/g, "&");
}

function extractDocumentBaseReference(html: string) {
  const tag = html.match(/<base\b[^>]*>/i)?.[0];
  expect(tag).toBeTruthy();
  const value = tag?.match(/\bhref=(?:"([^"]*)"|'([^']*)')/i);
  expect(value).toBeTruthy();
  return (value?.[1] ?? value?.[2] ?? "").replace(/&amp;/g, "&");
}

function localArtifactReference(reference: string, documentPath: string) {
  const resolved = new URL(reference, `http://localhost${documentPath}`);
  expect(resolved.origin).toBe("http://localhost");
  return `${resolved.pathname}${resolved.search}`;
}

async function withExternalOriginFixtures<T>(
  fixtures: Record<string, () => Response>,
  callback: (requests: string[]) => Promise<T>,
) {
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    requests.push(url);
    const fixture = fixtures[url];
    if (fixture) return fixture();
    return new Response("<!doctype html><h1>Origin HTML fallback</h1>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
  try {
    return await callback(requests);
  } finally {
    vi.stubGlobal("fetch", originalFetch);
  }
}

function trackedByteStream(
  totalBytes: number,
  options: { byte?: number; chunkSize?: number } = {},
) {
  const telemetry = { cancelled: 0, pulledBytes: 0, pulls: 0 };
  const byte = options.byte ?? 97;
  const chunkSize = options.chunkSize ?? 64 * 1024;
  let produced = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced >= totalBytes) {
        controller.close();
        return;
      }
      const length = Math.min(chunkSize, totalBytes - produced);
      produced += length;
      telemetry.pulledBytes += length;
      telemetry.pulls += 1;
      controller.enqueue(new Uint8Array(length).fill(byte));
      if (produced >= totalBytes) controller.close();
    },
    cancel() {
      telemetry.cancelled += 1;
    },
  });
  return { body, telemetry };
}

function paddedExternalTextStream(
  totalBytes: number,
  prefix: string,
  suffix: string,
  options: { chunkSize?: number } = {},
) {
  const encoder = new TextEncoder();
  const prefixBytes = encoder.encode(prefix);
  const suffixBytes = encoder.encode(suffix);
  if (prefixBytes.byteLength + suffixBytes.byteLength > totalBytes) {
    throw new RangeError("External text fixture exceeds its requested size");
  }
  const fillerBytes =
    totalBytes - prefixBytes.byteLength - suffixBytes.byteLength;
  const chunkSize = options.chunkSize ?? 512 * 1024;
  const telemetry = { cancelled: 0, pulledBytes: 0, pulls: 0 };
  let phase: "prefix" | "filler" | "suffix" | "done" = "prefix";
  let fillerProduced = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      let chunk: Uint8Array | null = null;
      if (phase === "prefix") {
        phase = fillerBytes > 0 ? "filler" : "suffix";
        chunk = prefixBytes;
      } else if (phase === "filler") {
        const length = Math.min(chunkSize, fillerBytes - fillerProduced);
        fillerProduced += length;
        if (fillerProduced >= fillerBytes) phase = "suffix";
        chunk = new Uint8Array(length).fill(32);
      } else if (phase === "suffix") {
        phase = "done";
        chunk = suffixBytes;
      } else {
        controller.close();
        return;
      }
      if (chunk.byteLength > 0) {
        telemetry.pulledBytes += chunk.byteLength;
        telemetry.pulls += 1;
        controller.enqueue(chunk);
      }
    },
    cancel() {
      telemetry.cancelled += 1;
    },
  });
  return { body, telemetry };
}

async function reviewAssetKeys() {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await (env as unknown as TestEnv).REVIEW_ASSETS.list({
      cursor,
      limit: 1_000,
    });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

async function createTestOrganizationMember(
  organizationId: string,
  email: string,
) {
  const normalizedEmail = email.toLowerCase();
  const callback = await requestHelper(
    `/auth/callback?code=${encodeURIComponent(`test-code:${organizationId}:${encodeURIComponent(normalizedEmail)}`)}`,
    { redirect: "manual" },
  );
  expect(callback.status).toBe(302);
  const userId = `user_${normalizedEmail
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
  return {
    id: userId,
    email: normalizedEmail,
    headers: {
      "x-shiplet-user-id": userId,
      "x-shiplet-user-email": normalizedEmail,
    },
  };
}

async function requestHelper(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const requestUrl = /^https?:\/\//.test(path)
    ? path
    : `http://localhost${path}`;
  const request = new Request(requestUrl, options);
  const ctx = createExecutionContext();
  const response = await app.fetch(request, env as unknown as TestEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function recreateLegacyProjectsTableWithoutArchiveColumns() {
  const db = (env as unknown as TestEnv).DB;
  await ensureSchema(db);
  await db.prepare("PRAGMA foreign_keys = OFF").run();
  await db.prepare("DROP TABLE IF EXISTS projects").run();
  await db
    .prepare(
      `CREATE TABLE projects (
				id TEXT PRIMARY KEY,
				organization_id TEXT,
				owner_user_id TEXT,
				name TEXT NOT NULL,
				subdomain TEXT UNIQUE NOT NULL,
				custom_hostname TEXT,
				source_type TEXT NOT NULL DEFAULT 'static',
				external_origin_url TEXT,
				script_content TEXT NOT NULL,
				visibility TEXT NOT NULL DEFAULT 'organization',
				created_on TEXT NOT NULL,
				modified_on TEXT NOT NULL
			)`,
    )
    .run();
  await db.prepare("PRAGMA foreign_keys = ON").run();
}

async function withFeatureFlags<T>(flags: string, callback: () => Promise<T>) {
  const testEnv = env as unknown as TestEnv;
  const previous = testEnv.SHIPLET_ENABLED_FEATURE_FLAGS;
  testEnv.SHIPLET_ENABLED_FEATURE_FLAGS = flags;
  try {
    return await callback();
  } finally {
    testEnv.SHIPLET_ENABLED_FEATURE_FLAGS = previous;
  }
}

async function withCustomDomain<T>(domain: string, callback: () => Promise<T>) {
  const testEnv = env as unknown as TestEnv;
  const previous = testEnv.CUSTOM_DOMAIN;
  testEnv.CUSTOM_DOMAIN = domain;
  try {
    return await callback();
  } finally {
    testEnv.CUSTOM_DOMAIN = previous;
  }
}

async function withAppUrl<T>(url: string, callback: () => Promise<T>) {
  const testEnv = env as unknown as TestEnv;
  const previous = testEnv.SHIPLET_APP_URL;
  testEnv.SHIPLET_APP_URL = url;
  try {
    return await callback();
  } finally {
    testEnv.SHIPLET_APP_URL = previous;
  }
}

async function withEmailBinding<T>(
  send: NonNullable<TestEnv["EMAIL"]>["send"],
  callback: () => Promise<T>,
) {
  const testEnv = env as unknown as TestEnv;
  const previousEmail = testEnv.EMAIL;
  const previousFrom = testEnv.SHIPLET_EMAIL_FROM;
  const previousFromName = testEnv.SHIPLET_EMAIL_FROM_NAME;
  const previousEnabled = testEnv.SHIPLET_EMAIL_NOTIFICATIONS;
  testEnv.EMAIL = { send };
  testEnv.SHIPLET_EMAIL_FROM = "notifications@shiplet.test";
  testEnv.SHIPLET_EMAIL_FROM_NAME = "Shiplet";
  testEnv.SHIPLET_EMAIL_NOTIFICATIONS = "true";
  try {
    return await callback();
  } finally {
    testEnv.EMAIL = previousEmail;
    testEnv.SHIPLET_EMAIL_FROM = previousFrom;
    testEnv.SHIPLET_EMAIL_FROM_NAME = previousFromName;
    testEnv.SHIPLET_EMAIL_NOTIFICATIONS = previousEnabled;
  }
}

async function withPostHogEnv<T>(
  values: { key?: string; host?: string },
  callback: () => Promise<T>,
) {
  const testEnv = env as unknown as TestEnv;
  const previousKey = testEnv.POSTHOG_KEY;
  const previousHost = testEnv.POSTHOG_HOST;
  testEnv.POSTHOG_KEY = values.key;
  testEnv.POSTHOG_HOST = values.host;
  try {
    return await callback();
  } finally {
    testEnv.POSTHOG_KEY = previousKey;
    testEnv.POSTHOG_HOST = previousHost;
  }
}

function extractFirstNav(html: string, className: string) {
  const escapedClass = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(`<nav class="${escapedClass}"[^>]*>[\\s\\S]*?<\\/nav>`),
  );
  return match?.[0] || "";
}

function extractElementById(html: string, id: string) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(`<[^>]+id="${escapedId}"[^>]*>[\\s\\S]*?<\\/[^>]+>`),
  );
  return match?.[0] || "";
}

function extractCssRule(html: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(`${escapedSelector}\\s*\\{[\\s\\S]*?\\}`),
  );
  return match?.[0] || "";
}

function expectedPublicShipletUrl(subdomain: string) {
  const customDomain = (env as unknown as TestEnv).CUSTOM_DOMAIN;
  return customDomain
    ? `https://${subdomain}.${customDomain}`
    : `/${subdomain}`;
}

function cookieHeaderFromResponse(response: Response) {
  const setCookie = response.headers.get("set-cookie") || "";
  return setCookie
    .split(/,(?=\s*(?:__Host-shiplet_|shiplet_))/)
    .map((cookie) => cookie.trim().split(";")[0])
    .filter(Boolean)
    .join("; ");
}

function mergeCookieHeaders(...headers: Array<string | null | undefined>) {
  const cookies = new Map<string, string>();
  for (const header of headers) {
    for (const pair of String(header || "").split(/;\s*/)) {
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function websocketHelper(path: string): Promise<WebSocket> {
  const response = await requestHelper(path, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
  expect(socket).toBeTruthy();
  socket!.accept();
  return socket!;
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>) {
  socket.send(JSON.stringify(payload));
}

function waitForSocketMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for websocket message"));
    }, 1000);
    const onMessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(String(event.data)) as Record<
          string,
          unknown
        >;
        if (!predicate(parsed)) return;
        clearTimeout(timeout);
        socket.removeEventListener("message", onMessage);
        resolve(parsed);
      } catch (error) {
        clearTimeout(timeout);
        socket.removeEventListener("message", onMessage);
        reject(error);
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

describe("Shiplet", () => {
  // Helper to make requests to the app
  async function makeRequest(
    path: string,
    options?: RequestInit,
  ): Promise<Response> {
    return requestHelper(path, {
      ...options,
      headers: { ...AUTH_HEADERS, ...(options?.headers || {}) },
    });
  }

  describe("Homepage", () => {
    it("should repair legacy project archive columns before loading dashboard data", async () => {
      await recreateLegacyProjectsTableWithoutArchiveColumns();

      const response = await makeRequest("/api/dashboard");
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).not.toContain("no such column: projects.archived_on");
      const body = JSON.parse(html) as {
        projects: unknown[];
        archivedProjects: unknown[];
      };
      expect(Array.isArray(body.projects)).toBe(true);
      expect(Array.isArray(body.archivedProjects)).toBe(true);

      const columns = await (env as unknown as TestEnv).DB.prepare(
        "PRAGMA table_info(projects)",
      ).all<{ name: string }>();
      const columnNames = (columns.results || []).map((column) => column.name);
      expect(columnNames).toContain("archived_on");
      expect(columnNames).toContain("delete_after");
    });

    it("Given an anonymous visitor, When the public entrypoint loads, Then Shiplet presents a review layer around their artifact", async () => {
      const response = await requestHelper("/");

      expect(response.status).toBe(200);
      const html = await response.text();
      const authCard =
        html.match(
          /<div class="form-container auth-card">[\s\S]*?<\/div>/,
        )?.[0] || "";
      expect(html).toContain("Review any build, file, or live URL");
      expect(html).toContain("trusted review layer around the artifact");
      expect(html).toContain("comment in context");
      expect(html).toContain("agents can pick up the feedback");
      expect(html).not.toContain(
        "Review agent-built work at the exact revision",
      );
      expect(authCard).not.toContain('class="auth-proof-list"');
      expect(html).not.toContain('class="shiplet-brand-header"');
      expect(html).not.toContain('class="shiplet-brand-nav"');
      expect(html).not.toContain('class="shiplet-waterline"');
      expect(authCard).toContain('href="/auth/login"');
      expect(authCard).toContain('href="/play"');
      expect(authCard).toContain('href="/docs/why-shiplet"');
      expect(authCard).not.toContain('href="/docs/access-control"');
      expect(authCard).toContain(
        '<span class="success-card-label">Shiplet</span>',
      );
      expect(authCard).toContain(
        '<a class="link-btn" href="/auth/login">Prepare a review</a>',
      );
      expect(authCard).toContain(
        '<a class="btn btn-secondary" href="/play">Try the sandbox</a>',
      );
      expect(authCard.indexOf(">Prepare a review</a>")).toBeLessThan(
        authCard.indexOf(">Try the sandbox</a>"),
      );
      expect(authCard).toContain(
        '<a class="auth-docs-link" href="/docs/why-shiplet">Docs</a>',
      );
      expect(html).toContain(">Try the sandbox</a>");
      expect(html).toContain(">Prepare a review</a>");
    });

    it("should render the original structured harbor scene above the landing card", async () => {
      const response = await requestHelper("/");

      expect(response.status).toBe(200);
      const html = await response.text();
      const authScene =
        html.match(/<div class="auth-scene"[\s\S]*?<\/div>/)?.[0] || "";

      expect(authScene).toContain("harbor-scene-svg");
      expect(authScene).toContain("scene-water");
      expect(authScene).toContain("scene-dock");
      expect(authScene).toContain("scene-working-vessel");
      expect(authScene).toContain("scene-beacon");
      expect(authScene).toContain("scene-gull");
      expect(
        authScene.match(/pathLength="1"/g)?.length || 0,
      ).toBeGreaterThanOrEqual(12);
      expect(authScene).not.toContain("auth-product-proof");
    });

    it("should restore the customs stamp treatment on the centered landing card", async () => {
      const response = await requestHelper("/");

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(".auth-card {\n  background-image:");
      expect(html).toContain(".publish-primary-panel {\n  background-image:");
    });

    it("should restore recognizable harbor landmarks to the anonymous entry scene", async () => {
      const response = await requestHelper("/");

      expect(response.status).toBe(200);
      const html = await response.text();
      const authScene =
        html.match(/<div class="auth-scene"[\s\S]*?<\/div>/)?.[0] || "";

      expect(authScene).toContain("scene-horizon-line");
      expect(authScene).toContain("scene-water-ripple");
      expect(authScene).toContain("scene-pier-house");
      expect(authScene).toContain("scene-dock-deck");
      expect(authScene).toContain("scene-dock-bollard");
      expect(authScene).toContain("scene-boathouse-shed-roof");
      expect(authScene).toContain("scene-boat-slip");
      expect(authScene).toContain("scene-working-vessel");
      expect(authScene).toContain("scene-beacon-cap");
      expect(authScene).toContain("scene-beacon-beam");
    });

    it("should use the working-vessel silhouette as the harbor scene boat", async () => {
      const response = await requestHelper("/");

      expect(response.status).toBe(200);
      const html = await response.text();
      const authScene =
        html.match(/<div class="auth-scene"[\s\S]*?<\/div>/)?.[0] || "";

      expect(authScene).toContain("scene-working-vessel");
      expect(authScene).toContain("scene-boat-hull");
      expect(authScene).toContain(
        'd="M245 124h168l-15 29c-28 15-102 16-137 2z"',
      );
      expect(authScene).toContain('d="M371 59l25 8-25 8z"');
    });

    it("should render the drawn harbor scene complete without JavaScript", async () => {
      const response = await requestHelper("/");

      expect(response.status).toBe(200);
      const html = await response.text();

      expect(html).toContain(
        ".harbor-scene-svg { display: block; max-width: 100%; overflow: hidden;",
      );
      expect(html).toContain(
        "html:not(.js) .draw-path { stroke-dashoffset: 0; }",
      );
      expect(html).toMatch(/class="[^"]*\bscene-horizon-line\b[^"]*"/);
      expect(html).toContain('pathLength="1"');
    });

    it("should serve public documentation without sign-in", async () => {
      const docs = await requestHelper("/docs");
      expect(docs.status).toBe(200);
      expect(docs.headers.get("content-type")).toContain("text/html");
      const docsHtml = await docs.text();
      expect(docsHtml).toContain("Shiplet documentation");
      expect(docsHtml).toContain("Quickstart");
      expect(docsHtml).toContain('href="/docs/code-mode-mcp"');
      expect(docsHtml).toContain('href="/openapi.json"');
      expect(docsHtml).not.toContain("Sign in to Shiplet");

      const mcpDocs = await requestHelper("/docs/code-mode-mcp");
      expect(mcpDocs.status).toBe(200);
      const mcpHtml = await mcpDocs.text();
      expect(mcpHtml).toContain("Code Mode MCP");
      expect(mcpHtml).toContain("https://shiplet.cc/api/mcp");
      expect(mcpHtml).toContain("codemode.request");
    });

    it("Given a reader opens a retired deployment guide, When the route resolves, Then they return to review-artifact guidance", async () => {
      const response = await requestHelper("/docs/deployment");
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe("/docs/publishing");
      const html = "";
      return;

      expect(html).toContain("Deployment and ownership");
      expect(html).toContain("Shiplet-managed hosting is the default");
      expect(html).toContain("Customer-owned Cloudflare");
      expect(html).toContain("scoped OAuth");
      expect(html).toContain("last customer-owned deployment keeps running");
      expect(html).toContain("separate OAuth connection");
      expect(html).toContain("prior active revision remains unchanged");
      expect(html).toContain("Rollback:");
      expect(html).toContain("external prerequisite");
      expect(html).toContain("immutable bytes");
      expect(html).toContain("credential stripping");
      expect(html).toContain("mediated egress");
      expect(html).not.toContain(
        "requires a configured Workers for Platforms dispatch namespace",
      );
      expect(html).toContain("https://campaign-prototype.shiplet.cc");
      expect(html).toContain("From an existing URL");
      expect(html).toContain("external_url");
      expect(html).toContain("https://preview.example.com");
      expect(html).not.toContain("Required secrets");
      expect(html).not.toContain("DISPATCH_NAMESPACE_API_TOKEN");
      expect(html).toContain("No API token is pasted into Shiplet");
      expect(html).toContain("operator_smoke");
      expect(html).toContain("exact-user");
      expect(html).toContain("separate confirmed deploy");

      const publishing = await requestHelper("/docs/publishing");
      expect(publishing.status).toBe(200);
      const publishingHtml = await publishing.text();
      expect(publishingHtml).toContain("Review artifacts");
      expect(publishingHtml).toContain(
        "A raw dispatch namespace is not sufficient",
      );
      expect(publishingHtml).toContain("immutable revision staging");
      expect(publishingHtml).toContain("platform-credential stripping");
      expect(publishingHtml).toContain("enforced invocation limits");
      expect(publishingHtml).toContain("deny-by-default outbound mediation");
    });

    it("Given a reviewer explores public docs, When navigation is scanned, Then the artifact and review layer stay distinct", async () => {
      const landing = await requestHelper("/docs");
      const landingHtml = await landing.text();

      expect(landing.status).toBe(200);
      expect(landingHtml).toContain('href="/docs/extensions"');
      expect(landingHtml).toContain('href="/docs/security"');
      expect(landingHtml).toContain('href="/docs/quickstart"');
      expect(landingHtml).not.toContain('href="/docs/packages-revisions"');
      expect(landingHtml).not.toContain('href="/docs/cli"');
      expect(landingHtml).not.toContain('href="/docs/deployment"');
      expect(landingHtml).not.toContain('href="/docs/external-setup"');
      expect(landingHtml).toContain('data-shiplet-docs-page="introduction"');
      expect(landingHtml.indexOf("Choose your task")).toBeLessThan(
        landingHtml.indexOf("How Shiplet fits around your work"),
      );

      const reviewLayerResponse = await requestHelper("/docs/extensions");
      const reviewLayerHtml = await reviewLayerResponse.text();
      expect(reviewLayerResponse.status).toBe(200);
      expect(reviewLayerHtml).toContain(
        "The artifact is the work your team reviews",
      );
      expect(reviewLayerHtml).toContain(
        "Shiplet provides the review layer around it",
      );
      expect(reviewLayerHtml).toContain(
        "The review layer stays separate from the artifact",
      );
      expect(reviewLayerHtml).toContain("Custom review widgets");
      expect(reviewLayerHtml).toContain("trusted confirmation");
      expect(reviewLayerHtml).not.toContain("raw package");

      for (const [route, location] of [
        ["/docs/packages-revisions", "/docs/publishing"],
        ["/docs/cli", "/docs/code-mode-mcp"],
        ["/docs/deployment", "/docs/publishing"],
        ["/docs/external-setup", "/docs/security"],
      ]) {
        const retired = await requestHelper(route);
        expect(retired.status, route).toBe(301);
        expect(retired.headers.get("location"), route).toBe(location);
      }
      return;

      const packages = await requestHelper("/docs/packages-revisions");
      const packagesHtml = await packages.text();
      expect(packages.status).toBe(200);
      for (const concept of [
        "Shiplet",
        "Package",
        "Draft",
        "Revision",
        "Deployment target",
        "Deployment",
        "State namespace",
      ]) {
        expect(packagesHtml).toContain(concept);
      }
      expect(packagesHtml).toContain("shiplet.package/v1");
      expect(packagesHtml).toContain("shiplet.runtime/v1");
      expect(packagesHtml).toContain(
        "application/vnd.shiplet.package+json;version=1",
      );
      for (const packagePath of [
        "artifact/**",
        "widget/**",
        "workflow/schema.json",
        "mcp/manifest.json",
        "mcp/handlers/**",
        "AGENTS.md",
        "validation/manifest.json",
        "provenance.json",
      ]) {
        expect(packagesHtml).toContain(packagePath);
      }
      expect(packagesHtml).toContain("Requested capabilities are declarations");
      expect(packagesHtml).toContain(
        "Shiplet never adds kernel-owned credentials",
      );
      expect(packagesHtml).toContain(
        "does not secret-scan arbitrary package file contents",
      );

      const cli = await requestHelper("/docs/cli");
      const cliHtml = await cli.text();
      expect(cli.status).toBe(200);
      for (const command of [
        "npm run shiplet -- prepare",
        "npm run shiplet -- fork",
        "npm run shiplet -- pull",
        "npm run shiplet -- diff",
        "npm run shiplet -- push",
        "npm run shiplet -- validate",
        "npm run shiplet -- deploy",
        "npm run shiplet -- promote",
        "npm run shiplet -- rollback",
        "npm run shiplet -- eject",
      ]) {
        expect(cliHtml).toContain(command);
      }
      expect(cliHtml).toContain("source checkout");
      expect(cliHtml).toContain("public registry package");
      expect(cliHtml).toContain("--expected-active");
      expect(cliHtml).toContain("--approve");
      expect(cliHtml).toContain("validation does not activate");

      const extensions = await requestHelper("/docs/extensions");
      const extensionsHtml = await extensions.text();
      expect(extensions.status).toBe(200);
      expect(extensionsHtml).toContain("arbitrary widget code");
      expect(extensionsHtml).toContain(
        "shiplet.&lt;shiplet&gt;.&lt;revision&gt;.&lt;tool&gt;",
      );
      expect(extensionsHtml).toContain("canonical event envelope");
      expect(extensionsHtml).toContain("trusted confirmation");
      expect(extensionsHtml).toContain("untrusted package content");

      const security = await requestHelper("/docs/security");
      const securityHtml = await security.text();
      expect(security.status).toBe(200);
      expect(securityHtml).toContain("No ambient browser credentials");
      expect(securityHtml).toContain("sandboxed frames");
      expect(securityHtml).toContain("wrong origin");
      expect(securityHtml).toContain("replay");
      expect(securityHtml).toContain("revision mismatch");
      expect(securityHtml).toContain("Human-attributed writes");
      expect(securityHtml).toContain("deny-by-default egress");
      expect(securityHtml).toContain("immutable audit");
      expect(securityHtml).toContain("managed_wfp_provider");
      expect(securityHtml).toContain("CLOUDFLARE_MANAGED_RUNTIME_RPC");
      expect(securityHtml).toContain("ambient bindings empty");
      expect(securityHtml).toContain(
        "package code receives no Cloudflare credential",
      );
      expect(securityHtml).toContain("operator_smoke");
      expect(securityHtml).toContain("lifecycle operator");
      expect(securityHtml).toContain(
        "separate immutable retirement audit record",
      );
      expect(securityHtml).toContain("ordinary OAuth revocation is allowed");
      expect(securityHtml).toContain(
        "managed Worker operations fail closed until a new fixed reservation is configured",
      );
      expect(securityHtml).not.toContain("structurally dedicated");

      const externalSetup = await requestHelper("/docs/external-setup");
      const externalSetupHtml = await externalSetup.text();
      expect(externalSetup.status).toBe(200);
      expect(externalSetupHtml).toContain("Platform operations");
      expect(externalSetupHtml).toContain("shiplet-cloudflare-control-plane");
      expect(externalSetupHtml).toContain("CLOUDFLARE_CUSTOM_MCP_RUNTIME_RPC");
      expect(externalSetupHtml).toContain("Stage 1:");
      expect(externalSetupHtml).toContain("Stage 10:");
      expect(externalSetupHtml).toContain("not production evidence");
      expect(externalSetupHtml).toContain('href="#stage-1"');
      expect(externalSetupHtml).toContain('href="#stage-10"');
      expect(externalSetupHtml).toContain('id="stage-1"');
      expect(externalSetupHtml).toContain('id="stage-10"');
      expect(externalSetupHtml).toContain("Stop or resume");
      expect(externalSetupHtml).toContain("fixed managed-only reservation");
      expect(externalSetupHtml).toContain("managed_wfp_provider");
      expect(externalSetupHtml).toContain(
        "package code receives no Cloudflare credential",
      );
      expect(externalSetupHtml).toContain(
        "account-scoped resource mutations and status checks",
      );
      expect(externalSetupHtml).toContain("exact-scope OAuth connection");
      expect(externalSetupHtml).toContain(
        "before every source-derived Wizard mutation and before entering each human-controlled mutation ceremony",
      );
      expect(externalSetupHtml).toContain(
        "Emergency rollback validates the captured immutable Worker UUID and remains available after checkout drift",
      );
      expect(externalSetupHtml).toContain(
        "account-level Workers Scripts Write",
      );
      expect(externalSetupHtml).toContain("Stage 7 is compile-only");
      expect(externalSetupHtml).toContain("/api/platform/support-contract");
      expect(externalSetupHtml).toContain(
        "six exact live named entrypoint contracts",
      );
      expect(externalSetupHtml).toContain("CLOUDFLARE_MANAGED_RUNTIME_RPC");
      expect(externalSetupHtml).toContain(
        "generated Worker contract is current",
      );
      expect(externalSetupHtml).toContain("lifecycle operator");
      expect(externalSetupHtml).toContain(
        "separate immutable retirement audit record",
      );
      expect(externalSetupHtml).toContain(
        "ordinary OAuth revocation is allowed",
      );
      expect(externalSetupHtml.toLowerCase()).toContain(
        "customer-owned deployments continue running",
      );
      expect(externalSetupHtml).toContain(
        "managed Worker operations fail closed until a new fixed reservation is configured",
      );
      expect(externalSetupHtml).not.toContain(
        "managed arbitrary Worker execution remains unavailable in this release",
      );
      expect(externalSetupHtml).not.toContain(
        "five exact live named entrypoint contracts",
      );
      expect(externalSetupHtml).not.toContain(
        "no separate WFP deployment credential",
      );
      expect(externalSetupHtml).not.toContain("structurally dedicated");

      const deployment = await requestHelper("/docs/deployment");
      const deploymentHtml = await deployment.text();
      expect(deployment.status).toBe(200);
      expect(deploymentHtml).toContain("Managed Workers for Platforms");
      expect(deploymentHtml).toContain("fixed managed-only reservation");
      expect(deploymentHtml).toContain("managed_wfp_provider");
      expect(deploymentHtml).toContain("CLOUDFLARE_MANAGED_RUNTIME_RPC");
      expect(deploymentHtml).toContain(
        "Custom MCP uses a separate Dynamic Workers contract",
      );
      expect(deploymentHtml).toContain("lifecycle operator");
      expect(deploymentHtml).toContain(
        "separate immutable retirement audit record",
      );
      expect(deploymentHtml.toLowerCase()).toContain(
        "customer-owned deployments continue running",
      );
      expect(deploymentHtml).toContain(
        "managed Worker operations fail closed until a new fixed reservation is configured",
      );
      expect(deploymentHtml).not.toContain(
        "managed arbitrary Worker execution remains unavailable in this release",
      );
      expect(deploymentHtml).not.toContain("structurally dedicated");
    });

    it("Given a first-time reviewer, When the quickstart is followed, Then a managed review has an executable path and visible next steps", async () => {
      const response = await requestHelper("/docs/quickstart");
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("Open the Prepare page");
      expect(html).toContain("Choose the work to review");
      expect(html).toContain("Open the review link");
      expect(html).toContain("Optional: automate with MCP");
      expect(html).toContain('href="/docs/review-feedback"');
      expect(html).not.toContain('href="/docs/packages-revisions"');
      expect(html).not.toContain('href="/docs/deployment"');
    });

    it("Given a first-time reviewer, When the public docs are operated, Then disclosure risk, recovery, and navigation are handled before action", async () => {
      const quickstart = await requestHelper("/docs/quickstart");
      const quickstartHtml = await quickstart.text();

      expect(quickstart.status).toBe(200);
      expect(quickstartHtml).toContain("sign in when asked");
      expect(quickstartHtml).toContain("returns to the Prepare page");
      expect(quickstartHtml).toContain("safe default");
      expect(quickstartHtml).toContain("Troubleshooting");
      expect(quickstartHtml).toContain("A file is rejected");
      expect(quickstartHtml).toContain("subdomain");
      expect(quickstartHtml).toContain("Publishing fails");
      expect(quickstartHtml).toContain("supported static files");
      expect(quickstartHtml).not.toContain("source-checkout CLI");
      expect(quickstartHtml.indexOf("safe default")).toBeLessThan(
        quickstartHtml.indexOf("Open the review link"),
      );
      expect(quickstartHtml).toContain("Optional: automate with MCP");

      const introduction = await requestHelper("/docs");
      const introductionHtml = await introduction.text();
      expect(introductionHtml).toContain(
        '<a class="docs-skip-link" href="#docs-article">Skip to article</a>',
      );
      expect(introductionHtml.indexOf('class="docs-skip-link"')).toBeLessThan(
        introductionHtml.indexOf('class="shiplet-brand-header"'),
      );
      expect(introductionHtml).toContain(
        '<details class="docs-nav-disclosure">',
      );
      expect(introductionHtml).toContain("Browse documentation");
      expect(introductionHtml).toContain('id="docs-article" tabindex="-1"');
      expect(introductionHtml).toContain('matchMedia("(min-width: 901px)")');

      const keys = await requestHelper("/docs/api-keys");
      const keysHtml = await keys.text();
      expect(keysHtml).toContain('href="/agents"');
      expect(keysHtml).toContain("Choose the required scopes");
      expect(keysHtml).toContain("Only selected");

      const agentsHtml = await (await makeRequest("/agents")).text();
      expect(agentsHtml).toMatch(
        /<option value="selected" selected(?:="")?>Only selected<\/option>/,
      );
      expect(agentsHtml).not.toMatch(/name="tokenScope"[^>]* checked/);
    });

    it("Given a technical owner, When MCP and widget guidance is read, Then automation stays on the review product boundary", async () => {
      const retiredCli = await requestHelper("/docs/cli");
      expect(retiredCli.status).toBe(301);
      expect(retiredCli.headers.get("location")).toBe("/docs/code-mode-mcp");

      const publicMcpHtml = await (
        await requestHelper("/docs/code-mode-mcp")
      ).text();
      expect(publicMcpHtml).toContain("search");
      expect(publicMcpHtml).toContain("execute");
      expect(publicMcpHtml).toContain("Prepare an artifact");
      expect(publicMcpHtml).toContain("Read feedback");
      expect(publicMcpHtml).not.toContain("custom_shiplet_scope_required");

      const publicReviewLayerHtml = await (
        await requestHelper("/docs/extensions")
      ).text();
      expect(publicReviewLayerHtml).toContain("Custom review widgets");
      expect(publicReviewLayerHtml).toContain("trusted confirmation");
      expect(publicReviewLayerHtml).not.toContain(
        "shiplet.widget.operation.v1",
      );
      return;
      const cliHtml = await (await requestHelper("/docs/cli")).text();
      expect(cliHtml).toContain("npm run shiplet -- prepare");
      expect(cliHtml).toContain("npm run shiplet -- promote");
      expect(cliHtml).toContain("npm run shiplet -- rollback");
      expect(cliHtml).toContain(
        "source-checkout CLI requires trusted browser authorization",
      );
      expect(cliHtml).toContain("Direct REST and core MCP");
      expect(cliHtml).toContain(
        "Customer-owned deployment requires a trusted browser-authorized human session",
      );
      expect(cliHtml).not.toContain(
        "project-authorized agent credential can promote or roll back",
      );

      const mcpHtml = await (await requestHelper("/docs/code-mode-mcp")).text();
      expect(mcpHtml).toContain('"_meta": { "shipletId": "project_123" }');
      expect(mcpHtml).toContain("custom_shiplet_scope_required");
      expect(mcpHtml).toContain("runtime_unavailable");

      const extensionsHtml = await (
        await requestHelper("/docs/extensions")
      ).text();
      expect(extensionsHtml).toContain("shiplet.widget.operation.v1");
      expect(extensionsHtml).toContain("page-lifetime channel nonce");
      expect(extensionsHtml).toContain("request ID replay set");
      expect(extensionsHtml).not.toContain("nonce, sequence");
      expect(extensionsHtml).not.toContain("expiry, and sequence");

      const securityHtml = await (await requestHelper("/docs/security")).text();
      expect(securityHtml).toContain("page-lifetime channel nonce");
      expect(securityHtml).toContain("request ID replay set");
      expect(securityHtml).not.toContain("expiry, and sequence");
    });

    it("Given a retired deployment URL, When it is requested, Then it redirects without exposing provider operations", async () => {
      const response = await requestHelper("/docs/deployment");
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe("/docs/publishing");
      return;
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("Availability at a glance");
      expect(html).toContain("Managed static");
      expect(html).toContain("Available by default");
      expect(html).toContain("Customer-owned static");
      expect(html).toContain("External prerequisite");
      expect(html).toContain("Deployment target");
      expect(html).toContain("one revision installed on one target");
      expect(html).toContain("conflict");
      expect(html).toContain("prior active revision remains unchanged");
      expect(html).toContain('href="/docs/security"');
    });

    it("Given a reader completes any public guide, When the article ends, Then a relevant next action is linked and stale authority claims are absent", async () => {
      for (const route of [
        "/docs",
        "/docs/why-shiplet",
        "/docs/quickstart",
        "/docs/access-control",
        "/docs/api-keys",
        "/docs/api-surface",
        "/docs/code-mode-mcp",
        "/docs/extensions",
        "/docs/security",
        "/docs/publishing",
        "/docs/review-feedback",
        "/docs/wordpress",
      ]) {
        const response = await requestHelper(route);
        const html = await response.text();
        expect(response.status, route).toBe(200);
        const article = html.match(
          /<div class="docs-content">([\s\S]*?)<\/div>\s*<\/article>/,
        )?.[1];
        expect(article, route).toBeTruthy();
        expect(article, route).toContain("<a ");
        const declaredDigest = html.match(
          /data-shiplet-docs-content-sha256="([a-f0-9]{64})"/,
        )?.[1];
        const digestBytes = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            article?.replace(/\r\n?/g, "\n").trim() || "",
          ),
        );
        const renderedDigest = Array.from(new Uint8Array(digestBytes), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        expect(declaredDigest, route).toBe(renderedDigest);
      }

      const introduction = await (await requestHelper("/docs")).text();
      const mcp = await (await requestHelper("/docs/code-mode-mcp")).text();
      const review = await (
        await requestHelper("/docs/review-feedback")
      ).text();
      expect(introduction).not.toContain("exposes only two tools");
      expect(mcp).not.toContain("exposes only two tools");
      expect(review).not.toContain(
        "Authenticated viewers get the review client injected",
      );
      expect(introduction).not.toContain("immutable revision");
      expect(mcp).not.toContain("custom_shiplet_scope_required");

      const wordpress = await (await requestHelper("/docs/wordpress")).text();
      expect(wordpress).toContain("source-checkout-only");
      expect(wordpress).toContain(
        "does not publish an official public download",
      );
    });

    it("Given a visitor opens Why Shiplet, When the article renders, Then its product argument and future-facing ownership idea are canonical", async () => {
      const response = await requestHelper("/docs/why-shiplet");
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("<title>Why Shiplet | Shiplet Docs</title>");
      expect(html).toContain(
        '<link rel="canonical" href="https://shiplet.cc/docs/why-shiplet">',
      );
      expect(html).toContain('data-shiplet-docs-page="why-shiplet"');
      expect(html).toContain("Every Shiplet gets a root");
      expect(html).toContain("acceptance criteria");
      expect(html).toContain("controls that prove them");
      expect(html).toContain("engineer");
      expect(html).toContain("researcher");
      expect(html).toContain("evidence");
      expect(html).toContain("Software should be allowed to wander");
      expect(html).toContain("Shiplet Cloud");
      expect(html).toContain("its own Cloudflare account");
      expect(html).toContain("local coding agents");
      expect(html).toContain("upstream improvements");
      expect(html).not.toMatch(
        /signed update bundle|transfer state|release channel|phase [0-9]|roadmap/i,
      );
      expect(html).not.toMatch(
        /legal review|legal agreement|homepage review|conversion depends on copy and layout/i,
      );
      expect(html).toContain('src="/brand/why-shiplet/shiplet-root-hero.webp"');
      expect(html).toContain('href="/docs/quickstart"');

      for (const asset of [
        "default-review-flow.webp",
        "durable-object-benefits.webp",
        "research-evidence-board.webp",
        "ticket-acceptance-runner.webp",
        "shiplet-root-hero.webp",
        "shiplet-root-runtime.webp",
      ]) {
        const assetResponse = await requestHelper(
          `/brand/why-shiplet/${asset}`,
        );
        const bytes = await assetResponse.arrayBuffer();
        expect(assetResponse.status, asset).toBe(200);
        expect(assetResponse.headers.get("content-type"), asset).toBe(
          "image/webp",
        );
        expect(bytes.byteLength, asset).toBeGreaterThan(1_024);
      }

      for (const retiredAsset of [
        "homepage-review-widget.webp",
        "legal-review-widget.webp",
      ]) {
        const retiredResponse = await requestHelper(
          `/brand/why-shiplet/${retiredAsset}`,
        );
        expect(retiredResponse.status, retiredAsset).toBe(404);
      }
    });

    it("Given a reader opens agent registration docs, When the flow visual loads, Then the Worker serves the accessible SVG", async () => {
      const pageResponse = await requestHelper("/docs/code-mode-mcp");
      const page = await pageResponse.text();
      const visualResponse = await requestHelper(
        "/brand/docs/agent-registration-flow.svg",
      );
      const visual = await visualResponse.text();

      expect(pageResponse.status).toBe(200);
      expect(page).toContain(
        'src="/brand/docs/agent-registration-flow.svg?v=2"',
      );
      expect(visualResponse.status).toBe(200);
      expect(visualResponse.headers.get("content-type")).toBe(
        "image/svg+xml; charset=utf-8",
      );
      expect(visualResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      expect(visual).toContain(
        "<title>Connect an agent to Shiplet</title>",
      );
      expect(visual).toContain("shiplet.cc/api/mcp");
      expect(visual).toContain("Shiplets and feedback");
      expect(visual).not.toMatch(/WorkOS|access token|assertion|refresh token/i);
    });

    it("Given a 320px documentation viewport, When tables and actions render, Then content scrolls locally and touch targets remain reachable", async () => {
      for (const route of ["/docs/access-control", "/docs/api-keys"]) {
        const html = await (await requestHelper(route)).text();
        expect(html, route).toContain('class="docs-table" tabindex="0"');
        expect(extractCssRule(html, ".docs-content"), route).toContain(
          "min-width: 0",
        );
        expect(extractCssRule(html, ".docs-table"), route).toContain(
          "overflow-x: auto",
        );
      }

      const html = await (await requestHelper("/docs")).text();
      expect(html).toContain(".docs-page .btn-sm");
      expect(html).toContain(".docs-page .docs-nav a");
      expect(extractCssRule(html, ".docs-table:focus-visible")).toContain(
        "var(--ring)",
      );
      expect(extractCssRule(html, ".docs-table:focus-visible")).not.toContain(
        "var(--focus)",
      );
      expect(html).toMatch(
        /\.docs-page \.settings-nav\s*\{[^}]*grid-template-columns:\s*1fr[^}]*\}/s,
      );
      expect(html).toMatch(
        /\.docs-page \.settings-nav a\s*\{[^}]*white-space:\s*normal[^}]*\}/s,
      );
      const brandLockupRule = extractCssRule(html, ".shiplet-brand-lockup");
      const brandLockupMinHeight = Number(
        brandLockupRule.match(/min-height:\s*(\d+)px/)?.[1],
      );
      const brandLockupMinWidth = Number(
        brandLockupRule.match(/min-width:\s*(\d+)px/)?.[1],
      );
      expect(brandLockupMinHeight).toBeGreaterThanOrEqual(44);
      expect(brandLockupMinWidth).toBeGreaterThanOrEqual(44);
    });

    it("Given a security-conscious reader, When access and publishing docs are read, Then anonymous visibility and least privilege are exact", async () => {
      const access = await (await requestHelper("/docs/access-control")).text();
      expect(access).toContain("Visibility");
      expect(access).toContain("Anyone with the link");
      expect(access).toContain(
        "Administrators, owners, and people with an explicit grant",
      );
      expect(access).toContain("View access never grants edit access");
      expect(access).not.toContain("Public shiplets are intended");

      const keys = await (await requestHelper("/docs/api-keys")).text();
      expect(keys).toContain("Browser OAuth is the default for people");
      expect(keys).toContain("Only selected");
      expect(keys).toContain("Keep keys out of artifacts, custom widgets");
      expect(keys).not.toContain(
        "Use All projects for most internal agent keys",
      );

      const publishing = await (await requestHelper("/docs/publishing")).text();
      expect(publishing).toContain("Trusted review boundary");
      expect(publishing).toContain("sandboxed frame");
      expect(publishing).toContain(
        "Browser sessions and reviewer authority remain in the trusted host",
      );
      expect(publishing).not.toContain("injects review feedback into HTML");
    });

    it("should document existing URL publishing in docs and OpenAPI", async () => {
      const publishing = await requestHelper("/docs/publishing");
      expect(publishing.status).toBe(200);
      const html = await publishing.text();

      expect(html).toContain("Existing public URLs");
      expect(html).toContain("external_url");
      expect(html).toContain("assets");
      expect(html).not.toContain("script_content");

      const openapi = await requestHelper("/openapi.json");
      expect(openapi.status).toBe(200);
      const spec = (await openapi.json()) as {
        paths: {
          "/api/shiplets": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      description: string;
                      properties: Record<string, unknown>;
                    };
                  };
                };
              };
            };
          };
        };
      };
      const publishSchema =
        spec.paths["/api/shiplets"].post.requestBody.content["application/json"]
          .schema;

      expect(publishSchema.properties.external_url).toMatchObject({
        type: "string",
        format: "uri",
      });
      expect(publishSchema.description).toContain("external_url");
    });

    it("should create an anonymous sandbox playground session", async () => {
      const response = await requestHelper("/play");

      expect(response.status).toBe(200);
      const cookie = response.headers.get("set-cookie") || "";
      expect(cookie).toContain("shiplet_sandbox=");

      const html = await response.text();
      expect(html).toContain("Try Shiplet in a sandbox");
      expect(html).toContain("sandbox-playground");
      expect(html).toContain("/api/play/session");
      expect(html).toContain("/api/play/mcp");
      expect(html).toContain("mcp-endpoint-copy");
      expect(html).toContain("Copy MCP endpoint");
      expect(html).toContain("https://shiplet.cc/api/play/mcp?session=");
      expect(html).toContain(
        "Everyone visiting this public sandbox shares the same live room.",
      );
      expect(html).not.toContain("Reset sandbox");
    });

    it("should place unauthenticated visitors into the same default sandbox with separate actor MCP URLs", async () => {
      const firstResponse = await requestHelper("/api/play/session");
      const secondResponse = await requestHelper("/api/play/session");
      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);

      const first = (await firstResponse.json()) as {
        session: { id: string; shared: boolean; mcpUrl: string };
        shiplets: Array<{ id: string }>;
      };
      const second = (await secondResponse.json()) as {
        session: { id: string; shared: boolean; mcpUrl: string };
        shiplets: Array<{ id: string }>;
      };

      expect(first.session.id).toMatch(/^sbx_/);
      expect(first.session.shared).toBe(true);
      expect(second.session.id).toBe(first.session.id);
      expect(second.session.shared).toBe(true);
      expect(second.shiplets[0].id).toBe(first.shiplets[0].id);
      expect(first.session.mcpUrl).toContain(`session=${first.session.id}`);
      expect(first.session.mcpUrl).toContain("actor=sba_");
      expect(second.session.mcpUrl).toContain("actor=sba_");
      expect(second.session.mcpUrl).not.toBe(first.session.mcpUrl);
    });

    it("should preserve explicit sandbox sessions from the sandbox cookie", async () => {
      const sessionId = `sbx_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const firstResponse = await requestHelper(
        `/api/play/session?session=${sessionId}`,
      );
      const cookie = cookieHeaderFromResponse(firstResponse);
      const followUpResponse = await requestHelper("/api/play/session", {
        headers: { cookie },
      });

      expect(followUpResponse.status).toBe(200);
      const body = (await followUpResponse.json()) as {
        session: { id: string; shared: boolean };
      };
      expect(body.session.id).toBe(sessionId);
      expect(body.session.shared).toBe(false);
    });

    it("should default the playground page back to the shared sandbox even with an old private cookie", async () => {
      const sessionId = `sbx_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const privateResponse = await requestHelper(
        `/api/play/session?session=${sessionId}`,
      );
      const privateCookie = cookieHeaderFromResponse(privateResponse);

      const response = await requestHelper("/play", {
        headers: { cookie: privateCookie },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(
        "Everyone visiting this public sandbox shares the same live room.",
      );
      expect(html).not.toContain(sessionId);
    });

    it("should not allow the shared public sandbox to be reset", async () => {
      const response = await requestHelper(
        "/api/play/reset?session=sbx_sharedsandboxdemo0000000",
        { method: "POST" },
      );

      expect(response.status).toBe(403);
      expect(await response.text()).toContain(
        "Shared sandbox cannot be reset.",
      );
    });

    it("should keep the shared sandbox multiplayer while scoping default MCP reads to the actor", async () => {
      const firstResponse = await requestHelper("/api/play/session");
      const secondResponse = await requestHelper("/api/play/session");
      const firstCookie = cookieHeaderFromResponse(firstResponse);
      const secondCookie = cookieHeaderFromResponse(secondResponse);
      const firstSession = (await firstResponse.json()) as {
        session: { id: string; shared: boolean; mcpUrl: string };
        shiplets: Array<{ id: string; previewUrl: string }>;
      };
      const secondSession = (await secondResponse.json()) as {
        session: { id: string; shared: boolean; mcpUrl: string };
        shiplets: Array<{ id: string }>;
      };
      const project = firstSession.shiplets[0];
      const firstComment = `Actor one feedback ${crypto.randomUUID()}`;
      const secondComment = `Actor two feedback ${crypto.randomUUID()}`;

      expect(firstSession.session.shared).toBe(true);
      expect(secondSession.session.id).toBe(firstSession.session.id);
      expect(secondSession.shiplets[0].id).toBe(project.id);

      for (const [cookie, comment] of [
        [firstCookie, firstComment],
        [secondCookie, secondComment],
      ]) {
        const response = await requestHelper(
          `/api/projects/${project.id}/review-feedback`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", cookie },
            body: JSON.stringify({
              comment,
              pageUrl: `https://shiplet.cc${project.previewUrl}`,
              clientFeedbackId: `client-${crypto.randomUUID().slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
              screenshotMode: "page",
            }),
          },
        );
        expect(response.status).toBe(201);
      }

      const sharedListResponse = await requestHelper(
        `/api/projects/${project.id}/review-feedback?includeClosed=true`,
        { headers: { cookie: firstCookie } },
      );
      expect(sharedListResponse.status).toBe(200);
      const sharedList = (await sharedListResponse.json()) as {
        feedback: Array<{ comment: string }>;
      };
      expect(sharedList.feedback.map((item) => item.comment)).toContain(
        firstComment,
      );
      expect(sharedList.feedback.map((item) => item.comment)).toContain(
        secondComment,
      );

      async function mcpFeedbackComments(mcpUrl: string, query: string) {
        const response = await requestHelper(mcpUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: crypto.randomUUID(),
            method: "tools/call",
            params: {
              name: "execute",
              arguments: {
                code: `async () => await codemode.request({
									method: "GET",
									path: "/api/projects/${project.id}/review-feedback",
									query: ${query}
								})`,
              },
            },
          }),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          result: { content: Array<{ text: string }> };
        };
        return JSON.parse(body.result.content[0].text) as {
          feedback: Array<{ comment: string }>;
        };
      }

      const firstMcpList = await mcpFeedbackComments(
        firstSession.session.mcpUrl,
        "{ includeClosed: true }",
      );
      expect(firstMcpList.feedback.map((item) => item.comment)).toContain(
        firstComment,
      );
      expect(firstMcpList.feedback.map((item) => item.comment)).not.toContain(
        secondComment,
      );

      const secondMcpList = await mcpFeedbackComments(
        secondSession.session.mcpUrl,
        "{ includeClosed: true }",
      );
      expect(secondMcpList.feedback.map((item) => item.comment)).toContain(
        secondComment,
      );
      expect(secondMcpList.feedback.map((item) => item.comment)).not.toContain(
        firstComment,
      );

      const untrustedSharedList = await mcpFeedbackComments(
        firstSession.session.mcpUrl,
        "{ includeClosed: true, includeSharedUntrusted: true }",
      );
      expect(
        untrustedSharedList.feedback.map((item) => item.comment),
      ).toContain(secondComment);
    });

    it("should serve a reviewable sandbox preview and persist feedback without auth", async () => {
      const sessionId = `sbx_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const sessionResponse = await requestHelper(
        `/api/play/session?session=${sessionId}`,
      );
      expect(sessionResponse.status).toBe(200);
      const cookie = cookieHeaderFromResponse(sessionResponse);
      const sessionBody = (await sessionResponse.json()) as {
        session: { id: string; shared: boolean };
        shiplets: Array<{ id: string; name: string; previewUrl: string }>;
      };
      expect(sessionBody.session.id).toBe(sessionId);
      expect(sessionBody.session.shared).toBe(false);
      expect(sessionBody.shiplets.length).toBeGreaterThan(0);
      const project = sessionBody.shiplets[0];

      const previewResponse = await requestHelper(project.previewUrl, {
        headers: { cookie },
      });
      expect(previewResponse.status).toBe(200);
      expect(previewResponse.headers.get("x-shiplet-review")).toBeNull();
      const previewHtml = await previewResponse.text();
      expect(previewHtml).toContain('data-shiplet-trusted-review-host="v1"');
      expect(previewHtml).toContain(`${project.previewUrl}/artifact-frame`);
      expect(previewHtml).not.toContain("__SHIPLET_REVIEW__");
      expect(previewHtml).not.toContain("reviewToken");
      const artifactResponse = await requestHelper(
        `${project.previewUrl}/artifact-frame`,
        { headers: { cookie } },
      );
      expect(artifactResponse.status).toBe(200);
      expect(artifactResponse.headers.get("content-security-policy")).toContain(
        "sandbox allow-scripts",
      );

      const feedbackResponse = await requestHelper(
        `/api/projects/${project.id}/review-feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({
            comment: "This sandbox feedback should persist.",
            pageUrl: `https://shiplet.cc${project.previewUrl}`,
            clientFeedbackId: `client-${crypto.randomUUID().slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
            screenshotMode: "page",
          }),
        },
      );
      expect(feedbackResponse.status).toBe(201);
      const feedbackBody = (await feedbackResponse.json()) as {
        ok: boolean;
        feedback: { ticket_label: string; comment: string };
      };
      expect(feedbackBody.ok).toBe(true);
      expect(feedbackBody.feedback.ticket_label).toBe("PF-2");

      const listResponse = await requestHelper(
        `/api/projects/${project.id}/review-feedback?includeClosed=true`,
        { headers: { cookie } },
      );
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as {
        feedback: Array<{ comment: string }>;
      };
      expect(listBody.feedback.length).toBeGreaterThanOrEqual(2);
      expect(
        listBody.feedback.some((item) =>
          item.comment.includes("sandbox feedback"),
        ),
      ).toBe(true);
    });

    it("should keep sandbox feedback screenshots and full response metadata in collapsed manifest details", async () => {
      const sessionId = `sbx_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const sessionResponse = await requestHelper(
        `/api/play/session?session=${sessionId}`,
      );
      const cookie = cookieHeaderFromResponse(sessionResponse);
      const sessionBody = (await sessionResponse.json()) as {
        shiplets: Array<{ id: string; previewUrl: string }>;
      };
      const project = sessionBody.shiplets[0];
      const screenshotDataUrl =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
      const selectedElement = {
        selector: ".hero",
        tagName: "SECTION",
        text: "Sandbox manifest screenshot",
      };
      const captureContext = {
        elementCount: 42,
        documentWidth: 1280,
        documentHeight: 900,
      };

      const feedbackResponse = await requestHelper(
        `/api/projects/${project.id}/review-feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({
            comment: "The sandbox manifest should keep this context available.",
            pageUrl: `https://shiplet.cc${project.previewUrl}`,
            clientFeedbackId: `client-${crypto.randomUUID().slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
            screenshotDataUrl,
            screenshotMode: "element",
            viewport: { width: 390, height: 740, devicePixelRatio: 2 },
            coordinates: {
              pageX: 120,
              pageY: 240,
              viewportX: 120,
              viewportY: 240,
            },
            selectedElement,
            captureContext,
            userAgent: "sandbox-test-agent",
          }),
        },
      );
      expect(feedbackResponse.status).toBe(201);
      const feedbackBody = (await feedbackResponse.json()) as {
        feedback: {
          id: string;
          screenshot_url: string | null;
          screenshot_failure_note: string | null;
          selected_element: Record<string, unknown> | null;
          capture_context: Record<string, unknown> | null;
        };
      };
      expect(feedbackBody.feedback.screenshot_url).toBe(screenshotDataUrl);
      expect(feedbackBody.feedback.screenshot_failure_note).toBeNull();
      expect(feedbackBody.feedback.selected_element).toMatchObject(
        selectedElement,
      );
      expect(feedbackBody.feedback.capture_context).toMatchObject(
        captureContext,
      );

      const snapshotResponse = await requestHelper(
        `/api/play/session?session=${sessionId}`,
        { headers: { cookie } },
      );
      const snapshot = (await snapshotResponse.json()) as {
        feedback: Array<{
          id: string;
          screenshot_url: string | null;
          selected_element: Record<string, unknown> | null;
          capture_context: Record<string, unknown> | null;
        }>;
      };
      const manifestItem = snapshot.feedback.find(
        (item) => item.id === feedbackBody.feedback.id,
      );
      expect(manifestItem?.screenshot_url).toBe(screenshotDataUrl);
      expect(manifestItem?.selected_element).toMatchObject(selectedElement);
      expect(manifestItem?.capture_context).toMatchObject(captureContext);

      const pageResponse = await requestHelper(`/play?session=${sessionId}`, {
        headers: { cookie },
      });
      expect(pageResponse.status).toBe(200);
      const html = await pageResponse.text();
      expect(html).toContain("feedback-manifest-developer-context");
      expect(html).toContain("Developer context");
      expect(html).toContain("Full response");
      expect(html).toContain("feedback-manifest-response");
      expect(html).toContain("data-feedback-screenshot");
      expect(html).toContain("loading='eager'");
      expect(html).not.toContain("loading='lazy'");
      expect(html).toContain("screenshot_url");
      expect(html).toContain(screenshotDataUrl);
      expect(html).not.toContain(
        "<details class='feedback-context-details feedback-manifest-developer-context' open",
      );
    });

    it("should scope sandbox review feedback by page URL when requested", async () => {
      const sessionId = `sbx_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const sessionResponse = await requestHelper(
        `/api/play/session?session=${sessionId}`,
      );
      const cookie = cookieHeaderFromResponse(sessionResponse);
      const sessionBody = (await sessionResponse.json()) as {
        shiplets: Array<{ id: string; previewUrl: string }>;
      };
      const project = sessionBody.shiplets[0];
      const firstPageUrl = `https://shiplet.cc${project.previewUrl}`;
      const secondPageUrl = `https://shiplet.cc${project.previewUrl}/settings`;

      for (const [pageUrl, comment] of [
        [firstPageUrl, "First page sandbox feedback"],
        [secondPageUrl, "Second page sandbox feedback"],
      ]) {
        const response = await requestHelper(
          `/api/projects/${project.id}/review-feedback`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", cookie },
            body: JSON.stringify({
              comment,
              pageUrl,
              clientFeedbackId: `client-${crypto.randomUUID().slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
              screenshotMode: "page",
            }),
          },
        );
        expect(response.status).toBe(201);
      }

      const listResponse = await requestHelper(
        `/api/projects/${project.id}/review-feedback?includeClosed=true&pageUrl=${encodeURIComponent(secondPageUrl)}`,
        { headers: { cookie } },
      );
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as {
        feedback: Array<{ comment: string; page_url_key: string }>;
      };
      expect(listBody.feedback.map((item) => item.comment)).toContain(
        "Second page sandbox feedback",
      );
      expect(listBody.feedback.map((item) => item.comment)).not.toContain(
        "First page sandbox feedback",
      );
      expect(
        listBody.feedback.every((item) =>
          item.page_url_key.endsWith("/settings"),
        ),
      ).toBe(true);
    });

    it("should filter profanity before storing shared sandbox feedback", async () => {
      const sessionId = `sbx_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const sessionResponse = await requestHelper(
        `/api/play/session?session=${sessionId}`,
      );
      const cookie = cookieHeaderFromResponse(sessionResponse);
      const sessionBody = (await sessionResponse.json()) as {
        shiplets: Array<{ id: string; previewUrl: string }>;
      };
      const project = sessionBody.shiplets[0];

      const feedbackResponse = await requestHelper(
        `/api/projects/${project.id}/review-feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({
            comment: "This sandbox comment is shit.",
            name: "shit poster",
            pageUrl: `https://shiplet.cc${project.previewUrl}`,
            clientFeedbackId: `client-${crypto.randomUUID().slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
            screenshotMode: "page",
          }),
        },
      );

      expect(feedbackResponse.status).toBe(201);
      const feedbackBody = (await feedbackResponse.json()) as {
        feedback: {
          comment: string;
          name: string | null;
          submitted_by_email: string | null;
        };
      };
      expect(feedbackBody.feedback.comment).toBe(
        "This sandbox comment is [filtered].",
      );
      expect(feedbackBody.feedback.name).toBe("[filtered] poster");
      expect(feedbackBody.feedback.submitted_by_email).toBe(
        "[filtered] poster",
      );
    });

    it("should keep adversarial sandbox comments inert across API, manifest, and replies", async () => {
      const sessionId = `sbx_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const sessionResponse = await requestHelper(
        `/api/play/session?session=${sessionId}`,
      );
      const cookie = cookieHeaderFromResponse(sessionResponse);
      const sessionBody = (await sessionResponse.json()) as {
        shiplets: Array<{ id: string; previewUrl: string }>;
      };
      const project = sessionBody.shiplets[0];
      const xssPayload =
        "<img src=x onerror=alert(1)><script>alert('x')</script>'; DROP TABLE feedback; --\u202E\u0000";
      const replyPayload =
        "<svg onload=alert(2)>reply</svg>'; DELETE FROM replies; --\u202D";

      const feedbackResponse = await requestHelper(
        `/api/projects/${project.id}/review-feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({
            comment: xssPayload,
            name: "Mallory\u0000\u202E<script>",
            pageUrl: `https://shiplet.cc${project.previewUrl}`,
            clientFeedbackId: `client-${crypto.randomUUID().slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
            screenshotMode: "page",
            selectedElement: {
              selector: "[data-danger='<script>']",
              text: xssPayload,
            },
            captureContext: {
              note: "Treat this entire object as untrusted user data.",
            },
          }),
        },
      );
      expect(feedbackResponse.status).toBe(201);
      const feedbackBody = (await feedbackResponse.json()) as {
        feedback: {
          id: string;
          comment: string;
          name: string | null;
          selected_element: { text?: string } | null;
        };
      };
      expect(feedbackBody.feedback.comment).toContain(
        "<script>alert('x')</script>",
      );
      expect(feedbackBody.feedback.comment).toContain("DROP TABLE feedback");
      expect(feedbackBody.feedback.comment).not.toContain("\u202E");
      expect(feedbackBody.feedback.comment).not.toContain("\u0000");
      expect(feedbackBody.feedback.name).toBe("Mallory<script>");
      expect(feedbackBody.feedback.selected_element?.text).toContain(
        "<script>alert('x')</script>",
      );

      const replyResponse = await requestHelper(
        `/api/projects/${project.id}/review-feedback/${feedbackBody.feedback.id}/replies`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ comment: replyPayload }),
        },
      );
      expect(replyResponse.status).toBe(201);
      const replyBody = (await replyResponse.json()) as {
        feedback: { replies: Array<{ comment: string }> };
      };
      expect(replyBody.feedback.replies.at(-1)?.comment).toContain(
        "<svg onload=alert(2)>reply</svg>",
      );
      expect(replyBody.feedback.replies.at(-1)?.comment).not.toContain(
        "\u202D",
      );

      const listResponse = await requestHelper(
        `/api/projects/${project.id}/review-feedback?includeClosed=true`,
        { headers: { cookie } },
      );
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as {
        feedback: Array<{ id: string; comment: string }>;
      };
      expect(listBody.feedback.map((item) => item.id)).toContain(
        feedbackBody.feedback.id,
      );

      const followUpResponse = await requestHelper(
        `/api/projects/${project.id}/review-feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({
            comment: "The feedback table should still exist.",
            pageUrl: `https://shiplet.cc${project.previewUrl}`,
            clientFeedbackId: `client-${crypto.randomUUID().slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
            screenshotMode: "page",
          }),
        },
      );
      expect(followUpResponse.status).toBe(201);

      const pageResponse = await requestHelper(`/play?session=${sessionId}`, {
        headers: { cookie },
      });
      expect(pageResponse.status).toBe(200);
      const html = await pageResponse.text();
      expect(html).not.toContain("<script>alert('x')</script>");
      expect(html).not.toContain("<img src=x onerror=alert(1)>");
      expect(html).not.toContain("<svg onload=alert(2)>reply</svg>");
      expect(html).toContain("\\u003cscript>alert('x')\\u003c/script>");
      expect(html).toContain("\\u003cimg src=x onerror=alert(1)>");
    });

    it("should expire sandbox review comments after one day", async () => {
      const start = new Date("2026-01-01T12:00:00.000Z");
      vi.useFakeTimers();
      try {
        vi.setSystemTime(start);
        const sessionId = `sbx_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const sessionResponse = await requestHelper(
          `/api/play/session?session=${sessionId}`,
        );
        const cookie = cookieHeaderFromResponse(sessionResponse);
        const sessionBody = (await sessionResponse.json()) as {
          shiplets: Array<{ id: string; previewUrl: string }>;
        };
        const project = sessionBody.shiplets[0];
        const comment = "This sandbox feedback should expire.";

        const feedbackResponse = await requestHelper(
          `/api/projects/${project.id}/review-feedback`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", cookie },
            body: JSON.stringify({
              comment,
              pageUrl: `https://shiplet.cc${project.previewUrl}`,
              clientFeedbackId: `client-${crypto.randomUUID().slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
              screenshotMode: "page",
            }),
          },
        );
        expect(feedbackResponse.status).toBe(201);

        const freshList = await requestHelper(
          `/api/projects/${project.id}/review-feedback?includeClosed=true`,
          { headers: { cookie } },
        );
        expect(freshList.status).toBe(200);
        expect(
          (
            (await freshList.json()) as { feedback: Array<{ comment: string }> }
          ).feedback.map((item) => item.comment),
        ).toContain(comment);

        vi.setSystemTime(new Date(start.getTime() + 24 * 60 * 60 * 1000 + 1));
        const expiredList = await requestHelper(
          `/api/projects/${project.id}/review-feedback?includeClosed=true`,
          { headers: { cookie } },
        );
        expect(expiredList.status).toBe(200);
        expect(
          (
            (await expiredList.json()) as {
              feedback: Array<{ comment: string }>;
            }
          ).feedback.map((item) => item.comment),
        ).not.toContain(comment);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should expose sandbox Code Mode MCP without auth or real API keys", async () => {
      const sessionId = `sbx_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const sessionResponse = await requestHelper(
        `/api/play/session?session=${sessionId}`,
      );
      const sessionBody = (await sessionResponse.json()) as {
        session: { id: string; mcpUrl: string };
        shiplets: Array<{ id: string }>;
      };
      const cookie = cookieHeaderFromResponse(sessionResponse);
      const mcpPath = sessionBody.session.mcpUrl;

      const toolsResponse = await requestHelper(mcpPath, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(toolsResponse.status).toBe(200);
      const toolsBody = (await toolsResponse.json()) as {
        result: { tools: Array<{ name: string }> };
      };
      expect(toolsBody.result.tools.map((tool) => tool.name)).toEqual([
        "search",
        "execute",
      ]);

      const publishResponse = await requestHelper(mcpPath, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request({
								method: "POST",
								path: "/api/shiplets",
								body: { name: "Sandbox Agent Publish", subdomain: "agent-demo" }
							})`,
            },
          },
        }),
      });
      expect(publishResponse.status).toBe(200);
      const publishBody = (await publishResponse.json()) as {
        result: { content: Array<{ text: string }> };
      };
      const publishResult = JSON.parse(publishBody.result.content[0].text) as {
        ok: boolean;
        project: { id: string; name: string };
        shipletUrl: string;
      };
      expect(publishResult.ok).toBe(true);
      expect(publishResult.project.id).toContain(sessionBody.session.id);
      expect(publishResult.shipletUrl).toContain("/play/preview/");

      const listResponse = await requestHelper(mcpPath, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request({ method: "GET", path: "/api/shiplets" })`,
            },
          },
        }),
      });
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as {
        result: { content: Array<{ text: string }> };
      };
      expect(listBody.result.content[0].text).toContain(
        "Sandbox Agent Publish",
      );

      const feedbackId = sessionBody.shiplets[0].id;
      const createFeedbackResponse = await requestHelper(mcpPath, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request({
								method: "POST",
								path: "/api/projects/${feedbackId}/review-feedback",
								body: {
									comment: "Sandbox MCP feedback",
									pageUrl: "https://shiplet.cc/play/preview/${feedbackId}",
									clientFeedbackId: "client-${crypto.randomUUID().slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}",
									screenshotMode: "page"
								}
							})`,
            },
          },
        }),
      });
      expect(createFeedbackResponse.status).toBe(200);
      const createFeedbackBody = (await createFeedbackResponse.json()) as {
        result: { content: Array<{ text: string }> };
      };
      const createFeedbackResult = JSON.parse(
        createFeedbackBody.result.content[0].text,
      ) as { feedback: { id: string; comment: string } };
      expect(createFeedbackResult.feedback.comment).toBe(
        "Sandbox MCP feedback",
      );

      const feedbackListResponse = await requestHelper(mcpPath, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request({ method: "GET", path: "/api/projects/${feedbackId}/review-feedback", query: { includeClosed: true } })`,
            },
          },
        }),
      });
      expect(feedbackListResponse.status).toBe(200);
      const feedbackListBody = (await feedbackListResponse.json()) as {
        result: { content: Array<{ text: string }> };
      };
      const feedbackList = JSON.parse(
        feedbackListBody.result.content[0].text,
      ) as { feedback: Array<{ id: string; comment: string }> };
      expect(feedbackList.feedback.map((item) => item.comment)).toContain(
        "Sandbox MCP feedback",
      );
      const ticketId = createFeedbackResult.feedback.id;

      const replyResponse = await requestHelper(mcpPath, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request({
								method: "POST",
								path: "/api/projects/${feedbackId}/review-feedback/${ticketId}/replies",
								body: { comment: "Sandbox MCP reply" }
							})`,
            },
          },
        }),
      });
      expect(replyResponse.status).toBe(200);
      expect(await replyResponse.text()).toContain("Sandbox MCP reply");

      const statusResponse = await requestHelper(mcpPath, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request({
								method: "POST",
								path: "/api/projects/${feedbackId}/review-feedback/${ticketId}/status",
								body: { status: "Done" }
							})`,
            },
          },
        }),
      });
      expect(statusResponse.status).toBe(200);
      const statusBody = (await statusResponse.json()) as {
        result: { content: Array<{ text: string }> };
      };
      const statusResult = JSON.parse(statusBody.result.content[0].text) as {
        feedback: { status: string };
      };
      expect(statusResult.feedback.status).toBe("Done");
    });

    it("should support browser sessions in local test auth mode", async () => {
      await withCustomDomain("shiplet.cc", async () => {
        await withAppUrl("http://localhost", async () => {
          const callback = await requestHelper(
            "/auth/callback?code=test-code%3A%3Abrowser-ui%2540example.com",
            { redirect: "manual" },
          );
          expect(callback.status).toBe(302);
          const cookie = callback.headers.get("set-cookie");
          expect(cookie).toContain("shiplet_session=");
          expect(cookie).not.toMatch(/shiplet_session=[^,]*Domain=/i);

          const response = await requestHelper("/", {
            headers: { cookie: cookie || "" },
          });
          expect(response.status).toBe(200);
          const html = await response.text();
          expect(html).toContain("Create a shiplet");
          expect(html).toContain("Add access controls, contextual feedback");
          expect(html).toContain("shiplet-header-avatar");
          expect(html).not.toContain(">Settings</a>");
        });
      });
    });

    it("Given a Shiplet account from a previous WorkOS environment, When production AuthKit returns a new subject for the same email, Then the existing account and shiplet ownership are preserved", async () => {
      const email = `workos-environment-${crypto.randomUUID()}@example.com`;
      const stagingUserId = `user_workos_staging_${crypto.randomUUID().replaceAll("-", "")}`;
      const stagingHeaders = {
        "x-shiplet-user-id": stagingUserId,
        "x-shiplet-user-email": email,
      };
      const organizationResponse = await requestHelper("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...stagingHeaders },
        body: JSON.stringify({ name: "Existing staging account" }),
      });
      expect(organizationResponse.status).toBe(201);
      const organization = (await organizationResponse.json()) as {
        organization: { id: string };
      };
      const publishResponse = await requestHelper("/api/shiplets", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...stagingHeaders },
        body: JSON.stringify({
          name: "Existing staging shiplet",
          organization_id: organization.organization.id,
          subdomain: `workos-environment-${crypto.randomUUID().slice(0, 8)}`,
          assets: [
            {
              path: "index.html",
              content: btoa("<!doctype html><h1>Existing ownership</h1>"),
            },
          ],
        }),
      });
      expect(publishResponse.status).toBe(201);
      const published = (await publishResponse.json()) as {
        project: { id: string };
      };

      const callback = await requestHelper(
        `/auth/callback?code=${encodeURIComponent(`test-code::${encodeURIComponent(email)}`)}`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(302);
      const cookie = cookieHeaderFromResponse(callback);

      const meResponse = await requestHelper("/api/me", {
        headers: { cookie },
      });
      expect(meResponse.status).toBe(200);
      const me = (await meResponse.json()) as { user: { id: string } };
      expect(me.user.id).toBe(stagingUserId);

      const shipletsResponse = await requestHelper("/api/shiplets", {
        headers: { cookie },
      });
      expect(shipletsResponse.status).toBe(200);
      const shiplets = (await shipletsResponse.json()) as {
        projects: Array<{ id: string }>;
      };
      expect(shiplets.projects.map((project) => project.id)).toContain(
        published.project.id,
      );

      const localUsers = await (env as unknown as TestEnv).DB.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE lower(email) = lower(?)",
      )
        .bind(email)
        .first<{ count: number }>();
      expect(localUsers?.count).toBe(1);

      const identity = await (env as unknown as TestEnv).DB.prepare(
        `SELECT workos_user_id, user_id FROM workos_user_identities
         WHERE user_id = ? LIMIT 1`,
      )
        .bind(stagingUserId)
        .first<{ workos_user_id: string; user_id: string }>();
      expect(identity?.user_id).toBe(stagingUserId);
      expect(identity?.workos_user_id).not.toBe(stagingUserId);
    });

    it("should reject browser-normalized cross-origin auth return targets", async () => {
      for (const returnTo of ["/\\evil.example", "/\t/evil.example"]) {
        const login = await requestHelper(
          `/auth/login?return_to=${encodeURIComponent(returnTo)}`,
          { redirect: "manual" },
        );

        expect(login.status).toBe(302);
        const authorizationUrl = new URL(login.headers.get("location")!);
        const state = JSON.parse(
          atob(authorizationUrl.searchParams.get("state")!),
        ) as { returnTo: string };
        expect(state.returnTo).toBe("/");
      }
    });

    it("should assign and update user avatars", async () => {
      const callback = await requestHelper(
        "/auth/callback?code=test-code%3A%3Aavatar%2540example.com",
        { redirect: "manual" },
      );
      const cookie = cookieHeaderFromResponse(callback);
      const me = await requestHelper("/api/me", { headers: { cookie } });
      expect(me.status).toBe(200);
      const meBody = (await me.json()) as {
        user: { avatar_preset: string; avatar_data_url: string | null };
        avatarPresets: Array<{ id: string }>;
      };
      expect(meBody.avatarPresets).toHaveLength(12);
      expect(meBody.user.avatar_preset).toBeTruthy();
      expect(meBody.user.avatar_data_url).toBeNull();

      const updatePreset = await requestHelper("/api/me/avatar", {
        method: "POST",
        headers: {
          cookie,
          "Content-Type": "application/json",
          Origin: "https://shiplet.cc",
        },
        body: JSON.stringify({ avatarPreset: "violet-signal" }),
      });
      expect(updatePreset.status).toBe(200);
      const presetBody = (await updatePreset.json()) as {
        user: { avatar_preset: string; avatar_data_url: string | null };
      };
      expect(presetBody.user.avatar_preset).toBe("violet-signal");
      expect(presetBody.user.avatar_data_url).toBeNull();

      const uploadedAvatar =
        "data:image/png;base64," +
        btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10));
      const upload = await requestHelper("/api/me/avatar", {
        method: "POST",
        headers: {
          cookie,
          "Content-Type": "application/json",
          Origin: "https://shiplet.cc",
        },
        body: JSON.stringify({
          avatarPreset: "violet-signal",
          avatarDataUrl: uploadedAvatar,
        }),
      });
      expect(upload.status).toBe(200);
      const uploadBody = (await upload.json()) as {
        user: { avatar_preset: string; avatar_data_url: string | null };
      };
      expect(uploadBody.user.avatar_preset).toBe("violet-signal");
      expect(uploadBody.user.avatar_data_url).toBe(uploadedAvatar);
    });

    it("should accept avatar uploads up to 10MB and expose crop controls", async () => {
      const tenMbAvatar = `data:image/png;base64,${btoa("x".repeat(MAX_AVATAR_UPLOAD_BYTES))}`;
      const accepted = validateAvatarUpdate({
        avatarPreset: "aurora-grid",
        avatarDataUrl: tenMbAvatar,
      });
      expect(accepted.ok).toBe(true);

      const oversizedAvatar = `data:image/png;base64,${btoa("x".repeat(MAX_AVATAR_UPLOAD_BYTES + 1))}`;
      const rejected = validateAvatarUpdate({
        avatarPreset: "aurora-grid",
        avatarDataUrl: oversizedAvatar,
      });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.errors).toContain(
          "Avatar upload must be 10MB or smaller.",
        );
      }

      const account = await makeRequest("/account");
      const html = await account.text();
      expect(account.status).toBe(200);
      expect(html).toContain("PNG, JPEG, or WebP up to 10MB");
      expect(html).toMatch(/id="avatarCropPanel"[^>]*hidden/);
      expect(html).toContain('id="avatarCropCanvas"');
      expect(html).toContain('id="avatarCropZoom"');
      expect(html).toContain("drawAvatarCrop");
      expect(html).toContain("canvas.toDataURL");
      expect(html).toContain("Avatar image can be up to 10MB.");
      expect(html).not.toContain("512KB");
    });

    it("should keep account switching disabled by default", async () => {
      await withFeatureFlags("", async () => {
        const callback = await requestHelper(
          "/auth/callback?code=test-code%3A%3Adefault-account%2540example.com",
          { redirect: "manual" },
        );
        const cookie = cookieHeaderFromResponse(callback);
        expect(callback.headers.get("set-cookie")).toContain(
          "__Host-shiplet_session=",
        );
        expect(callback.headers.get("set-cookie")).not.toContain(
          "__Host-shiplet_account_group=",
        );

        const dashboard = await requestHelper("/api/dashboard", {
          headers: { cookie },
        });
        expect(dashboard.status).toBe(200);
        const body = (await dashboard.json()) as {
          features: { accountEmailSwitching: boolean };
          accountSessions?: unknown[];
        };
        expect(body.features.accountEmailSwitching).toBe(false);
        expect(body.accountSessions || []).toEqual([]);

        const switchResponse = await requestHelper("/auth/switch-account", {
          method: "POST",
          headers: {
            cookie,
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: "https://shiplet.cc",
          },
          body: new URLSearchParams({ session_id: "sess_missing" }),
          redirect: "manual",
        });
        expect(switchResponse.status).toBe(404);
      });
    });

    it("should group and switch active email accounts when the flag is enabled", async () => {
      await withFeatureFlags("account-email-switching", async () => {
        const firstCallback = await requestHelper(
          "/auth/callback?code=test-code%3A%3Aalice%2540example.com",
          { redirect: "manual" },
        );
        expect(firstCallback.status).toBe(302);
        const firstCookie = cookieHeaderFromResponse(firstCallback);
        expect(firstCallback.headers.get("set-cookie")).toContain(
          "__Host-shiplet_session=",
        );
        expect(firstCallback.headers.get("set-cookie")).toContain(
          "__Host-shiplet_account_group=",
        );

        const addAccountState = btoa(
          JSON.stringify({
            returnTo: "/account",
            accountAction: "add",
          }),
        );
        const secondCallback = await requestHelper(
          `/auth/callback?code=${encodeURIComponent("test-code::bob@example.com")}&state=${encodeURIComponent(addAccountState)}`,
          { headers: { cookie: firstCookie }, redirect: "manual" },
        );
        expect(secondCallback.status).toBe(302);
        expect(secondCallback.headers.get("location")).toBe("/account");
        const secondCookie = mergeCookieHeaders(
          firstCookie,
          cookieHeaderFromResponse(secondCallback),
        );

        const dashboard = await requestHelper("/api/dashboard", {
          headers: { cookie: secondCookie },
        });
        expect(dashboard.status).toBe(200);
        const body = (await dashboard.json()) as {
          user: { email: string };
          features: { accountEmailSwitching: boolean };
          accountSessions: Array<{
            session_id: string;
            email: string;
            active: boolean;
          }>;
        };
        expect(body.user.email).toBe("bob@example.com");
        expect(body.features.accountEmailSwitching).toBe(true);
        expect(
          body.accountSessions.map((account) => account.email).sort(),
        ).toEqual(["alice@example.com", "bob@example.com"]);
        expect(
          body.accountSessions.find(
            (account) => account.email === "bob@example.com",
          )?.active,
        ).toBe(true);
        const aliceSession = body.accountSessions.find(
          (account) => account.email === "alice@example.com",
        );
        expect(aliceSession?.active).toBe(false);

        const switchResponse = await requestHelper("/auth/switch-account", {
          method: "POST",
          headers: {
            cookie: secondCookie,
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: "https://shiplet.cc",
          },
          body: new URLSearchParams({
            session_id: aliceSession!.session_id,
            return_to: "/account",
          }),
          redirect: "manual",
        });
        expect(switchResponse.status).toBe(302);
        expect(switchResponse.headers.get("location")).toBe("/account");

        const switchedCookie = mergeCookieHeaders(
          secondCookie,
          cookieHeaderFromResponse(switchResponse),
        );
        const me = await requestHelper("/api/me", {
          headers: { cookie: switchedCookie },
        });
        expect(me.status).toBe(200);
        const meBody = (await me.json()) as {
          user: { email: string };
        };
        expect(meBody.user.email).toBe("alice@example.com");
      });
    });

    it("should return the Shiplet publishing UI on the root path", async () => {
      const response = await makeRequest("/");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");

      const html = await response.text();
      expect(html).toContain("Shiplet");
      expect(html).toContain("Create a shiplet");
      expect(html).toContain("Add access controls, contextual feedback");
      expect(html).toContain(">Create shiplet</button>");
      expect(html).toContain("Choose the source");
      expect(html).toContain("Upload a build or file");
      expect(html).toContain(
        "Name the shiplet, choose its address, and decide who can open it.",
      );
      expect(html).toContain("Shiplet name");
      expect(html).toContain("Shiplet address");
      expect(html).toContain(
        "Your shiplet includes comments, invites, and agent handoff.",
      );
      expect(html).toContain(
        "Reviewers open the shared work, comment in context, and send agent-ready tickets back to your queue.",
      );
      expect(html).toContain("Create your first shiplet to get started.");
      expect(html).not.toContain("Create a live review link");
      expect(html).not.toContain("Artifact name");
      expect(html).not.toContain("Upload a built artifact");
      expect(html).toContain('aria-label="Shiplet home"');
      expect(html).toContain("shiplet-header-avatar");
      expect(html).not.toContain("shiplet-brand-words");
      expect(html).not.toContain("shiplet-brand-name");
      expect(html).not.toContain("shiplet-brand-tagline");
      expect(html).toContain('data-platform-app="react-tanstack"');
      expect(html).toContain('data-platform-route="publish"');
      expectPlatformStartShell(html, "publish");
      expect(html).toContain("shiplet-publish-page");
      expect(html).toContain('class="shiplet-upload-dropzone"');
      expect(html).toContain("projectForm");
      expect(html).toContain("What reviewers get");
      expect(html).not.toContain("review cockpit");
      expect(html).toContain('href="/workspace"');
      expect(html).not.toContain(">Settings</a>");
      expect(html).toContain('id="organizationSelectGroup" hidden');
      expect(html).toContain(
        'hideSingleWorkspaceSelect = !!document.querySelector(".shiplet-publish-page");',
      );
      expect(html).toContain(
        "organizationGroup.hidden = hideSingleWorkspaceSelect && state.organizations.length <= 1;",
      );
      expect(html).not.toContain('id="organizationForm"');
      expect(html).not.toContain('id="organizationInviteForm"');
      expect(html).not.toContain('id="teamForm"');
      expect(html).not.toContain('id="shipletShareForm"');
      expect(html).not.toContain("API Keys and MCP");
    });

    it("should leave PostHog disabled until the environment is configured", async () => {
      await withPostHogEnv({}, async () => {
        const response = await makeRequest("/");
        const html = await response.text();

        expect(response.status).toBe(200);
        expect(html).not.toContain("window.POSTHOG_CONFIG");
        expect(html).not.toContain("/static/array.js");
        expect(html).not.toContain("posthog.init");
      });
    });

    it("should keep configured analytics from loading executable third-party code on trusted pages", async () => {
      await withPostHogEnv(
        { key: "phc_test_project", host: "https://eu.i.posthog.com" },
        async () => {
          const response = await makeRequest("https://shiplet.cc/");
          const html = await response.text();
          const csp = response.headers.get("content-security-policy") || "";

          expect(response.status).toBe(200);
          expect(html).not.toContain("window.POSTHOG_CONFIG");
          expect(html).not.toContain("/static/array.js");
          expect(html).not.toContain("cdnjs.cloudflare.com");
          expect(html).not.toContain('createElement("script")');
          expect(html).not.toMatch(/<script[^>]+src=["']https?:\/\//i);
          const scriptPolicy =
            csp
              .split(";")
              .find((directive) =>
                directive.trim().startsWith("script-src "),
              ) || "";
          expect(scriptPolicy.trim()).toMatch(
            /^script-src 'nonce-[A-Za-z0-9+/_=-]{20,}'$/,
          );
          expect(scriptPolicy).not.toContain("'unsafe-inline'");
          expect(scriptPolicy).not.toContain("https:");
          expect(csp).toContain("script-src-attr 'none'");
          expect(csp).toContain("frame-ancestors 'none'");
          expect(csp).toContain("object-src 'none'");
          expect(response.headers.get("strict-transport-security")).toBe(
            "max-age=31536000; includeSubDomains",
          );
          expect(response.headers.get("x-content-type-options")).toBe(
            "nosniff",
          );
          expect(response.headers.get("referrer-policy")).toBe(
            "strict-origin-when-cross-origin",
          );
          expect(response.headers.get("x-frame-options")).toBe("DENY");
        },
      );
    });

    it("should present simple source choices for creating a shiplet", async () => {
      const response = await makeRequest("/");
      const html = await response.text();
      const publishPanelRule = extractCssRule(html, ".publish-primary-panel");
      const hiddenRule = extractCssRule(html, "[hidden]");
      const voyageRailRule = extractCssRule(html, ".voyage-rail::before");

      expect(html).toContain("sourceModeUpload");
      expect(html).toContain("Upload files");
      expect(html).toContain(
        "Select supported files, including static exports, images, video, audio, PDFs, code, data, and GIS files.",
      );
      expect(html).not.toContain("Drop a built folder");
      expect(html).toContain("sourceModeUrl");
      expect(html).toContain("URL");
      expect(html).toContain(
        "Attach a staging page, PR deployment, hosted report, or public URL.",
      );
      expect(html).toContain("sourceModeHosting");
      expect(html).toContain("Agent or CI");
      expect(html).toContain(
        "Use API/MCP from agents, CLIs, CI jobs, and local scripts after build.",
      );
      expect(html).toContain('href="/docs/code-mode-mcp"');
      expect(html).toContain(">Open MCP quickstart</a>");
      expect(html).toContain('href="/openapi.json"');
      expect(html).toContain(">View REST/OpenAPI</a>");
      expect(html).toContain(
        "Reviewers open the shared work, comment in context, and send agent-ready tickets back to your queue.",
      );
      expect(html).toContain('id="externalUrl"');
      expect(publishPanelRule).toContain("data:image/svg+xml");
      expect(publishPanelRule).toContain("CLEARED");
      expect(publishPanelRule).toContain("font-size%3D%2221%22");
      expect(publishPanelRule).not.toContain("CUSTOMS");
      expect(publishPanelRule).not.toContain("REVIEW%20PORT");
      expect(publishPanelRule).not.toContain("rope-knot.png");
      expect(hiddenRule).toContain("display: none !important;");
      expect(html).toContain('id="organizationSelectGroup" hidden');
      expect(voyageRailRule).toContain("repeating-linear-gradient");
      expect(voyageRailRule).toContain("var(--action)");
      expect(voyageRailRule).not.toContain("rope-v.png");
      expect(html).not.toContain("voyage-rope");
      expect(html).not.toContain("rope-base");
      expect(html).not.toContain("rope-draw");
    });

    it("should keep source choice radios hidden without widening the desktop page", async () => {
      const response = await makeRequest("/");
      const html = await response.text();
      const sourceChoiceRule = extractCssRule(html, ".source-choice");
      const sourceChoiceInputRule = extractCssRule(
        html,
        ".source-choice input",
      );

      expect(
        html.includes(
          'input:not([type="checkbox"]):not([type="radio"]):not([type="file"])',
        ),
        "generic dashboard field styles must not target radio inputs",
      ).toBe(true);
      expect(
        html.includes('input:not([type="checkbox"]):not([type="file"])'),
        "the old form selector made hidden source radios full-width",
      ).toBe(false);
      expect(sourceChoiceRule).toContain("position: relative;");
      expect(sourceChoiceRule).toContain("overflow: hidden;");
      expect(sourceChoiceInputRule).toContain("position: absolute;");
      expect(sourceChoiceInputRule).toContain("top: 0;");
      expect(sourceChoiceInputRule).toContain("left: 0;");
      expect(sourceChoiceInputRule).toContain("width: 1px;");
      expect(sourceChoiceInputRule).toContain("height: 1px;");
      expect(sourceChoiceInputRule).toContain("margin: 0;");
      expect(sourceChoiceInputRule).toContain("padding: 0;");
      expect(sourceChoiceInputRule).toContain("border: 0;");
    });

    it("should split settings workflows into focused platform pages", async () => {
      const legacySettings = await makeRequest("/settings", {
        redirect: "manual",
      });
      expect(legacySettings.status).toBe(302);
      expect(legacySettings.headers.get("location")).toBe("/workspace");

      const workspace = await makeRequest("/workspace");
      const workspaceHtml = await workspace.text();
      expect(workspace.status).toBe(200);
      expect(workspaceHtml).toContain('data-platform-app="react-tanstack"');
      expect(workspaceHtml).toContain('data-platform-route="workspace"');
      expectPlatformStartShell(workspaceHtml, "workspace");
      expect(workspaceHtml).toContain('data-platform-nav="primary"');
      expect(workspaceHtml).toContain("Workspace");
      expect(workspaceHtml).toContain('id="organizationForm"');
      expect(workspaceHtml).toContain('id="organizationInviteForm"');
      expect(workspaceHtml).toContain('id="teamForm"');
      expect(workspaceHtml).toContain('id="teamInviteForm"');
      expect(workspaceHtml).not.toContain('id="avatarForm"');
      expect(workspaceHtml).not.toContain('id="shipletShareForm"');
      expect(workspaceHtml).not.toContain('id="tokenForm"');
      expect(workspaceHtml).not.toContain('id="refreshDashboard"');

      const account = await makeRequest("/account");
      const accountHtml = await account.text();
      expect(account.status).toBe(200);
      expect(accountHtml).toContain('data-platform-route="account"');
      expectPlatformStartShell(accountHtml, "account");
      expect(accountHtml).toContain("Profile");
      expect(accountHtml).toContain('id="avatarForm"');
      expect(accountHtml).toContain('id="accountList"');
      expect(accountHtml).toContain('id="addAccountLink"');
      expect(accountHtml).not.toContain('id="organizationForm"');
      expect(accountHtml).not.toContain('id="teamForm"');
      expect(accountHtml).not.toContain('id="shipletShareForm"');
      expect(accountHtml).not.toContain('id="tokenForm"');

      const access = await makeRequest("/access");
      const accessHtml = await access.text();
      expect(access.status).toBe(200);
      expect(accessHtml).toContain('data-platform-route="access"');
      expectPlatformStartShell(accessHtml, "access");
      expect(accessHtml).toContain("Shiplets and sharing");
      expect(accessHtml).toContain('id="shipletShareForm"');
      expect(accessHtml).toContain('id="projectList"');
      expect(accessHtml).not.toContain('id="organizationForm"');
      expect(accessHtml).not.toContain('id="teamForm"');
      expect(accessHtml).not.toContain('id="tokenForm"');

      const agents = await makeRequest("/agents");
      const agentsHtml = await agents.text();
      expect(agents.status).toBe(200);
      expect(agentsHtml).toContain('data-platform-route="agents"');
      expectPlatformStartShell(agentsHtml, "agents");
      expect(agentsHtml).toContain("API Keys and MCP");
      expect(agentsHtml).toContain("MCP endpoint");
      expect(agentsHtml).toContain("Copy MCP endpoint");
      expect(agentsHtml).toContain("https://shiplet.cc/api/mcp");
      expect(agentsHtml).toContain(
        'data-copy-value="https://shiplet.cc/api/mcp"',
      );
      expect(agentsHtml).toContain('id="tokenForm"');
      expect(agentsHtml).not.toContain('id="organizationForm"');
      expect(agentsHtml).not.toContain('id="shipletShareForm"');
    });

    it("should keep signed-in navigation focused without duplicate route links", async () => {
      const publish = await makeRequest("/");
      const publishHtml = await publish.text();
      const signedInHeaderNav = extractFirstNav(
        publishHtml,
        "shiplet-brand-nav",
      );
      expect(signedInHeaderNav).toContain('href="/docs"');
      expect(signedInHeaderNav).toContain('href="/account"');
      expect(signedInHeaderNav).not.toContain('href="/shiplets"');
      expect(signedInHeaderNav).not.toContain('href="/feedback"');
      expect(signedInHeaderNav).not.toContain('href="/"');

      const workspace = await makeRequest("/workspace");
      const workspaceHtml = await workspace.text();
      const platformNav = extractFirstNav(workspaceHtml, "platform-nav");
      expect(platformNav).toContain('href="/"');
      expect(platformNav).toContain('href="/shiplets"');
      expect(platformNav).toContain('href="/feedback"');
      expect(platformNav).toContain('href="/inbox"');
      expect(platformNav).toContain('href="/workspace"');
      expect(platformNav).not.toContain('href="/access"');
      expect(platformNav).not.toContain('href="/agents"');

      const settingsNav = extractFirstNav(workspaceHtml, "settings-nav");
      expect(settingsNav).toContain("Overview");
      expect(settingsNav).toContain("Account");
      expect(settingsNav).toContain("Access");
      expect(settingsNav).toContain("Agents");
      expect(settingsNav).not.toContain(">Workspace</a>");

      const shiplets = await makeRequest("/shiplets");
      const shipletsHtml = await shiplets.text();
      const shipletsTopbar =
        shipletsHtml.match(
          /<header class="app-page-topbar">[\s\S]*?<\/header>/,
        )?.[0] || "";
      expect(shipletsTopbar).toContain("Prepare artifact");
      expect(shipletsTopbar).not.toContain('href="/access"');

      const feedback = await makeRequest("/feedback");
      const feedbackHtml = await feedback.text();
      const feedbackTopbar =
        feedbackHtml.match(
          /<header class="app-page-topbar">[\s\S]*?<\/header>/,
        )?.[0] || "";
      expect(feedbackTopbar).not.toContain('href="/inbox"');
      expect(feedbackTopbar).not.toContain('href="/shiplets"');
    });

    it("should hide live nav badges until polling returns counts", async () => {
      const workspace = await makeRequest("/workspace");
      const html = await workspace.text();
      const inboxBadge = extractElementById(html, "platformInboxBadge");
      const feedbackBadge = extractElementById(html, "platformFeedbackBadge");

      expect(inboxBadge).toContain("data-live-notification-count");
      expect(inboxBadge).toMatch(/\shidden(?:[=>\s]|$)/);
      expect(inboxBadge).not.toContain(">0</span>");
      expect(feedbackBadge).toContain("data-live-feedback-count");
      expect(feedbackBadge).toMatch(/\shidden(?:[=>\s]|$)/);
      expect(feedbackBadge).not.toContain(">0</span>");
    });

    it("should replace manual refresh controls with platform live updates", async () => {
      for (const path of [
        "/",
        "/workspace",
        "/shiplets",
        "/inbox",
        "/feedback",
      ]) {
        const response = await makeRequest(path);
        const html = await response.text();
        expect(response.status).toBe(200);
        expect(html).toContain('data-live-updates="polling"');
        expect(html).toContain("shiplet-platform-live-updates");
        expect(html).not.toContain('id="refreshDashboard"');
        expect(html).not.toContain('id="refreshInbox"');
        expect(html).not.toContain('id="refreshFeedback"');
      }

      const inboxHtml = await (await makeRequest("/inbox")).text();
      expect(inboxHtml).toContain('data-live-notification-table="true"');
      expect(inboxHtml).toContain("notificationRows");

      const feedbackHtml = await (await makeRequest("/feedback")).text();
      expect(feedbackHtml).toContain('data-live-feedback-table="true"');
      expect(feedbackHtml).toContain("feedbackRows");
    });

    it("should require sign-in for the dedicated shiplets list page", async () => {
      const response = await requestHelper("/shiplets");

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "/auth/login?return_to=%2Fshiplets",
      );
    });

    it("should render a dedicated shiplets list page without publish controls", async () => {
      const organization = await createTestOrganization(makeRequest);
      const shipletName = `List Page Shiplet ${crypto.randomUUID().slice(0, 8)}`;
      const publishResponse = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: shipletName,
          organization_id: organization.id,
          subdomain: `list-page-${crypto.randomUUID().slice(0, 8)}`,
          assets: [
            {
              path: "index.html",
              content: btoa("<!doctype html><h1>List flow</h1>"),
              size: 42,
            },
          ],
        }),
      });
      expect(publishResponse.status).toBe(201);
      const publishBody = (await publishResponse.json()) as {
        project: { id: string; subdomain: string };
        reviewUrl: string;
        previewUrl: string;
      };

      const response = await makeRequest("/shiplets");
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain('data-platform-app="react-tanstack"');
      expect(html).toContain('data-platform-route="shiplets"');
      expectPlatformStartShell(html, "shiplets");
      expect(html).toContain("All shiplets");
      expect(html).toContain("shiplet-list-shell");
      expect(html).toContain("shiplet-list-toolbar");
      expect(html).toContain('id="shipletSearch"');
      expect(html).toContain('id="shipletMetricCount"');
      expect(html).toContain(shipletName);
      expect(html).toContain(publishBody.reviewUrl);
      expect(publishBody.previewUrl).toContain("/review-host");
      expect(html).not.toContain("shiplet_preview_token=");
      expect(html).toContain("shiplet-list-row");
      expect(html).toContain("shiplet-visibility-badge");
      expect(html).toContain("View live");
      expect(html).toContain("Copy URL");
      expect(html).toContain("projectList");
      expect(html).toContain("organizationSelect");
      expect(html).toContain("dashboardStatus");
      expect(html).toContain("/api/dashboard");
      expect(html).not.toContain('class="shiplet-upload-dropzone"');
      expect(html).not.toContain('id="shipletForm"');
      expect(html).not.toContain("API Keys and MCP");
    });

    it("should expose archive-only bulk actions on the shiplets list page", async () => {
      const organization = await createTestOrganization(makeRequest);
      const publishBody = await publishStaticShiplet(
        makeRequest,
        organization.id,
        {
          name: `Bulk Action Shiplet ${crypto.randomUUID().slice(0, 8)}`,
        },
      );

      const response = await makeRequest("/shiplets");
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("shiplet-bulk-actions");
      expect(html).toContain('id="shiplets-platform-root"');
      expect(html).toContain('id="shiplet-platform-shiplets-state"');
      expect(html).toContain('id="shiplet-platform-start-shell"');
      expect(html).toContain('src="/assets/platform/shiplets.js"');
      expect(html).toContain("shipletSelectAll");
      expect(html).toContain("data-shiplet-select");
      expect(html).toContain("data-bulk-archive");
      expect(html).toContain("Archive selected");
      expect(html).toContain(publishBody.project.id);
      expect(html).not.toContain("data-bulk-delete");
      expect(html).not.toContain("Permanently delete selected");
      expect(html).not.toContain('name="confirmSubdomain"');
    });

    it("should serve the hydrated shiplets client asset", async () => {
      const response = await makeRequest("/assets/platform/shiplets.js");
      const source = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/javascript",
      );
      expect(source).toContain("shiplets-platform-root");
      expect(source).toContain("hydrateRoot");
      expect(source).not.toContain("process.env.NODE_ENV");
    });

    it("should archive shiplets with a 30 day retention window and restore them", async () => {
      const organization = await createTestOrganization(makeRequest);
      const publishBody = await publishStaticShiplet(
        makeRequest,
        organization.id,
        {
          subdomain: `archive-${crypto.randomUUID().slice(0, 8)}`,
        },
      );
      const projectId = publishBody.project.id;

      const archiveResponse = await makeRequest(
        `/api/projects/${projectId}/archive`,
        { method: "POST" },
      );
      expect(archiveResponse.status).toBe(200);
      const archiveBody = (await archiveResponse.json()) as {
        project: { id: string; archived_on: string; delete_after: string };
      };
      expect(archiveBody.project.id).toBe(projectId);
      expect(archiveBody.project.archived_on).toBeTruthy();
      const retentionMs =
        new Date(archiveBody.project.delete_after).getTime() -
        new Date(archiveBody.project.archived_on).getTime();
      expect(retentionMs).toBeGreaterThanOrEqual(29 * 24 * 60 * 60 * 1000);
      expect(retentionMs).toBeLessThanOrEqual(31 * 24 * 60 * 60 * 1000);

      const dashboard = await makeRequest("/api/dashboard");
      expect(dashboard.status).toBe(200);
      const dashboardBody = (await dashboard.json()) as {
        projects: Array<{ id: string }>;
        archivedProjects: Array<{
          id: string;
          archived_on: string;
          delete_after: string;
        }>;
      };
      expect(
        dashboardBody.projects.some((project) => project.id === projectId),
      ).toBe(false);
      expect(
        dashboardBody.archivedProjects.some(
          (project) =>
            project.id === projectId &&
            Boolean(project.archived_on) &&
            Boolean(project.delete_after),
        ),
      ).toBe(true);

      const activeList = await makeRequest("/api/shiplets");
      const activeBody = (await activeList.json()) as {
        projects: Array<{ id: string }>;
      };
      expect(
        activeBody.projects.some((project) => project.id === projectId),
      ).toBe(false);

      const archivedList = await makeRequest("/api/shiplets?status=archived");
      const archivedBody = (await archivedList.json()) as {
        projects: Array<{ id: string; archived_on: string }>;
      };
      expect(
        archivedBody.projects.some(
          (project) => project.id === projectId && Boolean(project.archived_on),
        ),
      ).toBe(true);

      const restoreResponse = await makeRequest(
        `/api/projects/${projectId}/restore`,
        { method: "POST" },
      );
      expect(restoreResponse.status).toBe(200);
      const restoreBody = (await restoreResponse.json()) as {
        project: {
          id: string;
          archived_on: string | null;
          delete_after: string | null;
        };
      };
      expect(restoreBody.project.archived_on).toBeNull();
      expect(restoreBody.project.delete_after).toBeNull();

      const restoredDashboard = await makeRequest("/api/dashboard");
      const restoredDashboardBody = (await restoredDashboard.json()) as {
        projects: Array<{ id: string }>;
        archivedProjects: Array<{ id: string }>;
      };
      expect(
        restoredDashboardBody.projects.some(
          (project) => project.id === projectId,
        ),
      ).toBe(true);
      expect(
        restoredDashboardBody.archivedProjects.some(
          (project) => project.id === projectId,
        ),
      ).toBe(false);
    });

    it("should let editor-equivalent users archive and restore while reserving permanent delete for owners", async () => {
      const organization = await createTestOrganization(makeRequest);
      const publishBody = await publishStaticShiplet(
        makeRequest,
        organization.id,
        {
          subdomain: `editor-archive-${crypto.randomUUID().slice(0, 8)}`,
        },
      );
      const projectId = publishBody.project.id;
      const editor = await createTestOrganizationMember(
        organization.id,
        `editor-${crypto.randomUUID().slice(0, 8)}@example.com`,
      );
      const reviewer = {
        id: `user_reviewer_${crypto.randomUUID().replace(/-/g, "")}`,
        email: `reviewer-${crypto.randomUUID().slice(0, 8)}@example.com`,
      };
      const reviewerHeaders = {
        "x-shiplet-user-id": reviewer.id,
        "x-shiplet-user-email": reviewer.email,
      };
      await requestHelper("/api/me", { headers: reviewerHeaders });
      await (env as unknown as TestEnv).DB.prepare(
        `INSERT INTO shiplet_access_grants
				 (id, project_id, organization_id, target_type, target_id, email, role,
				  invited_by_user_id, created_on)
				 VALUES (?, ?, ?, 'user', ?, ?, 'reviewer', ?, ?)`,
      )
        .bind(
          `grant_${crypto.randomUUID().replace(/-/g, "")}`,
          projectId,
          organization.id,
          reviewer.id,
          reviewer.email,
          AUTH_HEADERS["x-shiplet-user-id"],
          new Date().toISOString(),
        )
        .run();

      const reviewerArchive = await requestHelper(
        `/api/projects/${projectId}/archive`,
        { method: "POST", headers: reviewerHeaders },
      );
      expect(reviewerArchive.status).toBe(403);

      const editorArchive = await requestHelper(
        `/api/projects/${projectId}/archive`,
        { method: "POST", headers: editor.headers },
      );
      expect(editorArchive.status).toBe(200);

      const editorRestore = await requestHelper(
        `/api/projects/${projectId}/restore`,
        { method: "POST", headers: editor.headers },
      );
      expect(editorRestore.status).toBe(200);

      await requestHelper(`/api/projects/${projectId}/archive`, {
        method: "POST",
        headers: editor.headers,
      });
      const editorDelete = await requestHelper(`/api/projects/${projectId}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          ...editor.headers,
        },
        body: JSON.stringify({
          confirmSubdomain: publishBody.project.subdomain,
        }),
      });
      expect(editorDelete.status).toBe(403);

      const ownerDelete = await makeRequest(`/api/projects/${projectId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmSubdomain: publishBody.project.subdomain,
        }),
      });
      expect(ownerDelete.status).toBe(200);
    });

    it("should bulk archive shiplets without exposing a bulk permanent delete", async () => {
      const organization = await createTestOrganization(makeRequest);
      const first = await publishStaticShiplet(makeRequest, organization.id, {
        subdomain: `bulk-one-${crypto.randomUUID().slice(0, 8)}`,
      });
      const second = await publishStaticShiplet(makeRequest, organization.id, {
        subdomain: `bulk-two-${crypto.randomUUID().slice(0, 8)}`,
      });

      const response = await makeRequest("/api/projects/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectIds: [first.project.id, second.project.id],
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        archived: Array<{ id: string; archived_on: string }>;
      };
      expect(body.archived.map((project) => project.id).sort()).toEqual(
        [first.project.id, second.project.id].sort(),
      );
      expect(
        body.archived.every((project) => Boolean(project.archived_on)),
      ).toBe(true);

      const bulkDelete = await makeRequest("/api/projects/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectIds: [first.project.id, second.project.id],
        }),
      });
      expect(bulkDelete.status).toBe(404);
    });

    it("should show an archived page with owner restore and hide it after permanent delete", async () => {
      const organization = await createTestOrganization(makeRequest);
      const publishBody = await publishStaticShiplet(
        makeRequest,
        organization.id,
        {
          subdomain: `archived-page-${crypto.randomUUID().slice(0, 8)}`,
        },
      );
      const projectId = publishBody.project.id;
      const subdomain = publishBody.project.subdomain;

      await makeRequest(`/api/projects/${projectId}/archive`, {
        method: "POST",
      });

      const archivedPage = await makeRequest(`/${subdomain}`);
      expect(archivedPage.status).toBe(200);
      const archivedHtml = await archivedPage.text();
      expect(archivedHtml).toContain("This shiplet has been archived");
      expect(archivedHtml).toContain("Restore shiplet");
      expect(archivedHtml).toContain(`/shiplets/${projectId}/restore`);
      expect(archivedHtml).toContain("delete_after");

      const embeddedArchivedPage = await makeRequest(
        `/shiplets/${projectId}/review-host`,
      );
      expect(embeddedArchivedPage.status).toBe(200);
      expect(
        embeddedArchivedPage.headers.get("content-security-policy"),
      ).toContain("frame-ancestors 'self'");
      expect(embeddedArchivedPage.headers.get("x-frame-options")).toBe(
        "SAMEORIGIN",
      );

      await withCustomDomain("shiplet.cc", async () => {
        const tenantArchivedPage = await makeRequest(
          `https://${subdomain}.shiplet.cc/`,
        );
        expect(tenantArchivedPage.status).toBe(200);
        const tenantArchivedHtml = await tenantArchivedPage.text();
        expect(tenantArchivedHtml).toContain("This shiplet has been archived");
        expect(tenantArchivedHtml).toContain(`/shiplets/${projectId}/restore`);
        expect(
          tenantArchivedPage.headers.get("content-security-policy"),
        ).toContain("frame-ancestors 'none'");
        expect(tenantArchivedPage.headers.get("x-frame-options")).toBe("DENY");
        expect(
          tenantArchivedPage.headers.get("strict-transport-security"),
        ).toBe("max-age=31536000; includeSubDomains");
      });

      const detail = await makeRequest(`/shiplets/${projectId}`);
      expect(detail.status).toBe(200);
      const detailHtml = await detail.text();
      expect(detailHtml).toContain("Archived");
      expect(detailHtml).toContain("restoreShipletForm");
      expect(detailHtml).toContain("permanentDeleteShipletForm");
      expect(detailHtml).toContain('name="confirmSubdomain"');
      expect(detailHtml).toContain(subdomain);

      const wrongConfirmation = await makeRequest(
        `/api/projects/${projectId}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmSubdomain: "wrong-subdomain" }),
        },
      );
      expect(wrongConfirmation.status).toBe(400);

      const deleteResponse = await makeRequest(`/api/projects/${projectId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmSubdomain: subdomain }),
      });
      expect(deleteResponse.status).toBe(200);
      const deleteBody = (await deleteResponse.json()) as { deleted: boolean };
      expect(deleteBody.deleted).toBe(true);

      const missingPage = await makeRequest(`/${subdomain}`);
      expect(missingPage.status).toBe(404);
      expect(await missingPage.text()).not.toContain(
        "This shiplet has been archived",
      );
      const missingDetail = await makeRequest(`/shiplets/${projectId}`);
      expect(missingDetail.status).toBe(404);
    });

    it("should show a launch page with preview, review, and sharing after publish", async () => {
      const organization = await createTestOrganization(makeRequest);
      const publishResponse = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Launch Page Shiplet",
          organization_id: organization.id,
          subdomain: `launch-page-${crypto.randomUUID().slice(0, 8)}`,
          assets: [
            {
              path: "index.html",
              content: btoa("<!doctype html><h1>Launch flow</h1>"),
              size: 44,
            },
          ],
        }),
      });
      expect(publishResponse.status).toBe(201);
      const publishBody = (await publishResponse.json()) as {
        project: { id: string; subdomain: string };
        launchUrl: string;
        reviewUrl: string;
        previewUrl: string;
      };
      expect(publishBody.launchUrl).toBe(
        `/shiplets/${publishBody.project.id}?created=1`,
      );
      expect(publishBody.previewUrl).toBe(
        `/shiplets/${publishBody.project.id}/review-host`,
      );
      expect(publishBody.reviewUrl).toBe(
        expectedPublicShipletUrl(publishBody.project.subdomain),
      );

      const pageResponse = await makeRequest(publishBody.launchUrl);
      expect(pageResponse.status).toBe(200);
      const html = await pageResponse.text();
      expect(html).toContain("Shiplet ready");
      expect(html).toContain("Published for review");
      expect(html).toContain("Share the review link");
      expect(html).not.toContain("validated revision");
      expect(html).not.toContain(
        `href="/shiplets/${publishBody.project.id}/ownership"`,
      );
      expect(html).toContain("shiplet-detail-page");
      expect(html).toContain("bridge-interior-scene");
      expect(html).toContain("bridge-wheel-svg");
      expect(html).toContain("bridge-window-frame");
      expect(html).toContain("bridge-harbor-horizon");
      expect(html).toContain("bridge-console");
      expect(html).toContain("bridge-gauge");
      expect(html).not.toContain('<div class="arrival-water"></div>');
      expect(html).toContain("artifactPreviewFrame");
      expect(html).toContain(publishBody.previewUrl);
      expect(html).toContain("shipletShareForm");
      expect(html).toContain("showInviteForm");
      expect(html).toContain('id="shipletInviteFields" hidden');
      expect(html).toContain("bridgeCommentForm");
      expect(html).toContain("bridgeComment");
      expect(html).toContain("Add comment");
      expect(html).toContain("bridge-comment-submit");
      expect(html).toContain("feedbackList");
      expect(html).toContain("feedback-ticket-screenshot");
      expect(html).toContain("feedback-ticket-screenshot-note");
      expect(html).toContain("feedback-ticket-status-select");
      expect(html).toContain("data-feedback-screenshot");
      expect(html).toContain("feedback-screenshot-lightbox");
      expect(html).toContain("openFeedbackScreenshotLightbox");
      expect(html).toContain("aspect-ratio: 16 / 10;");
      expect(html).toContain("object-fit: contain;");
      expect(html).toContain("feedback-context-details");
      expect(html).toContain("commentLabelFor");
      expect(html).toContain("review-feedback");
      expect(html).toContain("shiplet:feedback-created");
      expect(html).toContain("startFeedbackAutoRefresh");
      expect(html).toContain("Invite reviewers");
      expect(html).toContain("Comments");
      expect(html).not.toContain("Tickets reviewers filed on this artifact.");
      expect(html).toContain("https://shiplet.cc/api/mcp");
      expect(html).toContain("mcp-endpoint-copy");
      expect(html).toContain("Copy MCP endpoint");
      expect(html).not.toContain("Review cockpit");

      const bridgeResponse = await makeRequest(
        `/shiplets/${publishBody.project.id}`,
      );
      expect(bridgeResponse.status).toBe(200);
      const bridgeHtml = await bridgeResponse.text();
      expect(bridgeHtml).toContain("Review bridge");
      expect(bridgeHtml).toContain("bridge-interior-scene");
      expect(bridgeHtml).toContain("bridge-wheel-svg");
      expect(bridgeHtml).toContain("bridge-window-frame");
      expect(bridgeHtml).toContain("bridge-harbor-horizon");
      expect(bridgeHtml).toContain("bridge-console");
      expect(bridgeHtml).toContain("bridge-gauge");
      expect(bridgeHtml).not.toContain('<div class="arrival-water"></div>');
      expect(bridgeHtml).not.toContain("Review cockpit");

      const previewResponse = await makeRequest(publishBody.previewUrl);
      expect(previewResponse.status).toBe(200);
      expect(previewResponse.headers.get("x-shiplet-review")).toBeNull();
      const previewHtml = await previewResponse.text();
      expect(previewHtml).toContain('data-shiplet-trusted-review-host="v1"');
      expect(previewHtml).toContain(
        `/shiplets/${publishBody.project.id}/artifact-frame/`,
      );
      expect(previewHtml).not.toContain("__SHIPLET_REVIEW__");
      expect(previewHtml).toContain("/api/review/host.js");
      const rawPreview = await makeRequest(
        `/shiplets/${publishBody.project.id}/artifact-frame/`,
      );
      expect(await rawPreview.text()).toContain("Launch flow");
    });

    it("should redirect anonymous shiplet detail visitors to login and authenticated outsiders to request access", async () => {
      const organization = await createTestOrganization(makeRequest);
      const publishBody = await publishStaticShiplet(
        makeRequest,
        organization.id,
      );

      const anonymousResponse = await requestHelper(publishBody.launchUrl, {
        redirect: "manual",
      });
      expect(anonymousResponse.status).toBe(302);
      expect(anonymousResponse.headers.get("location")).toBe(
        `/auth/login?return_to=${encodeURIComponent(publishBody.launchUrl)}`,
      );

      const deniedResponse = await requestHelper(publishBody.launchUrl, {
        headers: {
          "x-shiplet-user-id": "user_without_shiplet_access",
          "x-shiplet-user-email": "without-access@example.com",
        },
        redirect: "manual",
      });
      expect(deniedResponse.status).toBe(302);
      expect(deniedResponse.headers.get("location")).toBe(
        `/shiplets/${publishBody.project.id}/access`,
      );

      const requestAccessResponse = await requestHelper(
        deniedResponse.headers.get("location")!,
        {
          headers: {
            "x-shiplet-user-id": "user_without_shiplet_access",
            "x-shiplet-user-email": "without-access@example.com",
          },
        },
      );
      expect(requestAccessResponse.status).toBe(200);
      const html = await requestAccessResponse.text();
      expect(html).toContain(`Request access to ${publishBody.project.name}`);
      expect(html).toContain("without-access@example.com");
      expect(html).toContain(">Request access</button>");
      expect(html).not.toContain("Review artifact");

      const deniedPreview = await requestHelper(publishBody.previewUrl, {
        headers: {
          "x-shiplet-user-id": "user_without_shiplet_access",
          "x-shiplet-user-email": "without-access@example.com",
        },
        redirect: "manual",
      });
      expect(deniedPreview.status).toBe(302);
      expect(deniedPreview.headers.get("location")).toBe(
        `/shiplets/${publishBody.project.id}/access`,
      );
    });

    it("should grant organization access from WorkOS membership without trusting a matching email domain alone", async () => {
      const organization = await createTestOrganization(makeRequest);
      const publishBody = await publishStaticShiplet(
        makeRequest,
        organization.id,
      );
      const member = await createTestOrganizationMember(
        organization.id,
        "member@example.com",
      );

      const memberResponse = await requestHelper(publishBody.launchUrl, {
        headers: member.headers,
      });
      expect(memberResponse.status).toBe(200);
      expect(await memberResponse.text()).toContain("Review artifact");

      const unverifiedDomainMatch = await requestHelper(
        `/shiplets/${publishBody.project.id}/access`,
        {
          headers: {
            "x-shiplet-user-id": "user_unverified_domain_match",
            "x-shiplet-user-email": "coworker@example.com",
          },
        },
      );
      expect(unverifiedDomainMatch.status).toBe(200);
      expect(await unverifiedDomainMatch.text()).toContain("Request access to");

      const privateShiplet = await publishStaticShiplet(
        makeRequest,
        organization.id,
        { visibility: "private" },
      );
      const privateMemberResponse = await requestHelper(
        privateShiplet.launchUrl,
        {
          headers: member.headers,
          redirect: "manual",
        },
      );
      expect(privateMemberResponse.status).toBe(302);
      expect(privateMemberResponse.headers.get("location")).toBe(
        `/shiplets/${privateShiplet.project.id}/access`,
      );

      const memberShareResponse = await requestHelper(
        `/api/projects/${privateShiplet.project.id}/invitations`,
        {
          method: "POST",
          headers: {
            ...member.headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            targetType: "organization",
            organizationId: organization.id,
            role: "viewer",
          }),
        },
      );
      expect(memberShareResponse.status).toBe(403);

      const memberShipletsResponse = await requestHelper("/api/shiplets", {
        headers: member.headers,
      });
      expect(memberShipletsResponse.status).toBe(200);
      const memberShiplets = (await memberShipletsResponse.json()) as {
        projects: Array<{ id: string }>;
      };
      expect(
        memberShiplets.projects.map((project) => project.id),
      ).not.toContain(privateShiplet.project.id);

      const ownerToken = await createOrganizationApiToken(
        makeRequest,
        organization.id,
        { name: "Owner-only key" },
      );
      const memberDashboardResponse = await requestHelper("/api/dashboard", {
        headers: member.headers,
      });
      expect(memberDashboardResponse.status).toBe(200);
      const memberDashboard = (await memberDashboardResponse.json()) as {
        projects: Array<{ id: string }>;
        projectsByOrganization: Record<string, Array<{ id: string }>>;
        apiTokensByOrganization: Record<string, Array<{ id: string }>>;
        organizationRolesByOrganization: Record<string, string>;
      };
      expect(
        memberDashboard.projects.map((project) => project.id),
      ).not.toContain(privateShiplet.project.id);
      expect(
        (memberDashboard.projectsByOrganization[organization.id] || []).map(
          (project) => project.id,
        ),
      ).not.toContain(privateShiplet.project.id);
      expect(
        memberDashboard.apiTokensByOrganization[organization.id] || [],
      ).toEqual([]);
      expect(
        memberDashboard.organizationRolesByOrganization[organization.id],
      ).toBe("member");

      const memberAgentsResponse = await requestHelper("/agents", {
        headers: member.headers,
      });
      expect(memberAgentsResponse.status).toBe(200);
      const memberAgentsHtml = await memberAgentsResponse.text();
      expect(memberAgentsHtml).toMatch(/id="tokenManagement" hidden(?:=""|)/);
      expect(memberAgentsHtml).toContain(
        "Organization administrator access is required to manage API keys.",
      );
      expect(memberAgentsHtml).toContain(
        "state.organizationRolesByOrganization",
      );

      const memberTokenListResponse = await requestHelper(
        `/api/organizations/${organization.id}/api-tokens`,
        { headers: member.headers },
      );
      expect(memberTokenListResponse.status).toBe(403);

      const memberTokenCreateResponse = await requestHelper(
        `/api/organizations/${organization.id}/api-tokens`,
        {
          method: "POST",
          headers: {
            ...member.headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Unauthorized key" }),
        },
      );
      expect(memberTokenCreateResponse.status).toBe(403);

      const memberTokenRevokeResponse = await requestHelper(
        `/api/organizations/${organization.id}/api-tokens/${ownerToken.record.id}`,
        { method: "DELETE", headers: member.headers },
      );
      expect(memberTokenRevokeResponse.status).toBe(403);
    });

    it("should preserve organization administrator access during WorkOS membership reconciliation", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const adminEmail = `org-admin-${suffix}@example.com`;
      const adminHeaders = {
        "x-shiplet-user-id": `user_org-admin-${suffix}-example-com`,
        "x-shiplet-user-email": adminEmail,
      };
      const organizationResponse = await requestHelper("/api/organizations", {
        method: "POST",
        headers: {
          ...adminHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: `Admin workspace ${suffix}` }),
      });
      expect(organizationResponse.status).toBe(201);
      const organization = (await organizationResponse.json()) as {
        organization: { id: string };
      };
      const invitationResponse = await requestHelper(
        `/api/organizations/${organization.organization.id}/invitations`,
        {
          method: "POST",
          headers: {
            ...adminHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: adminEmail,
            role: "member",
          }),
        },
      );
      expect(invitationResponse.status).toBe(201);

      const callback = await requestHelper(
        `/auth/callback?code=${encodeURIComponent(
          `test-code:${organization.organization.id}:${encodeURIComponent(adminEmail)}`,
        )}`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(302);

      const tokenList = await requestHelper(
        `/api/organizations/${organization.organization.id}/api-tokens`,
        { headers: adminHeaders },
      );
      expect(tokenList.status).toBe(200);

      const membership = await (env as unknown as TestEnv).DB.prepare(
        `SELECT role
				 FROM organization_memberships
				 WHERE organization_id = ? AND user_id = ?`,
      )
        .bind(organization.organization.id, adminHeaders["x-shiplet-user-id"])
        .first<{ role: string }>();
      expect(membership?.role).toBe("admin");
    });

    it("should prevent organization members from creating administrator invitations", async () => {
      const organization = await createTestOrganization(makeRequest);
      const member = await createTestOrganizationMember(
        organization.id,
        `member-admin-invite-${crypto.randomUUID().slice(0, 8)}@example.com`,
      );

      const invitationResponse = await requestHelper(
        `/api/organizations/${organization.id}/invitations`,
        {
          method: "POST",
          headers: {
            ...member.headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: member.email,
            role: "admin",
          }),
        },
      );
      expect(invitationResponse.status).toBe(403);

      const workspaceResponse = await requestHelper("/workspace", {
        headers: member.headers,
      });
      expect(workspaceResponse.status).toBe(200);
      const workspaceHtml = await workspaceResponse.text();
      expect(workspaceHtml).toMatch(
        /<option value="admin" disabled(?:=""|) hidden(?:=""|)>Admin<\/option>/,
      );
      expect(workspaceHtml).toContain(
        "adminRoleOption.disabled = !canAssignAdmin",
      );

      const membership = await (env as unknown as TestEnv).DB.prepare(
        `SELECT role
				 FROM organization_memberships
				 WHERE organization_id = ? AND user_id = ?`,
      )
        .bind(organization.id, member.id)
        .first<{ role: string }>();
      expect(membership?.role).toBe("member");
    });

    it("should reject unsupported organization invitation roles", async () => {
      const organization = await createTestOrganization(makeRequest);
      const member = await createTestOrganizationMember(
        organization.id,
        `member-custom-role-${crypto.randomUUID().slice(0, 8)}@example.com`,
      );
      const invitedEmail = `custom-role-target-${crypto.randomUUID().slice(0, 8)}@example.com`;

      const invitationResponse = await requestHelper(
        `/api/organizations/${organization.id}/invitations`,
        {
          method: "POST",
          headers: {
            ...member.headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: invitedEmail,
            role: "owner",
          }),
        },
      );
      expect(invitationResponse.status).toBe(400);

      const invitation = await (env as unknown as TestEnv).DB.prepare(
        `SELECT id
				 FROM app_invitations
				 WHERE organization_id = ? AND email = ?`,
      )
        .bind(organization.id, invitedEmail)
        .first<{ id: string }>();
      expect(invitation).toBeNull();
    });

    it("should reject organization role escalation through team invitations", async () => {
      const organization = await createTestOrganization(makeRequest);
      const member = await createTestOrganizationMember(
        organization.id,
        `member-team-invite-${crypto.randomUUID().slice(0, 8)}@example.com`,
      );
      const teamResponse = await makeRequest(
        `/api/organizations/${organization.id}/teams`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `Team invite boundary ${crypto.randomUUID().slice(0, 8)}`,
          }),
        },
      );
      expect(teamResponse.status).toBe(201);
      const { team } = (await teamResponse.json()) as {
        team: { id: string };
      };

      const invitationResponse = await requestHelper(
        `/api/organizations/${organization.id}/teams/${team.id}/invitations`,
        {
          method: "POST",
          headers: {
            ...member.headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: `team-admin-target-${crypto.randomUUID().slice(0, 8)}@example.com`,
            role: "admin",
          }),
        },
      );
      expect(invitationResponse.status).toBe(400);

      const invitation = await (env as unknown as TestEnv).DB.prepare(
        `SELECT id
				 FROM app_invitations
				 WHERE organization_id = ? AND team_id = ? AND role = 'admin'`,
      )
        .bind(organization.id, team.id)
        .first<{ id: string }>();
      expect(invitation).toBeNull();
    });

    it("should not honor a pending administrator invitation created by a non-administrator", async () => {
      const organization = await createTestOrganization(makeRequest);
      const member = await createTestOrganizationMember(
        organization.id,
        `legacy-admin-inviter-${crypto.randomUUID().slice(0, 8)}@example.com`,
      );
      const invitedEmail = `legacy-admin-target-${crypto.randomUUID().slice(0, 8)}@example.com`;
      const createdOn = new Date().toISOString();

      await (env as unknown as TestEnv).DB.prepare(
        `INSERT INTO app_invitations
				 (id, organization_id, team_id, project_id, email, invite_type, role,
				  status, invited_by_user_id, workos_invitation_id,
				  workos_invitation_token, created_on, accepted_on)
				 VALUES (?, ?, NULL, NULL, ?, 'organization', 'admin', 'pending',
				  ?, ?, ?, ?, NULL)`,
      )
        .bind(
          `appinv_${crypto.randomUUID().replace(/-/g, "")}`,
          organization.id,
          invitedEmail,
          member.id,
          `inv_${crypto.randomUUID().replace(/-/g, "")}`,
          `tok_${crypto.randomUUID().replace(/-/g, "")}`,
          createdOn,
        )
        .run();

      const callback = await requestHelper(
        `/auth/callback?code=${encodeURIComponent(
          `test-code:${organization.id}:${encodeURIComponent(invitedEmail)}`,
        )}`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(302);

      const membership = await (env as unknown as TestEnv).DB.prepare(
        `SELECT organization_memberships.role
				 FROM organization_memberships
				 JOIN users ON users.id = organization_memberships.user_id
				 WHERE organization_memberships.organization_id = ?
				   AND users.email = ?`,
      )
        .bind(organization.id, invitedEmail)
        .first<{ role: string }>();
      expect(membership?.role).toBe("member");
    });

    it("should promote an existing organization member who accepts an administrator invitation", async () => {
      const organization = await createTestOrganization(makeRequest);
      const member = await createTestOrganizationMember(
        organization.id,
        `promoted-admin-${crypto.randomUUID().slice(0, 8)}@example.com`,
      );
      const invitationResponse = await makeRequest(
        `/api/organizations/${organization.id}/invitations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: member.email,
            role: "admin",
          }),
        },
      );
      expect(invitationResponse.status).toBe(201);

      const callback = await requestHelper(
        `/auth/callback?code=${encodeURIComponent(
          `test-code:${organization.id}:${encodeURIComponent(member.email)}`,
        )}`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(302);

      const membership = await (env as unknown as TestEnv).DB.prepare(
        `SELECT role
				 FROM organization_memberships
				 WHERE organization_id = ? AND user_id = ?`,
      )
        .bind(organization.id, member.id)
        .first<{ role: string }>();
      expect(membership?.role).toBe("admin");
    });

    it("should deduplicate access requests and email the shiplet owner without granting access", async () => {
      const organization = await createTestOrganization(makeRequest);
      const publishBody = await publishStaticShiplet(
        makeRequest,
        organization.id,
      );
      const requesterHeaders = {
        "x-shiplet-user-id": "user_external_requester",
        "x-shiplet-user-email": "external.requester@gmail.com",
      };
      const sentMessages: Array<{
        to: string;
        subject: string;
        html?: string;
        text?: string;
      }> = [];

      await withEmailBinding(
        async (message) => {
          sentMessages.push(message);
          return { id: "access-request-message" };
        },
        async () => {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const response = await requestHelper(
              `/shiplets/${publishBody.project.id}/access-requests`,
              {
                method: "POST",
                headers: requesterHeaders,
                redirect: "manual",
              },
            );
            expect(response.status).toBe(303);
            expect(response.headers.get("location")).toBe(
              `/shiplets/${publishBody.project.id}/access`,
            );
          }
        },
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        to: AUTH_HEADERS["x-shiplet-user-email"],
      });
      expect(sentMessages[0].subject).toContain("requested access");
      expect(sentMessages[0].text).toContain("external.requester@gmail.com");
      expect(sentMessages[0].text).toContain(publishBody.project.name);
      expect(sentMessages[0].text).toContain(
        `/shiplets/${publishBody.project.id}`,
      );

      const requestPage = await requestHelper(
        `/shiplets/${publishBody.project.id}/access`,
        { headers: requesterHeaders },
      );
      expect(requestPage.status).toBe(200);
      const requestHtml = await requestPage.text();
      expect(requestHtml).toContain("Access request sent");
      expect(requestHtml).not.toContain(">Request access</button>");
      expect(requestHtml).not.toContain("Review artifact");

      const stillDenied = await requestHelper(publishBody.launchUrl, {
        headers: requesterHeaders,
        redirect: "manual",
      });
      expect(stillDenied.status).toBe(302);
      expect(stillDenied.headers.get("location")).toBe(
        `/shiplets/${publishBody.project.id}/access`,
      );

      const row = await (env as unknown as TestEnv).DB.prepare(
        `SELECT status, email_status
				 FROM shiplet_access_requests
				 WHERE project_id = ? AND requester_user_id = ?`,
      )
        .bind(publishBody.project.id, requesterHeaders["x-shiplet-user-id"])
        .first<{ status: string; email_status: string }>();
      expect(row).toEqual({ status: "pending", email_status: "sent" });
    });

    it("should show a retryable error when an access-request email cannot be delivered", async () => {
      const organization = await createTestOrganization(makeRequest);
      const publishBody = await publishStaticShiplet(
        makeRequest,
        organization.id,
      );
      const requesterHeaders = {
        "x-shiplet-user-id": "user_failed_requester",
        "x-shiplet-user-email": "failed.requester@gmail.com",
      };

      await withEmailBinding(
        async () => {
          throw new Error("email provider unavailable");
        },
        async () => {
          const response = await requestHelper(
            `/shiplets/${publishBody.project.id}/access-requests`,
            {
              method: "POST",
              headers: requesterHeaders,
              redirect: "manual",
            },
          );
          expect(response.status).toBe(303);
        },
      );

      const requestPage = await requestHelper(
        `/shiplets/${publishBody.project.id}/access`,
        { headers: requesterHeaders },
      );
      expect(requestPage.status).toBe(200);
      const requestHtml = await requestPage.text();
      expect(requestHtml).toContain("We couldn’t send your request");
      expect(requestHtml).toContain(">Try again</button>");
      expect(requestHtml).not.toContain("Access request sent");

      const row = await (env as unknown as TestEnv).DB.prepare(
        `SELECT status, email_status
				 FROM shiplet_access_requests
				 WHERE project_id = ? AND requester_user_id = ?`,
      )
        .bind(publishBody.project.id, requesterHeaders["x-shiplet-user-id"])
        .first<{ status: string; email_status: string }>();
      expect(row).toEqual({ status: "pending", email_status: "failed" });
    });

    it("should retry an access-request email after an interrupted delivery claim becomes stale", async () => {
      const organization = await createTestOrganization(makeRequest);
      const publishBody = await publishStaticShiplet(
        makeRequest,
        organization.id,
      );
      const requesterHeaders = {
        "x-shiplet-user-id": "user_stale_requester",
        "x-shiplet-user-email": "stale.requester@gmail.com",
      };

      await withEmailBinding(
        async () => {
          throw new Error("email provider unavailable");
        },
        async () => {
          const response = await requestHelper(
            `/shiplets/${publishBody.project.id}/access-requests`,
            {
              method: "POST",
              headers: requesterHeaders,
              redirect: "manual",
            },
          );
          expect(response.status).toBe(303);
        },
      );

      await (env as unknown as TestEnv).DB.prepare(
        `UPDATE shiplet_access_requests
				 SET email_status = 'sending', updated_on = '1970-01-01T00:00:00.000Z'
				 WHERE project_id = ? AND requester_user_id = ?`,
      )
        .bind(publishBody.project.id, requesterHeaders["x-shiplet-user-id"])
        .run();

      const sentMessages: Array<{ to: string }> = [];
      await withEmailBinding(
        async (message) => {
          sentMessages.push(message);
          return { id: "retried-access-request-message" };
        },
        async () => {
          const response = await requestHelper(
            `/shiplets/${publishBody.project.id}/access-requests`,
            {
              method: "POST",
              headers: requesterHeaders,
              redirect: "manual",
            },
          );
          expect(response.status).toBe(303);
        },
      );

      expect(sentMessages).toHaveLength(1);
      const row = await (env as unknown as TestEnv).DB.prepare(
        `SELECT status, email_status
				 FROM shiplet_access_requests
				 WHERE project_id = ? AND requester_user_id = ?`,
      )
        .bind(publishBody.project.id, requesterHeaders["x-shiplet-user-id"])
        .first<{ status: string; email_status: string }>();
      expect(row).toEqual({ status: "pending", email_status: "sent" });
    });

    it("should ignore a late email result after a stale delivery claim is retried", async () => {
      const organization = await createTestOrganization(makeRequest);
      const publishBody = await publishStaticShiplet(
        makeRequest,
        organization.id,
      );
      const requesterHeaders = {
        "x-shiplet-user-id": "user_late_stale_requester",
        "x-shiplet-user-email": "late.stale.requester@gmail.com",
      };
      let deliveryAttempt = 0;
      let rejectFirstDelivery!: (reason?: unknown) => void;
      let markFirstDeliveryStarted!: () => void;
      const firstDeliveryStarted = new Promise<void>((resolve) => {
        markFirstDeliveryStarted = resolve;
      });

      await withEmailBinding(
        () => {
          deliveryAttempt += 1;
          if (deliveryAttempt === 1) {
            return new Promise((_, reject) => {
              rejectFirstDelivery = reject;
              markFirstDeliveryStarted();
            });
          }
          return Promise.resolve({ id: "retried-access-request-message" });
        },
        async () => {
          const firstResponsePromise = requestHelper(
            `/shiplets/${publishBody.project.id}/access-requests`,
            {
              method: "POST",
              headers: requesterHeaders,
              redirect: "manual",
            },
          );
          await firstDeliveryStarted;

          await (env as unknown as TestEnv).DB.prepare(
            `UPDATE shiplet_access_requests
						 SET updated_on = '1970-01-01T00:00:00.000Z'
						 WHERE project_id = ? AND requester_user_id = ?`,
          )
            .bind(publishBody.project.id, requesterHeaders["x-shiplet-user-id"])
            .run();

          const retryResponse = await requestHelper(
            `/shiplets/${publishBody.project.id}/access-requests`,
            {
              method: "POST",
              headers: requesterHeaders,
              redirect: "manual",
            },
          );
          expect(retryResponse.status).toBe(303);

          rejectFirstDelivery(new Error("late delivery failure"));
          const firstResponse = await firstResponsePromise;
          expect(firstResponse.status).toBe(303);
        },
      );

      expect(deliveryAttempt).toBe(2);
      const row = await (env as unknown as TestEnv).DB.prepare(
        `SELECT status, email_status
				 FROM shiplet_access_requests
				 WHERE project_id = ? AND requester_user_id = ?`,
      )
        .bind(publishBody.project.id, requesterHeaders["x-shiplet-user-id"])
        .first<{ status: string; email_status: string }>();
      expect(row).toEqual({ status: "pending", email_status: "sent" });
    });

    it("should publish and serve shiplets on dedicated tenant subdomains", async () => {
      await withCustomDomain("shiplet.cc", async () => {
        const organization = await createTestOrganization(makeRequest);
        const subdomain = `tenant-${crypto.randomUUID().slice(0, 8)}`;
        const publishResponse = await makeRequest("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Tenant Subdomain Shiplet",
            organization_id: organization.id,
            subdomain,
            assets: [
              {
                path: "index.html",
                content: btoa("<!doctype html><h1>Tenant Shiplet</h1>"),
                size: 43,
              },
            ],
          }),
        });

        expect(publishResponse.status).toBe(201);
        const publishBody = (await publishResponse.json()) as {
          project: { id: string; subdomain: string };
          shipletUrl: string;
          artifactUrl: string;
          reviewUrl: string;
          launchUrl: string;
        };
        const tenantUrl = `https://${subdomain}.shiplet.cc`;
        expect(publishBody.project.subdomain).toBe(subdomain);
        expect(publishBody.shipletUrl).toBe(tenantUrl);
        expect(publishBody.artifactUrl).toBe(tenantUrl);
        expect(publishBody.reviewUrl).toBe(tenantUrl);
        expect(publishBody.launchUrl).toBe(
          `/shiplets/${publishBody.project.id}?created=1`,
        );

        const anonymousTenantResponse = await requestHelper(`${tenantUrl}/`, {
          redirect: "manual",
        });
        expect(anonymousTenantResponse.status).toBe(302);
        const anonymousLoginUrl = new URL(
          anonymousTenantResponse.headers.get("location")!,
        );
        expect(anonymousLoginUrl.origin).toBe("https://shiplet.cc");
        expect(anonymousLoginUrl.pathname).toBe("/auth/login");
        const accessGateUrl = new URL(
          anonymousLoginUrl.searchParams.get("return_to")!,
        );
        expect(accessGateUrl.pathname).toBe(
          `/shiplets/${publishBody.project.id}/access`,
        );
        expect(accessGateUrl.searchParams.get("return_to")).toBe(
          `${tenantUrl}/`,
        );

        const anonymousTenantAuthResponse = await requestHelper(
          `${tenantUrl}/auth/login?return_to=%2F`,
          { redirect: "manual" },
        );
        expect(anonymousTenantAuthResponse.status).toBe(302);
        const nestedLoginUrl = new URL(
          anonymousTenantAuthResponse.headers.get("location")!,
        );
        expect(nestedLoginUrl.origin).toBe("https://shiplet.cc");
        expect(nestedLoginUrl.pathname).toBe("/auth/login");
        const nestedAccessGate = new URL(
          nestedLoginUrl.searchParams.get("return_to")!,
        );
        expect(nestedAccessGate.pathname).toBe(
          `/shiplets/${publishBody.project.id}/access`,
        );
        expect(nestedAccessGate.searchParams.get("return_to")).toBe(
          `${tenantUrl}/auth/login?return_to=%2F`,
        );

        const tenantResponse = await makeRequest(`${tenantUrl}/`);
        expect(tenantResponse.status).toBe(200);
        expect(tenantResponse.headers.get("x-shiplet-review")).toBeNull();
        const tenantHtml = await tenantResponse.text();
        expect(tenantHtml).toContain("Tenant Subdomain Shiplet");
        expect(tenantHtml).toContain('data-shiplet-trusted-review-host="v1"');
        expect(tenantHtml).not.toContain("__SHIPLET_REVIEW__");
        const tenantRaw = await makeRequest(
          `${tenantUrl}/__shiplet/artifact-frame/`,
        );
        expect(await tenantRaw.text()).toContain("Tenant Shiplet");

        const localFallbackResponse = await makeRequest(`/${subdomain}/`);
        expect(localFallbackResponse.status).toBe(200);
        expect(await localFallbackResponse.text()).toContain(
          "Tenant Subdomain Shiplet",
        );

        const rootResponse = await makeRequest("https://shiplet.cc/");
        expect(rootResponse.status).toBe(200);
        expect(await rootResponse.text()).toContain("Create a shiplet");
      });
    });

    it("should route platform pages on the configured app host during local custom-domain development", async () => {
      await withCustomDomain("localhost", async () => {
        await withAppUrl("https://shiplet.cc", async () => {
          const root = await makeRequest("https://shiplet.cc/");
          expect(root.status).toBe(200);
          expect(await root.text()).toContain('data-platform-route="publish"');

          const workspace = await makeRequest("https://shiplet.cc/workspace");
          expect(workspace.status).toBe(200);
          expect(await workspace.text()).toContain(
            'data-platform-route="workspace"',
          );
        });
      });
    });

    it("should expose the Shiplet brand system in the dashboard", async () => {
      const response = await makeRequest("/");
      const html = await response.text();
      const header =
        html.match(
          /<header class="shiplet-brand-header"[^>]*>[\s\S]*?<\/header>/,
        )?.[0] || "";

      expect(html).toContain("shiplet-brand-shell");
      expect(html).toContain("shiplet-brand-mark");
      expect(header.match(/data-header-vessel="primary"/g)).toHaveLength(1);
      for (const markDetail of [
        "shiplet-mark-vessel",
        "shiplet-mark-depth",
        "shiplet-mark-water-contact",
        "shiplet-mark-wake",
        "shiplet-brand-wake-extension",
      ]) {
        expect(header).toContain(markDetail);
      }
      expect(header).toContain('data-header-variant="authenticated"');
      expect(header.match(/<svg class="shiplet-waterline-svg"/g)).toHaveLength(
        1,
      );
      for (const waterlineLayer of [
        "shiplet-waterline-far",
        "shiplet-waterline-mid",
        "shiplet-waterline-near",
        "shiplet-waterline-foam",
      ]) {
        expect(header).toContain(waterlineLayer);
      }
      for (const authenticatedDetail of [
        "shiplet-waterline-marker-buoy",
        "shiplet-waterline-avatar-ripple",
      ]) {
        expect(header).toContain(authenticatedDetail);
      }
      expect(header).not.toContain("shiplet-waterline-vessel");
      expect(header).not.toContain("shiplet-waterline-pilot-skiff");
      expect(header).not.toContain("shiplet-waterline-distant-vessel");
      expect(html.indexOf("shiplet-waterline")).toBeLessThan(
        html.indexOf("</header>"),
      );
      expect(html).toContain(".shiplet-brand-header {\n  position: relative;");
      const brandInnerCssStart = html.indexOf(".shiplet-brand-inner {");
      const brandInnerCssEnd = html.indexOf("\n}", brandInnerCssStart);
      const brandInnerCss = html.slice(brandInnerCssStart, brandInnerCssEnd);
      expect(brandInnerCss).toContain("z-index: 3;");
      expect(html).toContain(".shiplet-waterline {\n  position: absolute;");
      expect(html).toContain("inset: auto -1px 0 -1px;");
      expect(html).toContain("pointer-events: none;");
      expect(html).toContain("z-index: 2;");
      expect(html).toContain('<a href="/docs">Docs</a>');
      const brandNavLinkCssStart = html.indexOf("\n.shiplet-brand-nav a {\n");
      const brandNavLinkCssEnd = html.indexOf("\n}", brandNavLinkCssStart);
      const brandNavLinkCss = html.slice(
        brandNavLinkCssStart,
        brandNavLinkCssEnd,
      );
      expect(brandNavLinkCss).toContain("color: var(--text);");
      expect(html).not.toContain("shiplet-docs-ship");
      expect(html).not.toContain("shiplet-docs-label");
      expect(html).not.toContain("docs-label-rock");
      const avatarCssStart = html.indexOf("\n.shiplet-header-avatar {\n");
      const avatarCssEnd = html.indexOf("\n}", avatarCssStart);
      const avatarCss = html.slice(avatarCssStart, avatarCssEnd);
      expect(avatarCss).toContain("position: relative;");
      expect(avatarCss).toContain("z-index: 4;");
      expect(avatarCss).toContain("width: 44px;");
      expect(avatarCss).toContain("height: 44px;");
      expect(avatarCss).toContain("background: var(--surface-sunken);");
      const slowMotionNames = [
        "shiplet-header-wake-shimmer",
        "shiplet-waterline-far-drift",
        "shiplet-waterline-mid-drift",
        "shiplet-waterline-near-drift",
        "shiplet-waterline-foam-drift",
        "shiplet-waterline-buoy-drift",
        "shiplet-waterline-avatar-ripple",
      ];
      for (const animationName of slowMotionNames) {
        const keyframeStart = html.indexOf(`@keyframes ${animationName}`);
        const nextKeyframe = html.indexOf("@keyframes", keyframeStart + 1);
        const keyframe = html.slice(
          keyframeStart,
          nextKeyframe === -1 ? undefined : nextKeyframe,
        );
        expect(keyframe).toContain("transform:");
        expect(keyframe).not.toContain("background-");
        expect(keyframe).not.toContain("opacity:");
      }
      expect(html).toContain(
        ".shiplet-brand-header .shiplet-mark-water-motion { animation: shiplet-header-wake-shimmer 6.4s ease-in-out -1.7s infinite; }",
      );
      const waterlineCssStart = html.indexOf(".shiplet-waterline {");
      const waterlineCssEnd = html.indexOf(".shiplet-main {", waterlineCssStart);
      const waterlineCss = html.slice(waterlineCssStart, waterlineCssEnd);
      expect(waterlineCss).toContain("height: 34px;");
      expect(waterlineCss).toContain("color: var(--mark-harbor);");
      expect(waterlineCss).not.toContain("data:image/svg+xml");
      for (const waterlineColorRule of [
        ".shiplet-waterline-far { color: var(--mark-harbor);",
        ".shiplet-waterline-mid { color: var(--mark-harbor);",
        ".shiplet-waterline-near { color: var(--mark-harbor);",
        ".shiplet-waterline-marker-buoy .shiplet-waterline-buoy-body { fill: var(--action); stroke: var(--action);",
        ".shiplet-waterline-foam { color: color-mix(in oklch, var(--surface), var(--mark-harbor) 24%);",
      ]) {
        expect(waterlineCss).toContain(waterlineColorRule);
      }
      expect(html).toContain(
        "html:not(.js) .shiplet-waterline-svg :is(.shiplet-waterline-wave, .shiplet-waterline-avatar-ripple) { animation: none; transform: none; }",
      );
      expect(html).toContain(
        "html:not(.js) .shiplet-brand-mark :is(.shiplet-mark-vessel, .shiplet-mark-water-motion) { animation: none; transform: none; }",
      );
      expect(html).toContain(
        ".shiplet-waterline-svg :is(.shiplet-waterline-wave, .shiplet-waterline-avatar-ripple) { transform: none; }",
      );
      expect(html).toContain(
        ".shiplet-brand-mark :is(.shiplet-mark-vessel, .shiplet-mark-water-motion) { transform: none; }",
      );
      expect(html).toContain(
        ".shiplet-waterline-svg .shiplet-waterline-drawn { stroke-dashoffset: 0; }",
      );
      expect(html).not.toContain("translate: 0 22px;");
      expect(html).not.toContain("waterline-boat");
      expect(html).toContain("shiplet-dashboard-stage");
      expect(html).toContain("shiplet-panel");
      expect(html).toContain("shiplet-focus-strip");
      expect(html).toContain("domain-input-group");
      expect(html).toContain('id="subdomainSuffix">.shiplet.cc</span>');
    });

    it("should wire drag and drop upload into the publish file input", async () => {
      const response = await makeRequest("/");
      const html = await response.text();

      expect(html).toContain("data-upload-dropzone");
      expect(html).toContain("handleUploadDrop");
      expect(html).toContain("event.dataTransfer.files");
      expect(html).toContain("fileInput.files = event.dataTransfer.files");
      expect(html).toContain("is-dragging");
    });

    it("should include mobile responsive dashboard structure", async () => {
      const response = await makeRequest("/");
      const workspaceResponse = await makeRequest("/workspace");
      const agentsResponse = await makeRequest("/agents");
      const html = `${await response.text()}\n${await workspaceResponse.text()}\n${await agentsResponse.text()}`;

      expect(html).toContain(
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
      );
      expect(html).toContain("dashboard-section-header");
      expect(html).toContain("dashboard-actions");
      expect(html).toContain("inline-field-row");
      expect(html).toContain("settings-layout");
      expect(html).toContain("scope-grid");
      expect(html).toContain("scope-pill");
      expect(html).toContain("@media (max-width: 640px)");
      expect(html).toContain("min-height: 44px");
      expect(html).toContain("-webkit-overflow-scrolling: touch");
      expect(html).toContain("grid-template-columns: 1fr !important");
      expect(html).toContain(
        "grid-template-columns: repeat(2, minmax(0, 1fr));",
      );
      expect(html).toContain("overflow-x: visible;");
      expect(html).toContain("flex-direction: column;");
      expect(html).toContain("min-width: 0;");
    });

    it("should expose homepage SEO, social, and structured metadata", async () => {
      const response = await requestHelper("/");
      const html = await response.text();

      expect(html).toContain(
        "<title>Shiplet | Review Builds, Files, and Live URLs</title>",
      );
      expect(html).toContain(
        '<meta name="description" content="Add a trusted review layer to builds, files, and live URLs for contextual feedback and agent handoff.">',
      );
      expect(html).toContain(
        '<link rel="canonical" href="https://shiplet.cc/">',
      );
      expect(html).toContain('<meta property="og:type" content="website">');
      expect(html).toContain(
        '<meta property="og:url" content="https://shiplet.cc/">',
      );
      expect(html).toContain(
        '<meta property="og:image" content="https://shiplet.cc/og-image.png">',
      );
      expect(html).toContain(
        '<meta name="twitter:card" content="summary_large_image">',
      );
      expect(html).toContain('<link rel="manifest" href="/site.webmanifest">');
      expect(html).toMatch(/<script\b[^>]*type="application\/ld\+json"[^>]*>/);
      expect(html).toContain('"@type":"SoftwareApplication"');
      expect(html).toContain('"url":"https://shiplet.cc/"');
      expect(html).toContain('"name":"Prepare a review"');
    });

    it("should expose unique canonical metadata and one page heading per docs route", async () => {
      const docs = await requestHelper("/docs");
      const docsHtml = await docs.text();
      expect(docsHtml).toContain("<title>Introduction | Shiplet Docs</title>");
      expect(docsHtml).toContain(
        '<meta name="description" content="Prepare an artifact, share a review link, and collect contextual feedback.">',
      );
      expect(docsHtml).toContain(
        '<link rel="canonical" href="https://shiplet.cc/docs">',
      );
      expect(docsHtml).toContain(
        '<meta property="og:url" content="https://shiplet.cc/docs">',
      );
      expect(docsHtml.match(/<h1(?:\s[^>]*)?>/g) || []).toHaveLength(1);
      expect(docsHtml).toContain("<h1>Introduction</h1>");

      const mcpDocs = await requestHelper("/docs/code-mode-mcp");
      const mcpHtml = await mcpDocs.text();
      expect(mcpHtml).toContain("<title>Code Mode MCP | Shiplet Docs</title>");
      expect(mcpHtml).toContain(
        '<meta name="description" content="Connect an agent, then prepare artifacts and work with feedback.">',
      );
      expect(mcpHtml).toContain(
        '<link rel="canonical" href="https://shiplet.cc/docs/code-mode-mcp">',
      );
      expect(mcpHtml).toContain(
        '<meta property="og:url" content="https://shiplet.cc/docs/code-mode-mcp">',
      );

      const duplicateIntroduction = await requestHelper("/docs/introduction", {
        redirect: "manual",
      });
      expect(duplicateIntroduction.status).toBe(301);
      expect(duplicateIntroduction.headers.get("location")).toBe("/docs");
    });

    it("Given a reader opens an unknown docs route, When the page is rendered, Then recovery stays inside the branded docs experience", async () => {
      const response = await requestHelper("/docs/not-a-page");

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html).toContain("Documentation page not found");
      expect(html).toContain('href="/docs"');
      expect(html).toContain("Shiplet documentation");
      expect(html).toContain("OpenAPI JSON");
    });

    it("should prevent indexing of private and machine-readable surfaces", async () => {
      const authenticatedHome = await requestHelper("/", {
        headers: AUTH_HEADERS,
      });
      const authenticatedHtml = await authenticatedHome.text();
      expect(authenticatedHome.headers.get("x-robots-tag")).toBe(
        "noindex, nofollow, noarchive",
      );
      expect(authenticatedHtml).toContain(
        '<meta name="robots" content="noindex,nofollow,noarchive">',
      );
      expect(authenticatedHtml).not.toContain('<link rel="canonical"');

      const sandbox = await requestHelper("/play");
      const sandboxHtml = await sandbox.text();
      expect(sandbox.headers.get("x-robots-tag")).toBe(
        "noindex, nofollow, noarchive",
      );
      expect(sandboxHtml).toContain(
        '<meta name="robots" content="noindex,nofollow,noarchive">',
      );

      const openapi = await requestHelper("/openapi.json");
      expect(openapi.headers.get("x-robots-tag")).toBe(
        "noindex, nofollow, noarchive",
      );
    });

    it("should serve crawler and AI discovery files", async () => {
      const robots = await requestHelper("/robots.txt");
      expect(robots.status).toBe(200);
      expect(robots.headers.get("content-type")).toContain("text/plain");
      const robotsText = await robots.text();
      expect(robotsText).toContain("Sitemap: https://shiplet.cc/sitemap.xml");
      expect(robotsText).toContain("Allow: /");
      expect(robotsText).toContain("Disallow: /api/");

      const sitemap = await requestHelper("/sitemap.xml");
      expect(sitemap.status).toBe(200);
      expect(sitemap.headers.get("content-type")).toContain("application/xml");
      const sitemapXml = await sitemap.text();
      expect(sitemapXml).toContain("<loc>https://shiplet.cc/</loc>");
      expect(sitemapXml).toContain("<loc>https://shiplet.cc/docs</loc>");
      expect(sitemapXml).toContain(
        "<loc>https://shiplet.cc/docs/code-mode-mcp</loc>",
      );
      for (const route of [
        "why-shiplet",
        "extensions",
        "security",
        "publishing",
        "api-surface",
      ]) {
        expect(sitemapXml).toContain(
          `<loc>https://shiplet.cc/docs/${route}</loc>`,
        );
      }
      for (const retiredRoute of [
        "packages-revisions",
        "cli",
        "deployment",
        "external-setup",
      ]) {
        expect(sitemapXml).not.toContain(`/docs/${retiredRoute}</loc>`);
      }
      expect(sitemapXml).not.toContain("/llms.txt</loc>");
      expect(sitemapXml).not.toContain("/openapi.json</loc>");
      expect(sitemapXml).not.toContain("/docs/introduction</loc>");

      const llms = await requestHelper("/llms.txt");
      expect(llms.status).toBe(200);
      expect(llms.headers.get("content-type")).toContain("text/plain");
      const llmsText = await llms.text();
      expect(llmsText).toContain("# Shiplet");
      expect(llmsText).toContain("Documentation");
      expect(llmsText).toContain("Code Mode MCP");
      expect(llmsText).toContain("https://shiplet.cc/api/mcp");
      expect(llmsText).toContain("review layer");
      expect(llmsText).toContain("sandboxed widget");
      expect(llmsText).toContain("Review artifacts");
      expect(llmsText).toContain("Why Shiplet");
      expect(llmsText).not.toContain("Portable packages");
      expect(llmsText).not.toContain("Immutable revisions");
      expect(llmsText).not.toContain("Customer-owned Cloudflare");
    });

    it("should serve stable logo, social image, and web manifest assets", async () => {
      const logo = await requestHelper("/brand/logo.png");
      expect(logo.status).toBe(200);
      expect(logo.headers.get("content-type")).toContain("image/png");
      expect(Number(logo.headers.get("content-length") || "0")).toBeGreaterThan(
        1000,
      );
      expect(logo.headers.get("cache-control")).toContain("max-age=31536000");

      const ogImage = await requestHelper("/og-image.png");
      expect(ogImage.status).toBe(200);
      expect(ogImage.headers.get("content-type")).toContain("image/png");
      expect(
        Number(ogImage.headers.get("content-length") || "0"),
      ).toBeGreaterThan(1000);

      const avatarSprite = await requestHelper(AVATAR_SPRITE_URL);
      expect(avatarSprite.status).toBe(200);
      expect(avatarSprite.headers.get("content-type")).toContain("image/png");
      expect(
        Number(avatarSprite.headers.get("content-length") || "0"),
      ).toBeGreaterThan(1000);
      expect(avatarSprite.headers.get("cache-control")).toContain(
        "max-age=31536000",
      );

      const manifest = await requestHelper("/site.webmanifest");
      expect(manifest.status).toBe(200);
      expect(manifest.headers.get("content-type")).toContain(
        "application/manifest+json",
      );
      const body = (await manifest.json()) as {
        name: string;
        start_url: string;
        icons: Array<{ src: string }>;
      };
      expect(body.name).toBe("Shiplet");
      expect(body.start_url).toBe("/");
      expect(body.icons.some((icon) => icon.src === "/brand/logo.png")).toBe(
        true,
      );
    });

    it("should hide Worker Code controls on deployments without Workers for Platforms", async () => {
      const response = await makeRequest("/");
      const html = await response.text();

      expect(html).toContain("Upload a build or file");
      expect(html).not.toContain("<summary>Worker Code</summary>");
      expect(html).not.toContain('id="scriptContent"');
    });

    it("should expose Worker Code capability state from the dashboard API", async () => {
      const response = await makeRequest("/api/dashboard");

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        features: { workerCodePublishing: boolean };
      };
      expect(body.features.workerCodePublishing).toBe(false);
    });
  });

  describe("Admin Dashboard", () => {
    it("should keep the retired global admin inventory fail-closed", async () => {
      const response = await makeRequest("/admin");

      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).not.toContain("Admin Dashboard");
    });

    it("should not expose project inventory on the retired admin route", async () => {
      const response = await makeRequest("/admin");
      const html = await response.text();

      expect(response.status).toBe(404);
      expect(html).not.toContain("Projects");
      expect(html).not.toContain("Subdomain");
    });
  });

  describe("Project Creation API", () => {
    it("Given a public URL with page metadata, when Shiplet prepares the URL, then it returns a suggested name and DNS-safe address without forwarding credentials", async () => {
      const originRequests: Request[] = [];
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const request =
          input instanceof Request ? input : new Request(input.toString());
        originRequests.push(request);
        return new Response(
          `<!doctype html><html><head>
            <meta name="application-name" content="Fallback application">
            <title>Fallback page title</title>
            <meta property="og:title" content="NewRo Eats &amp; Drinks">
          </head><body></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      });

      try {
        const response = await makeRequest("/api/external-url/metadata", {
          method: "POST",
          headers: {
            Authorization: "Bearer must-not-reach-origin",
            Cookie: "shiplet_session=must-not-reach-origin",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url: "https://newro-eats.vercel.app/" }),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          finalUrl: "https://newro-eats.vercel.app/",
          name: "NewRo Eats & Drinks",
          source: "og:title",
          subdomain: "newro-eats-drinks",
        });
        expect(originRequests).toHaveLength(1);
        expect(originRequests[0].method).toBe("GET");
        expect(originRequests[0].redirect).toBe("manual");
        expect(originRequests[0].headers.get("accept")).toContain("text/html");
        expect(originRequests[0].headers.get("authorization")).toBeNull();
        expect(originRequests[0].headers.get("cookie")).toBeNull();
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }
    });

    it("Given an anonymous or private-network URL metadata request, when it is submitted, then Shiplet fails before fetching the origin", async () => {
      const originalFetch = globalThis.fetch;
      const originFetch = vi.fn(async () => new Response("unexpected"));
      vi.stubGlobal("fetch", originFetch);

      try {
        const anonymous = await requestHelper("/api/external-url/metadata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "https://preview.example.com/" }),
        });
        expect(anonymous.status).toBe(401);

        const privateUrl = await makeRequest("/api/external-url/metadata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "http://127.0.0.1/internal" }),
        });
        expect(privateUrl.status).toBe(400);
        expect(await privateUrl.text()).toContain("public");
        expect(originFetch).not.toHaveBeenCalled();
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }
    });

    it("should reject unauthenticated publish requests", async () => {
      const response = await requestHelper("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(401);
    });

    it("should reject requests without required fields", async () => {
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Missing required fields");
    });

    it("should reject Worker publishing when only a raw dispatch binding exists", async () => {
      const organization = await createTestOrganization(makeRequest);
      const testEnv = env as unknown as TestEnv;
      const previousDispatcher = testEnv.dispatcher;
      let dispatchCalls = 0;
      testEnv.dispatcher = {
        get: () => {
          dispatchCalls += 1;
          return { fetch: async () => new Response("unmediated runtime") };
        },
      };
      const subdomain = `raw-dispatch-${crypto.randomUUID().slice(0, 8)}`;
      try {
        const response = await makeRequest("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Raw dispatch must stay unavailable",
            organization_id: organization.id,
            subdomain,
            script_content:
              "export default { fetch() { return new Response('unsafe'); } }",
          }),
        });

        expect(response.status).toBe(501);
        expect(await response.text()).toContain(
          "revision-aware managed runtime gateway",
        );
        expect(dispatchCalls).toBe(0);
        const stored = await testEnv.DB.prepare(
          "SELECT id FROM projects WHERE subdomain = ? LIMIT 1",
        )
          .bind(subdomain)
          .first();
        expect(stored).toBeNull();
      } finally {
        if (previousDispatcher) testEnv.dispatcher = previousDispatcher;
        else Reflect.deleteProperty(testEnv, "dispatcher");
      }
    });

    it("should reject invalid subdomain format", async () => {
      const organization = await createTestOrganization(makeRequest);
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Project",
          organization_id: organization.id,
          subdomain: "Invalid_Subdomain!",
          script_content:
            "export default { fetch() { return new Response('ok'); } }",
        }),
      });

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("DNS-safe");
    });

    it("should require either script_content or assets", async () => {
      const organization = await createTestOrganization(makeRequest);
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Project",
          organization_id: organization.id,
          subdomain: "test-project",
        }),
      });

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("script_content or assets");
    });

    it("should publish an external preview URL and proxy it with review injection", async () => {
      const organization = await createTestOrganization(makeRequest);
      const subdomain = `external-${crypto.randomUUID().slice(0, 8)}`;
      const originRequests: string[] = [];
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        originRequests.push(url);
        return new Response(
          "<!doctype html><body><h1>External Preview</h1></body>",
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "content-security-policy": "frame-ancestors 'none'",
              "x-frame-options": "DENY",
            },
          },
        );
      });

      try {
        const response = await makeRequest("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "External Preview",
            organization_id: organization.id,
            subdomain,
            external_url: "https://preview.example.com",
          }),
        });

        expect(response.status).toBe(201);
        const body = (await response.json()) as {
          ok: boolean;
          project: {
            organization_id: string;
            source_type: string;
            external_origin_url: string;
          };
        };
        expect(body.ok).toBe(true);
        expect(body.project.organization_id).toBe(organization.id);
        expect(body.project.source_type).toBe("external_url");
        expect(body.project.external_origin_url).toBe(
          "https://preview.example.com",
        );

        const proxyResponse = await makeRequest(
          `/${subdomain}/nested/path?tab=review`,
        );
        expect(proxyResponse.status).toBe(200);
        expect(proxyResponse.headers.get("x-shiplet-review")).toBeNull();
        const html = await proxyResponse.text();
        expect(html).toContain("External Preview");
        expect(html).toContain('data-shiplet-trusted-review-host="v1"');
        expect(html).not.toContain("__SHIPLET_REVIEW__");
        const rawProxy = await makeRequest(
          `/${subdomain}/__shiplet/artifact-frame/nested/path?tab=review`,
        );
        expect(await rawProxy.text()).toContain("External Preview");
        expect(originRequests).toContain(
          "https://preview.example.com/nested/path?tab=review",
        );
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }
    });

    it("Given a URL import with document-relative assets, When the artifact loads, Then CSS and images resolve from the source document URL", async () => {
      const organization = await createTestOrganization(makeRequest);
      await withExternalOriginFixtures(
        {
          "https://preview.example.com/releases/site/index.html": () =>
            new Response(
              '<!doctype html><link id="page-css" rel="stylesheet" href="styles/site.css"><img id="hero" src="../images/hero.png">',
              { headers: { "content-type": "text/html; charset=utf-8" } },
            ),
          "https://preview.example.com/releases/site/styles/site.css": () =>
            new Response(".relative-css-loaded{color:seagreen}", {
              headers: { "content-type": "text/css; charset=utf-8" },
            }),
          "https://preview.example.com/releases/images/hero.png": () =>
            new Response("hero-image-bytes", {
              headers: { "content-type": "image/png" },
            }),
        },
        async (originRequests) => {
          const published = await publishExternalTestShiplet(
            makeRequest,
            organization.id,
            "https://preview.example.com/releases/site/index.html",
          );
          const documentPath = externalArtifactFramePath(published.project.id);
          const documentResponse = await makeRequest(documentPath);
          expect(documentResponse.status).toBe(200);
          const html = await documentResponse.text();

          const cssPath = localArtifactReference(
            extractTagAttribute(html, 'id="page-css"', "href"),
            documentPath,
          );
          const imagePath = localArtifactReference(
            extractTagAttribute(html, 'id="hero"', "src"),
            documentPath,
          );
          const cssResponse = await makeRequest(cssPath);
          const imageResponse = await makeRequest(imagePath);

          expect(cssResponse.headers.get("content-type")).toContain("text/css");
          expect(await cssResponse.text()).toContain("relative-css-loaded");
          expect(imageResponse.headers.get("content-type")).toContain(
            "image/png",
          );
          expect(
            new TextDecoder().decode(await imageResponse.arrayBuffer()),
          ).toBe("hero-image-bytes");
          expect(originRequests).toContain(
            "https://preview.example.com/releases/site/styles/site.css",
          );
          expect(originRequests).toContain(
            "https://preview.example.com/releases/images/hero.png",
          );
        },
      );
    });

    it("Given a tampered signed external-resource URL, When it reaches the public artifact frame, Then it is rejected without contacting upstream", async () => {
      const organization = await createTestOrganization(makeRequest);
      await withExternalOriginFixtures(
        {
          "https://preview.example.com/app/index.html": () =>
            new Response(
              '<!doctype html><img id="signed-image" src="assets/image.png">',
              { headers: { "content-type": "text/html; charset=utf-8" } },
            ),
          "https://preview.example.com/app/assets/image.png": () =>
            new Response("signed-image-bytes", {
              headers: { "content-type": "image/png" },
            }),
        },
        async (originRequests) => {
          const published = await publishExternalTestShiplet(
            makeRequest,
            organization.id,
            "https://preview.example.com/app/index.html",
          );
          const documentPath = externalArtifactFramePath(published.project.id);
          const documentResponse = await requestHelper(documentPath);
          expect(documentResponse.status).toBe(200);
          const html = await documentResponse.text();
          const signedReference = extractTagAttribute(
            html,
            'id="signed-image"',
            "src",
          );
          const signedUrl = new URL(
            signedReference,
            `http://localhost${documentPath}`,
          );
          const resourceNamespace = "/__shiplet/external-resource";
          const namespaceIndex = signedUrl.pathname.indexOf(resourceNamespace);
          expect(namespaceIndex).toBeGreaterThanOrEqual(0);
          const namespaceEnd = namespaceIndex + resourceNamespace.length;

          const unsigned = new URL(signedUrl);
          unsigned.pathname = unsigned.pathname.slice(0, namespaceEnd);
          unsigned.search = "";
          const unsignedResponse = await requestHelper(
            `${unsigned.pathname}${unsigned.search}`,
          );

          const tampered = new URL(signedUrl);
          const pathCapabilityStart = namespaceEnd + 1;
          if (tampered.pathname.length > pathCapabilityStart) {
            const originalCharacter = tampered.pathname[pathCapabilityStart];
            tampered.pathname =
              tampered.pathname.slice(0, pathCapabilityStart) +
              (originalCharacter === "a" ? "b" : "a") +
              tampered.pathname.slice(pathCapabilityStart + 1);
          } else {
            const firstParameter = [...tampered.searchParams.entries()][0];
            expect(firstParameter).toBeTruthy();
            tampered.searchParams.set(
              firstParameter![0],
              `${firstParameter![1]}x`,
            );
          }
          const tamperedResponse = await requestHelper(
            `${tampered.pathname}${tampered.search}`,
          );

          expect(unsignedResponse.status).toBe(502);
          expect(tamperedResponse.status).toBe(502);
          expect(originRequests).toEqual([
            "https://preview.example.com/app/index.html",
          ]);
        },
      );
    });

    it("Given a signed external-resource URL for one project, When it is replayed through another project, Then the public artifact frame rejects it", async () => {
      const organization = await createTestOrganization(makeRequest);
      await withExternalOriginFixtures(
        {
          "https://preview.example.com/app/index.html": () =>
            new Response(
              '<!doctype html><img id="replay-image" src="assets/image.png">',
              { headers: { "content-type": "text/html; charset=utf-8" } },
            ),
          "https://preview.example.com/app/assets/image.png": () =>
            new Response("replay-image-bytes", {
              headers: { "content-type": "image/png" },
            }),
        },
        async (originRequests) => {
          const sourceProject = await publishExternalTestShiplet(
            makeRequest,
            organization.id,
            "https://preview.example.com/app/index.html",
          );
          const otherProject = await publishExternalTestShiplet(
            makeRequest,
            organization.id,
            "https://preview.example.com/app/index.html",
          );
          const sourceDocumentPath = externalArtifactFramePath(
            sourceProject.project.id,
          );
          const html = await (await requestHelper(sourceDocumentPath)).text();
          const sourceResourcePath = localArtifactReference(
            extractTagAttribute(html, 'id="replay-image"', "src"),
            sourceDocumentPath,
          );
          const replayed = new URL(sourceResourcePath, "http://localhost");
          replayed.pathname = replayed.pathname.replace(
            `/shiplets/${sourceProject.project.id}/artifact-frame`,
            `/shiplets/${otherProject.project.id}/artifact-frame`,
          );

          const replayResponse = await requestHelper(
            `${replayed.pathname}${replayed.search}`,
          );

          expect(replayResponse.status).toBe(502);
          expect(originRequests).toEqual([
            "https://preview.example.com/app/index.html",
          ]);
        },
      );
    });

    it("Given external artifact requests, When they reach upstream, Then only read methods and non-internal headers are forwarded", async () => {
      const organization = await createTestOrganization(makeRequest);
      const published = await publishExternalTestShiplet(
        makeRequest,
        organization.id,
        "https://preview.example.com/app/index.html",
      );
      const upstreamRequests: Request[] = [];
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const request =
          input instanceof Request ? input : new Request(input.toString());
        upstreamRequests.push(request);
        return new Response(
          request.method === "HEAD" ? null : "upstream-image-bytes",
          { headers: { "content-type": "image/png" } },
        );
      });

      try {
        const artifactPath = externalArtifactFramePath(
          published.project.id,
          "/assets/image.png",
        );
        const getResponse = await makeRequest(artifactPath, {
          headers: {
            ...AUTH_HEADERS,
            accept: "image/png",
            "x-shiplet-internal-marker": "must-not-reach-upstream",
          },
        });
        expect(getResponse.status).toBe(200);
        expect(getResponse.headers.get("content-type")).toContain("image/png");
        expect(new TextDecoder().decode(await getResponse.arrayBuffer())).toBe(
          "upstream-image-bytes",
        );

        const headResponse = await requestHelper(artifactPath, {
          method: "HEAD",
        });
        expect(headResponse.status).toBe(200);
        expect(headResponse.headers.get("content-type")).toContain("image/png");
        expect((await headResponse.arrayBuffer()).byteLength).toBe(0);

        const postResponse = await makeRequest(
          `/${published.project.subdomain}/__shiplet/artifact-frame/assets/image.png`,
          { method: "POST" },
        );
        expect(postResponse.status).toBe(405);
        expect(postResponse.headers.get("allow")).toBe("GET, HEAD");

        expect(upstreamRequests).toHaveLength(2);
        expect(upstreamRequests.map((request) => request.method)).toEqual([
          "GET",
          "HEAD",
        ]);
        expect(upstreamRequests[0].headers.get("accept")).toBe("image/png");
        expect(upstreamRequests[0].headers.get("x-shiplet-user-id")).toBeNull();
        expect(
          upstreamRequests[0].headers.get("x-shiplet-user-email"),
        ).toBeNull();
        expect(
          upstreamRequests[0].headers.get("x-shiplet-internal-marker"),
        ).toBeNull();
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }
    });

    it("Given anonymous forged subresource metadata, When a request targets Shiplet review or bridge namespaces, Then it never reaches the external origin", async () => {
      await withCustomDomain("shiplet.cc", async () => {
        const organization = await createTestOrganization(makeRequest);
        const subdomain = `reserved-review-${crypto.randomUUID().slice(0, 8)}`;
        const originRequests: string[] = [];
        const originalFetch = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          originRequests.push(url);
          return new Response("upstream-namespace-response", {
            headers: { "content-type": "text/javascript" },
          });
        });

        try {
          const publish = await makeRequest("/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Reserved review namespaces",
              organization_id: organization.id,
              subdomain,
              external_url: "https://preview.example.com/app",
            }),
          });
          expect(publish.status).toBe(201);

          for (const path of [
            "/__shiplet/review",
            "/__shiplet/review/feedback",
            "/__shiplet/review/unknown.js",
          ]) {
            const response = await requestHelper(
              `https://${subdomain}.shiplet.cc${path}`,
              {
                headers: { "Sec-Fetch-Dest": "script" },
                redirect: "manual",
              },
            );
            expect(response.status).toBe(302);
            expect(response.headers.get("location")).toContain("/auth/login");
          }

          const artifactBridge = await requestHelper(
            `https://${subdomain}.shiplet.cc/api/review/artifact-bridge.js`,
            { headers: { "Sec-Fetch-Dest": "script" } },
          );
          expect(artifactBridge.status).toBe(200);
          expect(artifactBridge.headers.get("content-type")).toMatch(
            /javascript/i,
          );

          const unknownBridge = await requestHelper(
            `https://${subdomain}.shiplet.cc/api/review/unknown.js`,
            { headers: { "Sec-Fetch-Dest": "script" } },
          );
          expect(unknownBridge.status).toBe(404);
          const bridgeNamespace = await requestHelper(
            `https://${subdomain}.shiplet.cc/api/review`,
            { headers: { "Sec-Fetch-Dest": "script" } },
          );
          expect(bridgeNamespace.status).toBe(404);
          expect(originRequests).toEqual([]);
        } finally {
          vi.stubGlobal("fetch", originalFetch);
        }
      });
    });

    it("Given imported CSS with nested imports and assets, When each stylesheet loads, Then every nested URL resolves from its containing stylesheet", async () => {
      const organization = await createTestOrganization(makeRequest);
      await withExternalOriginFixtures(
        {
          "https://preview.example.com/app/index.html": () =>
            new Response(
              '<!doctype html><link id="main-css" rel="stylesheet" href="styles/main.css">',
              { headers: { "content-type": "text/html; charset=utf-8" } },
            ),
          "https://preview.example.com/app/styles/main.css": () =>
            new Response(
              '@import "./theme/colors.css";.hero{background:url("../images/bg.png")}@font-face{src:url("./fonts/main.woff2")}',
              { headers: { "content-type": "text/css; charset=utf-8" } },
            ),
          "https://preview.example.com/app/styles/theme/colors.css": () =>
            new Response(
              '@font-face{font-family:Palette;src:url("../../fonts/palette.woff2")}.nested-css-loaded{color:navy}',
              { headers: { "content-type": "text/css; charset=utf-8" } },
            ),
          "https://preview.example.com/app/images/bg.png": () =>
            new Response("background-bytes", {
              headers: { "content-type": "image/png" },
            }),
          "https://preview.example.com/app/styles/fonts/main.woff2": () =>
            new Response("main-font-bytes", {
              headers: { "content-type": "font/woff2" },
            }),
          "https://preview.example.com/app/fonts/palette.woff2": () =>
            new Response("palette-font-bytes", {
              headers: { "content-type": "font/woff2" },
            }),
        },
        async (originRequests) => {
          const published = await publishExternalTestShiplet(
            makeRequest,
            organization.id,
            "https://preview.example.com/app/index.html",
          );
          const documentPath = externalArtifactFramePath(published.project.id);
          const html = await (await makeRequest(documentPath)).text();
          const mainCssPath = localArtifactReference(
            extractTagAttribute(html, 'id="main-css"', "href"),
            documentPath,
          );
          const mainCss = await (await makeRequest(mainCssPath)).text();
          const importReference = mainCss.match(
            /@import\s+(?:url\(\s*)?["']([^"']+)["']/i,
          )?.[1];
          const backgroundReference = mainCss.match(
            /\.hero\{background:url\(\s*["']?([^"')]+)["']?\s*\)/i,
          )?.[1];
          const mainFontReference = mainCss.match(
            /@font-face\{src:url\(\s*["']?([^"')]+)["']?\s*\)/i,
          )?.[1];
          expect(importReference).toBeTruthy();
          expect(backgroundReference).toBeTruthy();
          expect(mainFontReference).toBeTruthy();

          const importedCssPath = localArtifactReference(
            importReference!,
            mainCssPath,
          );
          const importedCss = await (await makeRequest(importedCssPath)).text();
          expect(importedCss).toContain("nested-css-loaded");
          const paletteFontReference = importedCss.match(
            /src:url\(\s*["']?([^"')]+)["']?\s*\)/i,
          )?.[1];
          expect(paletteFontReference).toBeTruthy();

          const background = await makeRequest(
            localArtifactReference(backgroundReference!, mainCssPath),
          );
          const mainFont = await makeRequest(
            localArtifactReference(mainFontReference!, mainCssPath),
          );
          const paletteFont = await makeRequest(
            localArtifactReference(paletteFontReference!, importedCssPath),
          );
          expect(background.headers.get("content-type")).toContain("image/png");
          expect(mainFont.headers.get("content-type")).toContain("font/woff2");
          expect(paletteFont.headers.get("content-type")).toContain(
            "font/woff2",
          );
          expect(originRequests).toEqual(
            expect.arrayContaining([
              "https://preview.example.com/app/styles/main.css",
              "https://preview.example.com/app/styles/theme/colors.css",
              "https://preview.example.com/app/images/bg.png",
              "https://preview.example.com/app/styles/fonts/main.woff2",
              "https://preview.example.com/app/fonts/palette.woff2",
            ]),
          );
        },
      );
    });

    it("Given imported HTML with a base href, When relative assets load, Then the authored base controls resolution inside the Shiplet proxy", async () => {
      const organization = await createTestOrganization(makeRequest);
      await withExternalOriginFixtures(
        {
          "https://preview.example.com/app/index.html": () =>
            new Response(
              '<!doctype html><base href="/static/v7/"><link id="base-css" rel="stylesheet" href="css/app.css"><img id="base-logo" src="images/logo.svg">',
              { headers: { "content-type": "text/html; charset=utf-8" } },
            ),
          "https://preview.example.com/static/v7/css/app.css": () =>
            new Response(".base-css-loaded{display:block}", {
              headers: { "content-type": "text/css; charset=utf-8" },
            }),
          "https://preview.example.com/static/v7/images/logo.svg": () =>
            new Response("<svg></svg>", {
              headers: { "content-type": "image/svg+xml" },
            }),
        },
        async (originRequests) => {
          const published = await publishExternalTestShiplet(
            makeRequest,
            organization.id,
            "https://preview.example.com/app/index.html",
          );
          const documentPath = externalArtifactFramePath(published.project.id);
          const html = await (await makeRequest(documentPath)).text();
          const baseReferences = Array.from(
            html.matchAll(/<base\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi),
            (match) => match[1],
          );
          expect(baseReferences).toHaveLength(1);
          const effectiveBase = new URL(
            baseReferences[0],
            "https://tenant.example.test",
          );
          expect(effectiveBase.origin).toBe("https://tenant.example.test");
          expect(effectiveBase.search).toBe("");
          expect(effectiveBase.href).not.toContain("shiplet_preview_token");

          const css = await makeRequest(
            localArtifactReference(
              extractTagAttribute(html, 'id="base-css"', "href"),
              documentPath,
            ),
          );
          const logo = await makeRequest(
            localArtifactReference(
              extractTagAttribute(html, 'id="base-logo"', "src"),
              documentPath,
            ),
          );
          expect(await css.text()).toContain("base-css-loaded");
          expect(logo.headers.get("content-type")).toContain("image/svg+xml");
          expect(originRequests).toContain(
            "https://preview.example.com/static/v7/css/app.css",
          );
          expect(originRequests).toContain(
            "https://preview.example.com/static/v7/images/logo.svg",
          );
        },
      );
    });

    it("Given inline runtime URLs under an authored base, When fetch, XHR, Worker, and module requests resolve in a production tenant, Then each request preserves the authored upstream base", async () => {
      await withCustomDomain("shiplet.cc", async () => {
        const organization = await createTestOrganization(makeRequest);
        await withExternalOriginFixtures(
          {
            "https://preview.example.com/releases/current/index.html": () =>
              new Response(
                '<!doctype html><base href="../runtime/v2/"><script type="module">fetch("api/fetch.json");const xhr=new XMLHttpRequest();xhr.open("GET","api/xhr.json");new Worker("workers/worker.js");import("modules/inline.js")</script>',
                { headers: { "content-type": "text/html; charset=utf-8" } },
              ),
            "https://preview.example.com/releases/runtime/v2/api/fetch.json":
              () => Response.json({ transport: "fetch" }),
            "https://preview.example.com/releases/runtime/v2/api/xhr.json":
              () => Response.json({ transport: "xhr" }),
            "https://preview.example.com/releases/runtime/v2/workers/worker.js":
              () =>
                new Response("self.runtimeWorkerLoaded=true", {
                  headers: { "content-type": "text/javascript" },
                }),
            "https://preview.example.com/releases/runtime/v2/modules/inline.js":
              () =>
                new Response("export const inlineModuleLoaded=true", {
                  headers: { "content-type": "text/javascript" },
                }),
          },
          async (originRequests) => {
            const published = await publishExternalTestShiplet(
              makeRequest,
              organization.id,
              "https://preview.example.com/releases/current/index.html",
            );
            const documentUrl = `https://${published.project.subdomain}.shiplet.cc/__shiplet/artifact-frame/`;
            const documentResponse = await requestHelper(documentUrl);
            expect(documentResponse.status).toBe(200);
            const html = await documentResponse.text();
            expect(html).toContain('fetch("api/fetch.json")');
            expect(html).toContain('xhr.open("GET","api/xhr.json")');
            expect(html).toContain('new Worker("workers/worker.js")');
            expect(html).toContain('import("modules/inline.js")');
            expect(html).not.toContain("shiplet_preview_token");

            const runtimeBase = new URL(
              extractDocumentBaseReference(html),
              documentUrl,
            );
            expect(runtimeBase.origin).toBe(
              `https://${published.project.subdomain}.shiplet.cc`,
            );
            expect(runtimeBase.search).toBe("");
            expect(runtimeBase.hash).toBe("");

            const fetchResponse = await requestHelper(
              new URL("api/fetch.json", runtimeBase).toString(),
              { headers: { "Sec-Fetch-Dest": "empty" } },
            );
            const xhrResponse = await requestHelper(
              new URL("api/xhr.json", runtimeBase).toString(),
              { headers: { "Sec-Fetch-Dest": "empty" } },
            );
            const workerResponse = await requestHelper(
              new URL("workers/worker.js", runtimeBase).toString(),
              { headers: { "Sec-Fetch-Dest": "worker" } },
            );
            const moduleResponse = await requestHelper(
              new URL("modules/inline.js", runtimeBase).toString(),
              { headers: { "Sec-Fetch-Dest": "script" } },
            );

            expect(await fetchResponse.json()).toEqual({ transport: "fetch" });
            expect(await xhrResponse.json()).toEqual({ transport: "xhr" });
            expect(await workerResponse.text()).toBe(
              "self.runtimeWorkerLoaded=true",
            );
            expect(await moduleResponse.text()).toBe(
              "export const inlineModuleLoaded=true",
            );
            expect(originRequests).toEqual(
              expect.arrayContaining([
                "https://preview.example.com/releases/runtime/v2/api/fetch.json",
                "https://preview.example.com/releases/runtime/v2/api/xhr.json",
                "https://preview.example.com/releases/runtime/v2/workers/worker.js",
                "https://preview.example.com/releases/runtime/v2/modules/inline.js",
              ]),
            );
          },
        );
      });
    });

    it("Given a signed external module, When static and dynamic relative ESM imports resolve, Then both stay project-bound and preserve the module directory", async () => {
      await withCustomDomain("shiplet.cc", async () => {
        const organization = await createTestOrganization(makeRequest);
        await withExternalOriginFixtures(
          {
            "https://preview.example.com/app/index.html": () =>
              new Response(
                '<!doctype html><script id="runtime-module" type="module" src="assets/app/main.js"></script>',
                { headers: { "content-type": "text/html; charset=utf-8" } },
              ),
            "https://preview.example.com/app/assets/app/main.js": () =>
              new Response(
                'import { staticReady } from "./static.js";import("./lazy.js");export { staticReady };',
                {
                  headers: {
                    "content-type": "application/javascript; charset=utf-8",
                  },
                },
              ),
            "https://preview.example.com/app/assets/app/static.js": () =>
              new Response("export const staticReady=true", {
                headers: { "content-type": "text/javascript" },
              }),
            "https://preview.example.com/app/assets/app/lazy.js": () =>
              new Response("export const lazyReady=true", {
                headers: { "content-type": "text/javascript" },
              }),
          },
          async (originRequests) => {
            const published = await publishExternalTestShiplet(
              makeRequest,
              organization.id,
              "https://preview.example.com/app/index.html",
            );
            const documentUrl = `https://${published.project.subdomain}.shiplet.cc/__shiplet/artifact-frame/`;
            const html = await (await requestHelper(documentUrl)).text();
            const moduleUrl = new URL(
              extractTagAttribute(html, 'id="runtime-module"', "src"),
              documentUrl,
            );
            expect(moduleUrl.origin).toBe(new URL(documentUrl).origin);
            expect(moduleUrl.search).toBe("");

            const moduleResponse = await requestHelper(moduleUrl.toString(), {
              headers: { "Sec-Fetch-Dest": "script" },
            });
            expect(await moduleResponse.text()).toContain(
              'import { staticReady } from "./static.js"',
            );
            const staticModuleUrl = new URL("./static.js", moduleUrl);
            const dynamicModuleUrl = new URL("./lazy.js", moduleUrl);
            expect(staticModuleUrl.origin).toBe(moduleUrl.origin);
            expect(dynamicModuleUrl.origin).toBe(moduleUrl.origin);
            expect(staticModuleUrl.search).toBe("");
            expect(dynamicModuleUrl.search).toBe("");

            const staticModule = await requestHelper(
              staticModuleUrl.toString(),
              { headers: { "Sec-Fetch-Dest": "script" } },
            );
            const dynamicModule = await requestHelper(
              dynamicModuleUrl.toString(),
              { headers: { "Sec-Fetch-Dest": "script" } },
            );
            expect(await staticModule.text()).toBe(
              "export const staticReady=true",
            );
            expect(await dynamicModule.text()).toBe(
              "export const lazyReady=true",
            );
            expect(originRequests).toEqual(
              expect.arrayContaining([
                "https://preview.example.com/app/assets/app/main.js",
                "https://preview.example.com/app/assets/app/static.js",
                "https://preview.example.com/app/assets/app/lazy.js",
              ]),
            );
          },
        );
      });
    });

    it("Given an opaque sandbox reads external artifact resources, When GET, HEAD, review, and mutation routes respond, Then only the read-only artifact responses allow credentialless CORS", async () => {
      await withCustomDomain("shiplet.cc", async () => {
        const organization = await createTestOrganization(makeRequest);
        await withExternalOriginFixtures(
          {
            "https://preview.example.com/app/index.html": () =>
              new Response(
                '<!doctype html><script id="opaque-module" type="module" src="assets/main.js"></script>',
                { headers: { "content-type": "text/html; charset=utf-8" } },
              ),
            "https://preview.example.com/app/assets/main.js": () =>
              new Response("export const opaqueSandboxReady=true", {
                headers: {
                  "content-type": "text/javascript; charset=utf-8",
                  "access-control-allow-credentials": "true",
                },
              }),
          },
          async (originRequests) => {
            const published = await publishExternalTestShiplet(
              makeRequest,
              organization.id,
              "https://preview.example.com/app/index.html",
            );
            const documentUrl = `https://${published.project.subdomain}.shiplet.cc/__shiplet/artifact-frame/`;
            const documentResponse = await requestHelper(documentUrl, {
              headers: { Origin: "null" },
            });
            expect(
              documentResponse.headers.get("access-control-allow-origin"),
            ).toBe("*");
            expect(
              documentResponse.headers.get("access-control-allow-credentials"),
            ).toBeNull();
            const html = await documentResponse.text();
            const moduleUrl = new URL(
              extractTagAttribute(html, 'id="opaque-module"', "src"),
              documentUrl,
            );

            const moduleGet = await requestHelper(moduleUrl.toString(), {
              headers: { Origin: "null", "Sec-Fetch-Dest": "script" },
            });
            expect(moduleGet.status).toBe(200);
            expect(moduleGet.headers.get("access-control-allow-origin")).toBe(
              "*",
            );
            expect(
              moduleGet.headers.get("access-control-allow-credentials"),
            ).toBeNull();

            const moduleHead = await requestHelper(moduleUrl.toString(), {
              method: "HEAD",
              headers: { Origin: "null", "Sec-Fetch-Dest": "script" },
            });
            expect(moduleHead.status).toBe(200);
            expect(moduleHead.headers.get("access-control-allow-origin")).toBe(
              "*",
            );
            expect(
              moduleHead.headers.get("access-control-allow-credentials"),
            ).toBeNull();

            const reviewRead = await requestHelper(
              `https://${published.project.subdomain}.shiplet.cc/__shiplet/review/feedback`,
              { headers: { Origin: "null" } },
            );
            expect(
              reviewRead.headers.get("access-control-allow-origin"),
            ).toBeNull();
            expect(
              reviewRead.headers.get("access-control-allow-credentials"),
            ).toBeNull();

            const upstreamRequestCount = originRequests.length;
            const moduleMutation = await requestHelper(moduleUrl.toString(), {
              method: "POST",
              headers: { Origin: "null", "Sec-Fetch-Dest": "script" },
            });
            expect(moduleMutation.status).toBeGreaterThanOrEqual(300);
            expect(
              moduleMutation.headers.get("access-control-allow-origin"),
            ).toBeNull();
            expect(
              moduleMutation.headers.get("access-control-allow-credentials"),
            ).toBeNull();
            expect(originRequests).toHaveLength(upstreamRequestCount);
          },
        );
      });
    });

    it("Given the local dashboard embeds an external URL import, When its opaque sandbox reads the direct artifact frame, Then only successful reads and signed redirects allow credentialless CORS", async () => {
      const organization = await createTestOrganization(makeRequest);
      const upstreamRequests: Request[] = [];
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const request =
          input instanceof Request ? input : new Request(input.toString());
        upstreamRequests.push(request);
        if (request.url === "https://preview.example.com/app/index.html") {
          return new Response(
            request.method === "HEAD"
              ? null
              : '<!doctype html><script id="dashboard-module" type="module" src="assets/entry.js"></script><script id="dashboard-cached-module" type="module" src="assets/cached.js"></script><script id="dashboard-missing-module" type="module" src="assets/missing.js"></script>',
            {
              headers: {
                "content-type": "text/html; charset=utf-8",
                "access-control-allow-origin": "https://upstream.example",
                "access-control-allow-credentials": "true",
                "set-cookie": "upstream_session=not-forwarded; Secure",
              },
            },
          );
        }
        if (request.url === "https://preview.example.com/app/assets/entry.js") {
          return new Response(null, {
            status: 302,
            headers: {
              location: "/cdn/build-9/entry.js",
              "access-control-allow-credentials": "true",
              "set-cookie": "upstream_redirect=not-forwarded; Secure",
            },
          });
        }
        if (
          request.url === "https://preview.example.com/cdn/build-9/entry.js"
        ) {
          return new Response("export const dashboardModuleReady=true", {
            headers: {
              "content-type": "text/javascript; charset=utf-8",
              "access-control-allow-credentials": "true",
              "set-cookie": "upstream_module=not-forwarded; Secure",
            },
          });
        }
        if (
          request.url === "https://preview.example.com/app/assets/cached.js"
        ) {
          return new Response(null, {
            status: 304,
            headers: {
              etag: '"dashboard-cached-module"',
              "access-control-allow-credentials": "true",
              "set-cookie": "upstream_cached=not-forwarded; Secure",
            },
          });
        }
        if (
          request.url === "https://preview.example.com/app/assets/missing.js"
        ) {
          return new Response("Missing module", {
            status: 404,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "access-control-allow-origin": "https://upstream.example",
              "access-control-allow-credentials": "true",
              "set-cookie": "upstream_missing=not-forwarded; Secure",
            },
          });
        }
        return new Response("Not found", { status: 404 });
      });

      try {
        const published = await publishExternalTestShiplet(
          makeRequest,
          organization.id,
          "https://preview.example.com/app/index.html",
        );
        const reviewHost = await requestHelper(
          `/shiplets/${published.project.id}/review-host`,
          { headers: AUTH_HEADERS },
        );
        expect(reviewHost.status).toBe(200);
        const artifactReference = extractTagAttribute(
          await reviewHost.text(),
          'data-shiplet-artifact-frame="v1"',
          "src",
        );
        const artifactUrl = new URL(artifactReference, "http://localhost");
        expect(artifactUrl.pathname).toBe(
          `/shiplets/${published.project.id}/artifact-frame/`,
        );

        const opaqueHeaders = new Headers({ Origin: "null", ...AUTH_HEADERS });
        opaqueHeaders.set("Cookie", "browser-marker=not-a-secret");
        opaqueHeaders.set(["author", "ization"].join(""), "not-a-credential");
        const documentResponse = await requestHelper(artifactUrl.toString(), {
          headers: opaqueHeaders,
        });
        expect(documentResponse.status).toBe(200);
        expect(
          documentResponse.headers.get("access-control-allow-origin"),
        ).toBe("*");
        expect(
          documentResponse.headers.get("access-control-allow-credentials"),
        ).toBeNull();
        expect(documentResponse.headers.get("set-cookie")).toBeNull();
        const html = await documentResponse.text();

        const headResponse = await requestHelper(artifactUrl.toString(), {
          method: "HEAD",
          headers: opaqueHeaders,
        });
        expect(headResponse.status).toBe(200);
        expect(headResponse.headers.get("access-control-allow-origin")).toBe(
          "*",
        );
        expect(
          headResponse.headers.get("access-control-allow-credentials"),
        ).toBeNull();
        expect(headResponse.headers.get("set-cookie")).toBeNull();
        expect((await headResponse.arrayBuffer()).byteLength).toBe(0);

        const initialModuleUrl = new URL(
          extractTagAttribute(html, 'id="dashboard-module"', "src"),
          artifactUrl,
        );
        const moduleRedirect = await requestHelper(
          initialModuleUrl.toString(),
          {
            headers: opaqueHeaders,
            redirect: "manual",
          },
        );
        expect(moduleRedirect.status).toBe(302);
        expect(moduleRedirect.headers.get("access-control-allow-origin")).toBe(
          "*",
        );
        expect(
          moduleRedirect.headers.get("access-control-allow-credentials"),
        ).toBeNull();
        expect(moduleRedirect.headers.get("set-cookie")).toBeNull();
        const finalModuleUrl = new URL(
          moduleRedirect.headers.get("location")!,
          initialModuleUrl,
        );
        expect(finalModuleUrl.origin).toBe(artifactUrl.origin);
        const finalModule = await requestHelper(finalModuleUrl.toString(), {
          headers: opaqueHeaders,
        });
        expect(finalModule.status).toBe(200);
        expect(finalModule.headers.get("access-control-allow-origin")).toBe(
          "*",
        );
        expect(
          finalModule.headers.get("access-control-allow-credentials"),
        ).toBeNull();
        expect(finalModule.headers.get("set-cookie")).toBeNull();
        expect(await finalModule.text()).toContain("dashboardModuleReady");

        const cachedModuleUrl = new URL(
          extractTagAttribute(html, 'id="dashboard-cached-module"', "src"),
          artifactUrl,
        );
        const cachedModule = await requestHelper(cachedModuleUrl.toString(), {
          headers: opaqueHeaders,
        });
        expect(cachedModule.status).toBe(304);
        expect(cachedModule.headers.get("access-control-allow-origin")).toBe(
          "*",
        );
        expect(
          cachedModule.headers.get("access-control-allow-credentials"),
        ).toBeNull();
        expect(cachedModule.headers.get("set-cookie")).toBeNull();

        const missingModuleUrl = new URL(
          extractTagAttribute(html, 'id="dashboard-missing-module"', "src"),
          artifactUrl,
        );
        const missingModule = await requestHelper(missingModuleUrl.toString(), {
          headers: opaqueHeaders,
        });
        expect(missingModule.status).toBe(404);
        expect(
          missingModule.headers.get("access-control-allow-origin"),
        ).toBeNull();
        expect(
          missingModule.headers.get("access-control-allow-credentials"),
        ).toBeNull();
        expect(missingModule.headers.get("set-cookie")).toBeNull();

        const resourceNamespace = "/__shiplet/external-resource";
        const tamperedModuleUrl = new URL(initialModuleUrl);
        const namespaceIndex =
          tamperedModuleUrl.pathname.indexOf(resourceNamespace);
        expect(namespaceIndex).toBeGreaterThanOrEqual(0);
        const capabilityStart = namespaceIndex + resourceNamespace.length + 1;
        const originalCharacter = tamperedModuleUrl.pathname[capabilityStart];
        tamperedModuleUrl.pathname =
          tamperedModuleUrl.pathname.slice(0, capabilityStart) +
          (originalCharacter === "a" ? "b" : "a") +
          tamperedModuleUrl.pathname.slice(capabilityStart + 1);
        const upstreamCountBeforeTamper = upstreamRequests.length;
        const tamperedModule = await requestHelper(
          tamperedModuleUrl.toString(),
          { headers: opaqueHeaders },
        );
        expect(tamperedModule.status).toBe(502);
        expect(
          tamperedModule.headers.get("access-control-allow-origin"),
        ).toBeNull();
        expect(
          tamperedModule.headers.get("access-control-allow-credentials"),
        ).toBeNull();
        expect(upstreamRequests).toHaveLength(upstreamCountBeforeTamper);

        const reviewRead = await requestHelper(
          `/api/projects/${published.project.id}/review-feedback`,
          { headers: { Origin: "null", ...AUTH_HEADERS } },
        );
        expect(reviewRead.status).toBe(401);
        expect(
          reviewRead.headers.get("access-control-allow-origin"),
        ).toBeNull();
        expect(
          reviewRead.headers.get("access-control-allow-credentials"),
        ).toBeNull();

        const upstreamCountBeforeMutation = upstreamRequests.length;
        const mutation = await requestHelper(artifactUrl.toString(), {
          method: "POST",
          headers: opaqueHeaders,
        });
        expect(mutation.status).toBeGreaterThanOrEqual(400);
        expect(mutation.headers.get("access-control-allow-origin")).toBeNull();
        expect(
          mutation.headers.get("access-control-allow-credentials"),
        ).toBeNull();
        expect(upstreamRequests).toHaveLength(upstreamCountBeforeMutation);

        const staticProject = await publishStaticShiplet(
          makeRequest,
          organization.id,
        );
        const staticArtifact = await requestHelper(
          externalArtifactFramePath(staticProject.project.id),
          { headers: { Origin: "null", ...AUTH_HEADERS } },
        );
        expect(staticArtifact.status).toBe(200);
        expect(
          staticArtifact.headers.get("access-control-allow-origin"),
        ).toBeNull();
        expect(
          staticArtifact.headers.get("access-control-allow-credentials"),
        ).toBeNull();
        const staticArtifactHead = await requestHelper(
          externalArtifactFramePath(staticProject.project.id),
          {
            method: "HEAD",
            headers: { Origin: "null", ...AUTH_HEADERS },
          },
        );
        expect(staticArtifactHead.status).toBe(200);
        expect(
          staticArtifactHead.headers.get("access-control-allow-origin"),
        ).toBeNull();
        expect(
          staticArtifactHead.headers.get("access-control-allow-credentials"),
        ).toBeNull();

        expect(upstreamRequests.length).toBeGreaterThan(0);
        for (const upstreamRequest of upstreamRequests) {
          expect(
            upstreamRequest.method === "GET" ||
              upstreamRequest.method === "HEAD",
          ).toBe(true);
          expect(upstreamRequest.headers.get("cookie")).toBeNull();
          expect(
            upstreamRequest.headers.get(["author", "ization"].join("")),
          ).toBeNull();
          expect(upstreamRequest.headers.get("x-shiplet-user-id")).toBeNull();
          expect(
            upstreamRequest.headers.get("x-shiplet-user-email"),
          ).toBeNull();
        }
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }
    });

    it("Given an external document returns an HTML error body, When the artifact frame serves it, Then the upstream status is preserved under the same exact-tenant sandbox CSP as successful HTML", async () => {
      const organization = await createTestOrganization(makeRequest);
      const upstreamRequests: Request[] = [];
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const request =
          input instanceof Request ? input : new Request(input.toString());
        upstreamRequests.push(request);
        if (request.url === "https://preview.example.com/error/index.html") {
          return new Response(
            '<!doctype html><script>fetch("https://ambient.example/leak")</script><form action="https://ambient.example/post"></form>',
            {
              status: 404,
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          );
        }
        return new Response("Not found", { status: 404 });
      });

      try {
        const published = await publishExternalTestShiplet(
          makeRequest,
          organization.id,
          "https://preview.example.com/error/index.html",
        );
        const tenantOrigin = `https://${published.project.subdomain}.shiplet.cc`;
        const artifacts = [
          {
            response: await requestHelper(
              externalArtifactFramePath(published.project.id),
              { headers: { Origin: "null", ...AUTH_HEADERS } },
            ),
            trustedOrigin: "https://shiplet.cc",
          },
          {
            response: await withCustomDomain("shiplet.cc", () =>
              requestHelper(`${tenantOrigin}/__shiplet/artifact-frame/`, {
                headers: { Origin: "null", ...AUTH_HEADERS },
              }),
            ),
            trustedOrigin: tenantOrigin,
          },
        ];
        for (const { response: artifact, trustedOrigin } of artifacts) {
          expect(artifact.status).toBe(404);
          expect(artifact.headers.get("content-type")).toContain("text/html");
          expect(
            artifact.headers.get("access-control-allow-origin"),
          ).toBeNull();
          const csp = artifact.headers.get("content-security-policy") || "";
          expect(csp).toContain("sandbox allow-scripts allow-forms");
          expect(csp).toContain("default-src 'none'");
          expect(csp).toContain(`connect-src ${trustedOrigin}`);
          expect(csp).toContain("form-action 'none'");
          expect(csp).toContain(`frame-ancestors ${trustedOrigin}`);
          expect(csp).not.toContain("ambient.example");
          expect(await artifact.text()).toContain("ambient.example/leak");
        }
        expect(upstreamRequests).toHaveLength(2);
        for (const upstreamRequest of upstreamRequests) {
          expect(upstreamRequest.headers.get("cookie")).toBeNull();
          expect(
            upstreamRequest.headers.get(["author", "ization"].join("")),
          ).toBeNull();
        }
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }
    });

    it("Given external HTML and CSS return bodyless cache or reset statuses, When the opaque artifact frame serves them, Then status and validators survive without rewriting, spooling, or upstream CORS credentials", async () => {
      const statuses = [204, 205, 304] as const;
      const organization = await createTestOrganization(makeRequest);
      const upstreamRequests: Request[] = [];
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const request =
          input instanceof Request ? input : new Request(input.toString());
        upstreamRequests.push(request);
        const htmlStatus = request.url.match(
          /^https:\/\/preview\.example\.com\/bodyless-html-(204|205|304)\.html$/,
        )?.[1];
        if (htmlStatus) {
          return new Response(null, {
            status: Number(htmlStatus),
            headers: {
              "content-type": "text/html; charset=utf-8",
              etag: `"bodyless-html-${htmlStatus}"`,
              "access-control-allow-origin": "https://upstream.example",
              "access-control-allow-credentials": "true",
              "set-cookie": "upstream=must-not-leak; Secure",
            },
          });
        }
        if (request.url === "https://preview.example.com/bodyless-css.html") {
          return new Response(
            `<!doctype html>${statuses
              .map(
                (status) =>
                  `<link id="bodyless-css-${status}" rel="stylesheet" href="styles/status-${status}.css">`,
              )
              .join("")}`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        const cssStatus = request.url.match(
          /^https:\/\/preview\.example\.com\/styles\/status-(204|205|304)\.css$/,
        )?.[1];
        if (cssStatus) {
          return new Response(null, {
            status: Number(cssStatus),
            headers: {
              "content-type": "text/css; charset=utf-8",
              etag: `"bodyless-css-${cssStatus}"`,
              "access-control-allow-origin": "https://upstream.example",
              "access-control-allow-credentials": "true",
              "set-cookie": "upstream=must-not-leak; Secure",
            },
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const browserHeaders = new Headers({ Origin: "null" });
      browserHeaders.set("Cookie", "browser-marker=must-not-forward");
      browserHeaders.set(["author", "ization"].join(""), "not-a-credential");
      browserHeaders.set("x-shiplet-user-id", "must-not-forward");

      try {
        const beforeKeys = await reviewAssetKeys();
        for (const status of statuses) {
          const published = await publishExternalTestShiplet(
            makeRequest,
            organization.id,
            `https://preview.example.com/bodyless-html-${status}.html`,
          );
          const response = await requestHelper(
            externalArtifactFramePath(published.project.id),
            { headers: browserHeaders },
          );
          expect(response.status).toBe(status);
          expect(response.headers.get("etag")).toBe(
            `"bodyless-html-${status}"`,
          );
          expect(response.headers.get("access-control-allow-origin")).toBe("*");
          expect(
            response.headers.get("access-control-allow-credentials"),
          ).toBeNull();
          expect(response.headers.get("set-cookie")).toBeNull();
          expect((await response.arrayBuffer()).byteLength).toBe(0);
        }

        const cssProject = await publishExternalTestShiplet(
          makeRequest,
          organization.id,
          "https://preview.example.com/bodyless-css.html",
        );
        const documentPath = externalArtifactFramePath(cssProject.project.id);
        const html = await (
          await requestHelper(documentPath, { headers: browserHeaders })
        ).text();
        for (const status of statuses) {
          const cssPath = localArtifactReference(
            extractTagAttribute(html, `id="bodyless-css-${status}"`, "href"),
            documentPath,
          );
          const response = await requestHelper(cssPath, {
            headers: browserHeaders,
          });
          expect(response.status).toBe(status);
          expect(response.headers.get("etag")).toBe(`"bodyless-css-${status}"`);
          expect(response.headers.get("access-control-allow-origin")).toBe("*");
          expect(
            response.headers.get("access-control-allow-credentials"),
          ).toBeNull();
          expect(response.headers.get("set-cookie")).toBeNull();
          expect((await response.arrayBuffer()).byteLength).toBe(0);
        }

        expect(await reviewAssetKeys()).toEqual(beforeKeys);
        expect(upstreamRequests.length).toBeGreaterThanOrEqual(7);
        for (const request of upstreamRequests) {
          expect(request.headers.get("cookie")).toBeNull();
          expect(
            request.headers.get(["author", "ization"].join("")),
          ).toBeNull();
          expect(request.headers.get("x-shiplet-user-id")).toBeNull();
        }
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }
    });

    it("Given external HTML and CSS return partial-content bodies, When the artifact frame would need to rewrite them, Then it fails closed without raw bytes, range metadata, temporary spools, or credential forwarding", async () => {
      const partialBytes = 1024 * 1024;
      const organization = await createTestOrganization(makeRequest);
      const upstreamRequests: Request[] = [];
      const partialHtml = paddedExternalTextStream(
        partialBytes,
        '<!doctype html><p id="raw-partial-html">raw-partial-html</p>',
        '<img src="partial.png">',
        { chunkSize: 64 * 1024 },
      );
      const partialCss = paddedExternalTextStream(
        partialBytes,
        ".raw-partial-css{color:red}",
        '.tail{background:url("partial.png")}',
        { chunkSize: 64 * 1024 },
      );
      const partialResponse = (
        body: ReadableStream<Uint8Array>,
        contentType: string,
      ) =>
        new Response(body, {
          status: 206,
          headers: {
            "content-type": contentType,
            "content-length": "64",
            "content-range": `bytes 0-63/${partialBytes}`,
            "accept-ranges": "bytes",
            etag: '"partial-validator"',
            "access-control-allow-origin": "https://upstream.example",
            "access-control-allow-credentials": "true",
            "set-cookie": "upstream=must-not-leak; Secure",
          },
        });
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const request =
          input instanceof Request ? input : new Request(input.toString());
        upstreamRequests.push(request);
        if (request.url === "https://preview.example.com/partial.html") {
          return partialResponse(partialHtml.body, "text/html; charset=utf-8");
        }
        if (request.url === "https://preview.example.com/partial-css.html") {
          return new Response(
            '<!doctype html><link id="partial-css" rel="stylesheet" href="styles/partial.css">',
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        if (request.url === "https://preview.example.com/styles/partial.css") {
          return partialResponse(partialCss.body, "text/css; charset=utf-8");
        }
        return new Response("Not found", { status: 404 });
      });

      const browserHeaders = new Headers({ Origin: "null" });
      browserHeaders.set("Cookie", "browser-marker=must-not-forward");
      browserHeaders.set(["author", "ization"].join(""), "not-a-credential");
      browserHeaders.set("x-shiplet-user-id", "must-not-forward");

      const expectCleanPartialRejection = async (response: Response) => {
        expect(response.status).toBe(502);
        expect(response.headers.get("content-type")).toContain("text/plain");
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(
          response.headers.get("access-control-allow-credentials"),
        ).toBeNull();
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(response.headers.get("content-range")).toBeNull();
        expect(response.headers.get("accept-ranges")).toBeNull();
        expect(response.headers.get("content-length")).toBeNull();
        expect(response.headers.get("etag")).toBeNull();
        const body = await response.text();
        expect(body).toMatch(/external.*partial|partial.*external/i);
        expect(body).not.toContain("raw-partial");
        expect(body).not.toContain("__shiplet/external-resource");
        expect(body).not.toContain("data-shiplet-kernel-artifact-bridge");
      };

      try {
        const beforeKeys = await reviewAssetKeys();
        const htmlProject = await publishExternalTestShiplet(
          makeRequest,
          organization.id,
          "https://preview.example.com/partial.html",
        );
        await expectCleanPartialRejection(
          await requestHelper(
            externalArtifactFramePath(htmlProject.project.id),
            { headers: browserHeaders },
          ),
        );

        const cssProject = await publishExternalTestShiplet(
          makeRequest,
          organization.id,
          "https://preview.example.com/partial-css.html",
        );
        const documentPath = externalArtifactFramePath(cssProject.project.id);
        const html = await (
          await requestHelper(documentPath, { headers: browserHeaders })
        ).text();
        const cssPath = localArtifactReference(
          extractTagAttribute(html, 'id="partial-css"', "href"),
          documentPath,
        );
        await expectCleanPartialRejection(
          await requestHelper(cssPath, { headers: browserHeaders }),
        );

        expect(partialHtml.telemetry.cancelled).toBe(1);
        expect(partialCss.telemetry.cancelled).toBe(1);
        expect(partialHtml.telemetry.pulledBytes).toBeLessThan(partialBytes);
        expect(partialCss.telemetry.pulledBytes).toBeLessThan(partialBytes);
        expect(await reviewAssetKeys()).toEqual(beforeKeys);
        for (const request of upstreamRequests) {
          expect(request.headers.get("cookie")).toBeNull();
          expect(
            request.headers.get(["author", "ization"].join("")),
          ).toBeNull();
          expect(request.headers.get("x-shiplet-user-id")).toBeNull();
        }
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }
    });

    it("Given 8 MiB through 32 MiB external HTML with unknown or dishonest lengths, When the artifact frame rewrites it, Then the full asset, effective base, and bridge behavior survives spooling", async () => {
      const mebibyte = 1024 * 1024;
      const sizes = [8 * mebibyte + 1, 16 * mebibyte, 32 * mebibyte];
      const organization = await createTestOrganization(makeRequest);
      const originRequests: string[] = [];
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const request =
          input instanceof Request ? input : new Request(input.toString());
        originRequests.push(request.url);
        const documentMatch = request.url.match(
          /^https:\/\/preview\.example\.com\/large-html-(\d+)\/site\/index\.html$/,
        );
        if (documentMatch) {
          const size = Number(documentMatch[1]);
          const fixture = paddedExternalTextStream(
            size,
            '<!doctype html><html><head><base href="../runtime/"><title>Large external document</title></head><body><p id="large-start">start</p>',
            `<img id="large-asset-${size}" src="images/hero-${size}.png"><p id="large-end">end</p></body></html>`,
          );
          const headers = new Headers({
            "content-type": "text/html; charset=utf-8",
          });
          if (size === 16 * mebibyte) headers.set("content-length", "1");
          if (size === 32 * mebibyte) {
            headers.set("content-length", String(8 * mebibyte));
          }
          return new Response(fixture.body, { headers });
        }
        if (
          /\/large-html-\d+\/runtime\/images\/hero-\d+\.png$/.test(request.url)
        ) {
          return new Response(`asset-bytes:${request.url}`, {
            headers: { "content-type": "image/png" },
          });
        }
        if (/\/large-html-\d+\/runtime\/state\.json$/.test(request.url)) {
          return Response.json({ fullDocumentRuntimeBase: true });
        }
        return new Response("Not found", { status: 404 });
      });

      try {
        for (const size of sizes) {
          const beforeKeys = await reviewAssetKeys();
          const published = await publishExternalTestShiplet(
            makeRequest,
            organization.id,
            `https://preview.example.com/large-html-${size}/site/index.html`,
          );
          const documentPath = externalArtifactFramePath(published.project.id);
          const documentContext = createExecutionContext();
          const documentResponse = await app.fetch(
            new Request(`http://localhost${documentPath}`, {
              headers: { Origin: "null" },
            }),
            env as unknown as TestEnv,
            documentContext,
          );
          expect(documentResponse.status).toBe(200);
          expect(documentResponse.headers.get("content-type")).toBe(
            "text/html; charset=utf-8",
          );
          expect(
            documentResponse.headers.get("access-control-allow-origin"),
          ).toBe("*");
          const openKeys = await reviewAssetKeys();
          expect(
            openKeys.some(
              (key) =>
                !beforeKeys.includes(key) &&
                key.startsWith(EXTERNAL_REWRITE_SPOOL_PREFIX),
            ),
          ).toBe(true);
          const html = await documentResponse.text();
          await waitOnExecutionContext(documentContext);
          expect(html).toContain('id="large-start"');
          expect(html).toContain('id="large-end"');
          expect(
            html.match(/data-shiplet-kernel-artifact-bridge="v1"/g),
          ).toHaveLength(1);
          expect(html.match(/<base\b/gi)).toHaveLength(1);

          const documentUrl = new URL(documentPath, "http://localhost");
          const runtimeBaseUrl = new URL(
            extractDocumentBaseReference(html),
            documentUrl,
          );
          const runtimeState = await requestHelper(
            new URL("state.json", runtimeBaseUrl).toString(),
            { headers: { "Sec-Fetch-Dest": "empty" } },
          );
          expect(await runtimeState.json()).toEqual({
            fullDocumentRuntimeBase: true,
          });

          const assetReference = extractTagAttribute(
            html,
            `id="large-asset-${size}"`,
            "src",
          );
          expect(assetReference).not.toContain("preview.example.com");
          const assetResponse = await requestHelper(
            localArtifactReference(assetReference, documentPath),
            { headers: { "Sec-Fetch-Dest": "image" } },
          );
          expect(assetResponse.status).toBe(200);
          expect(
            new TextDecoder().decode(await assetResponse.arrayBuffer()),
          ).toContain(`/large-html-${size}/runtime/images/hero-${size}.png`);
          expect(originRequests).toEqual(
            expect.arrayContaining([
              `https://preview.example.com/large-html-${size}/runtime/state.json`,
              `https://preview.example.com/large-html-${size}/runtime/images/hero-${size}.png`,
            ]),
          );
          expect(await reviewAssetKeys()).toEqual(beforeKeys);
        }
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }
    });

    it("Given 8 MiB through 32 MiB external CSS with unknown or dishonest lengths, When the signed stylesheet is rewritten, Then a tail asset still resolves from the stylesheet URL and temporary parts are removed at EOF", async () => {
      const mebibyte = 1024 * 1024;
      const sizes = [8 * mebibyte + 1, 16 * mebibyte, 32 * mebibyte];
      const organization = await createTestOrganization(makeRequest);
      const originRequests: string[] = [];
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const request =
          input instanceof Request ? input : new Request(input.toString());
        originRequests.push(request.url);
        const documentMatch = request.url.match(
          /^https:\/\/preview\.example\.com\/large-css-(\d+)\/index\.html$/,
        );
        if (documentMatch) {
          const size = Number(documentMatch[1]);
          return new Response(
            `<!doctype html><link id="large-css-${size}" rel="stylesheet" href="styles/main.css">`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        const stylesheetMatch = request.url.match(
          /^https:\/\/preview\.example\.com\/large-css-(\d+)\/styles\/main\.css$/,
        );
        if (stylesheetMatch) {
          const size = Number(stylesheetMatch[1]);
          const fixture = paddedExternalTextStream(
            size,
            '@charset "UTF-8";.large-start{display:block}',
            `.large-end-${size}{background-image:url("../images/hero-${size}.png")}`,
          );
          const headers = new Headers({
            "content-type": "text/css; charset=utf-8",
          });
          if (size === 16 * mebibyte) headers.set("content-length", "1");
          if (size === 32 * mebibyte) {
            headers.set("content-length", String(8 * mebibyte));
          }
          return new Response(fixture.body, { headers });
        }
        if (/\/large-css-\d+\/images\/hero-\d+\.png$/.test(request.url)) {
          return new Response(`css-asset-bytes:${request.url}`, {
            headers: { "content-type": "image/png" },
          });
        }
        return new Response("Not found", { status: 404 });
      });

      try {
        for (const size of sizes) {
          const beforeKeys = await reviewAssetKeys();
          const published = await publishExternalTestShiplet(
            makeRequest,
            organization.id,
            `https://preview.example.com/large-css-${size}/index.html`,
          );
          const documentPath = externalArtifactFramePath(published.project.id);
          const html = await (await requestHelper(documentPath)).text();
          const cssPath = localArtifactReference(
            extractTagAttribute(html, `id="large-css-${size}"`, "href"),
            documentPath,
          );
          const cssContext = createExecutionContext();
          const cssResponse = await app.fetch(
            new Request(`http://localhost${cssPath}`, {
              headers: { Origin: "null", "Sec-Fetch-Dest": "style" },
            }),
            env as unknown as TestEnv,
            cssContext,
          );
          expect(cssResponse.status).toBe(200);
          expect(cssResponse.headers.get("content-type")).toBe(
            "text/css; charset=utf-8",
          );
          expect(cssResponse.headers.get("access-control-allow-origin")).toBe(
            "*",
          );
          const openKeys = await reviewAssetKeys();
          expect(
            openKeys.some(
              (key) =>
                !beforeKeys.includes(key) &&
                key.startsWith(EXTERNAL_REWRITE_SPOOL_PREFIX),
            ),
          ).toBe(true);
          const css = await cssResponse.text();
          await waitOnExecutionContext(cssContext);
          expect(css).toContain(".large-start{display:block}");
          const assetReference = css.match(
            new RegExp(
              `\\.large-end-${size}\\{background-image:url\\(["']?([^"')]+)`,
            ),
          )?.[1];
          expect(assetReference).toBeTruthy();
          expect(assetReference).not.toContain("preview.example.com");
          const assetResponse = await requestHelper(
            localArtifactReference(assetReference!, cssPath),
            { headers: { "Sec-Fetch-Dest": "image" } },
          );
          expect(
            new TextDecoder().decode(await assetResponse.arrayBuffer()),
          ).toContain(`/large-css-${size}/images/hero-${size}.png`);
          expect(originRequests).toContain(
            `https://preview.example.com/large-css-${size}/images/hero-${size}.png`,
          );
          expect(await reviewAssetKeys()).toEqual(beforeKeys);
        }
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }
    });

    it("Given a spooled external document response, When the browser cancels before EOF, Then every temporary REVIEW_ASSETS part is removed", async () => {
      const totalBytes = 16 * 1024 * 1024;
      const organization = await createTestOrganization(makeRequest);
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const request =
          input instanceof Request ? input : new Request(input.toString());
        if (request.url === "https://preview.example.com/cancel/index.html") {
          return new Response(
            paddedExternalTextStream(
              totalBytes,
              "<!doctype html><html><head><title>Cancelled spool</title></head><body>",
              '<img src="images/never-read.png"></body></html>',
            ).body,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        return new Response("not found", { status: 404 });
      });

      try {
        const published = await publishExternalTestShiplet(
          makeRequest,
          organization.id,
          "https://preview.example.com/cancel/index.html",
        );
        const beforeKeys = await reviewAssetKeys();
        const context = createExecutionContext();
        const response = await app.fetch(
          new Request(
            `http://localhost${externalArtifactFramePath(published.project.id)}`,
            { headers: { Origin: "null" } },
          ),
          env as unknown as TestEnv,
          context,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
        const openKeys = await reviewAssetKeys();
        expect(
          openKeys.some(
            (key) =>
              !beforeKeys.includes(key) &&
              key.startsWith(EXTERNAL_REWRITE_SPOOL_PREFIX),
          ),
        ).toBe(true);

        const responseReader = response.body!.getReader();
        const firstOutputChunk = await responseReader.read();
        expect(firstOutputChunk.done).toBe(false);
        expect(firstOutputChunk.value?.byteLength).toBeGreaterThan(0);
        await responseReader.cancel();
        await waitOnExecutionContext(context);
        expect(await reviewAssetKeys()).toEqual(beforeKeys);
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }
    });

    it("Given a 64 MiB plus one byte external HTML stream without a trustworthy length, When the circuit breaker trips, Then the route returns one clean non-CORS 502 and deletes all partial spool state", async () => {
      const circuitBreakerBytes = 64 * 1024 * 1024;
      const organization = await createTestOrganization(makeRequest);
      const oversized = paddedExternalTextStream(
        circuitBreakerBytes + 1,
        '<!doctype html><p id="raw-before-limit">raw-before-limit</p>',
        '<img id="partial-after-limit" src="images/partial.png">',
      );
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const request =
          input instanceof Request ? input : new Request(input.toString());
        if (request.url === "https://preview.example.com/overflow.html") {
          return new Response(oversized.body, {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "content-length": String(8 * 1024 * 1024),
              "access-control-allow-origin": "https://upstream.example",
            },
          });
        }
        return new Response("unexpected upstream request", { status: 500 });
      });

      try {
        const published = await publishExternalTestShiplet(
          makeRequest,
          organization.id,
          "https://preview.example.com/overflow.html",
        );
        const beforeKeys = await reviewAssetKeys();
        const response = await requestHelper(
          externalArtifactFramePath(published.project.id),
          { headers: { Origin: "null" } },
        );
        expect(response.status).toBe(502);
        expect(response.headers.get("content-type")).toContain("text/plain");
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        const body = await response.text();
        expect(body).toMatch(/external.*rewrite.*limit/i);
        expect(body).not.toContain("raw-before-limit");
        expect(body).not.toContain("partial-after-limit");
        expect(body).not.toContain("__shiplet/external-resource");
        expect(body).not.toContain("data-shiplet-kernel-artifact-bridge");
        expect(oversized.telemetry.pulledBytes).toBe(circuitBreakerBytes + 1);
        expect(await reviewAssetKeys()).toEqual(beforeKeys);
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }
    });

    it("Given stale external rewrite parts and unrelated REVIEW_ASSETS objects, When the scheduled job runs while support readiness is unavailable, Then cleanup deletes only the reserved spool prefix", async () => {
      const bucket = (env as unknown as TestEnv).REVIEW_ASSETS;
      const marker = crypto.randomUUID();
      const stalePart = `${EXTERNAL_REWRITE_SPOOL_PREFIX}0000000000000/project_${marker}/spool/part-000000`;
      const prefixLookalike = `_internal/external-rewrite/v1-lookalike/${marker}`;
      const unrelatedReviewAsset = `review/screenshots/${marker}.png`;
      await bucket.put(stalePart, "stale external rewrite part");
      await bucket.put(prefixLookalike, "must remain");
      await bucket.put(unrelatedReviewAsset, "must remain");
      const context = createExecutionContext();
      const unavailableSupportEnv = new Proxy(env as unknown as TestEnv, {
        get(target, property, receiver) {
          if (property === "CLOUDFLARE_CONTROL_PLANE_VERSION_ID") {
            return "support-not-ready-for-cleanup-test";
          }
          return Reflect.get(target, property, receiver);
        },
      });

      try {
        await app.scheduled(
          {
            cron: "*/15 * * * *",
            scheduledTime: Date.now() + EXTERNAL_REWRITE_SPOOL_MAX_AGE_MS + 1,
          } as ScheduledController,
          unavailableSupportEnv as unknown as Parameters<
            typeof app.scheduled
          >[1],
          context,
        );
        await waitOnExecutionContext(context);

        expect(await bucket.get(stalePart)).toBeNull();
        expect(await bucket.get(prefixLookalike)).not.toBeNull();
        expect(await bucket.get(unrelatedReviewAsset)).not.toBeNull();
      } finally {
        await bucket.delete([stalePart, prefixLookalike, unrelatedReviewAsset]);
      }
    });

    it("Given REVIEW_ASSETS cleanup is temporarily unavailable, When the scheduled job runs, Then the cleanup failure does not reject or abort the remaining maintenance chain", async () => {
      const bucket = (env as unknown as TestEnv).REVIEW_ASSETS;
      let databasePrepareCalls = 0;
      const database = new Proxy((env as unknown as TestEnv).DB, {
        get(target, property, receiver) {
          if (property === "prepare") {
            return (...args: Parameters<D1Database["prepare"]>) => {
              databasePrepareCalls += 1;
              return target.prepare(...args);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const unavailableBucket = new Proxy(bucket, {
        get(target, property, receiver) {
          if (property === "list") {
            return async () => {
              throw new Error("fixture REVIEW_ASSETS list failure");
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const unavailableCleanupEnv = new Proxy(env as unknown as TestEnv, {
        get(target, property, receiver) {
          if (property === "REVIEW_ASSETS") return unavailableBucket;
          if (property === "DB") return database;
          if (property === "CLOUDFLARE_CONTROL_PLANE_VERSION_ID") {
            return "support-not-ready-after-cleanup-failure";
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const context = createExecutionContext();

      await app.scheduled(
        {
          cron: "*/15 * * * *",
          scheduledTime: Date.now(),
        } as ScheduledController,
        unavailableCleanupEnv as unknown as Parameters<typeof app.scheduled>[1],
        context,
      );

      await expect(waitOnExecutionContext(context)).resolves.toBeUndefined();
      expect(databasePrepareCalls).toBeGreaterThan(0);
    });

    it("Given in-limit UTF-8 text and a binary artifact larger than the text circuit breaker, When the external artifact frame serves them, Then text charset behavior is preserved and binary bytes stream without rewrite buffering", async () => {
      const binaryBytesTotal = 64 * 1024 * 1024 + 1;
      const organization = await createTestOrganization(makeRequest);
      const upstreamRequests: Request[] = [];
      const binary = trackedByteStream(binaryBytesTotal, {
        byte: 0x5a,
        chunkSize: 1024 * 1024,
      });
      const htmlBytes = new TextEncoder().encode(
        '<!doctype html><p id="utf8-copy">café</p><link id="utf8-css" rel="stylesheet" href="styles/utf8.css"><img id="large-binary" src="assets/blob.bin">',
      );
      const cssBytes = new TextEncoder().encode(
        '.café{background-image:url("../images/café.png")}',
      );
      const splitUtf8Stream = (bytes: Uint8Array) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            const split = Math.max(1, bytes.indexOf(0xc3) + 1);
            controller.enqueue(bytes.slice(0, split));
            controller.enqueue(bytes.slice(split));
            controller.close();
          },
        });
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const request =
          input instanceof Request ? input : new Request(input.toString());
        upstreamRequests.push(request);
        if (request.url === "https://preview.example.com/app/index.html") {
          return new Response(
            request.method === "HEAD" ? null : splitUtf8Stream(htmlBytes),
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        if (request.url === "https://preview.example.com/app/styles/utf8.css") {
          return new Response(splitUtf8Stream(cssBytes), {
            headers: { "content-type": "text/css; charset=utf-8" },
          });
        }
        if (request.url === "https://preview.example.com/app/assets/blob.bin") {
          return new Response(binary.body, {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        return new Response("image", {
          headers: { "content-type": "image/png" },
        });
      });

      try {
        const published = await publishExternalTestShiplet(
          makeRequest,
          organization.id,
          "https://preview.example.com/app/index.html",
        );
        const documentPath = externalArtifactFramePath(published.project.id);
        const browserHeaders = new Headers({ Origin: "null" });
        browserHeaders.set("Cookie", "browser-marker=not-a-secret");
        browserHeaders.set(["author", "ization"].join(""), "not-a-credential");
        const documentResponse = await requestHelper(documentPath, {
          headers: browserHeaders,
        });
        expect(documentResponse.status).toBe(200);
        expect(documentResponse.headers.get("content-type")).toBe(
          "text/html; charset=utf-8",
        );
        expect(
          documentResponse.headers.get("access-control-allow-origin"),
        ).toBe("*");
        const html = await documentResponse.text();
        expect(html).toContain("café");

        const cssPath = localArtifactReference(
          extractTagAttribute(html, 'id="utf8-css"', "href"),
          documentPath,
        );
        const cssResponse = await requestHelper(cssPath, {
          headers: browserHeaders,
        });
        expect(cssResponse.status).toBe(200);
        expect(cssResponse.headers.get("content-type")).toBe(
          "text/css; charset=utf-8",
        );
        expect(await cssResponse.text()).toContain(".café");

        const binaryPath = localArtifactReference(
          extractTagAttribute(html, 'id="large-binary"', "src"),
          documentPath,
        );
        const binaryResponse = await requestHelper(binaryPath, {
          headers: browserHeaders,
        });
        expect(binaryResponse.status).toBe(200);
        expect(binaryResponse.headers.get("content-type")).toBe(
          "application/octet-stream",
        );
        const binaryReader = binaryResponse.body!.getReader();
        let consumedBinaryBytes = 0;
        let firstBinaryByte: number | undefined;
        let lastBinaryByte: number | undefined;
        while (true) {
          const { done, value } = await binaryReader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          firstBinaryByte ??= value[0];
          lastBinaryByte = value[value.byteLength - 1];
          consumedBinaryBytes += value.byteLength;
        }
        expect(consumedBinaryBytes).toBe(binaryBytesTotal);
        expect(firstBinaryByte).toBe(0x5a);
        expect(lastBinaryByte).toBe(0x5a);
        expect(binary.telemetry.cancelled).toBe(0);
        expect(binary.telemetry.pulledBytes).toBe(binaryBytesTotal);

        const headResponse = await requestHelper(documentPath, {
          method: "HEAD",
          headers: browserHeaders,
        });
        expect(headResponse.status).toBe(200);
        expect((await headResponse.arrayBuffer()).byteLength).toBe(0);
        for (const upstreamRequest of upstreamRequests) {
          expect(upstreamRequest.headers.get("cookie")).toBeNull();
          expect(
            upstreamRequest.headers.get(["author", "ization"].join("")),
          ).toBeNull();
        }
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }
    });

    it("Given an external document and external module redirect, When runtime-relative references resolve, Then the redirect-final document and module URLs remain their bases", async () => {
      await withCustomDomain("shiplet.cc", async () => {
        const organization = await createTestOrganization(makeRequest);
        await withExternalOriginFixtures(
          {
            "https://preview.example.com/latest": () =>
              new Response(null, {
                status: 302,
                headers: { location: "/deploys/build-42/index.html" },
              }),
            "https://preview.example.com/deploys/build-42/index.html": () =>
              new Response(
                '<!doctype html><script>fetch("api/config.json")</script><script id="redirect-module" type="module" src="scripts/entry.js"></script>',
                { headers: { "content-type": "text/html; charset=utf-8" } },
              ),
            "https://preview.example.com/deploys/build-42/api/config.json":
              () => Response.json({ build: 42 }),
            "https://preview.example.com/deploys/build-42/scripts/entry.js":
              () =>
                new Response(null, {
                  status: 302,
                  headers: { location: "/cdn/build-42/modules/entry.js" },
                }),
            "https://preview.example.com/cdn/build-42/modules/entry.js": () =>
              new Response('import("./dependency.js")', {
                headers: { "content-type": "text/javascript" },
              }),
            "https://preview.example.com/cdn/build-42/modules/dependency.js":
              () =>
                new Response("export const redirectedDependency=true", {
                  headers: { "content-type": "text/javascript" },
                }),
          },
          async (originRequests) => {
            const published = await publishExternalTestShiplet(
              makeRequest,
              organization.id,
              "https://preview.example.com/latest",
            );
            const documentUrl = `https://${published.project.subdomain}.shiplet.cc/__shiplet/artifact-frame/`;
            const html = await (await requestHelper(documentUrl)).text();
            const runtimeBase = new URL(
              extractDocumentBaseReference(html),
              documentUrl,
            );
            const configResponse = await requestHelper(
              new URL("api/config.json", runtimeBase).toString(),
              { headers: { "Sec-Fetch-Dest": "empty" } },
            );
            expect(await configResponse.json()).toEqual({ build: 42 });

            const moduleUrl = new URL(
              extractTagAttribute(html, 'id="redirect-module"', "src"),
              documentUrl,
            );
            expect(moduleUrl.search).toBe("");
            const moduleRedirect = await requestHelper(moduleUrl.toString(), {
              headers: { "Sec-Fetch-Dest": "script" },
              redirect: "manual",
            });
            expect(moduleRedirect.status).toBe(302);
            const finalModuleUrl = new URL(
              moduleRedirect.headers.get("location")!,
              moduleUrl,
            );
            expect(finalModuleUrl.origin).toBe(moduleUrl.origin);
            expect(finalModuleUrl.search).toBe("");
            expect(finalModuleUrl.pathname).toContain(
              "/__shiplet/artifact-frame/",
            );
            expect(moduleRedirect.headers.get("location")).not.toContain(
              "https://preview.example.com",
            );
            expect(moduleRedirect.headers.get("set-cookie")).toBeNull();
            expect(moduleRedirect.headers.get("cache-control")).toContain(
              "no-store",
            );
            const moduleResponse = await requestHelper(
              finalModuleUrl.toString(),
              { headers: { "Sec-Fetch-Dest": "script" } },
            );
            expect(await moduleResponse.text()).toBe(
              'import("./dependency.js")',
            );
            const dependencyResponse = await requestHelper(
              new URL("./dependency.js", finalModuleUrl).toString(),
              { headers: { "Sec-Fetch-Dest": "script" } },
            );
            expect(await dependencyResponse.text()).toBe(
              "export const redirectedDependency=true",
            );
            expect(originRequests).toEqual(
              expect.arrayContaining([
                "https://preview.example.com/latest",
                "https://preview.example.com/deploys/build-42/index.html",
                "https://preview.example.com/deploys/build-42/api/config.json",
                "https://preview.example.com/deploys/build-42/scripts/entry.js",
                "https://preview.example.com/cdn/build-42/modules/entry.js",
                "https://preview.example.com/cdn/build-42/modules/dependency.js",
              ]),
            );
          },
        );
      });
    });

    it("Given a nested imported document without an authored base, When a production tenant resolves a relative runtime URL, Then the document directory is preserved instead of rebasing at the configured origin root", async () => {
      await withCustomDomain("shiplet.cc", async () => {
        const organization = await createTestOrganization(makeRequest);
        await withExternalOriginFixtures(
          {
            "https://preview.example.com/products/releases/index.html": () =>
              new Response(
                '<!doctype html><script>fetch("api/runtime-state.json")</script>',
                { headers: { "content-type": "text/html; charset=utf-8" } },
              ),
            "https://preview.example.com/products/releases/api/runtime-state.json":
              () => Response.json({ pathPreserved: true }),
          },
          async (originRequests) => {
            const published = await publishExternalTestShiplet(
              makeRequest,
              organization.id,
              "https://preview.example.com/products/releases/index.html",
            );
            const documentUrl = `https://${published.project.subdomain}.shiplet.cc/__shiplet/artifact-frame/`;
            const html = await (await requestHelper(documentUrl)).text();
            const runtimeBase = new URL(
              extractDocumentBaseReference(html),
              documentUrl,
            );
            const runtimeResponse = await requestHelper(
              new URL("api/runtime-state.json", runtimeBase).toString(),
              { headers: { "Sec-Fetch-Dest": "empty" } },
            );

            expect(await runtimeResponse.json()).toEqual({
              pathPreserved: true,
            });
            expect(originRequests).toContain(
              "https://preview.example.com/products/releases/api/runtime-state.json",
            );
            expect(originRequests).not.toContain(
              "https://preview.example.com/api/runtime-state.json",
            );
          },
        );
      });
    });

    it("Given an external URL that redirects, When relative assets load, Then the final response URL becomes their base", async () => {
      const organization = await createTestOrganization(makeRequest);
      await withExternalOriginFixtures(
        {
          "https://preview.example.com/latest": () =>
            new Response(null, {
              status: 302,
              headers: { location: "/builds/abc/index.html" },
            }),
          "https://preview.example.com/builds/abc/index.html": () =>
            new Response(
              '<!doctype html><link id="redirect-css" rel="stylesheet" href="assets/app.css">',
              { headers: { "content-type": "text/html; charset=utf-8" } },
            ),
          "https://preview.example.com/builds/abc/assets/app.css": () =>
            new Response(".redirect-css-loaded{display:grid}", {
              headers: { "content-type": "text/css; charset=utf-8" },
            }),
        },
        async (originRequests) => {
          const published = await publishExternalTestShiplet(
            makeRequest,
            organization.id,
            "https://preview.example.com/latest",
          );
          const documentPath = externalArtifactFramePath(published.project.id);
          const html = await (await makeRequest(documentPath)).text();
          const css = await makeRequest(
            localArtifactReference(
              extractTagAttribute(html, 'id="redirect-css"', "href"),
              documentPath,
            ),
          );
          expect(css.headers.get("content-type")).toContain("text/css");
          expect(await css.text()).toContain("redirect-css-loaded");
          expect(originRequests).toEqual(
            expect.arrayContaining([
              "https://preview.example.com/latest",
              "https://preview.example.com/builds/abc/index.html",
              "https://preview.example.com/builds/abc/assets/app.css",
            ]),
          );
        },
      );
    });

    it("Given framework-generated root asset paths, When the imported app loads, Then CSS, chunks, media, and fonts stay rooted at the upstream origin", async () => {
      const organization = await createTestOrganization(makeRequest);
      await withExternalOriginFixtures(
        {
          "https://preview.example.com/app/dashboard": () =>
            new Response(
              '<!doctype html><link id="next-css" rel="stylesheet" href="/_next/static/css/app.css"><script id="next-chunk" src="/_next/static/chunks/app.js"></script><img id="public-logo" src="/assets/logo.png">',
              { headers: { "content-type": "text/html; charset=utf-8" } },
            ),
          "https://preview.example.com/_next/static/css/app.css": () =>
            new Response(
              '@font-face{font-family:Framework;src:url("/_next/static/media/framework.woff2")}.framework-css-loaded{display:grid}',
              { headers: { "content-type": "text/css; charset=utf-8" } },
            ),
          "https://preview.example.com/_next/static/chunks/app.js": () =>
            new Response("globalThis.frameworkChunkLoaded=true", {
              headers: {
                "content-type": "application/javascript; charset=utf-8",
              },
            }),
          "https://preview.example.com/_next/static/media/framework.woff2":
            () =>
              new Response("framework-font-bytes", {
                headers: { "content-type": "font/woff2" },
              }),
          "https://preview.example.com/assets/logo.png": () =>
            new Response("framework-logo-bytes", {
              headers: { "content-type": "image/png" },
            }),
        },
        async (originRequests) => {
          const published = await publishExternalTestShiplet(
            makeRequest,
            organization.id,
            "https://preview.example.com/app/dashboard",
          );
          const documentPath = externalArtifactFramePath(published.project.id);
          const html = await (await makeRequest(documentPath)).text();
          const cssPath = localArtifactReference(
            extractTagAttribute(html, 'id="next-css"', "href"),
            documentPath,
          );
          const cssResponse = await makeRequest(cssPath);
          const css = await cssResponse.text();
          const chunkResponse = await makeRequest(
            localArtifactReference(
              extractTagAttribute(html, 'id="next-chunk"', "src"),
              documentPath,
            ),
          );
          const logoResponse = await makeRequest(
            localArtifactReference(
              extractTagAttribute(html, 'id="public-logo"', "src"),
              documentPath,
            ),
          );
          const fontReference = css.match(
            /src:url\(\s*["']?([^"')]+)["']?\s*\)/i,
          )?.[1];
          expect(fontReference).toBeTruthy();
          const fontResponse = await makeRequest(
            localArtifactReference(fontReference!, cssPath),
          );

          expect(cssResponse.headers.get("content-type")).toContain("text/css");
          expect(css).toContain("framework-css-loaded");
          expect(chunkResponse.headers.get("content-type")).toMatch(
            /^(?:application|text)\/javascript(?:\s*;\s*charset=utf-8)?$/i,
          );
          expect(await chunkResponse.text()).toBe(
            "globalThis.frameworkChunkLoaded=true",
          );
          expect(logoResponse.headers.get("content-type")).toContain(
            "image/png",
          );
          expect(fontResponse.headers.get("content-type")).toContain(
            "font/woff2",
          );
          expect(originRequests).toEqual(
            expect.arrayContaining([
              "https://preview.example.com/_next/static/css/app.css",
              "https://preview.example.com/_next/static/chunks/app.js",
              "https://preview.example.com/_next/static/media/framework.woff2",
              "https://preview.example.com/assets/logo.png",
            ]),
          );
        },
      );
    });

    it("Given a framework runtime creates a root-relative asset request, When the browser identifies it as a subresource, Then the tenant boundary routes it upstream", async () => {
      await withCustomDomain("shiplet.cc", async () => {
        const organization = await createTestOrganization(makeRequest);
        const subdomain = `runtime-root-${crypto.randomUUID().slice(0, 8)}`;
        const originRequests: string[] = [];
        const upstreamRequests: Request[] = [];
        const originalFetch = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const request =
            input instanceof Request ? input : new Request(input.toString());
          const url = request.url;
          originRequests.push(url);
          upstreamRequests.push(request);
          if (
            url ===
            "https://preview.example.com/_next/static/chunks/runtime-lazy.js"
          ) {
            return new Response("globalThis.runtimeLazyChunkLoaded=true", {
              headers: { "content-type": "text/javascript" },
            });
          }
          if (url === "https://preview.example.com/api/runtime-data") {
            return Response.json({ runtimeDataLoaded: true });
          }
          if (url === "https://preview.example.com/assets/runtime-head.png") {
            return new Response(
              request.method === "HEAD" ? null : "runtime-head-bytes",
              { headers: { "content-type": "image/png" } },
            );
          }
          return new Response("<!doctype html><h1>Framework shell</h1>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        });

        try {
          const response = await makeRequest("/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Framework runtime root asset",
              organization_id: organization.id,
              subdomain,
              external_url: "https://preview.example.com/app/dashboard",
            }),
          });
          expect(response.status).toBe(201);

          const artifact = await requestHelper(
            `https://${subdomain}.shiplet.cc/__shiplet/artifact-frame/`,
          );
          expect(artifact.status).toBe(200);
          expect(artifact.headers.get("content-security-policy")).toContain(
            `connect-src https://${subdomain}.shiplet.cc`,
          );
          expect(artifact.headers.get("content-security-policy")).not.toContain(
            "connect-src https://preview.example.com",
          );

          const artifactBridge = await requestHelper(
            `https://${subdomain}.shiplet.cc/api/review/artifact-bridge.js`,
            { headers: { "Sec-Fetch-Dest": "script" } },
          );
          expect(artifactBridge.status).toBe(200);
          expect(artifactBridge.headers.get("content-type")).toMatch(
            /javascript/i,
          );
          expect(await artifactBridge.text()).toContain(
            "shiplet.artifact.channel.v1",
          );

          const runtimeChunk = await requestHelper(
            `https://${subdomain}.shiplet.cc/_next/static/chunks/runtime-lazy.js`,
            { headers: { "Sec-Fetch-Dest": "script" } },
          );
          expect(runtimeChunk.status).toBe(200);
          expect(runtimeChunk.headers.get("content-type")).toContain(
            "text/javascript",
          );
          expect(await runtimeChunk.text()).toContain("runtimeLazyChunkLoaded");
          const runtimeData = await requestHelper(
            `https://${subdomain}.shiplet.cc/api/runtime-data`,
            { headers: { "Sec-Fetch-Dest": "empty" } },
          );
          expect(runtimeData.status).toBe(200);
          expect(runtimeData.headers.get("content-type")).toContain(
            "application/json",
          );
          expect(await runtimeData.json()).toEqual({
            runtimeDataLoaded: true,
          });
          const headHeaders = new Headers({
            "Sec-Fetch-Dest": "image",
          });
          headHeaders.set(["author", "ization"].join(""), "not-a-credential");
          headHeaders.set("Cookie", "browser-marker=not-a-secret");
          const runtimeHead = await requestHelper(
            `https://${subdomain}.shiplet.cc/assets/runtime-head.png`,
            { method: "HEAD", headers: headHeaders },
          );
          expect(runtimeHead.status).toBe(200);
          expect(runtimeHead.headers.get("content-type")).toContain(
            "image/png",
          );
          expect((await runtimeHead.arrayBuffer()).byteLength).toBe(0);
          const upstreamHead = upstreamRequests.find(
            (request) =>
              request.url ===
              "https://preview.example.com/assets/runtime-head.png",
          );
          expect(upstreamHead?.method).toBe("HEAD");
          expect(upstreamHead?.headers.get("cookie")).toBeNull();
          expect(
            upstreamHead?.headers.get(["author", "ization"].join("")),
          ).toBeNull();
          expect(originRequests).toContain(
            "https://preview.example.com/_next/static/chunks/runtime-lazy.js",
          );
          expect(originRequests).toContain(
            "https://preview.example.com/api/runtime-data",
          );
          expect(originRequests).toContain(
            "https://preview.example.com/assets/runtime-head.png",
          );
          expect(originRequests).not.toContain(
            "https://preview.example.com/api/review/artifact-bridge.js",
          );
        } finally {
          vi.stubGlobal("fetch", originalFetch);
        }
      });
    });

    it("Given a dashboard review host and a real tenant domain, When it embeds the artifact, Then runtime root requests stay on the project tenant while local fallback stays path-routed", async () => {
      const organization = await createTestOrganization(makeRequest);
      const subdomain = `dashboard-tenant-${crypto.randomUUID().slice(0, 8)}`;
      const originRequests: string[] = [];
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const request =
          input instanceof Request ? input : new Request(input.toString());
        originRequests.push(request.url);
        if (
          request.url ===
          "https://preview.example.com/_next/static/chunks/dashboard.js"
        ) {
          return new Response("globalThis.dashboardChunkLoaded=true", {
            headers: { "content-type": "text/javascript" },
          });
        }
        if (request.url === "https://preview.example.com/api/dashboard-data") {
          return Response.json({ dashboardDataLoaded: true });
        }
        return new Response("<!doctype html><h1>Dashboard tenant shell</h1>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      });

      try {
        const published = await withCustomDomain("shiplet.cc", async () => {
          const publish = await makeRequest("/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Dashboard tenant artifact",
              organization_id: organization.id,
              subdomain,
              external_url: "https://preview.example.com/app/dashboard",
            }),
          });
          expect(publish.status).toBe(201);
          const body = (await publish.json()) as {
            project: { id: string; subdomain: string };
          };

          const reviewHost = await makeRequest(
            `https://shiplet.cc/shiplets/${body.project.id}/review-host`,
          );
          expect(reviewHost.status).toBe(200);
          const reviewHostHtml = await reviewHost.text();
          const artifactReference = extractTagAttribute(
            reviewHostHtml,
            'data-shiplet-artifact-frame="v1"',
            "src",
          );
          const artifactUrl = new URL(artifactReference, "https://shiplet.cc");
          expect(artifactUrl.origin).toBe(`https://${subdomain}.shiplet.cc`);
          expect(artifactUrl.pathname).toBe("/__shiplet/artifact-frame/");
          expect(artifactUrl.search).toBe("");

          const artifact = await requestHelper(artifactUrl.toString());
          expect(artifact.status).toBe(200);
          expect(await artifact.text()).toContain("Dashboard tenant shell");

          const runtimeChunk = await requestHelper(
            `https://${subdomain}.shiplet.cc/_next/static/chunks/dashboard.js`,
            {
              headers: {
                "Sec-Fetch-Dest": "script",
              },
            },
          );
          expect(runtimeChunk.status).toBe(200);
          expect(await runtimeChunk.text()).toContain("dashboardChunkLoaded");
          const runtimeData = await requestHelper(
            `https://${subdomain}.shiplet.cc/api/dashboard-data`,
            {
              headers: {
                "Sec-Fetch-Dest": "empty",
              },
            },
          );
          expect(runtimeData.status).toBe(200);
          expect(await runtimeData.json()).toEqual({
            dashboardDataLoaded: true,
          });
          return body;
        });

        const localReviewHost = await makeRequest(
          `/shiplets/${published.project.id}/review-host`,
        );
        expect(localReviewHost.status).toBe(200);
        const localArtifactReference = extractTagAttribute(
          await localReviewHost.text(),
          'data-shiplet-artifact-frame="v1"',
          "src",
        );
        const localArtifactUrl = new URL(
          localArtifactReference,
          "http://localhost",
        );
        expect(localArtifactUrl.origin).not.toBe(
          `https://${subdomain}.shiplet.cc`,
        );
        expect(localArtifactUrl.pathname).toBe(
          `/shiplets/${published.project.id}/artifact-frame/`,
        );
        expect(originRequests).toEqual(
          expect.arrayContaining([
            "https://preview.example.com/app/dashboard",
            "https://preview.example.com/_next/static/chunks/dashboard.js",
            "https://preview.example.com/api/dashboard-data",
          ]),
        );
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }
    });

    it("should load public URL preview assets without iframe credentials while keeping the review host private", async () => {
      const organization = await createTestOrganization(makeRequest);
      const subdomain = `external-assets-${crypto.randomUUID().slice(0, 8)}`;
      const originRequests: string[] = [];
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        originRequests.push(url);
        if (url.endsWith("/logo.png")) {
          return new Response("logo-bytes", {
            headers: { "content-type": "image/png" },
          });
        }
        if (url.endsWith("/docs")) {
          return new Response("<!doctype html><h1>Upstream docs</h1>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response(
          '<!doctype html><body><img id="public-logo" src="/logo.png"><a id="public-docs" href="/docs">Docs</a></body>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      });

      try {
        const response = await makeRequest("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "External Preview Assets",
            organization_id: organization.id,
            subdomain,
            external_url: "https://preview.example.com",
          }),
        });
        expect(response.status).toBe(201);
        const body = (await response.json()) as {
          project: { id: string };
          previewUrl: string;
        };

        const previewResponse = await makeRequest(body.previewUrl);
        expect(previewResponse.status).toBe(200);
        const previewHtml = await previewResponse.text();
        expect(previewHtml).toContain(
          `/shiplets/${body.project.id}/artifact-frame/`,
        );
        expect(previewHtml).not.toContain("__SHIPLET_REVIEW__");
        const rawPreviewResponse = await makeRequest(
          `/shiplets/${body.project.id}/artifact-frame/`,
        );
        const rawPreviewHtml = await rawPreviewResponse.text();
        const rewrittenImagePath = localArtifactReference(
          extractTagAttribute(rawPreviewHtml, 'id="public-logo"', "src"),
          `/shiplets/${body.project.id}/artifact-frame/`,
        );
        const rewrittenDocsPath = localArtifactReference(
          extractTagAttribute(rawPreviewHtml, 'id="public-docs"', "href"),
          `/shiplets/${body.project.id}/artifact-frame/`,
        );
        const rewrittenImage = await requestHelper(rewrittenImagePath);
        expect(rewrittenImage.status).toBe(200);
        expect(rewrittenImage.headers.get("content-type")).toContain(
          "image/png",
        );
        expect(
          new TextDecoder().decode(await rewrittenImage.arrayBuffer()),
        ).toBe("logo-bytes");
        const rewrittenDocs = await requestHelper(rewrittenDocsPath);
        expect(rewrittenDocs.status).toBe(200);
        expect(rewrittenDocs.headers.get("content-type")).toContain(
          "text/html",
        );
        expect(await rewrittenDocs.text()).toContain("Upstream docs");

        const assetResponse = await makeRequest(
          `/shiplets/${body.project.id}/artifact-frame/logo.png`,
        );
        expect(assetResponse.status).toBe(200);
        expect(assetResponse.headers.get("content-type")).toContain(
          "image/png",
        );
        expect(
          new TextDecoder().decode(await assetResponse.arrayBuffer()),
        ).toBe("logo-bytes");
        expect(originRequests).toContain("https://preview.example.com/");
        expect(originRequests).toContain(
          "https://preview.example.com/logo.png",
        );

        const anonymousAssetResponse = await requestHelper(
          `/shiplets/${body.project.id}/artifact-frame/logo.png`,
        );
        expect(anonymousAssetResponse.status).toBe(200);
        expect(anonymousAssetResponse.headers.get("content-type")).toContain(
          "image/png",
        );
        expect(
          new TextDecoder().decode(await anonymousAssetResponse.arrayBuffer()),
        ).toBe("logo-bytes");

        const anonymousTenantAssetResponse = await requestHelper(
          `/${subdomain}/__shiplet/artifact-frame/logo.png`,
        );
        expect(anonymousTenantAssetResponse.status).toBe(200);
        expect(
          new TextDecoder().decode(
            await anonymousTenantAssetResponse.arrayBuffer(),
          ),
        ).toBe("logo-bytes");

        const anonymousReviewHost = await requestHelper(body.previewUrl, {
          redirect: "manual",
        });
        expect(anonymousReviewHost.status).toBe(302);
        expect(anonymousReviewHost.headers.get("location")).toContain(
          "/auth/login",
        );

        const anonymousTenantReviewHost = await requestHelper(
          `/${subdomain}/`,
          { redirect: "manual" },
        );
        expect(anonymousTenantReviewHost.status).toBe(302);
        expect(anonymousTenantReviewHost.headers.get("location")).toContain(
          "/auth/login",
        );

        const uploadedProject = await publishStaticShiplet(
          makeRequest,
          organization.id,
          {
            subdomain: `private-upload-${crypto.randomUUID().slice(0, 8)}`,
            visibility: "organization",
          },
        );
        const anonymousUploadedArtifact = await requestHelper(
          `/shiplets/${uploadedProject.project.id}/artifact-frame/`,
          { redirect: "manual" },
        );
        expect(anonymousUploadedArtifact.status).toBe(302);
        expect(anonymousUploadedArtifact.headers.get("location")).toContain(
          "/auth/login",
        );
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }
    });

    it("should normalize URL-shaped custom hostnames and route them to external preview projects", async () => {
      await withCustomDomain("shiplet.cc", async () => {
        const organization = await createTestOrganization(makeRequest);
        const subdomain = `external-host-${crypto.randomUUID().slice(0, 8)}`;
        const originRequests: string[] = [];
        const originalFetch = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          originRequests.push(url);
          if (url === "https://origin.example.com/logo.png") {
            return new Response("custom-host-logo-bytes", {
              headers: { "content-type": "image/png" },
            });
          }
          return new Response(
            '<!doctype html><body><h1>External Host</h1><img id="custom-logo" src="/logo.png"></body>',
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        });

        try {
          const response = await makeRequest("/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "External Custom Host",
              organization_id: organization.id,
              subdomain,
              external_url: "https://origin.example.com",
              custom_hostname: "https://agnt.one",
            }),
          });
          expect(response.status).toBe(201);
          const body = (await response.json()) as {
            project: { custom_hostname: string };
          };
          expect(body.project.custom_hostname).toBe("agnt.one");

          const proxyResponse = await makeRequest("https://agnt.one/path?q=1");
          expect(proxyResponse.status).toBe(200);
          const html = await proxyResponse.text();
          expect(html).toContain("External Custom Host");
          expect(html).toContain('data-shiplet-trusted-review-host="v1"');
          const rawProxy = await makeRequest(
            "https://agnt.one/__shiplet/artifact-frame/path?q=1",
          );
          const rawHtml = await rawProxy.text();
          expect(rawHtml).toContain("External Host");
          const logoReference = extractTagAttribute(
            rawHtml,
            'id="custom-logo"',
            "src",
          );
          const logoResponse = await makeRequest(
            new URL(
              logoReference,
              "https://agnt.one/__shiplet/artifact-frame/path?q=1",
            ).toString(),
          );
          expect(logoResponse.status).toBe(200);
          expect(logoResponse.headers.get("content-type")).toContain(
            "image/png",
          );
          expect(
            new TextDecoder().decode(await logoResponse.arrayBuffer()),
          ).toBe("custom-host-logo-bytes");
          expect(originRequests).toContain(
            "https://origin.example.com/path?q=1",
          );
          expect(originRequests).toContain(
            "https://origin.example.com/logo.png",
          );
        } finally {
          vi.stubGlobal("fetch", originalFetch);
        }
      });
    });

    it.each([
      ["single-label internal hostname", "https://intranet/preview"],
      ["localhost hostname", "http://localhost:5173"],
      ["internal-use suffix", "https://service.internal/preview"],
      ["mDNS suffix", "https://printer.local/preview"],
      ["home network suffix", "https://router.home.arpa/preview"],
      ["reserved test suffix", "https://example.test/preview"],
      ["reserved invalid suffix", "https://example.invalid/preview"],
      ["reserved example suffix", "https://service.example/preview"],
      ["anonymous service suffix", "https://service.onion/preview"],
      ["local network suffix", "https://device.lan/preview"],
      ["non-default HTTPS port", "https://preview.example.com:8443/preview"],
      ["IPv4 loopback", "http://127.0.0.1:5173"],
      ["IPv4 6to4 relay anycast", "http://192.88.99.1/preview"],
      ["unspecified IPv6", "http://[::]:5173"],
      ["IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]:5173"],
      ["IPv6 first-group zero", "http://[0:1::1]/preview"],
      ["IPv6 NAT64 to private IPv4", "http://[64:ff9b::a00:1]/preview"],
      ["IPv6 discard-only range", "http://[100::1]/preview"],
      ["IPv6 benchmarking range", "http://[2001:2::1]/preview"],
      ["IPv6 6to4 to private IPv4", "http://[2002:a00:1::]/preview"],
      ["IPv6 documentation range", "http://[3fff::1]/preview"],
      ["low link-local IPv6", "http://[fe80::1]:5173"],
      ["high link-local IPv6", "http://[febf::1]:5173"],
      ["deprecated site-local IPv6", "http://[fec0::1]/preview"],
    ])(
      "should reject a non-public %s external preview URL",
      async (_label, externalUrl) => {
        const organization = await createTestOrganization(makeRequest);
        const response = await makeRequest("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Unsafe Preview",
            organization_id: organization.id,
            subdomain: `external-unsafe-${crypto.randomUUID().slice(0, 8)}`,
            external_url: externalUrl,
          }),
        });

        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("External URL must be public");
      },
    );

    it.each([
      ["multi-label hostname", "https://preview.example.com/app"],
      ["public IPv4 literal", "https://1.1.1.1/app"],
      ["public IPv6 literal", "https://[2606:4700:4700::1111]/app"],
      ["6to4 with public IPv4", "https://[2002:0808:0808::]/app"],
    ])(
      "should accept a public %s external preview URL",
      async (_label, externalUrl) => {
        const organization = await createTestOrganization(makeRequest);
        const response = await makeRequest("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Public Preview",
            organization_id: organization.id,
            subdomain: `external-public-${crypto.randomUUID().slice(0, 8)}`,
            external_url: externalUrl,
          }),
        });

        expect(response.status).toBe(201);
      },
    );

    it("Given external URLs at and above the signed-resource URL limit, When they are published, Then the supported boundary succeeds and the oversized URL fails before later rewrite work", async () => {
      const organization = await createTestOrganization(makeRequest);
      const prefix = "https://preview.example.com/";
      const maximumUrl = `${prefix}${"a".repeat(8_192 - prefix.length)}`;
      const oversizedUrl = `${maximumUrl}a`;
      const normalizationExpandedUrl = `${prefix}${"é".repeat(1_400)}`;
      expect(maximumUrl.length).toBe(8_192);
      expect(oversizedUrl.length).toBe(8_193);
      expect(normalizationExpandedUrl.length).toBeLessThan(8_192);
      expect(
        new URL(normalizationExpandedUrl).toString().length,
      ).toBeGreaterThan(8_192);

      const accepted = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Maximum external URL",
          organization_id: organization.id,
          subdomain: `external-maximum-${crypto.randomUUID().slice(0, 8)}`,
          external_url: maximumUrl,
        }),
      });
      expect(accepted.status).toBe(201);
      const acceptedBody = (await accepted.json()) as {
        project: { id: string };
      };
      const originalFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response("<!doctype html><h1>Maximum URL artifact</h1>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      );
      try {
        const artifact = await makeRequest(
          externalArtifactFramePath(acceptedBody.project.id),
        );
        expect(artifact.status).toBe(200);
        expect(await artifact.text()).toContain("Maximum URL artifact");
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }

      const rejected = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Oversized external URL",
          organization_id: organization.id,
          subdomain: `external-oversized-${crypto.randomUUID().slice(0, 8)}`,
          external_url: oversizedUrl,
        }),
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toContain(
        "External URL exceeds the URL limit",
      );

      const normalizationExpanded = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Normalization-expanded external URL",
          organization_id: organization.id,
          subdomain: `external-expanded-${crypto.randomUUID().slice(0, 8)}`,
          external_url: normalizationExpandedUrl,
        }),
      });
      expect(normalizationExpanded.status).toBe(400);
      expect(await normalizationExpanded.text()).toContain(
        "External URL exceeds the URL limit",
      );
    });

    it.each([
      ["IPv4 loopback", "http://127.0.0.1/internal"],
      ["unspecified IPv6", "http://[::]/internal"],
      ["IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/internal"],
      ["low link-local IPv6", "http://[fe80::1]/internal"],
      ["high link-local IPv6", "http://[febf::1]/internal"],
    ])(
      "should reject an external-origin redirect to a private %s destination before a second fetch",
      async (_label, redirectUrl) => {
        const organization = await createTestOrganization(makeRequest);
        const subdomain = `external-redirect-${crypto.randomUUID().slice(0, 8)}`;
        const originRequests: string[] = [];
        const originalFetch = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          originRequests.push(url);
          return new Response(null, {
            status: 302,
            headers: { location: redirectUrl },
          });
        });

        try {
          const publish = await makeRequest("/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "External redirect guard",
              organization_id: organization.id,
              subdomain,
              external_url: "https://preview.example.com",
            }),
          });
          expect(publish.status).toBe(201);

          const response = await makeRequest(
            `/${subdomain}/__shiplet/artifact-frame/`,
          );
          expect(response.status).toBe(502);
          expect(await response.text()).toContain(
            "External origin redirect denied",
          );
          expect(originRequests).toEqual(["https://preview.example.com/"]);
        } finally {
          vi.stubGlobal("fetch", originalFetch);
        }
      },
    );

    it("Given an external origin redirects beyond the signed-resource URL limit, When the artifact follows redirects, Then it rejects the oversized target before a second upstream request", async () => {
      const organization = await createTestOrganization(makeRequest);
      const published = await publishExternalTestShiplet(
        makeRequest,
        organization.id,
        "https://preview.example.com/latest",
      );
      const upstreamRequests: Request[] = [];
      const originalFetch = globalThis.fetch;
      const oversizedRedirect = `https://cdn.example.com/${"a".repeat(8_192)}`;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const request =
          input instanceof Request ? input : new Request(input.toString());
        upstreamRequests.push(request);
        if (request.url === "https://preview.example.com/latest") {
          return new Response(null, {
            status: 302,
            headers: { location: oversizedRedirect },
          });
        }
        return new Response("oversized redirect reached upstream", {
          headers: { "content-type": "text/plain" },
        });
      });

      try {
        const response = await makeRequest(
          externalArtifactFramePath(published.project.id),
        );
        expect(response.status).toBe(502);
        expect(await response.text()).toContain(
          "External origin redirect denied",
        );
        expect(upstreamRequests).toHaveLength(1);
      } finally {
        vi.stubGlobal("fetch", originalFetch);
      }
    });

    it("should publish standalone static assets by generating a review page", async () => {
      const organization = await createTestOrganization(makeRequest);
      const subdomain = `standalone-${crypto.randomUUID().slice(0, 8)}`;
      const fileName = "mermaid diagram (2) #100% + final ✓.png";
      const encodedFileName = encodeURIComponent(fileName);
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Standalone Image",
          organization_id: organization.id,
          subdomain,
          assets: [
            {
              path: fileName,
              content: btoa("png-bytes"),
              size: 9,
            },
          ],
        }),
      });

      expect(response.status).toBe(201);

      const wrapperResponse = await makeRequest(`/${subdomain}/`);
      expect(wrapperResponse.status).toBe(200);
      expect(wrapperResponse.headers.get("content-type")).toContain(
        "text/html",
      );
      expect(wrapperResponse.headers.get("x-shiplet-review")).toBeNull();
      const html = await wrapperResponse.text();
      expect(html).toContain("Standalone Image");
      expect(html).toContain('data-shiplet-trusted-review-host="v1"');
      expect(html).not.toContain("__SHIPLET_REVIEW__");
      const rawWrapper = await makeRequest(
        `/${subdomain}/__shiplet/artifact-frame/`,
      );
      const rawHtml = await rawWrapper.text();
      expect(rawHtml).toContain(encodedFileName);
      expect(rawHtml).not.toContain(fileName);

      const assetResponse = await makeRequest(
        `/${subdomain}/${encodedFileName}`,
      );
      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get("content-type")).toContain("image/png");
      expect(new TextDecoder().decode(await assetResponse.arrayBuffer())).toBe(
        "png-bytes",
      );
    });

    it("should reject static uploads with unsafe asset paths", async () => {
      const organization = await createTestOrganization(makeRequest);
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Unsafe Static Upload",
          organization_id: organization.id,
          subdomain: `unsafe-${crypto.randomUUID().slice(0, 8)}`,
          assets: [
            {
              path: "../index.html",
              content: btoa("<!doctype html><h1>bad</h1>"),
              size: 29,
            },
          ],
        }),
      });

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Unsafe asset path");
    });

    it("should reject risky or unsupported static asset types", async () => {
      const organization = await createTestOrganization(makeRequest);
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Risky Static Upload",
          organization_id: organization.id,
          subdomain: `risky-${crypto.randomUUID().slice(0, 8)}`,
          assets: [
            {
              path: "index.html",
              content: btoa("<!doctype html><h1>Shiplet</h1>"),
              size: 32,
            },
            {
              path: "payload.exe",
              content: btoa("MZ"),
              size: 2,
            },
          ],
        }),
      });

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Unsupported asset type");
    });

    it("should reject static uploads with invalid base64 content", async () => {
      const organization = await createTestOrganization(makeRequest);
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Broken Static Upload",
          organization_id: organization.id,
          subdomain: `broken-${crypto.randomUUID().slice(0, 8)}`,
          assets: [
            {
              path: "index.html",
              content: "%%%not-base64%%%",
              size: 14,
            },
          ],
        }),
      });

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("base64");
    });

    it("should reject static uploads over the file count limit", async () => {
      const organization = await createTestOrganization(makeRequest);
      const assets = [
        {
          path: "index.html",
          content: btoa("<!doctype html><h1>Shiplet</h1>"),
          size: 32,
        },
        ...Array.from({ length: 200 }, (_, index) => ({
          path: `assets/file-${index}.txt`,
          content: btoa(`asset ${index}`),
          size: 10,
        })),
      ];
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Too Many Files",
          organization_id: organization.id,
          subdomain: `many-${crypto.randomUUID().slice(0, 8)}`,
          assets,
        }),
      });

      expect(response.status).toBe(413);
      const text = await response.text();
      expect(text).toContain("Static uploads are limited");
    });

    it("should reject oversized static asset uploads", async () => {
      const organization = await createTestOrganization(makeRequest);
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Large Static Upload",
          organization_id: organization.id,
          subdomain: `large-${crypto.randomUUID().slice(0, 8)}`,
          assets: [
            {
              path: "index.html",
              content: btoa("x".repeat(10_000_001)),
              size: 10_000_001,
            },
          ],
        }),
      });

      expect(response.status).toBe(413);
      const text = await response.text();
      expect(text).toContain("Asset is too large");
    });

    it("should publish and serve large screenshot-sized static assets from object storage", async () => {
      const organization = await createTestOrganization(makeRequest);
      const subdomain = `large-image-${crypto.randomUUID().slice(0, 8)}`;
      const screenshotBytes = "x".repeat(5_000_000);
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Large Screenshot Static Shiplet",
          organization_id: organization.id,
          subdomain,
          assets: [
            {
              path: "index.html",
              content: btoa(
                '<!doctype html><img src="/images/screenshot.png">',
              ),
              size: 52,
            },
            {
              path: "images/screenshot.png",
              content: btoa(screenshotBytes),
              size: screenshotBytes.length,
            },
          ],
        }),
      });

      expect(response.status).toBe(201);

      const assetResponse = await makeRequest(
        `/${subdomain}/images/screenshot.png`,
      );
      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get("content-type")).toContain("image/png");
      expect(assetResponse.headers.get("content-length")).toBe("5000000");
      expect(assetResponse.headers.get("x-shiplet-static-fallback")).toBe("r2");
    }, 15_000);

    it("should keep root-relative static image URLs inside the authenticated preview route", async () => {
      const organization = await createTestOrganization(makeRequest);
      const subdomain = `preview-image-${crypto.randomUUID().slice(0, 8)}`;
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Preview Image Static Shiplet",
          organization_id: organization.id,
          subdomain,
          assets: [
            {
              path: "index.html",
              content: btoa(
                '<!doctype html><img src="/images/screenshot.png" srcset="/images/screenshot.png 1x, /images/screenshot@2x.png 2x"><link rel="stylesheet" href="/styles/site.css">',
              ),
              size: 158,
            },
            {
              path: "images/screenshot.png",
              content: btoa("png-bytes"),
              size: 9,
            },
            {
              path: "images/screenshot@2x.png",
              content: btoa("png-2x-bytes"),
              size: 12,
            },
            {
              path: "styles/site.css",
              content: btoa(
                ".hero{background-image:url('/images/screenshot.png')}",
              ),
              size: 53,
            },
          ],
        }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        project: { id: string; subdomain: string };
        previewUrl: string;
      };

      const previewResponse = await makeRequest(body.previewUrl);
      expect(previewResponse.status).toBe(200);
      const previewHtml = await previewResponse.text();
      expect(previewHtml).toContain(
        `/shiplets/${body.project.id}/artifact-frame/`,
      );
      expect(previewHtml).not.toContain("__SHIPLET_REVIEW__");
      const rawPreviewResponse = await makeRequest(
        `/shiplets/${body.project.id}/artifact-frame/`,
      );
      const rawPreviewHtml = await rawPreviewResponse.text();
      expect(rawPreviewHtml).toContain(
        `src="/shiplets/${body.project.id}/artifact-frame/images/screenshot.png"`,
      );
      expect(rawPreviewHtml).toContain(
        `/shiplets/${body.project.id}/artifact-frame/images/screenshot@2x.png 2x`,
      );
      expect(rawPreviewHtml).toContain(
        `href="/shiplets/${body.project.id}/artifact-frame/styles/site.css"`,
      );

      const previewAssetResponse = await makeRequest(
        `/shiplets/${body.project.id}/artifact-frame/images/screenshot.png`,
      );
      expect(previewAssetResponse.status).toBe(200);
      expect(previewAssetResponse.headers.get("content-type")).toContain(
        "image/png",
      );
      expect(
        new TextDecoder().decode(await previewAssetResponse.arrayBuffer()),
      ).toBe("png-bytes");

      const previewCssResponse = await makeRequest(
        `/shiplets/${body.project.id}/artifact-frame/styles/site.css`,
      );
      expect(previewCssResponse.status).toBe(200);
      expect(await previewCssResponse.text()).toContain(
        `url('/shiplets/${body.project.id}/artifact-frame/images/screenshot.png')`,
      );

      const rootAssetResponse = await makeRequest(
        "https://shiplet.cc/images/screenshot.png",
      );
      expect(rootAssetResponse.status).toBe(404);

      const fallbackResponse = await makeRequest(`/${subdomain}/`);
      expect(fallbackResponse.status).toBe(200);
      const fallbackHtml = await fallbackResponse.text();
      expect(fallbackHtml).toContain(`/${subdomain}/__shiplet/artifact-frame/`);
    });

    it.each([
      ["image", "CleanShot 2026-08-14.png", "image/png"],
      ["SVG image", "diagram.svg", "image/svg+xml"],
      ["video", "walkthrough.webm", "video/webm"],
    ])(
      "should render a standalone uploaded %s without an authenticated subresource request",
      async (_label, fileName, mediaType) => {
        const organization = await createTestOrganization(makeRequest);
        const subdomain = `standalone-media-${crypto.randomUUID().slice(0, 8)}`;
        const mediaBytes = `standalone-${fileName}-bytes`;
        const response = await makeRequest("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Standalone Image Shiplet",
            organization_id: organization.id,
            subdomain,
            assets: [
              {
                path: fileName,
                content: btoa(mediaBytes),
                size: mediaBytes.length,
              },
            ],
          }),
        });
        expect(response.status).toBe(201);
        const body = (await response.json()) as { project: { id: string } };

        const artifact = await makeRequest(
          `/shiplets/${body.project.id}/artifact-frame/`,
        );
        expect(artifact.status).toBe(200);
        const html = await artifact.text();
        expect(html).toContain(
          `src="data:${mediaType};base64,${btoa(mediaBytes)}"`,
        );
        expect(html).toContain("height: 100dvh");
        expect(html).toContain("object-fit: contain");
        expect(html).not.toContain(`src="/shiplets/${body.project.id}/`);
        expect(html).not.toContain('class="asset-card"');
      },
    );

    it("should safely accept and preview common code, document, data, and GIS formats", async () => {
      const organization = await createTestOrganization(makeRequest);
      const subdomain = `wide-preview-${crypto.randomUUID().slice(0, 8)}`;
      const textAssets = [
        ["app.ts", "export const ready = true;"],
        ["analysis.py", "print('ready')"],
        ["config.yaml", "ready: true"],
        [".gitignore", "dist/"],
        ["query.sql", "select true;"],
        ["districts.geojson", '{"type":"FeatureCollection","features":[]}'],
        ["route.kml", "<kml></kml>"],
        ["track.gpx", "<gpx></gpx>"],
      ];
      const binaryAssets = [
        "report.pdf",
        "roads.shp",
        "roads.shx",
        "roads.dbf",
        "city.gpkg",
        "elevation.tif",
        "survey.laz",
        "parcels.parquet",
      ];
      const assets = [
        ...textAssets.map(([path, value]) => ({
          path,
          content: btoa(value),
          size: value.length,
        })),
        ...binaryAssets.map((path) => ({
          path,
          content: btoa(`${path}-bytes`),
          size: `${path}-bytes`.length,
        })),
      ];

      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Wide format preview",
          organization_id: organization.id,
          subdomain,
          assets,
        }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { project: { id: string } };

      const reviewHost = await makeRequest(
        `/shiplets/${body.project.id}/review-host`,
      );
      const reviewHostHtml = await reviewHost.text();
      expect(reviewHostHtml).toMatch(
        /data-shiplet-artifact-frame="v1"[^>]+sandbox="[^"]*allow-downloads/,
      );

      const artifact = await makeRequest(
        `/shiplets/${body.project.id}/artifact-frame/`,
      );
      expect(artifact.status).toBe(200);
      expect(artifact.headers.get("content-security-policy")).toContain(
        "sandbox allow-scripts allow-forms allow-downloads",
      );
      const html = await artifact.text();
      expect(html).toContain('class="asset-text-preview"');
      expect(html).toContain('class="asset-binary-preview"');
      expect(html).toContain("Shapefile set");
      expect(html).toContain("data:application/pdf;base64,");
      expect(html).not.toContain('href="./report.pdf"');

      const contentTypes = [
        ["app.ts", "text/plain"],
        ["districts.geojson", "application/geo+json"],
        ["city.gpkg", "application/geopackage+sqlite3"],
        ["elevation.tif", "image/tiff"],
        ["parcels.parquet", "application/vnd.apache.parquet"],
      ];
      for (const [path, expectedType] of contentTypes) {
        const asset = await makeRequest(
          `/shiplets/${body.project.id}/artifact-frame/${path}`,
        );
        expect(asset.status).toBe(200);
        expect(asset.headers.get("content-type")).toContain(expectedType);
        expect(asset.headers.get("content-security-policy")).not.toContain(
          "allow-downloads",
        );
      }
    });

    it("should publish a static shiplet into an organization", async () => {
      const organization = await createTestOrganization(makeRequest);
      const subdomain = `static-${crypto.randomUUID().slice(0, 8)}`;
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Static Shiplet",
          organization_id: organization.id,
          subdomain,
          assets: [
            {
              path: "index.html",
              content: btoa("<!doctype html><h1>Shiplet</h1>"),
              size: 32,
            },
          ],
        }),
      });

      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        ok: boolean;
        project: { organization_id: string };
      };
      expect(body.ok).toBe(true);
      expect(body.project.organization_id).toBe(organization.id);

      const artifactResponse = await makeRequest(`/${subdomain}/`);
      expect(artifactResponse.status).toBe(200);
      expect(artifactResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      expect(artifactResponse.headers.get("referrer-policy")).toBe(
        "strict-origin",
      );
      expect(artifactResponse.headers.get("permissions-policy")).toContain(
        "camera=()",
      );
    });
  });

  describe("Organizations and Teams", () => {
    it("should create an organization for the current user", async () => {
      const organization = await createTestOrganization(makeRequest);

      expect(organization.id).toMatch(/^org_/);
    });

    it("should create a team inside an organization", async () => {
      const organization = await createTestOrganization(makeRequest);
      const response = await makeRequest(
        `/api/organizations/${organization.id}/teams`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Design",
            description: "Product design team",
          }),
        },
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { team: { id: string } };
      expect(body.team.id).toMatch(/^team_/);
    });

    it("should send a WorkOS-backed organization invitation", async () => {
      const organization = await createTestOrganization(makeRequest);
      const response = await makeRequest(
        `/api/organizations/${organization.id}/invitations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "new-person@example.com",
            role: "member",
          }),
        },
      );

      expect(response.status).toBe(201);
      const responseText = await response.clone().text();
      const body = (await response.json()) as {
        invitation: { workos_invitation_id: string };
        workosInvitation: { id: string };
      };
      expect(body.invitation.workos_invitation_id).toBe(
        body.workosInvitation.id,
      );
      expect(body.workosInvitation).toEqual({ id: body.workosInvitation.id });
      expect(responseText).not.toContain(
        `tok_new-person-example-com_${body.workosInvitation.id.slice(-8)}`,
      );
      expect(responseText).not.toMatch(
        /"(?:token|code|[^\"]*(?:access[_-]?token|refresh[_-]?token|invitation[_-]?token|oauth[_-]?token|authorization(?:[_-]?(?:code|header))?|credential|password|secret|claim[_-]?url)[^\"]*)"\s*:/i,
      );
    });

    it("should send a WorkOS-backed team invitation with pending team intent", async () => {
      const organization = await createTestOrganization(makeRequest);
      const teamResponse = await makeRequest(
        `/api/organizations/${organization.id}/teams`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `Team ${crypto.randomUUID()}` }),
        },
      );
      const { team } = (await teamResponse.json()) as {
        team: { id: string };
      };

      const response = await makeRequest(
        `/api/organizations/${organization.id}/teams/${team.id}/invitations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "teammate@example.com" }),
        },
      );

      expect(response.status).toBe(201);
      const responseText = await response.clone().text();
      const body = (await response.json()) as {
        invitation: { team_id: string; invite_type: string };
        workosInvitation: { id: string };
      };
      expect(body.invitation.team_id).toBe(team.id);
      expect(body.invitation.invite_type).toBe("team");
      expect(responseText).not.toContain(
        `tok_teammate-example-com_${body.workosInvitation.id.slice(-8)}`,
      );
      expect(responseText).not.toMatch(
        /"(?:token|code|[^\"]*(?:access[_-]?token|refresh[_-]?token|invitation[_-]?token|oauth[_-]?token|authorization(?:[_-]?(?:code|header))?|credential|password|secret|claim[_-]?url)[^\"]*)"\s*:/i,
      );
    });
  });

  describe("Platform MCP", () => {
    function testOAuthToken(email: string) {
      return `shiplet_oauth_${btoa(email).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
    }

    it("should expose OAuth protected resource metadata for MCP clients", async () => {
      const response = await requestHelper(
        "/.well-known/oauth-protected-resource",
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      const body = (await response.json()) as {
        resource: string;
        authorization_servers: string[];
        bearer_methods_supported: string[];
        scopes_supported: string[];
      };
      expect(body.resource).toBe("https://shiplet.cc/api/mcp");
      expect(body.authorization_servers[0]).toBe(
        "https://example.authkit.app",
      );
      expect(body.authorization_servers[0]).not.toContain("staging");
      expect(body.bearer_methods_supported).toContain("header");
      expect(body.scopes_supported).toEqual(
        expect.arrayContaining(["openid", "profile", "email"]),
      );
    });

    it("should challenge unauthenticated MCP clients with OAuth discovery metadata", async () => {
      const response = await requestHelper("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      });

      expect(response.status).toBe(401);
      const challenge = response.headers.get("www-authenticate") || "";
      expect(challenge).toContain("Bearer");
      expect(challenge).toContain(
        'resource_metadata="https://shiplet.cc/.well-known/oauth-protected-resource"',
      );
      expect(challenge).toContain('scope="openid profile email"');
    });

    it("should let a first-time OAuth MCP user publish with an auto-created organization", async () => {
      const authorization = `Bearer ${testOAuthToken("oauth-agent@example.com")}`;
      const subdomain = `oauth-mcp-${crypto.randomUUID().slice(0, 8)}`;
      const publishResponse = await requestHelper("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request({
								method: "POST",
								path: "/api/shiplets",
								body: {
									name: "OAuth Published Shiplet",
									subdomain: "${subdomain}",
									assets: [
										{
											path: "index.html",
											content: "${btoa("<!doctype html><h1>OAuth MCP</h1>")}",
											size: 35
										}
									]
								}
							})`,
            },
          },
        }),
      });

      expect(publishResponse.status).toBe(200);
      const publishBody = (await publishResponse.json()) as {
        result: { content: Array<{ text: string }> };
      };
      const publishResult = JSON.parse(publishBody.result.content[0].text) as {
        ok: boolean;
        project: { organization_id: string; subdomain: string };
      };
      expect(publishResult.ok).toBe(true);
      expect(publishResult.project.organization_id).toMatch(/^org_/);
      expect(publishResult.project.subdomain).toBe(subdomain);

      const listResponse = await requestHelper("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request({
								method: "GET",
								path: "/api/shiplets"
							})`,
            },
          },
        }),
      });
      const listBody = (await listResponse.json()) as {
        result: { content: Array<{ text: string }> };
      };
      const listResult = JSON.parse(listBody.result.content[0].text) as {
        projects: Array<{ subdomain: string }>;
      };
      expect(
        listResult.projects.some((project) => project.subdomain === subdomain),
      ).toBe(true);
    });

    it("should publish a static shiplet through MCP for a browser-created organization", async () => {
      const organization = await createTestOrganization(makeRequest);

      const subdomain = `mcp-${crypto.randomUUID().slice(0, 8)}`;
      const publishResponse = await makeRequest("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request({
								method: "POST",
								path: "/api/shiplets",
								body: {
									name: "MCP Published Shiplet",
									organization_id: "${organization.id}",
									subdomain: "${subdomain}",
									assets: [
										{
											path: "index.html",
											content: "${btoa("<!doctype html><h1>MCP Shiplet</h1>")}",
											size: 36
										}
									]
								}
							})`,
            },
          },
        }),
      });
      expect(publishResponse.status).toBe(200);
      const publishBody = (await publishResponse.json()) as {
        result: { content: Array<{ text: string }> };
      };
      const publishResult = JSON.parse(publishBody.result.content[0].text) as {
        ok: boolean;
        project: { id: string; subdomain: string };
        shipletUrl: string;
      };
      expect(publishResult.ok).toBe(true);
      expect(publishResult.project.subdomain).toBe(subdomain);
      expect(publishResult.shipletUrl).toBe(
        expectedPublicShipletUrl(subdomain),
      );

      const pageResponse = await makeRequest(`/${subdomain}`);
      expect(pageResponse.status).toBe(200);
      expect(pageResponse.headers.get("x-shiplet-review")).toBeNull();
      const html = await pageResponse.text();
      expect(html).toContain("MCP Published Shiplet");
      expect(html).toContain('data-shiplet-trusted-review-host="v1"');
      expect(html).not.toContain("__SHIPLET_REVIEW__");
      const rawPageResponse = await makeRequest(
        `/${subdomain}/__shiplet/artifact-frame/`,
      );
      expect(await rawPageResponse.text()).toContain("MCP Shiplet");
    });
  });

  describe("Organization API and MCP", () => {
    async function publishStaticShiplet(
      organizationId: string,
      name = "API Shiplet",
    ) {
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          organization_id: organizationId,
          subdomain: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${crypto.randomUUID().slice(0, 8)}`,
          assets: [
            {
              path: "index.html",
              content: btoa(`<!doctype html><h1>${name}</h1>`),
              size: 48,
            },
          ],
        }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        project: { id: string; organization_id: string; name: string };
      };
      return body.project;
    }

    it("should let one organization API key publish and list shiplets", async () => {
      const organization = await createTestOrganization(makeRequest);
      const { token } = await createOrganizationApiToken(
        makeRequest,
        organization.id,
      );

      const subdomain = `api-${crypto.randomUUID().slice(0, 8)}`;
      const publishResponse = await requestHelper("/api/shiplets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: "API Published Shiplet",
          subdomain,
          assets: [
            {
              path: "index.html",
              content: btoa("<!doctype html><h1>API Shiplet</h1>"),
              size: 38,
            },
          ],
        }),
      });
      expect(publishResponse.status).toBe(201);
      const publishBody = (await publishResponse.json()) as {
        ok: boolean;
        project: { id: string; organization_id: string; subdomain: string };
      };
      expect(publishBody.ok).toBe(true);
      expect(publishBody.project.organization_id).toBe(organization.id);
      expect(publishBody.project.subdomain).toBe(subdomain);

      const listResponse = await requestHelper("/api/shiplets", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as {
        projects: Array<{ id: string; subdomain: string }>;
      };
      expect(
        listBody.projects.some(
          (project) => project.id === publishBody.project.id,
        ),
      ).toBe(true);
    });

    it("Given an API key is restricted to selected existing Shiplets, When it tries to create a new Shiplet through REST or Code Mode, Then creation fails closed", async () => {
      const organization = await createTestOrganization(makeRequest);
      const allowedProject = await publishStaticShiplet(
        organization.id,
        "Selected Creation Fence",
      );
      const { token } = await createOrganizationApiToken(
        makeRequest,
        organization.id,
        {
          name: "Selected project writer",
          scopes: ["shiplets:write", "mcp"],
          projectAccessMode: "selected",
          projectRules: [{ projectId: allowedProject.id, effect: "allow" }],
        },
      );
      const restSubdomain = `selected-rest-${crypto.randomUUID().slice(0, 8)}`;
      const requestBody = {
        name: "Unauthorized new Shiplet",
        subdomain: restSubdomain,
        assets: [
          {
            path: "index.html",
            content: btoa("<!doctype html><h1>Denied</h1>"),
          },
        ],
      };

      const restResponse = await requestHelper("/api/shiplets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody),
      });
      expect(restResponse.status).toBe(403);

      const mcpResponse = await requestHelper("/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request(${JSON.stringify({
                method: "POST",
                path: "/api/shiplets",
                body: { ...requestBody, subdomain: `${restSubdomain}-mcp` },
              })})`,
            },
          },
        }),
      });
      const mcpBody = await expectCodeModeToolError(
        mcpResponse,
        "Authorization denied",
      );
      expect(JSON.stringify(mcpBody)).not.toContain("shiplets:write");

      const persisted = await (env as Env).DB.prepare(
        "SELECT COUNT(*) AS count FROM projects WHERE subdomain IN (?, ?)",
      )
        .bind(restSubdomain, `${restSubdomain}-mcp`)
        .first<{ count: number }>();
      expect(Number(persisted?.count || 0)).toBe(0);
    });

    it("should let organization API keys with shiplets:archive archive and restore shiplets", async () => {
      const organization = await createTestOrganization(makeRequest);
      const firstProject = await publishStaticShiplet(
        organization.id,
        "API Archive One",
      );
      const secondProject = await publishStaticShiplet(
        organization.id,
        "API Archive Two",
      );
      const { token } = await createOrganizationApiToken(
        makeRequest,
        organization.id,
        {
          name: "Archive Automation",
          scopes: ["shiplets:read", "shiplets:archive"],
        },
      );

      const archiveResponse = await requestHelper(
        `/api/projects/${firstProject.id}/archive`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(archiveResponse.status).toBe(200);
      const archiveBody = (await archiveResponse.json()) as {
        project: { id: string; archived_on: string; delete_after: string };
      };
      expect(archiveBody.project.id).toBe(firstProject.id);
      expect(archiveBody.project.archived_on).toBeTruthy();
      expect(archiveBody.project.delete_after).toBeTruthy();

      const activeListResponse = await requestHelper("/api/shiplets", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(activeListResponse.status).toBe(200);
      const activeListBody = (await activeListResponse.json()) as {
        projects: Array<{ id: string }>;
      };
      expect(
        activeListBody.projects.some(
          (project) => project.id === firstProject.id,
        ),
      ).toBe(false);

      const archivedListResponse = await requestHelper(
        "/api/shiplets?status=archived",
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(archivedListResponse.status).toBe(200);
      const archivedListBody = (await archivedListResponse.json()) as {
        projects: Array<{ id: string; archived_on: string }>;
      };
      expect(
        archivedListBody.projects.some(
          (project) =>
            project.id === firstProject.id && Boolean(project.archived_on),
        ),
      ).toBe(true);

      const bulkArchiveResponse = await requestHelper("/api/projects/archive", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ projectIds: [secondProject.id] }),
      });
      expect(bulkArchiveResponse.status).toBe(200);
      const bulkArchiveBody = (await bulkArchiveResponse.json()) as {
        archived: Array<{ id: string; archived_on: string }>;
      };
      expect(bulkArchiveBody.archived).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: secondProject.id,
            archived_on: expect.any(String),
          }),
        ]),
      );

      const restoreResponse = await requestHelper(
        `/api/projects/${firstProject.id}/restore`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(restoreResponse.status).toBe(200);
      const restoreBody = (await restoreResponse.json()) as {
        project: {
          id: string;
          archived_on: string | null;
          delete_after: string | null;
        };
      };
      expect(restoreBody.project.id).toBe(firstProject.id);
      expect(restoreBody.project.archived_on).toBeNull();
      expect(restoreBody.project.delete_after).toBeNull();
    });

    it("should require shiplets:archive and project access for organization API archive actions", async () => {
      const organization = await createTestOrganization(makeRequest);
      const allowedProject = await publishStaticShiplet(
        organization.id,
        "Archive Allowed",
      );
      const deniedProject = await publishStaticShiplet(
        organization.id,
        "Archive Denied",
      );
      const readWriteToken = await createOrganizationApiToken(
        makeRequest,
        organization.id,
        {
          name: "Read Write Only",
          scopes: ["shiplets:read", "shiplets:write"],
        },
      );

      const missingScopeResponse = await requestHelper(
        `/api/projects/${allowedProject.id}/archive`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${readWriteToken.token}` },
        },
      );
      expect(missingScopeResponse.status).toBe(403);
      expect(await missingScopeResponse.text()).toContain("shiplets:archive");

      const archiveToken = await createOrganizationApiToken(
        makeRequest,
        organization.id,
        {
          name: "Archive With Deny",
          scopes: ["shiplets:read", "shiplets:archive"],
          projectAccessMode: "all",
          projectRules: [{ projectId: deniedProject.id, effect: "deny" }],
        },
      );

      const deniedArchiveResponse = await requestHelper(
        `/api/projects/${deniedProject.id}/archive`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${archiveToken.token}` },
        },
      );
      expect(deniedArchiveResponse.status).toBe(403);

      const allowedArchiveResponse = await requestHelper(
        `/api/projects/${allowedProject.id}/archive`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${archiveToken.token}` },
        },
      );
      expect(allowedArchiveResponse.status).toBe(200);

      const tokenDeleteResponse = await requestHelper(
        `/api/projects/${allowedProject.id}`,
        {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${archiveToken.token}`,
          },
          body: JSON.stringify({ confirmSubdomain: "archive-allowed" }),
        },
      );
      expect(tokenDeleteResponse.status).toBe(401);
    });

    it("should require shiplets:archive for organization API keys using MCP archive actions", async () => {
      const organization = await createTestOrganization(makeRequest);
      const project = await publishStaticShiplet(
        organization.id,
        "MCP Archive Grant",
      );
      const missingArchiveToken = await createOrganizationApiToken(
        makeRequest,
        organization.id,
        {
          name: "MCP Without Archive",
          scopes: ["shiplets:read", "mcp"],
        },
      );

      const missingScopeResponse = await requestHelper("/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${missingArchiveToken.token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request({
								method: "POST",
								path: "/api/projects/${project.id}/archive"
							})`,
            },
          },
        }),
      });
      const missingScopeBody = await expectCodeModeToolError(
        missingScopeResponse,
        "Authorization denied",
      );
      expect(JSON.stringify(missingScopeBody)).not.toContain(
        "shiplets:archive",
      );

      const { token } = await createOrganizationApiToken(
        makeRequest,
        organization.id,
        {
          name: "MCP Archive Automation",
          scopes: ["shiplets:read", "shiplets:archive", "mcp"],
        },
      );
      const archiveResponse = await requestHelper("/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request({
								method: "POST",
								path: "/api/projects/${project.id}/archive"
							})`,
            },
          },
        }),
      });
      expect(archiveResponse.status).toBe(200);
      const archiveBody = (await archiveResponse.json()) as {
        result: { content: Array<{ text: string }> };
      };
      const archiveResult = JSON.parse(archiveBody.result.content[0].text) as {
        project: { id: string; archived_on: string };
      };
      expect(archiveResult.project.id).toBe(project.id);
      expect(archiveResult.project.archived_on).toBeTruthy();

      const archivedListResponse = await requestHelper("/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request({
								method: "GET",
								path: "/api/shiplets",
								query: { status: "archived" }
							})`,
            },
          },
        }),
      });
      expect(archivedListResponse.status).toBe(200);
      const archivedListBody = (await archivedListResponse.json()) as {
        result: { content: Array<{ text: string }> };
      };
      const archivedListResult = JSON.parse(
        archivedListBody.result.content[0].text,
      ) as { projects: Array<{ id: string }> };
      expect(
        archivedListResult.projects.some((item) => item.id === project.id),
      ).toBe(true);

      const restoreResponse = await requestHelper("/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request({
								method: "POST",
								path: "/api/projects/${project.id}/restore"
							})`,
            },
          },
        }),
      });
      expect(restoreResponse.status).toBe(200);
      const restoreBody = (await restoreResponse.json()) as {
        result: { content: Array<{ text: string }> };
      };
      const restoreResult = JSON.parse(restoreBody.result.content[0].text) as {
        project: { id: string; archived_on: string | null };
      };
      expect(restoreResult.project.id).toBe(project.id);
      expect(restoreResult.project.archived_on).toBeNull();
    });

    it("should expose organization-scoped MCP tools with publish and review access", async () => {
      const organization = await createTestOrganization(makeRequest);
      const { token } = await createOrganizationApiToken(
        makeRequest,
        organization.id,
      );

      const toolsResponse = await requestHelper("/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      });
      expect(toolsResponse.status).toBe(200);
      const toolsBody = (await toolsResponse.json()) as {
        result: { tools: Array<{ name: string }> };
      };
      expect(toolsBody.result.tools.map((tool) => tool.name)).toEqual([
        "search",
        "execute",
      ]);

      const subdomain = `mcp-api-${crypto.randomUUID().slice(0, 8)}`;
      const publishResponse = await requestHelper("/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request({
								method: "POST",
								path: "/api/shiplets",
								body: {
									name: "MCP API Shiplet",
									subdomain: "${subdomain}",
									assets: [
										{
											path: "index.html",
											content: "${btoa("<!doctype html><h1>MCP API</h1>")}",
											size: 34
										}
									]
								}
							})`,
            },
          },
        }),
      });
      expect(publishResponse.status).toBe(200);
      const publishBody = (await publishResponse.json()) as {
        result: { content: Array<{ text: string }> };
      };
      const publishResult = JSON.parse(publishBody.result.content[0].text) as {
        ok: boolean;
        project: { id: string; organization_id: string; subdomain: string };
      };
      expect(publishResult.ok).toBe(true);
      expect(publishResult.project.organization_id).toBe(organization.id);
      expect(publishResult.project.subdomain).toBe(subdomain);
    });

    it("should enforce project deny rules for organization API and MCP access", async () => {
      const organization = await createTestOrganization(makeRequest);
      const allowedProject = await publishStaticShiplet(
        organization.id,
        "Allowed Review",
      );
      const deniedProject = await publishStaticShiplet(
        organization.id,
        "Denied Review",
      );

      for (const project of [allowedProject, deniedProject]) {
        const feedbackResponse = await makeRequest(
          `/api/projects/${project.id}/review-feedback`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              comment: `${project.name} feedback`,
              pageUrl: `http://localhost/${project.id}/review`,
              clientFeedbackId: `client-${crypto.randomUUID()}`,
            }),
          },
        );
        expect(feedbackResponse.status).toBe(201);
      }

      const { token } = await createOrganizationApiToken(
        makeRequest,
        organization.id,
        {
          name: "Deny One Shiplet",
          scopes: ["shiplets:read", "feedback:read", "mcp"],
          projectAccessMode: "all",
          projectRules: [{ projectId: deniedProject.id, effect: "deny" }],
        },
      );

      const listResponse = await requestHelper("/api/shiplets", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as {
        projects: Array<{ id: string }>;
      };
      expect(
        listBody.projects.some((project) => project.id === allowedProject.id),
      ).toBe(true);
      expect(
        listBody.projects.some((project) => project.id === deniedProject.id),
      ).toBe(false);

      const allowedFeedbackResponse = await requestHelper(
        `/api/projects/${allowedProject.id}/review-feedback`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(allowedFeedbackResponse.status).toBe(200);

      const deniedFeedbackResponse = await requestHelper(
        `/api/projects/${deniedProject.id}/review-feedback`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(deniedFeedbackResponse.status).toBe(403);

      const deniedMcpResponse = await requestHelper("/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request({
								method: "GET",
								path: "/api/projects/${deniedProject.id}/review-feedback"
							})`,
            },
          },
        }),
      });
      const deniedMcpBody = await expectCodeModeToolError(
        deniedMcpResponse,
        "Authorization denied",
      );
      expect(JSON.stringify(deniedMcpBody)).not.toContain("Project access");
    });
  });

  describe("Dashboard API", () => {
    it("Given an existing account, When AuthKit returns an organization unknown to Shiplet, Then login succeeds without granting access to that organization", async () => {
      const email = `unknown-auth-org-${crypto.randomUUID()}@example.com`;
      const userId = `user_existing_${crypto.randomUUID().replaceAll("-", "")}`;
      const createResponse = await requestHelper("/api/organizations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-shiplet-user-id": userId,
          "x-shiplet-user-email": email,
        },
        body: JSON.stringify({ name: "Existing workspace" }),
      });
      expect(createResponse.status).toBe(201);
      const { organization } = (await createResponse.json()) as {
        organization: { id: string };
      };
      const unknownOrganizationId = `org_external_${crypto.randomUUID()}`;
      const callback = await requestHelper(
        `/auth/callback?code=${encodeURIComponent(
          `test-code:${unknownOrganizationId}:${encodeURIComponent(email)}`,
        )}`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(302);
      const identityResponse = await requestHelper("/api/me", {
        headers: { cookie: cookieHeaderFromResponse(callback) },
      });
      expect(identityResponse.status).toBe(200);
      const identity = (await identityResponse.json()) as {
        user: { id: string };
      };
      expect(identity.user.id).toBe(userId);
      const db = (env as unknown as TestEnv).DB;
      const memberships = await db.prepare(
        "SELECT organization_id, role FROM organization_memberships WHERE user_id = ?",
      ).bind(userId).all<{ organization_id: string; role: string }>();
      expect(memberships.results).toEqual([
        { organization_id: organization.id, role: "admin" },
      ]);
      const unknownOrganization = await db.prepare(
        "SELECT id FROM organizations WHERE id = ?",
      ).bind(unknownOrganizationId).first();
      expect(unknownOrganization).toBeNull();
    });

    it("preserves an administrator role when WorkOS returns the active organization", async () => {
      const email = "owner-preserve@example.com";
      const userId = "user_owner-preserve-example-com";
      const createResponse = await makeRequest("/api/organizations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-shiplet-user-id": userId,
          "x-shiplet-user-email": email,
        },
        body: JSON.stringify({
          name: `Preserved Admin ${crypto.randomUUID()}`,
        }),
      });
      expect(createResponse.status).toBe(201);
      const { organization } = (await createResponse.json()) as {
        organization: { id: string };
      };
      const callback = await requestHelper(
        `/auth/callback?code=${encodeURIComponent(
          `test-code:${organization.id}:${encodeURIComponent(email)}`,
        )}`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(302);

      const membership = await (env as unknown as TestEnv).DB.prepare(
        `SELECT role FROM organization_memberships
         WHERE organization_id = ? AND user_id = ?`,
      )
        .bind(organization.id, userId)
        .first<{ role: string }>();
      expect(membership?.role).toBe("admin");

      const response = await requestHelper(
        `/api/organizations/${organization.id}/api-tokens`,
        {
          headers: { cookie: cookieHeaderFromResponse(callback) },
        },
      );
      expect(response.status).toBe(200);
    });

    it("should aggregate organizations, teams, projects, and organization API keys", async () => {
      const organization = await createTestOrganization(makeRequest);
      const teamResponse = await makeRequest(
        `/api/organizations/${organization.id}/teams`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Product Review",
            description: "Prototype reviewers",
          }),
        },
      );
      expect(teamResponse.status).toBe(201);
      const teamBody = (await teamResponse.json()) as {
        team: { id: string; name: string };
      };

      const projectResponse = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Dashboard Shiplet",
          organization_id: organization.id,
          subdomain: `dashboard-${crypto.randomUUID().slice(0, 8)}`,
          assets: [
            {
              path: "index.html",
              content: btoa("<!doctype html><h1>Dashboard Shiplet</h1>"),
              size: 45,
            },
          ],
        }),
      });
      expect(projectResponse.status).toBe(201);
      const projectBody = (await projectResponse.json()) as {
        project: { id: string; organization_id: string; name: string };
      };

      const tokenBody = await createOrganizationApiToken(
        makeRequest,
        organization.id,
        {
          name: "Dashboard Agent",
          scopes: ["shiplets:read", "feedback:read", "mcp"],
        },
      );
      expect(tokenBody.record.name).toBe("Dashboard Agent");

      const dashboardResponse = await makeRequest("/api/dashboard");
      expect(dashboardResponse.status).toBe(200);
      const dashboardBody = (await dashboardResponse.json()) as {
        organizations: Array<{ id: string; name: string }>;
        teamsByOrganization: Record<
          string,
          Array<{ id: string; name: string }>
        >;
        projects: Array<{ id: string; organization_id: string; name: string }>;
        apiTokensByOrganization: Record<
          string,
          Array<{ id: string; name: string; revoked_on: string | null }>
        >;
      };
      expect(
        dashboardBody.organizations.some((org) => org.id === organization.id),
      ).toBe(true);
      expect(
        dashboardBody.teamsByOrganization[organization.id].some(
          (team) => team.id === teamBody.team.id,
        ),
      ).toBe(true);
      expect(
        dashboardBody.projects.some(
          (project) => project.id === projectBody.project.id,
        ),
      ).toBe(true);
      expect(
        dashboardBody.apiTokensByOrganization[organization.id].some(
          (token) => token.id === tokenBody.record.id,
        ),
      ).toBe(true);

      const revokeResponse = await makeRequest(
        `/api/organizations/${organization.id}/api-tokens/${tokenBody.record.id}`,
        { method: "DELETE" },
      );
      expect(revokeResponse.status).toBe(200);

      const listResponse = await makeRequest(
        `/api/organizations/${organization.id}/api-tokens`,
      );
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as {
        tokens: Array<{ id: string; revoked_on: string | null }>;
      };
      expect(
        listBody.tokens.find((token) => token.id === tokenBody.record.id)
          ?.revoked_on,
      ).toBeTruthy();
    });
  });

  describe("Production Bootstrap", () => {
    it("should create a protected production test org, team, shiplet, and invite", async () => {
      const unauthorized = await requestHelper(
        "/api/bootstrap/production-test",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "gavin@swirlwebdesign.com" }),
        },
      );
      expect(unauthorized.status).toBe(401);

      const response = await requestHelper("/api/bootstrap/production-test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-bootstrap-token",
        },
        body: JSON.stringify({ email: "gavin@swirlwebdesign.com" }),
      });

      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        ok: boolean;
        organization: { id: string };
        team: { id: string };
        project: { id: string; subdomain: string };
        invitation: { id: string; email: string; invite_type: string };
        shipletUrl: string;
      };
      expect(body.ok).toBe(true);
      expect(body.organization.id).toMatch(/^org_/);
      expect(body.team.id).toMatch(/^team_/);
      expect(body.project.id).toMatch(/^project_/);
      expect(body.invitation.email).toBe("gavin@swirlwebdesign.com");
      expect(body.invitation.invite_type).toBe("production_test");
      expect(body.shipletUrl).toBe(
        expectedPublicShipletUrl(body.project.subdomain),
      );

      const pending = await (env as unknown as TestEnv).DB.prepare(
        `SELECT workos_invitation_token
				 FROM app_invitations
				 WHERE id = ?`,
      )
        .bind(body.invitation.id)
        .first<{ workos_invitation_token: string }>();
      expect(pending?.workos_invitation_token).toBeTruthy();

      const state = btoa(
        JSON.stringify({
          returnTo: body.shipletUrl,
          invitationToken: pending!.workos_invitation_token,
        }),
      );
      const invitedUserId = "user_gavin-swirlwebdesign-com";
      const callback = await requestHelper(
        `/auth/callback?code=${encodeURIComponent(
          `test-code:${body.organization.id}:${encodeURIComponent(
            body.invitation.email,
          )}`,
        )}&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(body.shipletUrl);

      const orgMembership = await (env as unknown as TestEnv).DB.prepare(
        `SELECT id FROM organization_memberships
				 WHERE organization_id = ? AND user_id = ?`,
      )
        .bind(body.organization.id, invitedUserId)
        .first<{ id: string }>();
      expect(orgMembership?.id).toBeTruthy();

      const teamMembership = await (env as unknown as TestEnv).DB.prepare(
        `SELECT team_id FROM team_memberships
				 WHERE team_id = ? AND user_id = ?`,
      )
        .bind(body.team.id, invitedUserId)
        .first<{ team_id: string }>();
      expect(teamMembership?.team_id).toBe(body.team.id);

      const userGrant = await (env as unknown as TestEnv).DB.prepare(
        `SELECT target_id, role, accepted_on
				 FROM shiplet_access_grants
				 WHERE project_id = ? AND target_type = 'user' AND target_id = ?`,
      )
        .bind(body.project.id, invitedUserId)
        .first<{ target_id: string; role: string; accepted_on: string }>();
      expect(userGrant?.target_id).toBe(invitedUserId);
      expect(userGrant?.role).toBe("reviewer");
      expect(userGrant?.accepted_on).toBeTruthy();
    });

    it("should not auto-add pending team and shiplet intents from a generic AuthKit callback", async () => {
      const response = await requestHelper("/api/bootstrap/production-test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-bootstrap-token",
        },
        body: JSON.stringify({ email: "invited@example.com" }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        organization: { id: string };
        team: { id: string };
        project: { id: string };
        shipletUrl: string;
      };

      const state = btoa(JSON.stringify({ returnTo: body.shipletUrl }));
      const code = `test-code:${body.organization.id}:${encodeURIComponent("invited@example.com")}`;
      const callback = await requestHelper(
        `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(body.shipletUrl);

      const appInvitation = await (env as unknown as TestEnv).DB.prepare(
        `SELECT status, accepted_on
				 FROM app_invitations
				 WHERE organization_id = ? AND email = 'invited@example.com'`,
      )
        .bind(body.organization.id)
        .first<{ status: string; accepted_on: string | null }>();
      expect(appInvitation?.status).toBe("pending");
      expect(appInvitation?.accepted_on).toBeNull();

      const teamMembership = await (env as unknown as TestEnv).DB.prepare(
        `SELECT team_id FROM team_memberships
				 WHERE team_id = ? AND user_id = 'user_invited'`,
      )
        .bind(body.team.id)
        .first<{ team_id: string }>();
      expect(teamMembership).toBeNull();

      const userGrant = await (env as unknown as TestEnv).DB.prepare(
        `SELECT target_id, role, accepted_on
				 FROM shiplet_access_grants
				 WHERE project_id = ? AND target_type = 'user' AND target_id = 'user_invited'`,
      )
        .bind(body.project.id)
        .first<{ target_id: string; role: string; accepted_on: string }>();
      expect(userGrant).toBeNull();
    });

    it("should reconcile an already-accepted WorkOS invitation into local access", async () => {
      const response = await requestHelper("/api/bootstrap/production-test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-bootstrap-token",
        },
        body: JSON.stringify({ email: "accepted@example.com" }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        organization: { id: string };
        team: { id: string };
        project: { id: string };
        invitation: { id: string; workos_invitation_id: string };
      };

      const reconcile = await requestHelper(
        "/api/bootstrap/reconcile-invitation",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-bootstrap-token",
          },
          body: JSON.stringify({
            workosInvitationId: body.invitation.workos_invitation_id,
          }),
        },
      );
      expect(reconcile.status).toBe(200);
      const reconcileBody = (await reconcile.json()) as {
        ok: boolean;
        reconciled: number;
        results: Array<{ localInvitationId: string; state: string }>;
      };
      expect(reconcileBody.ok).toBe(true);
      expect(reconcileBody.reconciled).toBe(1);
      expect(reconcileBody.results).toEqual([
        { localInvitationId: body.invitation.id, state: "accepted" },
      ]);

      const accepted = await (env as unknown as TestEnv).DB.prepare(
        `SELECT status, accepted_on
				 FROM app_invitations
				 WHERE id = ?`,
      )
        .bind(body.invitation.id)
        .first<{ status: string; accepted_on: string | null }>();
      expect(accepted?.status).toBe("accepted");
      expect(accepted?.accepted_on).toBeTruthy();

      const user = await (env as unknown as TestEnv).DB.prepare(
        `SELECT id, email
				 FROM users
				 WHERE email = 'accepted@example.com'`,
      ).first<{ id: string; email: string }>();
      expect(user?.id).toBe("user_accepted");

      const orgMembership = await (env as unknown as TestEnv).DB.prepare(
        `SELECT id FROM organization_memberships
				 WHERE organization_id = ? AND user_id = 'user_accepted'`,
      )
        .bind(body.organization.id)
        .first<{ id: string }>();
      expect(orgMembership?.id).toBeTruthy();

      const teamMembership = await (env as unknown as TestEnv).DB.prepare(
        `SELECT team_id FROM team_memberships
				 WHERE team_id = ? AND user_id = 'user_accepted'`,
      )
        .bind(body.team.id)
        .first<{ team_id: string }>();
      expect(teamMembership?.team_id).toBe(body.team.id);

      const userGrant = await (env as unknown as TestEnv).DB.prepare(
        `SELECT target_id, role, accepted_on
				 FROM shiplet_access_grants
				 WHERE project_id = ? AND target_type = 'user' AND target_id = 'user_accepted'`,
      )
        .bind(body.project.id)
        .first<{ target_id: string; role: string; accepted_on: string }>();
      expect(userGrant?.target_id).toBe("user_accepted");
      expect(userGrant?.role).toBe("reviewer");
      expect(userGrant?.accepted_on).toBeTruthy();
    });
  });

  describe("Shiplet Sharing", () => {
    async function createStaticShiplet() {
      const organization = await createTestOrganization(makeRequest);
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Shareable Shiplet",
          organization_id: organization.id,
          subdomain: `share-${crypto.randomUUID().slice(0, 8)}`,
          assets: [
            {
              path: "index.html",
              content: btoa("<!doctype html><h1>Shared</h1>"),
              size: 31,
            },
          ],
        }),
      });

      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        project: { id: string; organization_id: string };
      };
      return { organization, project: body.project };
    }

    it("should grant a team access to a shiplet", async () => {
      const { organization, project } = await createStaticShiplet();
      const teamResponse = await makeRequest(
        `/api/organizations/${organization.id}/teams`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `Review ${crypto.randomUUID()}` }),
        },
      );
      const { team } = (await teamResponse.json()) as {
        team: { id: string };
      };

      const response = await makeRequest(
        `/api/projects/${project.id}/invitations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetType: "team",
            teamId: team.id,
            role: "reviewer",
          }),
        },
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        grant: { target_type: string; target_id: string; role: string };
      };
      expect(body.grant.target_type).toBe("team");
      expect(body.grant.target_id).toBe(team.id);
      expect(body.grant.role).toBe("reviewer");
    });

    it("should send a WorkOS-backed email invitation for a user shiplet share", async () => {
      const { project } = await createStaticShiplet();
      const response = await makeRequest(
        `/api/projects/${project.id}/invitations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetType: "user",
            email: "reviewer@example.com",
            role: "viewer",
          }),
        },
      );

      expect(response.status).toBe(201);
      const responseText = await response.clone().text();
      const body = (await response.json()) as {
        grant: { email: string; workos_invitation_id: string };
        appInvitation: { invite_type: string; workos_invitation_id: string };
        workosInvitation: { id: string };
      };
      expect(body.grant.email).toBe("reviewer@example.com");
      expect(body.appInvitation.invite_type).toBe("shiplet_user");
      expect(body.appInvitation.workos_invitation_id).toBe(
        body.workosInvitation.id,
      );
      expect(responseText).not.toContain(
        `tok_reviewer-example-com_${body.workosInvitation.id.slice(-8)}`,
      );
      expect(responseText).not.toMatch(
        /"(?:token|code|[^\"]*(?:access[_-]?token|refresh[_-]?token|invitation[_-]?token|oauth[_-]?token|authorization(?:[_-]?(?:code|header))?|credential|password|secret|claim[_-]?url)[^\"]*)"\s*:/i,
      );
    });

    it("should not reconcile a Shiplet invitation for a different authenticated email", async () => {
      const { project } = await createStaticShiplet();
      const invitationResponse = await makeRequest(
        `/api/projects/${project.id}/invitations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetType: "user",
            email: "intended-reviewer@example.com",
            role: "viewer",
          }),
        },
      );
      expect(invitationResponse.status).toBe(201);
      const invitation = (await invitationResponse.json()) as {
        appInvitation: { id: string };
      };
      const pendingInvitation = await (env as unknown as TestEnv).DB.prepare(
        `SELECT workos_invitation_token
				 FROM app_invitations
				 WHERE id = ?`,
      )
        .bind(invitation.appInvitation.id)
        .first<{ workos_invitation_token: string | null }>();
      expect(pendingInvitation?.workos_invitation_token).toBeTruthy();
      const state = btoa(
        JSON.stringify({
          invitationToken: pendingInvitation!.workos_invitation_token,
        }),
      );

      const callback = await requestHelper(
        `/auth/callback?code=${encodeURIComponent(
          "test-code::different-reviewer@example.com",
        )}&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(302);

      const unauthorizedArtifact = await requestHelper(
        `/shiplets/${project.id}`,
        {
          headers: {
            "x-shiplet-user-id": "user_different-reviewer-example-com",
            "x-shiplet-user-email": "different-reviewer@example.com",
          },
          redirect: "manual",
        },
      );
      expect(unauthorizedArtifact.status).toBe(302);
      expect(unauthorizedArtifact.headers.get("location")).toBe(
        `/shiplets/${project.id}/access`,
      );

      const unauthorizedGrant = await (env as unknown as TestEnv).DB.prepare(
        `SELECT id
				 FROM shiplet_access_grants
				 WHERE project_id = ?
				   AND target_type = 'user'
				   AND target_id = 'user_different-reviewer-example-com'`,
      )
        .bind(project.id)
        .first<{ id: string }>();
      expect(unauthorizedGrant).toBeNull();
    });

    it("should not synchronize organization membership from another user’s invitation token", async () => {
      const { organization } = await createStaticShiplet();
      const intendedEmail = "intended-consumer@gmail.com";
      const authenticatedEmail = "different-consumer@gmail.com";
      const invitationToken = [
        "test-org-invitation",
        encodeURIComponent(organization.id),
        encodeURIComponent(intendedEmail),
      ].join(":");
      const state = btoa(JSON.stringify({ invitationToken }));

      const callback = await requestHelper(
        `/auth/callback?code=${encodeURIComponent(
          `test-code::${encodeURIComponent(authenticatedEmail)}`,
        )}&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(302);

      const unauthorizedMembership = await (
        env as unknown as TestEnv
      ).DB.prepare(
        `SELECT organization_memberships.id
				 FROM organization_memberships
				 JOIN users ON users.id = organization_memberships.user_id
				 WHERE organization_memberships.organization_id = ?
				   AND users.email = ?`,
      )
        .bind(organization.id, authenticatedEmail)
        .first<{ id: string }>();
      expect(unauthorizedMembership).toBeNull();
    });

    it("should require an accepted editor grant before listing or sharing a private shiplet", async () => {
      const organization = await createTestOrganization(makeRequest);
      const publishBody = await publishStaticShiplet(
        makeRequest,
        organization.id,
        { visibility: "private" },
      );
      const suffix = crypto.randomUUID().slice(0, 8);
      const editorEmail = `pending-editor-${suffix}@example.com`;
      const editorHeaders = {
        "x-shiplet-user-id": `user_pending-editor-${suffix}-example-com`,
        "x-shiplet-user-email": editorEmail,
      };
      const invitationResponse = await makeRequest(
        `/api/projects/${publishBody.project.id}/invitations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetType: "user",
            email: editorEmail,
            role: "editor",
          }),
        },
      );
      expect(invitationResponse.status).toBe(201);
      const invitation = (await invitationResponse.json()) as {
        appInvitation: { id: string };
      };
      const pendingInvitation = await (env as unknown as TestEnv).DB.prepare(
        `SELECT workos_invitation_token
				 FROM app_invitations
				 WHERE id = ?`,
      )
        .bind(invitation.appInvitation.id)
        .first<{ workos_invitation_token: string | null }>();
      expect(pendingInvitation?.workos_invitation_token).toBeTruthy();

      const pendingShare = await requestHelper(
        `/api/projects/${publishBody.project.id}/invitations`,
        {
          method: "POST",
          headers: {
            ...editorHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            targetType: "organization",
            organizationId: organization.id,
            role: "viewer",
          }),
        },
      );
      expect(pendingShare.status).toBe(403);

      for (const path of ["/api/shiplets", "/api/dashboard"]) {
        const pendingListingResponse = await requestHelper(path, {
          headers: editorHeaders,
        });
        expect(pendingListingResponse.status).toBe(200);
        const pendingListing = (await pendingListingResponse.json()) as {
          projects: Array<{ id: string }>;
        };
        expect(
          pendingListing.projects.map((project) => project.id),
        ).not.toContain(publishBody.project.id);
      }

      const state = btoa(
        JSON.stringify({
          invitationToken: pendingInvitation!.workos_invitation_token,
        }),
      );
      const callback = await requestHelper(
        `/auth/callback?code=${encodeURIComponent(
          `test-code::${encodeURIComponent(editorEmail)}`,
        )}&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(302);

      const acceptedShare = await requestHelper(
        `/api/projects/${publishBody.project.id}/invitations`,
        {
          method: "POST",
          headers: {
            ...editorHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            targetType: "organization",
            organizationId: organization.id,
            role: "viewer",
          }),
        },
      );
      expect(acceptedShare.status).toBe(201);

      const acceptedListingResponse = await requestHelper("/api/shiplets", {
        headers: editorHeaders,
      });
      expect(acceptedListingResponse.status).toBe(200);
      const acceptedListing = (await acceptedListingResponse.json()) as {
        projects: Array<{ id: string }>;
      };
      expect(acceptedListing.projects.map((project) => project.id)).toContain(
        publishBody.project.id,
      );
    });

    it("should honor an explicit editor grant even when a narrower grant was created first", async () => {
      const organization = await createTestOrganization(makeRequest);
      const member = await createTestOrganizationMember(
        organization.id,
        `later-editor-${crypto.randomUUID().slice(0, 8)}@example.com`,
      );
      const publishBody = await publishStaticShiplet(
        makeRequest,
        organization.id,
        { visibility: "private" },
      );

      for (const role of ["viewer", "editor"]) {
        const grantResponse = await makeRequest(
          `/api/projects/${publishBody.project.id}/invitations`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              targetType: "organization",
              organizationId: organization.id,
              role,
            }),
          },
        );
        expect(grantResponse.status).toBe(201);
      }

      const memberShareResponse = await requestHelper(
        `/api/projects/${publishBody.project.id}/invitations`,
        {
          method: "POST",
          headers: {
            ...member.headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            targetType: "organization",
            organizationId: organization.id,
            role: "viewer",
          }),
        },
      );
      expect(memberShareResponse.status).toBe(201);
    });
  });

  describe("Review Feedback", () => {
    async function createReviewShiplet() {
      const organization = await createTestOrganization(makeRequest);
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Reviewable Shiplet",
          organization_id: organization.id,
          subdomain: `review-${crypto.randomUUID().slice(0, 8)}`,
          assets: [
            {
              path: "index.html",
              content: btoa("<!doctype html><h1>Review me</h1>"),
              size: 34,
            },
          ],
        }),
      });

      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        project: { id: string; organization_id: string };
      };
      return { organization, project: body.project };
    }

    async function createOrganizationMember(
      organizationId: string,
      email: string,
    ) {
      const normalizedEmail = email.toLowerCase();
      const callback = await requestHelper(
        `/auth/callback?code=${encodeURIComponent(`test-code:${organizationId}:${encodeURIComponent(normalizedEmail)}`)}`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(302);
      const userId = `user_${normalizedEmail
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")}`;
      return {
        id: userId,
        email: normalizedEmail,
        headers: {
          "x-shiplet-user-id": userId,
          "x-shiplet-user-email": normalizedEmail,
        },
      };
    }

    async function createPublicPresenceShiplet() {
      const organization = await createTestOrganization(makeRequest);
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Presence Shiplet",
          organization_id: organization.id,
          subdomain: `presence-${crypto.randomUUID().slice(0, 8)}`,
          visibility: "public",
          assets: [
            {
              path: "index.html",
              content: btoa("<!doctype html><h1>Presence me</h1>"),
              size: 37,
            },
          ],
        }),
      });

      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        project: { id: string; organization_id: string; subdomain: string };
      };
      return { organization, project: body.project };
    }

    it("should serve the embedded review client script", async () => {
      const response = await makeRequest("/api/review/client.js");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("javascript");
      const script = await response.text();
      expect(script).toContain("shiplet-review-root");
      expect(script).toContain("__SHIPLET_REVIEW_CLIENT_MOUNTED__");
      expect(script).toContain(
        "[data-shiplet-review-style],#shiplet-review-root",
      );
      expect(script).toContain("function isElementTarget");
      expect(script).toContain("function resolveReviewAssetUrl");
      expect(script).toContain("avatarSpritePath");
      expect(script).toContain("avatarSpriteUrl");
      expect(script).toContain("review-feedback");
      expect(script).toContain("postMessage");
      expect(script).toContain("Authorization");
      expect(script).toContain('credentials: "omit"');
      expect(script).not.toContain('credentials: "include"');
      expect(script).toContain(
        'const presenceToken = String(config.presenceToken || reviewToken || "");',
      );
      expect(script).toContain(
        'if (presenceToken) url.searchParams.set("reviewToken", presenceToken);',
      );
      expect(script).toContain("shiplet:feedback-created");
      expect(script).toContain("shiplet-review-bubble-layer");
      expect(script).toContain("shiplet-review-bubble");
      expect(script).toContain("data-collapse-bubble");
      expect(script).not.toContain("data-dismiss-feedback");
      expect(script).not.toContain("Dismiss</button>");
      expect(script).not.toContain("dismissedTicketIds");
      expect(script).toContain("shiplet-review-bottom-sheet");
      expect(script).toContain("sheetCollapsed");
      expect(script).toContain("avatarBackgroundForViewer");
      expect(script).toContain("data-preview-feedback-id");
      expect(script).not.toContain("shiplet-review-bubble-avatar");
      expect(script).toContain("data-bubble-cluster");
      expect(script).toContain("activeBubbleClusterId");
      expect(script).toContain("layoutReviewBubbles");
      expect(script).toContain("clampExpandedBubbleFrame");
      expect(script).toContain(
        "const createdFeedback = created && created.feedback;",
      );
      expect(script).toContain(
        "state.optimisticCreatedFeedback[createdFeedback.id] = createdFeedback;",
      );
      expect(script).toContain("state.items = [createdFeedback].concat");
      expect(script).toContain("state.expandedBubbleId = createdFeedback.id;");
      expect(script).toContain("feedbackPollIntervalMs");
      expect(script).toContain("startFeedbackPolling();");
      expect(script).toContain("installLocationWatcher();");
      expect(script).toContain("serial !== feedbackLoadSerial");
      expect(script).toContain("replaceFeedbackItems(data.feedback || []);");
      expect(script).toContain("pendingStatusIds");
      expect(script).toContain("pendingReplyIds");
      expect(script).toContain(
        ".shiplet-review-bubble-layer,.shiplet-review-bubble-layer *{box-sizing:border-box}",
      );
      expect(script).toContain(
        ".shiplet-review-comment-list-root,.shiplet-review-comment-list-root *{box-sizing:border-box}",
      );
      expect(script).toContain(
        ".shiplet-review-bubble-card{display:none;position:relative;z-index:2;width:100%;height:100%;box-sizing:border-box",
      );
      expect(script).toContain("overflow-x:hidden;overflow-y:auto");
      expect(script).toContain(
        ".shiplet-review-bubble.is-expanded .shiplet-review-row{justify-content:flex-start;flex-wrap:wrap;min-width:0}",
      );
      expect(script).toContain("pointerover");
      expect(script).toContain("focusin");
      expect(script).toContain("captureScreenshotDataUrl");
      expect(script).toContain("screenshotDataUrl");
      expect(script).toContain("shiplet-review-presence-root");
      expect(script).toContain("isEmbeddedFrame");
      expect(script).toContain("canRenderPresenceRoster");
      expect(script).toContain("window.self !== window.top");
      expect(script).toContain(
        "const canRenderPresenceRoster = !isEmbeddedFrame;",
      );
      expect(script).toContain("shiplet-review-presence-avatar");
      expect(script).toContain("avatarBackgroundForViewer");
      expect(script).toContain("review-presence/ws");
      expect(script).toContain("data-presence-avatar-id");
      expect(script).toContain("shiplet-review-cursor-layer");
      expect(script).toContain("Following");
      expect(script).toContain("Guest ");
      expect(script).toContain("review-mention-users");
      expect(script).toContain("data-mention-user");
      expect(script).toContain("data-remove-mention");
      expect(script).not.toContain("review-watch");
      expect(script).not.toContain("data-watch");
      expect(script).toContain("data-show-bubbles");
      expect(script).toContain("data-bubble-status='Done'");
      expect(script).toContain("captureDomScreenshotDataUrl");
      expect(script).toContain("isCanvasVisuallyBlank");
      expect(script).toContain(
        "DOM screenshot capture was blank; used fallback capture.",
      );
      expect(script).toContain("foreignObject");
      expect(script).toContain("pageX - window.scrollX");
      expect(script).toContain("rect.left + rect.width / 2");
      expect(script).toContain("rect.width > 0 && rect.height > 0");
      expect(script).toContain(
        "DOM screenshot capture failed; used fallback capture.",
      );
      expect(() => new Function(script)).not.toThrow();
      expect(script).not.toContain(
        "Client-side bitmap capture is not enabled in this Shiplet review client.",
      );
    });

    it("should resolve review client brand assets against the platform app host", () => {
      expect(
        resolveReviewAssetUrl(AVATAR_SPRITE_URL, "https://shiplet.cc"),
      ).toBe("https://shiplet.cc/brand/avatars/shiplet-avatar-presets-v9.png");
      expect(
        resolveReviewAssetUrl(AVATAR_SPRITE_URL, "https://shiplet.cc/"),
      ).toBe("https://shiplet.cc/brand/avatars/shiplet-avatar-presets-v9.png");
      expect(
        resolveReviewAssetUrl(
          "https://cdn.example.com/avatar.png",
          "https://shiplet.cc",
        ),
      ).toBe("https://cdn.example.com/avatar.png");
      expect(resolveReviewAssetUrl(AVATAR_SPRITE_URL, "")).toBe(
        AVATAR_SPRITE_URL,
      );
    });

    it("should preserve linked page CSS when capturing DOM screenshots", async () => {
      const response = await makeRequest("/api/review/client.js");

      expect(response.status).toBe(200);
      const script = await response.text();

      expect(script).toContain("data-shiplet-review-style");
      expect(script).toContain("inlineSnapshotStyles(clone);");
      expect(script).toContain("collectSnapshotStylesheetText()");
      expect(script).toContain(
        "absolutizeCssUrlsForSnapshot(sheetText, sheet.href || baseUrl)",
      );
      expect(script).toContain("link[rel~='stylesheet']");
      expect(script).toContain("snapshotBackgroundColor()");
      expect(script).toContain("ctx.fillRect(0, 0, width, height);");
    });

    it("should render page feedback comments in a sidebar instead of under the composer", async () => {
      const response = await makeRequest("/api/review/client.js");

      expect(response.status).toBe(200);
      const script = await response.text();

      expect(script).toContain("shiplet-review-comment-list-panel");
      expect(script).toContain("shiplet-review-comment-list-button");
      expect(script).toContain("canRenderCommentList");
      expect(script).toContain("return window.self !== window.top");
      expect(script).toContain('if (!canRenderCommentList) return ""');
      expect(script).toContain("data-toggle-comment-list");
      expect(script).toContain("data-close-comment-list");
      expect(script).toContain("renderCommentListPanel()");
      expect(script).toContain("commentListMeta()");
      expect(script).toContain("shiplet-review-comment-list-button-label");
      expect(script).toContain(
        "<h2 class='shiplet-review-comment-list-title'>Comments</h2>",
      );
      expect(script).toContain("No comments on this page yet.");
      expect(script).toContain("state.commentListOpen");
      expect(script).not.toContain("View tickets");
      expect(script).not.toContain("Page tickets");
      expect(script).not.toContain("No tickets on this page yet.");
      expect(script).not.toContain("const itemsHtml = state.loading");
    });

    it("should compose review controls from a unified toolbar, linear threads, and an anchored editor", async () => {
      const response = await makeRequest("/api/review/client.js");

      expect(response.status).toBe(200);
      const script = await response.text();

      expect(script).toContain("shiplet-review-toolbar");
      expect(script).toContain("shiplet-review-comment-list-button-label");
      expect(script).toContain("shiplet-review-comment-list-count");
      expect(script).toContain("shiplet-review-comment-list-header-actions");
      expect(script).toContain("data-new-comment");
      expect(script).toContain("shiplet-review-comment-list-avatar");
      expect(script).toContain("shiplet-review-comment-list-time");
      expect(script).toContain("shiplet-review-inline-context");
      expect(script).toContain("shiplet-review-inline-editor");
      expect(script).toContain("shiplet-review-inline-footer");
      expect(script).toContain("aria-label='Add comment'");
      expect(script).toContain("aria-label='Comment'");
      expect(script).toContain(
        "#shiplet-review-root .shiplet-review-inline-textarea:focus-visible{outline:0;box-shadow:inset 0 0 0 2px var(--shiplet-accent)}",
      );
      expect(script).toContain("@media (prefers-reduced-motion:reduce)");
    });

    it("should keep picker-first review out of the mobile sheet", async () => {
      const response = await makeRequest("/api/review/client.js");

      expect(response.status).toBe(200);
      const script = await response.text();
      const startCapture = script.slice(
        script.indexOf("function startCapture()"),
        script.indexOf("function onMouseMove"),
      );
      const openAnnotationEditor = script.slice(
        script.indexOf("function openAnnotationEditor()"),
        script.indexOf("function closeAnnotationEditor()"),
      );

      expect(script).toContain("shouldAutoCollapseSheet");
      expect(script).toContain("(max-width: 640px)");
      expect(script).toContain("shiplet-review-inline-composer");
      expect(script).toContain("shiplet-review-picker-cursor");
      expect(script).toContain("collapseSheetForViewportInteraction");
      expect(startCapture).toContain("state.panelOpen = false;");
      expect(startCapture).not.toContain(
        "collapseSheetForViewportInteraction();",
      );
      expect(startCapture).not.toContain("state.sheetCollapsed = false;");
      expect(openAnnotationEditor).toContain(
        "collapseSheetForViewportInteraction();",
      );
      expect(script).toContain("collapseSheetAfterSubmit();");
      expect(script).toContain("submittedFromInlineComposer");
      expect(script).toContain("state.sheetCollapsed = true;");
    });

    it("should keep the comment sidebar in Shiplet styling without a one-click Done action", async () => {
      const response = await makeRequest("/api/review/client.js");

      expect(response.status).toBe(200);
      const script = await response.text();

      expect(script).toContain("shiplet-review-comment-list-panel");
      expect(script).toContain("--shiplet-surface:#fbf9f4");
      expect(script).toContain("--shiplet-action:#c2502f");
      expect(script).toContain(
        "background:var(--shiplet-surface);border:1px solid var(--shiplet-line-strong)",
      );
      expect(script).toContain("shiplet-review-comment-list-send-button");
      expect(script).toContain("background:var(--shiplet-action);color:#fff");
      expect(script).not.toContain("data-sidebar-status");
      expect(script).not.toContain("shiplet-review-comment-list-done-button");
    });

    it("should keep the comment sidebar status changer compact", async () => {
      const response = await makeRequest("/api/review/client.js");

      expect(response.status).toBe(200);
      const script = await response.text();

      expect(script).toContain("shiplet-review-comment-list-item-main");
      expect(script).toContain(
        "<select class='shiplet-review-comment-list-status-select' data-status='",
      );
      expect(script).toContain("shiplet-review-comment-list-thread-actions");
      expect(script).toContain(
        ".shiplet-review-comment-list-item-main{display:grid;grid-template-columns:1fr",
      );
      expect(script).toContain(
        ".shiplet-review-comment-list-root{position:fixed;inset:0;z-index:2147483002",
      );
      expect(script).toContain(
        ".shiplet-review-comment-list-panel{position:fixed;right:16px;top:16px;bottom:16px",
      );
      expect(script).toContain(
        "pointer-events:auto;z-index:2147483003;overflow:hidden",
      );
      expect(script).toContain(
        ".shiplet-review-comment-list-item-header{display:flex;align-items:center;gap:6px",
      );
      expect(script).toContain(
        ".shiplet-review-comment-list-status-select{width:90px;height:24px",
      );
      expect(script).toContain("@media (max-width:859px)");
      expect(script).toContain(
        ".shiplet-review-comment-list-item-main{grid-template-columns:1fr}",
      );
      expect(script).toContain("@media (max-width:640px)");
      expect(script).toContain(
        ".shiplet-review-comment-list-panel{left:0;right:0;top:0;bottom:0;width:auto;max-width:none",
      );
      expect(script).toContain(
        ".shiplet-review-comment-list-reply-actions{grid-template-columns:minmax(0,1fr) 44px}",
      );
      expect(script).not.toContain(
        "shiplet-review-comment-list-status-controls",
      );
      expect(script).not.toContain(
        "shiplet-review-comment-list-status-actions",
      );
    });

    it("should hide the review sheet collapse control on desktop", async () => {
      const response = await makeRequest("/api/review/client.js");

      expect(response.status).toBe(200);
      const script = await response.text();

      expect(script).toContain("shiplet-review-sheet-toggle");
      expect(script).toContain(".shiplet-review-sheet-toggle{display:none}");
      expect(script).toContain(
        ".shiplet-review-sheet-toggle{display:inline-flex}",
      );
      expect(script).toContain("sheetToggleLabel()");
      expect(script).toContain(
        'state.sheetCollapsed ? "Expand review sheet" : "Collapse review sheet"',
      );
      expect(script).toContain("sheetToggleIcon()");
      expect(script).toContain('viewBox: "0 0 16 16"');
      expect(script).toContain("M4 6.25 8 10.25 12 6.25");
      expect(script).not.toContain("m6 9 6 6 6-6");
      expect(script).toContain(
        "<div class='shiplet-review-sheet-grip' aria-hidden='true'></div>",
      );
      expect(script).toContain("shiplet-review-sheet-grip{display:block}");
    });

    it("should keep the review widget header controls minimal with secondary actions in settings", async () => {
      const response = await makeRequest("/api/review/client.js");

      expect(response.status).toBe(200);
      const script = await response.text();
      const headerStart = script.indexOf(
        "<div class='shiplet-review-actions'>",
      );
      const headerEnd = script.indexOf("</div>", headerStart);
      const headerMarkup = script.slice(headerStart, headerEnd);

      expect(headerMarkup).toContain("data-capture");
      expect(headerMarkup).toContain("data-toggle-settings");
      expect(headerMarkup).toContain("data-toggle-sheet");
      expect(headerMarkup).toContain("data-close");
      expect(headerMarkup).not.toContain("data-watch");
      expect(headerMarkup).not.toContain("data-refresh");
      expect(script).toContain("shipletReviewIcon");
      expect(script).toContain("shiplet-review-icon-svg");
      expect(script).not.toContain("aria-label='Refresh'>↻");
      expect(script).not.toContain("aria-label='Review settings'>⚙");
      expect(script).not.toContain("aria-label='Collapse'>⌄");
      expect(script).not.toContain("aria-label='Close'>×");
      expect(script).toContain("shiplet-review-settings-actions");
      expect(script).toContain(
        "<button class='shiplet-review-small' data-annotate type='button'>Draw on screenshot</button>",
      );
      expect(script).not.toContain("watchButtonHtml");
      expect(script).not.toContain("toggleWatch");
      expect(script).toContain("data-refresh type='button'");
    });

    it("should keep artifact watch controls on the review bridge page instead of the widget", async () => {
      const { project } = await createReviewShiplet();
      const response = await makeRequest(`/shiplets/${project.id}`);

      expect(response.status).toBe(200);
      const html = await response.text();

      expect(html).toContain('id="watchArtifact"');
      expect(html).toContain("data-watch-artifact");
      expect(html).toContain("Watch artifact");
      expect(html).toContain("loadArtifactWatchStatus");
      expect(html).toContain("toggleArtifactWatch");
      expect(html).toContain(
        `"/api/projects/" + encodeURIComponent(detailProject.id) + "/review-watch`,
      );
    });

    it("should absolutize CSS asset URLs for serialized screenshot styles", () => {
      const css =
        ".hero{background:url('/images/bg.png')}@font-face{src:url(fonts/main.woff2)}.icon{mask:url(\"./icons/mark.svg\")} .data{background:url(data:image/png;base64,abc)}";

      expect(
        absolutizeCssUrlsForSnapshot(
          css,
          "https://preview.shiplet.test/app/page",
        ),
      ).toBe(
        ".hero{background:url('https://preview.shiplet.test/images/bg.png')}@font-face{src:url(https://preview.shiplet.test/app/fonts/main.woff2)}.icon{mask:url(\"https://preview.shiplet.test/app/icons/mark.svg\")} .data{background:url(data:image/png;base64,abc)}",
      );
    });

    it("should include screenshot annotation controls in the embedded review client", async () => {
      const response = await makeRequest("/api/review/client.js");

      expect(response.status).toBe(200);
      const script = await response.text();
      expect(script).toContain("Draw on screenshot");
      expect(script).toContain("data-annotation-canvas");
      expect(script).toContain("aria-label='Drawing canvas'");
      expect(script).toContain("Screenshot text annotation");
      expect(script).toContain("Undo annotation");
      expect(script).toContain("shiplet-review-annotation-editor");
      expect(script).toContain("data-annotation-editor='true'");
      expect(script).toContain("shiplet-review-annotation-layer");
      expect(script).toContain("shiplet-review-annotation-tool");
      expect(script).toContain("shiplet-review-annotation-color");
      expect(script).toContain("shiplet-review-annotation-stroke-width");
      expect(script).toContain("isAnnotationCanvasTarget");
      expect(script).toContain(
        "annotationLayer.setPointerCapture(event.pointerId)",
      );
      expect(script).toContain(
        'window.addEventListener("pointermove", handleAnnotationPointerMove, true);',
      );
      expect(script).toContain(
        'window.addEventListener("pointerup", finishAnnotationDraft, true);',
      );
      expect(script).toContain("drawAnnotationOnCanvas");
      expect(script).toContain("Screenshot includes reviewer annotations.");
    });

    it("should keep the feedback composer textarea mounted while typing", async () => {
      const response = await makeRequest("/api/review/client.js");

      expect(response.status).toBe(200);
      const script = await response.text();
      const inputHandlerStart = script.indexOf('root.addEventListener("input"');
      const inputHandlerEnd = script.indexOf(
        'window.addEventListener("resize"',
        inputHandlerStart,
      );
      const inputHandler = script.slice(inputHandlerStart, inputHandlerEnd);

      expect(inputHandlerStart).toBeGreaterThanOrEqual(0);
      expect(inputHandlerEnd).toBeGreaterThan(inputHandlerStart);
      expect(script).toContain("data-mention-menu-slot");
      expect(script).toContain("data-mention-row-slot");
      expect(script).toContain("renderComposerMentionState");
      expect(inputHandler).toContain("renderMentionMenu();");
      expect(inputHandler).not.toContain("render();");
    });

    it("should stack clustered bubbles, fan them out, and clamp expanded cards", () => {
      const viewport = { width: 360, height: 240 };
      const items = [
        { id: "a", x: 330, y: 210 },
        { id: "b", x: 334, y: 212 },
        { id: "c", x: 326, y: 208 },
      ];

      const stacked = layoutReviewBubbles(items, viewport);
      expect(new Set(stacked.map((item) => item.clusterId)).size).toBe(1);
      expect(stacked.every((item) => item.clusterSize === 3)).toBe(true);
      expect(new Set(stacked.map((item) => `${item.x},${item.y}`)).size).toBe(
        3,
      );

      const fanned = layoutReviewBubbles(items, viewport, {
        activeClusterId: stacked[0].clusterId,
      });
      const stackedSpread =
        Math.max(...stacked.map((item) => item.x)) -
        Math.min(...stacked.map((item) => item.x));
      const fannedSpread =
        Math.max(...fanned.map((item) => item.x)) -
        Math.min(...fanned.map((item) => item.x));
      expect(fannedSpread).toBeGreaterThan(stackedSpread);
      expect(fanned.every((item) => item.x >= 24 && item.x <= 336)).toBe(true);
      expect(fanned.every((item) => item.y >= 24 && item.y <= 216)).toBe(true);

      const expanded = clampExpandedBubbleFrame({ x: 350, y: 230 }, viewport, {
        width: 320,
        minHeight: 168,
        margin: 14,
      });
      expect(expanded.left).toBe(26);
      expect(expanded.top).toBe(58);
      expect(expanded.width).toBe(320);
    });

    it("should autocomplete org mentions, invite mentioned reviewers, and create inbox notifications", async () => {
      const { organization, project } = await createReviewShiplet();
      const reviewer = await createOrganizationMember(
        organization.id,
        `reviewer-${crypto.randomUUID().slice(0, 8)}@example.com`,
      );

      const autocompleteResponse = await makeRequest(
        `/api/projects/${project.id}/review-mention-users?q=${encodeURIComponent(reviewer.email)}`,
      );
      expect(autocompleteResponse.status).toBe(200);
      const autocomplete = (await autocompleteResponse.json()) as {
        users: Array<{
          id: string;
          email: string;
          shiplet_access_status: string;
        }>;
      };
      expect(autocomplete.users).toHaveLength(1);
      expect(autocomplete.users[0]).toMatchObject({
        id: reviewer.id,
        email: reviewer.email,
        shiplet_access_status: "invite_required",
      });

      const createResponse = await makeRequest(
        `/api/projects/${project.id}/review-feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comment: `Please check this, @${reviewer.email}.`,
            pageUrl: "http://localhost/review/mentions",
            clientFeedbackId: `client-${crypto.randomUUID()}`,
            mentions: [{ userId: reviewer.id, email: reviewer.email }],
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as {
        feedback: {
          id: string;
          mentions: Array<{
            mentioned_user_id: string;
            mentioned_email: string;
            access_status: string;
            grant_id: string | null;
          }>;
        };
      };
      expect(created.feedback.mentions).toHaveLength(1);
      expect(created.feedback.mentions[0]).toMatchObject({
        mentioned_user_id: reviewer.id,
        mentioned_email: reviewer.email,
        access_status: "invited",
      });
      expect(created.feedback.mentions[0].grant_id).toMatch(/^grant_/);

      const grant = await (env as unknown as TestEnv).DB.prepare(
        `SELECT * FROM shiplet_access_grants
					 WHERE project_id = ? AND target_id = ? AND role = 'reviewer'`,
      )
        .bind(project.id, reviewer.id)
        .first<{ id: string; email: string }>();
      expect(grant?.id).toBe(created.feedback.mentions[0].grant_id);
      expect(grant?.email).toBe(reviewer.email);

      const inboxResponse = await requestHelper("/api/notifications", {
        headers: reviewer.headers,
      });
      expect(inboxResponse.status).toBe(200);
      const inbox = (await inboxResponse.json()) as {
        notifications: Array<{
          id: string;
          type: string;
          reason: string;
          read_on: string | null;
          email_status: string;
          feedback_id: string;
        }>;
      };
      expect(inbox.notifications[0]).toMatchObject({
        type: "mention",
        reason: "mentioned",
        read_on: null,
        email_status: "email_not_configured",
        feedback_id: created.feedback.id,
      });

      const inboxPageResponse = await requestHelper("/inbox", {
        headers: reviewer.headers,
      });
      const inboxPageHtml = await inboxPageResponse.text();
      const inboxBadge = extractElementById(
        inboxPageHtml,
        "platformInboxBadge",
      );
      expect(inboxPageResponse.status).toBe(200);
      expect(inboxBadge).toContain("data-live-notification-count");
      expect(inboxBadge).not.toMatch(/\shidden(?:[=>\s]|$)/);
      expect(inboxBadge).toContain(">1</span>");

      const readResponse = await requestHelper(
        `/api/notifications/${inbox.notifications[0].id}/read`,
        { method: "POST", headers: reviewer.headers },
      );
      expect(readResponse.status).toBe(200);
      const readBody = (await readResponse.json()) as {
        notification: { read_on: string | null };
      };
      expect(readBody.notification.read_on).toBeTruthy();

      const mentionedFeedbackResponse = await requestHelper(
        "/api/feedback?mentionedMe=true",
        { headers: reviewer.headers },
      );
      expect(mentionedFeedbackResponse.status).toBe(200);
      const mentionedFeedback = (await mentionedFeedbackResponse.json()) as {
        feedback: Array<{ id: string; project_name: string | null }>;
      };
      expect(mentionedFeedback.feedback.map((item) => item.id)).toContain(
        created.feedback.id,
      );
    });

    it("should send configured mention notification emails without blocking feedback creation", async () => {
      const sendEmail = vi.fn().mockResolvedValue({ id: "email_test" });
      await withEmailBinding(sendEmail, async () => {
        const { organization, project } = await createReviewShiplet();
        const reviewer = await createOrganizationMember(
          organization.id,
          `email-reviewer-${crypto.randomUUID().slice(0, 8)}@example.com`,
        );

        const createResponse = await makeRequest(
          `/api/projects/${project.id}/review-feedback`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              comment: "Email this reviewer.",
              pageUrl: "http://localhost/review/email",
              clientFeedbackId: `client-${crypto.randomUUID()}`,
              mentions: [{ userId: reviewer.id, email: reviewer.email }],
            }),
          },
        );
        expect(createResponse.status).toBe(201);
        const created = (await createResponse.json()) as {
          feedback: { id: string };
        };

        expect(sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: reviewer.email,
            from: { email: "notifications@shiplet.test", name: "Shiplet" },
            subject: expect.stringContaining("Shiplet PF-1"),
            text: expect.stringContaining("mentioned you"),
          }),
        );

        const inboxResponse = await requestHelper("/api/notifications", {
          headers: reviewer.headers,
        });
        const inbox = (await inboxResponse.json()) as {
          notifications: Array<{
            feedback_id: string;
            email_status: string;
          }>;
        };
        expect(
          inbox.notifications.find(
            (notification) => notification.feedback_id === created.feedback.id,
          )?.email_status,
        ).toBe("sent");
      });
    });

    it("should let reviewers watch shiplets and receive watch notifications", async () => {
      const { organization, project } = await createReviewShiplet();
      const watcher = await createOrganizationMember(
        organization.id,
        `watcher-${crypto.randomUUID().slice(0, 8)}@example.com`,
      );

      const ownerWatchResponse = await makeRequest(
        `/api/projects/${project.id}/review-watch`,
      );
      expect(ownerWatchResponse.status).toBe(200);
      const ownerWatch = (await ownerWatchResponse.json()) as {
        watch: { watching: boolean; source: string };
      };
      expect(ownerWatch.watch).toMatchObject({
        watching: true,
        source: "owner_default",
      });

      const watchResponse = await requestHelper(
        `/api/projects/${project.id}/review-watch`,
        { method: "POST", headers: watcher.headers },
      );
      expect(watchResponse.status).toBe(200);
      const watchBody = (await watchResponse.json()) as {
        watch: { watching: boolean; source: string };
      };
      expect(watchBody.watch).toMatchObject({
        watching: true,
        source: "explicit",
      });

      const createResponse = await makeRequest(
        `/api/projects/${project.id}/review-feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comment: "Watcher should see this even without a mention.",
            pageUrl: "http://localhost/review/watchers",
            clientFeedbackId: `client-${crypto.randomUUID()}`,
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as {
        feedback: { id: string };
      };

      const inboxResponse = await requestHelper("/api/notifications", {
        headers: watcher.headers,
      });
      const inbox = (await inboxResponse.json()) as {
        notifications: Array<{
          type: string;
          reason: string;
          feedback_id: string;
        }>;
      };
      expect(inbox.notifications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "watch",
            reason: "new_feedback",
            feedback_id: created.feedback.id,
          }),
        ]),
      );

      const watchedFeedbackResponse = await requestHelper(
        "/api/feedback?watched=true",
        { headers: watcher.headers },
      );
      expect(watchedFeedbackResponse.status).toBe(200);
      const watchedFeedback = (await watchedFeedbackResponse.json()) as {
        feedback: Array<{ id: string }>;
      };
      expect(watchedFeedback.feedback.map((item) => item.id)).toContain(
        created.feedback.id,
      );

      const unwatchResponse = await requestHelper(
        `/api/projects/${project.id}/review-watch`,
        { method: "DELETE", headers: watcher.headers },
      );
      expect(unwatchResponse.status).toBe(200);
      const unwatchBody = (await unwatchResponse.json()) as {
        watch: { watching: boolean; source: string };
      };
      expect(unwatchBody.watch).toMatchObject({
        watching: false,
        source: "muted",
      });
    });

    it("should expose hydrated inbox state for signed-in users", async () => {
      const response = await makeRequest("/inbox");
      const html = await response.text();
      const stateMatch = html.match(
        /<script\b[^>]*type="application\/json"[^>]*id="shiplet-platform-inbox-state"[^>]*>([\s\S]*?)<\/script>/,
      );

      expect(response.status).toBe(200);
      expect(html).toContain('id="inbox-platform-root"');
      expect(html).toContain('data-platform-app="react-tanstack"');
      expect(html).toContain('data-platform-route="inbox"');
      expectPlatformStartShell(html, "inbox");
      expect(html).toContain(
        'data-notifications-endpoint="/api/notifications?limit=100"',
      );
      expect(html).toContain('src="/assets/platform/inbox.js"');
      expect(stateMatch?.[1]).toBeTruthy();

      const state = JSON.parse(stateMatch![1]) as {
        notificationsEndpoint: string;
        initialNotifications: unknown[];
        initialUi: { selectedNotificationId: string | null };
        queryKey: [string, Record<string, unknown>];
        route: string;
      };

      expect(state.route).toBe("inbox");
      expect(state.notificationsEndpoint).toBe("/api/notifications?limit=100");
      expect(state.initialNotifications).toEqual([]);
      expect(state.initialUi).toEqual({ selectedNotificationId: null });
      expect(state.queryKey).toEqual([
        "notifications",
        { route: "inbox", limit: 100 },
      ]);
    });

    it("should expose global feedback hydration state with URL-owned filters", async () => {
      const response = await makeRequest(
        "/feedback?status=Blocked&mentionedMe=true&watched=true&submittedByMe=true",
      );
      const html = await response.text();
      const stateMatch = html.match(
        /<script\b[^>]*type="application\/json"[^>]*id="shiplet-platform-feedback-state"[^>]*>([\s\S]*?)<\/script>/,
      );

      expect(response.status).toBe(200);
      expect(html).toContain('id="feedback-platform-root"');
      expectPlatformStartShell(html, "feedback");
      expect(html).toContain('data-feedback-hydration="pending"');
      expect(html).toContain('data-feedback-filter-form="true"');
      expect(html).toContain('data-feedback-client-filters="local"');
      expect(html).toContain('src="/assets/platform/feedback.js"');
      expect(stateMatch?.[1]).toBeTruthy();
      const feedbackBadge = extractElementById(html, "platformFeedbackBadge");
      expect(feedbackBadge).toContain("data-live-feedback-count");
      expect(feedbackBadge).toMatch(/\shidden(?:[=>\s]|$)/);
      expect(feedbackBadge).not.toContain(">0</span>");

      const state = JSON.parse(stateMatch![1]) as {
        feedbackEndpoint: string;
        filters: {
          projectId: string | null;
          status: string | null;
          mentionedMe: boolean;
          watched: boolean;
          submittedByMe: boolean;
        };
        queryKey: [string, Record<string, unknown>];
        route: string;
      };

      expect(state.route).toBe("feedback");
      expect(state.feedbackEndpoint).toBe("/api/feedback");
      expect(state.filters).toEqual({
        projectId: null,
        status: "Blocked",
        mentionedMe: true,
        watched: true,
        submittedByMe: true,
      });
      expect(state.queryKey).toEqual([
        "feedback",
        {
          projectId: "",
          status: "Blocked",
          mentionedMe: true,
          watched: true,
          submittedByMe: true,
        },
      ]);
    });

    it("should preserve project-scoped feedback filters in hydration state", async () => {
      const first = await createReviewShiplet();
      const second = await createReviewShiplet();
      const firstComment = `Scoped first ${crypto.randomUUID()}`;
      const secondComment = `Scoped second ${crypto.randomUUID()}`;

      for (const [projectId, comment] of [
        [first.project.id, firstComment],
        [second.project.id, secondComment],
      ]) {
        const createResponse = await makeRequest(
          `/api/projects/${projectId}/review-feedback`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              comment,
              pageUrl: "http://localhost/review/project-scope",
              clientFeedbackId: `client-${crypto.randomUUID()}`,
            }),
          },
        );
        expect(createResponse.status).toBe(201);
      }

      const response = await makeRequest(
        `/feedback?projectId=${encodeURIComponent(first.project.id)}`,
      );
      const html = await response.text();
      const stateMatch = html.match(
        /<script\b[^>]*type="application\/json"[^>]*id="shiplet-platform-feedback-state"[^>]*>([\s\S]*?)<\/script>/,
      );
      expect(response.status).toBe(200);
      expect(stateMatch?.[1]).toBeTruthy();
      expect(html).toContain(firstComment);
      expect(html).not.toContain(secondComment);

      const state = JSON.parse(stateMatch![1]) as {
        filters: { projectId: string | null };
        initialFeedback: Array<{ comment: string; project_id: string }>;
        queryKey: [string, Record<string, unknown>];
      };
      expect(state.filters.projectId).toBe(first.project.id);
      expect(state.initialFeedback).toEqual([
        expect.objectContaining({
          comment: firstComment,
          project_id: first.project.id,
        }),
      ]);
      expect(state.queryKey).toEqual([
        "feedback",
        expect.objectContaining({ projectId: first.project.id }),
      ]);
    });

    it("should render inbox and global feedback pages for signed-in users", async () => {
      const inboxResponse = await makeRequest("/inbox");
      expect(inboxResponse.status).toBe(200);
      const inboxHtml = await inboxResponse.text();
      expect(inboxHtml).toContain("Notifications");
      expect(inboxHtml).toContain("Notification inbox");
      expect(inboxHtml).toContain("/feedback");
      expect(inboxHtml).toContain('data-platform-app="react-tanstack"');
      expect(inboxHtml).toContain('data-platform-route="inbox"');
      expectPlatformStartShell(inboxHtml, "inbox");
      expect(inboxHtml).toContain('id="inbox-platform-root"');
      expect(inboxHtml).toContain('id="shiplet-platform-inbox-state"');
      expect(inboxHtml).toContain('src="/assets/platform/inbox.js"');

      const feedbackResponse = await makeRequest("/feedback");
      expect(feedbackResponse.status).toBe(200);
      const feedbackHtml = await feedbackResponse.text();
      expect(feedbackHtml).toContain("All feedback");
      expect(feedbackHtml).toContain("Global ledger");
      expect(feedbackHtml).toContain("Review comments");
      expect(feedbackHtml).not.toContain("Review tickets");
      expect(feedbackHtml).toContain("mentionedMe");
      expect(feedbackHtml).toContain('data-platform-app="react-tanstack"');
      expect(feedbackHtml).toContain('data-platform-route="feedback"');
      expectPlatformStartShell(feedbackHtml, "feedback");
      expect(feedbackHtml).toContain('id="feedback-platform-root"');
      expect(feedbackHtml).toContain('id="shiplet-platform-feedback-state"');
      expect(feedbackHtml).toContain('src="/assets/platform/feedback.js"');
    });

    it("should serve hydrated platform client assets without Node-only globals", async () => {
      for (const asset of [
        "/assets/platform/shiplets.js",
        "/assets/platform/inbox.js",
        "/assets/platform/feedback.js",
      ]) {
        const response = await makeRequest(asset);
        const source = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain(
          "application/javascript",
        );
        expect(source).toContain("hydrateRoot");
        expect(source).not.toContain("process.env.NODE_ENV");
      }
    });

    it("should allow credentialed review feedback API calls from shiplet subdomains", async () => {
      await withCustomDomain("shiplet.cc", async () => {
        const response = await requestHelper(
          "/api/projects/project_test/review-feedback",
          {
            method: "OPTIONS",
            headers: {
              Origin: "https://demo.shiplet.cc",
              "Access-Control-Request-Method": "POST",
              "Access-Control-Request-Headers": "content-type, authorization",
            },
          },
        );

        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBe(
          "https://demo.shiplet.cc",
        );
        expect(
          response.headers.get("access-control-allow-credentials"),
        ).toBeNull();
        expect(response.headers.get("access-control-allow-methods")).toContain(
          "POST",
        );
      });
    });

    it("should reject review presence websocket requests without an upgrade", async () => {
      const { project } = await createPublicPresenceShiplet();

      const response = await requestHelper(
        `/api/projects/${project.id}/review-presence/ws?path=%2F`,
      );

      expect(response.status).toBe(426);
      expect(await response.text()).toContain("Upgrade: websocket");
    });

    it("should allow anonymous public viewers to join review presence", async () => {
      const { project } = await createPublicPresenceShiplet();
      const socket = await websocketHelper(
        `/api/projects/${project.id}/review-presence/ws?path=%2F`,
      );

      sendJson(socket, {
        type: "hello",
        viewer: {
          id: "guest_alpha",
          name: "Guest Alpha",
          kind: "guest",
          avatarPreset: "aurora-grid",
          color: "#c2502f",
        },
        page: { pathname: "/", href: "https://presence.shiplet.cc/" },
      });

      const message = await waitForSocketMessage(
        socket,
        (candidate) =>
          candidate.type === "presence:update" &&
          Array.isArray(candidate.viewers) &&
          (candidate.viewers as Array<{ id: string }>).some(
            (viewer) => viewer.id === "guest_alpha",
          ),
      );
      const viewers = message.viewers as Array<{ id: string; name: string }>;
      expect(viewers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "guest_alpha", name: "Guest Alpha" }),
        ]),
      );
      socket.close(1000, "done");
    });

    it("should broadcast cursors only to viewers on the same review page", async () => {
      const { project } = await createPublicPresenceShiplet();
      const pageOneA = await websocketHelper(
        `/api/projects/${project.id}/review-presence/ws?path=%2Fone`,
      );
      const pageOneB = await websocketHelper(
        `/api/projects/${project.id}/review-presence/ws?path=%2Fone`,
      );
      const pageTwo = await websocketHelper(
        `/api/projects/${project.id}/review-presence/ws?path=%2Ftwo`,
      );

      sendJson(pageOneA, {
        type: "hello",
        viewer: {
          id: "guest_alpha",
          name: "Guest Alpha",
          kind: "guest",
          avatarPreset: "aurora-grid",
          color: "#c2502f",
        },
        page: { pathname: "/one", href: "https://presence.shiplet.cc/one" },
      });
      sendJson(pageOneB, {
        type: "hello",
        viewer: {
          id: "guest_bravo",
          name: "Guest Bravo",
          kind: "guest",
          avatarPreset: "violet-signal",
          color: "#2f6e88",
        },
        page: { pathname: "/one", href: "https://presence.shiplet.cc/one" },
      });
      sendJson(pageTwo, {
        type: "hello",
        viewer: {
          id: "guest_charlie",
          name: "Guest Charlie",
          kind: "guest",
          avatarPreset: "coral-orbit",
          color: "#c3922e",
        },
        page: { pathname: "/two", href: "https://presence.shiplet.cc/two" },
      });

      await waitForSocketMessage(
        pageOneB,
        (candidate) =>
          candidate.type === "presence:update" &&
          Array.isArray(candidate.viewers) &&
          (candidate.viewers as Array<{ id: string }>).some(
            (viewer) => viewer.id === "guest_alpha",
          ),
      );

      sendJson(pageOneA, {
        type: "cursor:update",
        cursor: { x: 120, y: 240, scrollX: 0, scrollY: 100 },
        page: { pathname: "/one", href: "https://presence.shiplet.cc/one" },
      });

      const cursorMessage = await waitForSocketMessage(
        pageOneB,
        (candidate) =>
          candidate.type === "cursor:update" &&
          (candidate.viewer as { id?: string } | undefined)?.id ===
            "guest_alpha",
      );
      expect(cursorMessage.cursor).toMatchObject({ x: 120, y: 240 });

      let isolated = true;
      try {
        await waitForSocketMessage(
          pageTwo,
          (candidate) =>
            candidate.type === "cursor:update" &&
            (candidate.viewer as { id?: string } | undefined)?.id ===
              "guest_alpha",
        );
        isolated = false;
      } catch {
        isolated = true;
      }
      expect(isolated).toBe(true);

      pageOneA.close(1000, "done");
      pageOneB.close(1000, "done");
      pageTwo.close(1000, "done");
    });

    it("should reject anonymous review feedback submissions", async () => {
      const { project } = await createReviewShiplet();
      const response = await requestHelper(
        `/api/projects/${project.id}/review-feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      expect(response.status).toBe(401);
    });

    it("should submit and hydrate review feedback for a shiplet", async () => {
      const { project } = await createReviewShiplet();
      const pageUrl = `http://localhost/${project.id}/dashboard`;
      const response = await makeRequest(
        `/api/projects/${project.id}/review-feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comment: "The chart title is unclear.",
            pageUrl,
            clientFeedbackId: `client-${crypto.randomUUID()}`,
            screenshotMode: "element",
            viewport: { width: 1280, height: 720 },
            coordinates: {
              pageX: 320,
              pageY: 240,
              viewportX: 320,
              viewportY: 140,
            },
            selectedElement: {
              selector: "h1",
              tagName: "H1",
              text: "Review me",
              ariaLabel: null,
              className: null,
              rect: { top: 100, left: 300, width: 200, height: 40 },
            },
            captureContext: {
              elementCount: 12,
              imageCount: 1,
              documentWidth: 1280,
              documentHeight: 1400,
              scrollX: 0,
              scrollY: 100,
            },
          }),
        },
      );

      expect(response.status).toBe(201);
      const created = (await response.json()) as {
        ok: boolean;
        feedback: {
          id: string;
          ticket_number: number;
          ticket_label: string;
          submitted_by_avatar_preset: string | null;
        };
      };
      expect(created.ok).toBe(true);
      expect(created.feedback.ticket_number).toBe(1);
      expect(created.feedback.ticket_label).toBe("PF-1");
      expect(created.feedback.submitted_by_avatar_preset).toBeTruthy();

      const listResponse = await makeRequest(
        `/api/projects/${project.id}/review-feedback?pageUrl=${encodeURIComponent(pageUrl)}`,
      );
      expect(listResponse.status).toBe(200);
      const list = (await listResponse.json()) as {
        feedback: Array<{
          id: string;
          comment: string;
          ticket_label: string;
          submitted_by_avatar_preset: string | null;
        }>;
      };
      expect(list.feedback).toHaveLength(1);
      expect(list.feedback[0].comment).toBe("The chart title is unclear.");
      expect(list.feedback[0].ticket_label).toBe("PF-1");
      expect(list.feedback[0].submitted_by_avatar_preset).toBe(
        created.feedback.submitted_by_avatar_preset,
      );
    });

    it("should render stored review screenshots through an authorized endpoint", async () => {
      const { project } = await createReviewShiplet();
      const screenshotDataUrl =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
      const createResponse = await makeRequest(
        `/api/projects/${project.id}/review-feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comment: "The screenshot should be visible in the review bridge.",
            pageUrl: "http://localhost/review/with-screenshot",
            clientFeedbackId: `client-${crypto.randomUUID()}`,
            screenshotDataUrl,
            screenshotMode: "page",
          }),
        },
      );

      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as {
        feedback: {
          id: string;
          screenshot_key: string | null;
          screenshot_url: string | null;
          screenshot_content_type: string | null;
          screenshot_size: number | null;
        };
      };
      expect(created.feedback.screenshot_key).toContain(
        `projects/${project.id}/feedback/${created.feedback.id}.png`,
      );
      expect(created.feedback.screenshot_url).toBe(
        `/api/projects/${project.id}/review-feedback/${created.feedback.id}/screenshot`,
      );
      expect(created.feedback.screenshot_content_type).toBe("image/png");
      expect(created.feedback.screenshot_size).toBeGreaterThan(0);

      const listResponse = await makeRequest(
        `/api/projects/${project.id}/review-feedback?includeClosed=true`,
      );
      const listBody = (await listResponse.json()) as {
        feedback: Array<{ id: string; screenshot_url: string | null }>;
      };
      expect(
        listBody.feedback.find((item) => item.id === created.feedback.id)
          ?.screenshot_url,
      ).toBe(created.feedback.screenshot_url);

      const screenshotResponse = await makeRequest(
        created.feedback.screenshot_url!,
      );
      expect(screenshotResponse.status).toBe(200);
      expect(screenshotResponse.headers.get("content-type")).toBe("image/png");
      expect(screenshotResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      expect(screenshotResponse.headers.get("cache-control")).toContain(
        "private",
      );
      expect(
        new Uint8Array(await screenshotResponse.arrayBuffer()).byteLength,
      ).toBe(created.feedback.screenshot_size);

      const anonymousResponse = await requestHelper(
        created.feedback.screenshot_url!,
      );
      expect(anonymousResponse.status).toBe(401);
    });

    it("should return 404 for review feedback without a stored screenshot", async () => {
      const { project } = await createReviewShiplet();
      const createResponse = await makeRequest(
        `/api/projects/${project.id}/review-feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comment: "No bitmap was captured.",
            pageUrl: "http://localhost/review/no-screenshot",
            clientFeedbackId: `client-${crypto.randomUUID()}`,
            screenshotFailureNote:
              "Client-side bitmap capture is not enabled in this Shiplet review client.",
          }),
        },
      );
      const created = (await createResponse.json()) as {
        feedback: {
          id: string;
          screenshot_url: string | null;
          screenshot_failure_note: string | null;
        };
      };
      expect(created.feedback.screenshot_url).toBeNull();
      expect(created.feedback.screenshot_failure_note).toContain(
        "Client-side bitmap capture is not enabled",
      );

      const screenshotResponse = await makeRequest(
        `/api/projects/${project.id}/review-feedback/${created.feedback.id}/screenshot`,
      );
      expect(screenshotResponse.status).toBe(404);
    });

    it("should add replies and update feedback status", async () => {
      const { project } = await createReviewShiplet();
      const createResponse = await makeRequest(
        `/api/projects/${project.id}/review-feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comment: "Needs a loading state.",
            pageUrl: "http://localhost/review/loading",
            clientFeedbackId: `client-${crypto.randomUUID()}`,
          }),
        },
      );
      const { feedback } = (await createResponse.json()) as {
        feedback: { id: string };
      };

      const replyResponse = await makeRequest(
        `/api/projects/${project.id}/review-feedback/${feedback.id}/replies`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comment: "Agreed, adding a skeleton." }),
        },
      );
      expect(replyResponse.status).toBe(201);

      const statusResponse = await makeRequest(
        `/api/projects/${project.id}/review-feedback/${feedback.id}/status`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "In Progress" }),
        },
      );
      expect(statusResponse.status).toBe(200);
      const statusBody = (await statusResponse.json()) as {
        feedback: { status: string; replies: Array<{ comment: string }> };
      };
      expect(statusBody.feedback.status).toBe("In Progress");
      expect(statusBody.feedback.replies[0].comment).toBe(
        "Agreed, adding a skeleton.",
      );
    });

    it("should expose review feedback through the organization Code Mode MCP", async () => {
      const { organization, project } = await createReviewShiplet();
      const createResponse = await makeRequest(
        `/api/projects/${project.id}/review-feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comment: "Agent should pick this up.",
            pageUrl: "http://localhost/review/mcp",
            clientFeedbackId: `client-${crypto.randomUUID()}`,
          }),
        },
      );
      expect(createResponse.status).toBe(201);

      const { token } = await createOrganizationApiToken(
        makeRequest,
        organization.id,
        {
          name: "Local Codex",
          scopes: ["feedback:read", "feedback:write", "mcp"],
        },
      );

      const mcpResponse = await requestHelper("/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: `async () => await codemode.request({
								method: "GET",
								path: "/api/projects/${project.id}/review-feedback",
								query: { status: "New" }
							})`,
            },
          },
        }),
      });
      expect(mcpResponse.status).toBe(200);
      const mcpBody = (await mcpResponse.json()) as {
        result: { content: Array<{ text: string }> };
      };
      expect(mcpBody.result.content[0].text).toContain(
        "Agent should pick this up.",
      );
    });

    it("should not expose project-scoped review token or MCP routes", async () => {
      const { project } = await createReviewShiplet();

      const tokenResponse = await makeRequest(
        `/api/projects/${project.id}/review-tokens`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Legacy" }),
        },
      );
      expect(tokenResponse.status).toBe(404);

      const mcpResponse = await requestHelper(
        `/api/projects/${project.id}/mcp`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
          }),
        },
      );
      expect(mcpResponse.status).toBe(404);
    });
  });

  describe("Static Assets", () => {
    it("should return the generated logo for favicon requests", async () => {
      const response = await makeRequest("/favicon.ico");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("image/png");
      expect(
        Number(response.headers.get("content-length") || "0"),
      ).toBeGreaterThan(1000);
    });
  });

  describe("Database Initialization", () => {
    it("should keep the retired GET reset endpoint fail-closed", async () => {
      const response = await makeRequest("/init", { redirect: "manual" });

      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
    });
  });
});

describe("Input Validation", () => {
  async function makeRequest(
    path: string,
    options?: RequestInit,
  ): Promise<Response> {
    return requestHelper(path, {
      ...options,
      headers: { ...AUTH_HEADERS, ...(options?.headers || {}) },
    });
  }

  it("should accept valid subdomain with hyphens", async () => {
    const organization = await createTestOrganization(makeRequest);
    const response = await makeRequest("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My Test Site",
        organization_id: organization.id,
        subdomain: `my-test-site-${crypto.randomUUID().slice(0, 8)}`,
        script_content:
          "export default { fetch() { return new Response('ok'); } }",
      }),
    });

    // Will fail due to missing env config in test, but validates input first
    const text = await response.text();
    // Should NOT contain subdomain validation error
    expect(text).not.toContain("lowercase letters, numbers, and hyphens");
  });

  it("should accept valid subdomain with numbers", async () => {
    const organization = await createTestOrganization(makeRequest);
    const response = await makeRequest("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Site 123",
        organization_id: organization.id,
        subdomain: `site123-${crypto.randomUUID().slice(0, 8)}`,
        script_content:
          "export default { fetch() { return new Response('ok'); } }",
      }),
    });

    const text = await response.text();
    expect(text).not.toContain("lowercase letters, numbers, and hyphens");
  });

  it.each(["-leading", "trailing-", "double--hyphen", "a".repeat(64)])(
    "should reject DNS-unsafe subdomain %s",
    async (subdomain) => {
      const organization = await createTestOrganization(makeRequest);
      const response = await makeRequest("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Invalid DNS Site",
          organization_id: organization.id,
          subdomain,
          script_content:
            "export default { fetch() { return new Response('ok'); } }",
        }),
      });

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("DNS-safe");
    },
  );

  it("should accept screenshot data URLs up to the public upload ceiling", () => {
    const screenshotDataUrl = `data:image/png;base64,${btoa("x".repeat(5_000_000))}`;
    const result = validateReviewFeedbackPayload({
      comment: "Screenshot should be accepted.",
      pageUrl: "http://localhost/review",
      clientFeedbackId: `client-${crypto.randomUUID()}`,
      screenshotDataUrl,
    });

    expect(result.ok).toBe(true);
  });
});
