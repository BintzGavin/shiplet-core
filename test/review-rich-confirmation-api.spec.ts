import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  createEmbedReviewSession,
  createEmbedReviewSessionCookieHeader,
} from "../src/embed";
import app from "../src/index";
import type { ReviewRichPayloadV1 } from "../src/review-rich-payload";
import { getUser } from "../src/store";

const OWNER = {
  "x-shiplet-user-id": "user_r2_confirmation_owner",
  "x-shiplet-user-email": "r2-confirmation-owner@example.com",
};

async function request(path: string, init: RequestInit = {}, runtime = env as Env) {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(`http://localhost${path}`, init),
    runtime,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

function pngBytes(size = 32) {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function dataUrl(bytes: Uint8Array, contentType = "image/png") {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

function richPayload(overrides: Partial<ReviewRichPayloadV1> = {}): ReviewRichPayloadV1 {
  return {
    version: 1,
    screenshotAnnotations: {
      version: 1,
      coordinateSpace: "normalized",
      imageWidth: 100,
      imageHeight: 100,
      shapes: [
        {
          id: "annotation-1",
          type: "text",
          color: "#AABBCC",
          x: 0.1,
          y: 0.1,
          width: 0.4,
          height: 0.2,
          fontSize: 16,
          text: "Review this area",
        },
      ],
    },
    captureFidelity: {
      version: 1,
      kind: "sanitized-dom",
      limitations: ["images", "external-styles"],
    },
    attachments: [
      {
        id: "capture-1",
        name: "capture.png",
        mimeType: "image/png",
        size: 32,
        dataUrl: dataUrl(pngBytes()),
      },
    ],
    copyRequest: {
      version: 1,
      changes: [
        {
          id: "copy-1",
          kind: "text",
          selector: "h1",
          previousText: "Before",
          proposedText: "After",
        },
        {
          id: "copy-2",
          kind: "template",
          selector: "[data-copy]",
          previousText: "{{title}}",
          proposedText: "{{title}}",
        },
        {
          id: "copy-3",
          kind: "image",
          selector: "img.hero",
          attachmentId: "capture-1",
          altText: "A changed hero",
        },
      ],
    },
    ...overrides,
  };
}

async function fixture(options: { external?: boolean } = {}) {
  const organizationResponse = await request("/api/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({ name: `R2 organization ${crypto.randomUUID()}` }),
  });
  expect(organizationResponse.status).toBe(201);
  const { organization } = (await organizationResponse.json()) as { organization: { id: string } };
  const subdomain = `r2-${crypto.randomUUID().slice(0, 8)}`;
  const projectResponse = await request("/api/shiplets", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({
      name: "R2 review project",
      organization_id: organization.id,
      subdomain,
      visibility: "organization",
      ...(options.external
        ? { external_url: "https://r2-artifact.example/" }
        : { assets: [{ path: "index.html", content: btoa("<!doctype html><h1>R2</h1>") }] }),
    }),
  });
  expect(projectResponse.status).toBe(201);
  const { project } = (await projectResponse.json()) as { project: { id: string; subdomain: string } };
  const packageResponse = await request(`/api/shiplets/${project.id}/package`, { headers: OWNER });
  expect(packageResponse.status).toBe(200);
  const revision = await (env as Env).DB
    .prepare("SELECT active_revision_id FROM projects WHERE id = ?")
    .bind(project.id)
    .first<{ active_revision_id: string }>();
  return {
    organization,
    project,
    revisionId: revision!.active_revision_id,
    pageUrl: options.external ? "https://r2-artifact.example/docs" : `http://localhost/${project.subdomain}`,
  };
}

async function embedBinding(projectId: string, organizationId: string, revisionId: string, pageUrl: string) {
  const user = await getUser((env as Env).DB, OWNER["x-shiplet-user-id"]);
  const installationId = `embed_installation_${crypto.randomUUID()}`;
  const siteOrigin = new URL(pageUrl).origin;
  const now = new Date().toISOString();
  await (env as Env).DB.prepare(
    `INSERT INTO embed_installations (
      id, project_id, organization_id, site_origin, site_url, site_name,
      secret_hash, created_by_user_id, created_on, last_used_on, revoked_on
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).bind(
    installationId,
    projectId,
    organizationId,
    siteOrigin,
    `${siteOrigin}/`,
    "R2 site",
    `browser-only:${crypto.randomUUID()}`,
    user!.id,
    now,
  ).run();
  const installation = await (env as Env).DB
    .prepare("SELECT * FROM embed_installations WHERE id = ?")
    .bind(installationId)
    .first<any>();
  const session = await createEmbedReviewSession((env as Env).DB, {
    installation,
    project: await (env as Env).DB.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first<any>(),
    revisionId,
    user: user!,
    pageUrl,
  });
  const cookie = createEmbedReviewSessionCookieHeader({
    installationId,
    sessionHandle: session.sessionHandle,
    now: new Date(),
    expiresOn: session.expiresOn,
  }).split(";", 1)[0];
  return { installationId, cookie, pageUrl, siteOrigin };
}

function richBody(pageUrl: string, payload: ReviewRichPayloadV1, extra: Record<string, unknown> = {}) {
  return {
    comment: "Rich confirmation summary",
    pageUrl,
    clientFeedbackId: `r2-${crypto.randomUUID()}`,
    richPayload: payload,
    ...extra,
  };
}

async function createRichDirect(projectId: string, pageUrl: string, extra: Record<string, unknown> = {}) {
  const response = await request(`/api/projects/${projectId}/review-feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify(richBody(pageUrl, richPayload(), extra)),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { feedback: any };
}

function intentIdFromConfirmation(html: string) {
  return html.match(/name="intent_id" value="([^"]+)"/)?.[1] || "";
}

function private404(response: Response) {
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
}

describe("rich confirmation, trusted assets, and mention authority", () => {
  it("accepts same-origin embedded direct rich submit exactly once with bound replay and conflict checks", async () => {
    const { organization, project, revisionId, pageUrl } = await fixture();
    const embed = await embedBinding(project.id, organization.id, revisionId, pageUrl);
    const requestId = `request_${crypto.randomUUID()}`;
    const body = richBody(pageUrl, richPayload(), { requestId, reviewRevisionId: revisionId });
    const headers = {
      Origin: "http://localhost",
      "Content-Type": "application/json",
      Cookie: embed.cookie,
    };
    const first = await request(
      `/embed/review/feedback?installation_id=${encodeURIComponent(embed.installationId)}`,
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    expect(first.status, await first.clone().text()).toBe(201);
    const firstBody = (await first.json()) as { feedback: any };
    expect(firstBody.feedback.attachments).toHaveLength(1);

    const replay = await request(
      `/embed/review/feedback?installation_id=${encodeURIComponent(embed.installationId)}`,
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    expect(replay.status, await replay.clone().text()).toBe(201);
    const replayBody = (await replay.json()) as { feedback: any };
    expect(replayBody.feedback.id).toBe(firstBody.feedback.id);

    const conflict = await request(
      `/embed/review/feedback?installation_id=${encodeURIComponent(embed.installationId)}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, comment: "Changed after durable submit" }),
      },
    );
    expect(conflict.status).toBe(409);

    const wrongOrigin = await request(
      `/embed/review/feedback?installation_id=${encodeURIComponent(embed.installationId)}`,
      {
        method: "POST",
        headers: { ...headers, Origin: "https://wrong.example" },
        body: JSON.stringify({ ...body, requestId: `request_${crypto.randomUUID()}` }),
      },
    );
    expect(wrongOrigin.status).toBe(403);

    const wrongPage = await request(
      `/embed/review/feedback?installation_id=${encodeURIComponent(embed.installationId)}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...body,
          requestId: `request_${crypto.randomUUID()}`,
          pageUrl: `${pageUrl}/wrong`,
        }),
      },
    );
    expect(wrongPage.status).toBe(403);

    const stored = await (env as Env).DB.prepare(
      "SELECT payload_json FROM embed_review_operation_intents WHERE request_id = ?",
    ).bind(requestId).first<{ payload_json: string }>();
    expect(stored?.payload_json).toContain("captureFidelity");
    expect(stored?.payload_json).toContain("copyRequest");
  });

  it("preserves the shared durable screenshot when a concurrent same-ID rich retry loses its batch fence", async () => {
    const { organization, project, revisionId, pageUrl } = await fixture();
    const embed = await embedBinding(project.id, organization.id, revisionId, pageUrl);
    const screenshot = pngBytes(300_000);
    const body = richBody(pageUrl, richPayload(), {
      requestId: `request_${crypto.randomUUID()}`,
      reviewRevisionId: revisionId,
      screenshotDataUrl: dataUrl(screenshot),
      screenshotFailureNote: null,
      screenshotMode: "page",
      viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
      coordinates: { pageX: 0, pageY: 0, viewportX: 0, viewportY: 0 },
      selectedElement: null,
      captureContext: { documentWidth: 1280, documentHeight: 1600, scrollX: 0, scrollY: 0 },
    });
    const screenshotKey = `projects/${project.id}/feedback/`;
    const assets = (env as Env).REVIEW_ASSETS!;
    let promotionReads = 0;
    let releasePromotionReads!: () => void;
    const bothPromotionReads = new Promise<void>((resolve) => { releasePromotionReads = resolve; });
    const gatedAssets = new Proxy(assets, {
      get(target, property) {
        const original = Reflect.get(target, property, target);
        if (property === "get") {
          return async (key: string, ...options: unknown[]) => {
            const object = await Reflect.apply(original, target, [key, ...options]);
            if (key.startsWith(screenshotKey) && !key.slice(screenshotKey.length).includes("/")) {
              promotionReads += 1;
              if (promotionReads === 2) releasePromotionReads();
              await bothPromotionReads;
            }
            return object;
          };
        }
        return typeof original === "function" ? original.bind(target) : original;
      },
    }) as R2Bucket;
    const runtime = { ...(env as Env), REVIEW_ASSETS: gatedAssets } as Env;
    const headers = {
      Origin: "http://localhost",
      "Content-Type": "application/json",
      Cookie: embed.cookie,
    };
    const submit = () => request(
      `/embed/review/feedback?installation_id=${encodeURIComponent(embed.installationId)}`,
      { method: "POST", headers, body: JSON.stringify(body) },
      runtime,
    );

    const responses = await Promise.all([submit(), submit()]);
    expect(promotionReads).toBe(2);
    const responseBodies = await Promise.all(responses.map(async (response) => {
      expect(response.status, await response.clone().text()).toBe(201);
      return response.json() as Promise<{ feedback: { id: string } }>;
    }));
    expect(responseBodies[0]?.feedback.id).toBe(responseBodies[1]?.feedback.id);

    const feedbackId = responseBodies[0]!.feedback.id;
    const replay = await submit();
    expect(replay.status, await replay.clone().text()).toBe(201);
    expect((await replay.json() as { feedback: { id: string } }).feedback.id).toBe(feedbackId);

    const counts = await (env as Env).DB.prepare(
      `SELECT
       (SELECT COUNT(*) FROM review_feedback WHERE project_id = ?) AS feedback,
       (SELECT COUNT(*) FROM shiplet_events WHERE project_id = ? AND event_kind = 'review.feedback-created') AS events,
       (SELECT COUNT(*) FROM shiplet_audit_events WHERE project_id = ? AND event_kind = 'review.feedback_created') AS audits`,
    ).bind(project.id, project.id, project.id).first<any>();
    expect(counts).toMatchObject({ feedback: 1, events: 1, audits: 1 });

    const screenshotResponse = await request(
      `/api/projects/${project.id}/review-feedback/${feedbackId}/screenshot`,
      { headers: OWNER },
    );
    expect(screenshotResponse.status).toBe(200);
    expect(new Uint8Array(await screenshotResponse.arrayBuffer())).toEqual(screenshot);
  });

  it("preserves rich structure through general confirmation, completion, replay, list, and detail", async () => {
    const { project, revisionId, pageUrl } = await fixture();
    const payload = richPayload();
    const requestId = `request_${crypto.randomUUID()}`;
    const form = new URLSearchParams({
      request_id: requestId,
      operation: "feedback.create",
      shiplet_id: project.id,
      revision_id: revisionId,
      comment: "Rich confirmation summary",
      page_url: pageUrl,
      client_feedback_id: `r2-${crypto.randomUUID()}`,
      rich_payload_json: JSON.stringify(payload),
    });
    const originalFetch = globalThis.fetch;
    let unexpectedFetches = 0;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      unexpectedFetches += 1;
      throw new Error("copy replacement fetch must remain inert");
    }) as typeof fetch;
    let intentId = "";
    let preparedHtml = "";
    try {
      const prepared = await request("/review/confirm", {
        method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded", ...OWNER },
        body: form,
      });
      expect(prepared.status, await prepared.clone().text()).toBe(200);
      preparedHtml = await prepared.text();
      expect(preparedHtml).toContain("Rich confirmation summary");
      intentId = intentIdFromConfirmation(preparedHtml);
      expect(intentId).toMatch(/^review_intent_/);
      expect(preparedHtml).not.toContain("projects/");
      expect(preparedHtml).not.toContain("sha256:");

      const complete = await request("/review/confirm/complete", {
        method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded", ...OWNER },
        body: new URLSearchParams({ intent_id: intentId, approval: "confirm" }),
      });
      expect(complete.status, await complete.clone().text()).toBe(200);
      expect((await complete.text())).toContain('data-shiplet-confirmation="complete"');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(unexpectedFetches).toBe(0);

    const replay = await request("/review/confirm/complete", {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded", ...OWNER },
      body: new URLSearchParams({ intent_id: intentId, approval: "confirm" }),
    });
    expect(replay.status).toBe(200);
    const replayHtml = await replay.text();
    expect(replayHtml).toContain('data-shiplet-confirmation="complete"');

    const operation = await (env as Env).DB.prepare(
      "SELECT result_feedback_id, payload_json FROM embed_review_operation_intents WHERE id = ?",
    ).bind(intentId).first<{ result_feedback_id: string; payload_json: string }>();
    expect(operation?.result_feedback_id).toMatch(/^review_/);
    expect(operation?.payload_json).toContain("captureFidelity");
    expect(operation?.payload_json).not.toContain("data:image/");
    const list = await request(`/api/projects/${project.id}/review-feedback?state=all`, { headers: OWNER });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { feedback: any[] };
    const saved = listed.feedback.find((item) => item.id === operation?.result_feedback_id);
    expect(saved).toMatchObject({ review_kind: "copy_request" });
    expect(saved.attachments).toHaveLength(1);
    expect(saved.capture_context).toMatchObject({ captureFidelity: payload.captureFidelity });
    const detail = await request(`/api/projects/${project.id}/review-feedback/${operation?.result_feedback_id}`, { headers: OWNER });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      feedback: { attachments: unknown[] };
    };
    expect(detailBody.feedback.attachments).toHaveLength(1);
  });

  it("derives surface-specific attachment URLs and enforces exact GET/HEAD headers and private 404s", async () => {
    const { organization, project, revisionId, pageUrl } = await fixture();
    const { feedback } = await createRichDirect(project.id, pageUrl);
    const attachmentId = feedback.attachments[0].id as string;
    const generalPath = `/api/projects/${project.id}/review-feedback/${feedback.id}/attachments/${attachmentId}`;
    const general = await request(generalPath, { headers: OWNER });
    expect(general.status).toBe(200);
    expect(general.headers.get("content-type")).toBe("image/png");
    expect(general.headers.get("content-length")).toBe("32");
    expect(general.headers.get("cache-control")).toBe("private, no-store");
    expect(general.headers.get("x-content-type-options")).toBe("nosniff");
    expect(general.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(general.headers.get("access-control-allow-origin")).toBeNull();
    expect(general.headers.get("content-disposition")).toContain("inline");
    expect(new Uint8Array(await general.arrayBuffer())).toEqual(pngBytes());

    const generalHead = await request(generalPath, { method: "HEAD", headers: OWNER });
    expect(generalHead.status).toBe(200);
    expect(await generalHead.text()).toBe("");
    expect(generalHead.headers.get("content-length")).toBe("32");

    const hosted = await request(`/${project.subdomain}/__shiplet/review/feedback/${feedback.id}/attachments/${attachmentId}`, { headers: OWNER });
    expect(hosted.status).toBe(200);
    expect(new Uint8Array(await hosted.arrayBuffer())).toEqual(pngBytes());
    const hostedHead = await request(`/${project.subdomain}/__shiplet/review/feedback/${feedback.id}/attachments/${attachmentId}`, { method: "HEAD", headers: OWNER });
    expect(hostedHead.status).toBe(200);
    expect(await hostedHead.text()).toBe("");

    private404(await request(
      `/${project.subdomain}/__shiplet/review/feedback/${feedback.id}/attachments/${attachmentId}?revision_id=stale-revision`,
      { headers: OWNER },
    ));
    private404(await request(
      `/${project.subdomain}/__shiplet/review/feedback/${feedback.id}/attachments/${attachmentId}?page_url=${encodeURIComponent("https://wrong.example/page")}`,
      { headers: OWNER },
    ));

    const embed = await embedBinding(project.id, organization.id, revisionId, pageUrl);
    const embedPath = `/embed/review/feedback/${feedback.id}/attachments/${attachmentId}?installation_id=${encodeURIComponent(embed.installationId)}&page_url=${encodeURIComponent(pageUrl)}`;
    const embedded = await request(embedPath, { headers: { Cookie: embed.cookie } });
    expect(embedded.status).toBe(200);
    expect(new Uint8Array(await embedded.arrayBuffer())).toEqual(pngBytes());
    const embeddedHead = await request(embedPath, { method: "HEAD", headers: { Cookie: embed.cookie } });
    expect(embeddedHead.status).toBe(200);
    expect(await embeddedHead.text()).toBe("");
    private404(await request(
      `${embedPath}&revision_id=stale-revision`,
      { headers: { Cookie: embed.cookie } },
    ));
    private404(await request(
      embedPath.replace(encodeURIComponent(pageUrl), encodeURIComponent("https://wrong.example/page")),
      { headers: { Cookie: embed.cookie } },
    ));
    private404(await request(
      embedPath.replace(encodeURIComponent(embed.installationId), "unknown-installation"),
      { headers: { Cookie: embed.cookie } },
    ));

    for (const path of [
      generalPath.replace(feedback.id, "feedback-guessed"),
      generalPath.replace(attachmentId, "attachment-guessed"),
      `/${project.subdomain}/__shiplet/review/feedback/${feedback.id}/attachments/${attachmentId.replace("capture", "foreign")}`,
    ]) private404(await request(path, { headers: OWNER }));
    private404(await request(generalPath, { headers: { ...OWNER, "x-shiplet-user-id": "user_foreign_r2", "x-shiplet-user-email": "foreign-r2@example.com" } }));
    const revoked = await (env as Env).DB.prepare("UPDATE embed_installations SET revoked_on = ? WHERE id = ?").bind(new Date().toISOString(), embed.installationId).run();
    expect(revoked.meta.changes).toBe(1);
    private404(await request(embedPath, { headers: { Cookie: embed.cookie } }));
  });

  it("keeps active SVG downloads, verifies tampering, and never exposes object keys", async () => {
    const { project, pageUrl } = await fixture();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"/></svg>';
    const response = await request(`/api/projects/${project.id}/review-feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify(richBody(pageUrl, richPayload({
        attachments: [{ id: "vector", name: "vector.svg", mimeType: "image/svg+xml", size: svg.length, dataUrl: dataUrl(new TextEncoder().encode(svg), "image/svg+xml") }],
        copyRequest: null,
      }))),
    });
    expect(response.status).toBe(201);
    const { feedback } = (await response.json()) as { feedback: any };
    expect(JSON.stringify(feedback)).not.toContain("object_key");
    const read = await request(`/api/projects/${project.id}/review-feedback/${feedback.id}/attachments/vector`, { headers: OWNER });
    expect(read.status).toBe(200);
    expect(read.headers.get("content-disposition")).toContain("attachment");
    const row = await (env as Env).DB.prepare("SELECT object_key, digest FROM review_feedback_attachments WHERE feedback_id = ?").bind(feedback.id).first<{ object_key: string; digest: string }>();
    expect(row?.object_key).toContain(`/feedback/${feedback.id}/attachments/vector/`);
    await (env as Env).DB.prepare("UPDATE review_feedback_attachments SET digest = ? WHERE feedback_id = ? AND attachment_id = ?").bind("sha256:" + "0".repeat(64), feedback.id, "vector").run();
    private404(await request(`/api/projects/${project.id}/review-feedback/${feedback.id}/attachments/vector`, { headers: OWNER }));
  });

  it("paginates every authorized modern mention candidate in stable equal-label order and binds cursors", async () => {
    const { organization, project, pageUrl, revisionId } = await fixture();
    const now = new Date().toISOString();
    const localUsers = Array.from({ length: 61 }, (_, index) => ({
      id: `user_r2_candidate_${String(index).padStart(3, "0")}`,
      email: `candidate-${String(index).padStart(3, "0")}@r2.example.com`,
    }));
    const foreignId = `user_r2_foreign_${crypto.randomUUID()}`;
    await (env as Env).DB.batch([
      ...localUsers.map((user) => (env as Env).DB.prepare(
        "INSERT INTO users (id, email, first_name, last_name, created_on, updated_on) VALUES (?, ?, 'Equal', 'Label', ?, ?)",
      ).bind(user.id, user.email, now, now)),
      (env as Env).DB.prepare("INSERT INTO users (id, email, first_name, last_name, created_on, updated_on) VALUES (?, ?, 'Equal', 'Label', ?, ?)").bind(foreignId, `foreign-${crypto.randomUUID()}@r2-foreign.example`, now, now),
      ...localUsers.map((user, index) => (env as Env).DB.prepare(
        "INSERT INTO organization_memberships (id, organization_id, user_id, role, created_on) VALUES (?, ?, ?, 'member', ?)",
      ).bind(`membership_${user.id}`, organization.id, user.id, now)),
    ]);
    const makePage = async (path: string, headers: HeadersInit = OWNER) => {
      const response = await request(path, { headers });
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as { users: Array<{ id: string; label: string }>; nextCursor: string | null };
    };
    const all: Array<{ id: string; label: string }> = [];
    let cursor: string | null = null;
    do {
      const page = await makePage(`/api/projects/${project.id}/review-mention-users?q=equal&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      all.push(...page.users);
      cursor = page.nextCursor;
    } while (cursor);
    expect(all).toHaveLength(61);
    expect(new Set(all.map((user) => user.id)).size).toBe(61);
    expect(all.every((user) => user.label === "Equal Label")).toBe(true);
    expect(all.map((user) => user.id)).toEqual([...all].sort((left, right) => left.id.localeCompare(right.id)).map((user) => user.id));
    expect(all.map((user) => user.id)).not.toContain(foreignId);

    const first = await makePage(`/${project.subdomain}/__shiplet/review/mention-users?q=equal&limit=20`, OWNER);
    expect(first.users).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    const embed = await embedBinding(project.id, organization.id, revisionId, pageUrl);
    const embeddedMention = await makePage(`/embed/review/mention-users?installation_id=${encodeURIComponent(embed.installationId)}&page_url=${encodeURIComponent(pageUrl)}&q=equal&limit=20`, { Cookie: embed.cookie });
    expect(embeddedMention.users).toHaveLength(20);

    const empty = await request(`/api/projects/${project.id}/review-mention-users?q=%20%20&limit=20`, { headers: OWNER });
    expect(empty.status).toBe(400);
    const tooLong = await request(`/api/projects/${project.id}/review-mention-users?q=${"a".repeat(81)}`, { headers: OWNER });
    expect(tooLong.status).toBe(400);
    const badLimit = await request(`/api/projects/${project.id}/review-mention-users?q=equal&limit=21`, { headers: OWNER });
    expect(badLimit.status).toBe(400);
    const malformed = await request(`/api/projects/${project.id}/review-mention-users?q=equal&cursor=not.valid+cursor`, { headers: OWNER });
    expect(malformed.status).toBe(400);
    const transplanted = await request(`/api/projects/${project.id}/review-mention-users?q=other&limit=20&cursor=${encodeURIComponent(first.nextCursor!)}`, { headers: OWNER });
    expect(transplanted.status).toBe(400);
    const legacy = await request(`/api/projects/${project.id}/review-mention-users`, { headers: OWNER });
    expect(legacy.status).toBe(200);
    expect(Object.keys(await legacy.json())).toEqual(["users"]);
    const sandbox = await request("/api/projects/sandbox-sbx_123456789012345678901234-demo/review-mention-users", { headers: OWNER });
    expect(sandbox.status).toBe(409);
    expect(await sandbox.json()).toEqual({ error: "sandbox_mentions_unsupported" });
  });

  it("shows selected recipients, keeps copy inert, and rolls back every effect after membership removal", async () => {
    const { organization, project, revisionId, pageUrl } = await fixture();
    const recipientId = `user_r2_recipient_${crypto.randomUUID()}`;
    const recipientEmail = `recipient-${crypto.randomUUID()}@r2.example.com`;
    const now = new Date().toISOString();
    await (env as Env).DB.batch([
      (env as Env).DB.prepare("INSERT INTO users (id, email, first_name, last_name, created_on, updated_on) VALUES (?, ?, 'Selected', 'Recipient', ?, ?)").bind(recipientId, recipientEmail, now, now),
      (env as Env).DB.prepare("INSERT INTO organization_memberships (id, organization_id, user_id, role, created_on) VALUES (?, ?, ?, 'member', ?)").bind(`membership_${recipientId}`, organization.id, recipientId, now),
    ]);
    const requestId = `request_${crypto.randomUUID()}`;
    const body = new URLSearchParams({
      request_id: requestId,
      operation: "feedback.create",
      shiplet_id: project.id,
      revision_id: revisionId,
      comment: "@Selected Recipient is only an inert string",
      page_url: pageUrl,
      client_feedback_id: `r2-${crypto.randomUUID()}`,
      mentions_json: JSON.stringify([{ userId: recipientId }]),
      rich_payload_json: JSON.stringify(richPayload({ copyRequest: null })),
    });
    const prepared = await request("/review/confirm", {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded", ...OWNER },
      body,
    });
    expect(prepared.status).toBe(200);
    const html = await prepared.text();
    expect(html).toContain(recipientId);
    const intentId = intentIdFromConfirmation(html);
    await (env as Env).DB.prepare("DELETE FROM organization_memberships WHERE organization_id = ? AND user_id = ?").bind(organization.id, recipientId).run();
    const complete = await request("/review/confirm/complete", {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded", ...OWNER },
      body: new URLSearchParams({ intent_id: intentId, approval: "confirm" }),
    });
    expect([409, 500]).toContain(complete.status);
    const counts = await (env as Env).DB.prepare(
      `SELECT
       (SELECT COUNT(*) FROM review_feedback WHERE project_id = ?) AS feedback,
       (SELECT COUNT(*) FROM review_feedback_attachments WHERE project_id = ?) AS attachments,
       (SELECT COUNT(*) FROM review_feedback_mentions WHERE project_id = ?) AS mentions,
       (SELECT COUNT(*) FROM review_notifications WHERE project_id = ?) AS notifications,
       (SELECT COUNT(*) FROM shiplet_events WHERE project_id = ? AND event_kind = 'review.feedback-created') AS events,
       (SELECT COUNT(*) FROM shiplet_audit_events WHERE project_id = ? AND event_kind = 'review.feedback_created') AS audits`,
    ).bind(project.id, project.id, project.id, project.id, project.id, project.id).first<any>();
    expect(counts).toMatchObject({ feedback: 0, attachments: 0, mentions: 0, notifications: 0, events: 0, audits: 0 });
    const intent = await (env as Env).DB.prepare("SELECT completed_on, failed_on FROM embed_review_operation_intents WHERE id = ?").bind(intentId).first<any>();
    expect(intent?.completed_on).toBeNull();
    expect(intent?.failed_on).toBeNull();
  });

  it("keeps legacy no-rich writes and nullable fidelity records compatible", async () => {
    const { project, pageUrl } = await fixture();
    const response = await request(`/api/projects/${project.id}/review-feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({ comment: "Legacy no-rich", pageUrl, clientFeedbackId: `legacy-${crypto.randomUUID()}` }),
    });
    expect(response.status).toBe(201);
    const { feedback } = (await response.json()) as { feedback: any };
    expect(feedback).toMatchObject({ review_kind: "comment", copy_changes: null, attachments: [] });
    expect(feedback.capture_context?.captureFidelity ?? null).toBeNull();
    const row = await (env as Env).DB.prepare("SELECT revision_id, review_kind, copy_changes_json, capture_context_json FROM review_feedback WHERE id = ?").bind(feedback.id).first<any>();
    expect(row?.review_kind).toBe("comment");
    expect(row?.copy_changes_json).toBeNull();
    expect(row?.capture_context_json).toBeNull();
  });
});
