import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import * as embedContracts from "../src/embed";
import {
  claimEmbedReviewOperationReceipt,
  createEmbedReviewSessionCookieHeader,
  normalizeEmbedReviewPageUrl,
  publicEmbedReviewSession,
  readEmbedReviewSessionHandle,
  validateEmbedReviewSessionBinding,
} from "../src/embed";

// Website-widget review sessions: the shared embedded review boundary that
// every `<shiplet-feedback>` installation registered at /embed/install uses.

const OWNER_HEADERS = {
  "x-shiplet-user-id": "user_embed_review_owner",
  "x-shiplet-user-email": "embed-review-owner@example.com",
};
const SITE_ORIGIN = "https://client.example.com";

async function request(path: string, options?: RequestInit) {
  const url = /^https?:\/\//.test(path) ? path : `http://localhost${path}`;
  const executionContext = createExecutionContext();
  let response: Response;
  try {
    response = await app.fetch(
      new Request(url, options),
      env as Env,
      executionContext,
    );
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    response = error;
  }
  await waitOnExecutionContext(executionContext);
  return response;
}

async function createOrganization() {
  const response = await request("/api/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
    body: JSON.stringify({ name: `Embed review ${crypto.randomUUID()}` }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    organization: { id: string; name: string };
  };
}

async function createExternalProject(organizationId: string) {
  const response = await request("/api/shiplets", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
    body: JSON.stringify({
      name: "Client website",
      organization_id: organizationId,
      subdomain: `embed-review-${crypto.randomUUID().slice(0, 8)}`,
      external_url: `${SITE_ORIGIN}/`,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    project: { id: string; name: string };
  };
}

function setupForm(projectId: string, extra: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { ...OWNER_HEADERS, Origin: "http://localhost" },
    body: new URLSearchParams({
      project_id: projectId,
      site_url: `${SITE_ORIGIN}/`,
      ...extra,
    }),
  } satisfies RequestInit;
}

async function activeInstallationId(projectId: string) {
  const row = await (env as Env).DB.prepare(
    `SELECT id FROM embed_installations
     WHERE project_id = ? AND site_origin = ? AND revoked_on IS NULL`,
  )
    .bind(projectId, SITE_ORIGIN)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function installWebsite(projectId: string) {
  const response = await request("/embed/install", setupForm(projectId));
  expect(response.status).toBe(200);
  const installationId = await activeInstallationId(projectId);
  expect(installationId).toBeTruthy();
  return { installation: { id: installationId! } };
}

async function disconnectWebsite(projectId: string, installationId: string) {
  const response = await request(
    "/embed/install",
    setupForm(projectId, { action: "revoke", installation_id: installationId }),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("Site disconnected");
}

async function installedProject() {
  const { organization } = await createOrganization();
  const { project } = await createExternalProject(organization.id);
  const installed = await installWebsite(project.id);
  return { organization, project, ...installed };
}

async function startReviewSession(
  installationId: string,
  pageUrl = `${SITE_ORIGIN}/pricing/?campaign=summer`,
) {
  const start = await request(
    `/embed/review/start?${new URLSearchParams({
      installation_id: installationId,
      return_url: pageUrl,
    })}`,
    { redirect: "manual", headers: OWNER_HEADERS },
  );
  return {
    start,
    location: start.headers.get("location") || "",
    cookie: (start.headers.get("set-cookie") || "").split(";", 1)[0],
    pageUrl,
  };
}

async function installActiveWidgetRevision(
  projectId: string,
  widgetFiles: Array<{ path: string; mediaType: string; content: string }>,
) {
  const active = await (env as Env).DB.prepare(
    `SELECT active_revision_id, active_revision_generation
     FROM projects WHERE id = ?`,
  )
    .bind(projectId)
    .first<{
      active_revision_id: string;
      active_revision_generation: number;
    }>();
  if (!active?.active_revision_id) {
    throw new Error("Published website Shiplet is missing its initial revision");
  }
  const revisionId = `revision_widget_${crypto.randomUUID().replace(/-/g, "")}`;
  const createdOn = new Date().toISOString();
  const packageJson = JSON.stringify({
    mediaType: "application/vnd.shiplet.package+json;version=1",
    manifest: {
      schemaVersion: "shiplet.package/v1",
      runtimeCompatibility: "shiplet.runtime/v1",
      staticFirst: true,
      entrypoints: {
        artifact: "artifact/index.html",
        widget: "widget/index.html",
      },
    },
    files: widgetFiles.map((file) => ({
      path: file.path,
      mediaType: file.mediaType,
      size: file.content.length,
    })),
  });
  await (env as Env).DB.batch([
    (env as Env).DB.prepare(
      `INSERT INTO shiplet_revisions (
				id, project_id, parent_revision_id, package_json, package_digest,
				content_digest, runtime_compatibility, validation_report_json,
				created_by_actor_kind, created_by_actor_id, created_on
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      revisionId,
      projectId,
      active.active_revision_id,
      packageJson,
      `package_${revisionId}`,
      `content_${revisionId}`,
      "shiplet.runtime/v1",
      JSON.stringify({ valid: true }),
      "human",
      OWNER_HEADERS["x-shiplet-user-id"],
      createdOn,
    ),
    ...widgetFiles.map((file) =>
      (env as Env).DB.prepare(
        `INSERT INTO shiplet_revision_files (
				revision_id, path, media_type, size, object_key, content_base64
			) VALUES (?, ?, ?, ?, NULL, ?)`,
      ).bind(
        revisionId,
        file.path,
        file.mediaType,
        file.content.length,
        btoa(file.content),
      ),
    ),
    (env as Env).DB.prepare(
      `INSERT INTO shiplet_revision_seals (revision_id, sealed_on)
			 VALUES (?, ?)`,
    ).bind(revisionId, createdOn),
    (env as Env).DB.prepare(
      `UPDATE projects SET active_revision_id = ?, active_revision_generation = ?,
       modified_on = ? WHERE id = ?`,
    ).bind(
      revisionId,
      active.active_revision_generation + 1,
      createdOn,
      projectId,
    ),
  ]);
  const root = (env as Env).SHIPLET_ROOT.getByName(projectId);
  await runInDurableObject(root, async (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE review_layer SET
        version = ?, entry_path = ?, files_json = ?, updated_on = ?
       WHERE singleton = 1`,
      `review_layer_bypass_${revisionId}`,
      "index.html",
      JSON.stringify(
        widgetFiles.map((file) => ({
          path: file.path.replace(/^widget\//, ""),
          mediaType: file.mediaType,
          encoding: "utf8",
          content: file.content,
        })),
      ),
      createdOn,
    );
    expect(_instance).toBeTypeOf("object");
  });
  return { revisionId };
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function createFeedbackOperationReceipt(input: {
  installationId: string;
  projectId: string;
  pageUrl: string;
  comment: string;
  clientFeedbackId: string;
}) {
  const session = await (env as Env).DB.prepare(
    `SELECT revision_id FROM embed_review_sessions
		 WHERE installation_id = ? AND project_id = ?
		 ORDER BY created_on DESC LIMIT 1`,
  )
    .bind(input.installationId, input.projectId)
    .first<{ revision_id: string }>();
  if (!session?.revision_id) throw new Error("review revision required");
  const handle = `receipt_${crypto.randomUUID().replace(/-/g, "")}`;
  const payloadDigest = `sha256:${await sha256Hex(
    JSON.stringify({
      comment: input.comment,
      pageUrl: input.pageUrl,
      clientFeedbackId: input.clientFeedbackId,
    }),
  )}`;
  await (env as Env).DB.prepare(
    `INSERT INTO embed_review_operation_receipts (
			receipt_hash, installation_id, project_id, revision_id,
			actor_user_id, effect, payload_digest, request_id, expires_on, claimed_on
		) VALUES (?, ?, ?, ?, ?, 'feedback.create', ?, ?, ?, NULL)`,
  )
    .bind(
      await sha256Hex(handle),
      input.installationId,
      input.projectId,
      session.revision_id,
      OWNER_HEADERS["x-shiplet-user-id"],
      payloadDigest,
      input.clientFeedbackId,
      new Date(Date.now() + 60_000).toISOString(),
    )
    .run();
  return handle;
}

// A row shaped like the retired server-secret installations: its secret_hash
// is a SHA-256 digest rather than the `browser-only:` marker.
async function insertServerSecretInstallation(
  projectId: string,
  organizationId: string,
) {
  const id = `embed_installation_${crypto.randomUUID().replace(/-/g, "")}`;
  await (env as Env).DB.prepare(
    `INSERT INTO embed_installations
		 (id, project_id, organization_id, site_origin, site_url, site_name,
		  secret_hash, created_by_user_id, created_on, last_used_on, revoked_on)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  )
    .bind(
      id,
      projectId,
      organizationId,
      SITE_ORIGIN,
      `${SITE_ORIGIN}/`,
      "Client site",
      await sha256Hex(`retired-secret-${crypto.randomUUID()}`),
      OWNER_HEADERS["x-shiplet-user-id"],
      new Date().toISOString(),
    )
    .run();
  return id;
}

describe("retired server-secret site connections", () => {
  it("no longer serves the connect, secret exchange, secret disconnect, legacy loader, or artifact widget routes", async () => {
    const { project, installation } = await installedProject();
    const connectQuery = new URLSearchParams({
      site_url: `${SITE_ORIGIN}/`,
      site_name: "Client site",
      return_url: `${SITE_ORIGIN}/callback`,
      state: "connect-state",
      project_id: project.id,
    });
    const session = await startReviewSession(installation.id);
    expect(session.start.status).toBe(302);
    const binding = new URLSearchParams({
      installation_id: installation.id,
      page_url: session.pageUrl,
    });
    const attempts: Array<[string, string, RequestInit]> = [
      [
        "GET /embed/connect",
        `/embed/connect?${connectQuery}`,
        { headers: OWNER_HEADERS },
      ],
      [
        "POST /embed/connect",
        "/embed/connect",
        {
          method: "POST",
          redirect: "manual",
          headers: {
            ...OWNER_HEADERS,
            Origin: "http://localhost",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: connectQuery,
        },
      ],
      [
        "POST /api/embed/installations/exchange",
        "/api/embed/installations/exchange",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: "shiplet_embed_connect_test",
            siteUrl: `${SITE_ORIGIN}/`,
          }),
        },
      ],
      [
        "DELETE /api/embed/installations/:installationId",
        `/api/embed/installations/${installation.id}`,
        {
          method: "DELETE",
          headers: { Authorization: "Bearer shiplet_embed_install_test" },
        },
      ],
      ["GET /api/embed/client.js", "/api/embed/client.js", {}],
      [
        "GET /embed/review/widget",
        `/embed/review/widget?${binding}`,
        { headers: { Cookie: session.cookie } },
      ],
    ];
    for (const [label, path, init] of attempts) {
      const response = await request(path, init);
      expect(response.status, label).toBe(404);
      expect(response.headers.get("location"), label).toBeNull();
    }
    expect(await activeInstallationId(project.id)).toBe(installation.id);
  });

  it("grants no review authority to a stored server-secret installation and lets the site reconnect as a website widget", async () => {
    const { organization } = await createOrganization();
    const { project } = await createExternalProject(organization.id);
    const legacyId = await insertServerSecretInstallation(
      project.id,
      organization.id,
    );
    const returnUrl = `${SITE_ORIGIN}/pricing/`;
    const start = await request(
      `/embed/review/start?${new URLSearchParams({
        installation_id: legacyId,
        return_url: returnUrl,
      })}`,
      { redirect: "manual", headers: OWNER_HEADERS },
    );
    expect(start.status).toBe(404);
    expect(start.headers.get("set-cookie")).toBeNull();
    const authorize = await request(
      `/embed/review/authorize?${new URLSearchParams({
        installation_id: legacyId,
        return_url: returnUrl,
      })}`,
      { headers: OWNER_HEADERS },
    );
    expect(authorize.status).toBe(403);
    expect(await authorize.text()).not.toContain("shiplet_embed_auth_");
    const sessions = await (env as Env).DB.prepare(
      "SELECT COUNT(*) AS count FROM embed_review_sessions WHERE installation_id = ?",
    )
      .bind(legacyId)
      .first<{ count: number }>();
    expect(sessions?.count).toBe(0);
    const setup = await request(`/embed/install?project_id=${project.id}`, {
      headers: OWNER_HEADERS,
    });
    expect(setup.status).toBe(200);
    expect(await setup.text()).not.toContain(legacyId);

    const reconnected = await installWebsite(project.id);
    expect(reconnected.installation.id).not.toBe(legacyId);
    const legacyRow = await (env as Env).DB.prepare(
      "SELECT revoked_on FROM embed_installations WHERE id = ?",
    )
      .bind(legacyId)
      .first<{ revoked_on: string | null }>();
    expect(legacyRow?.revoked_on).toBeTruthy();
    const session = await startReviewSession(reconnected.installation.id);
    expect(session.start.status).toBe(302);
  });
});

describe("website widget review sessions", () => {
  it("establishes review authority only inside an app-origin trusted frame", async () => {
    const { installation } = await installedProject();
    const returnUrl = `${SITE_ORIGIN}/pricing/?shiplet-review=1&campaign=summer`;

    const denied = await request(
      `/embed/review/start?${new URLSearchParams({
        installation_id: installation.id,
        return_url: returnUrl,
      })}`,
      {
        headers: {
          "x-shiplet-user-id": "user_embed_review_outsider",
          "x-shiplet-user-email": "outsider@example.com",
        },
      },
    );
    expect(denied.status).toBe(403);

    const start = await request(
      `/embed/review/start?${new URLSearchParams({
        installation_id: installation.id,
        return_url: returnUrl,
      })}`,
      { redirect: "manual", headers: OWNER_HEADERS },
    );
    expect(start.status).toBe(302);
    const trustedHost = new URL(start.headers.get("location") || "");
    expect(trustedHost.origin).toBe("http://localhost");
    expect(trustedHost.pathname).toBe("/embed/review/host");
    expect(trustedHost.searchParams.get("installation_id")).toBe(
      installation.id,
    );
    expect(trustedHost.searchParams.get("page_url")).toBe(returnUrl);
    for (const credentialParam of [
      "shiplet_embed_code",
      "code",
      "token",
      "session",
      "capability",
    ]) {
      expect(trustedHost.searchParams.has(credentialParam)).toBe(false);
    }

    const cookie = start.headers.get("set-cookie") || "";
    expect(cookie).toContain(`__Host-shiplet_embed_review_${installation.id}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Partitioned");
    expect(cookie).not.toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");

    const publicLocation = `${trustedHost}${cookie}`;
    expect(publicLocation).not.toContain("shiplet_review_cap_v1");
    expect(publicLocation).not.toContain("reviewToken");
    expect(publicLocation).not.toContain("presenceToken");
  });

  it("never grants installation pages direct review API CORS authority", async () => {
    const { project, installation } = await installedProject();
    const feedbackPath = `/api/projects/${project.id}/review-feedback`;

    const clientPagePreflight = await request(feedbackPath, {
      method: "OPTIONS",
      headers: {
        Origin: SITE_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,authorization",
      },
    });
    expect(clientPagePreflight.status).toBe(204);
    expect(
      clientPagePreflight.headers.get("access-control-allow-origin"),
    ).toBeNull();

    const deniedPreflight = await request(feedbackPath, {
      method: "OPTIONS",
      headers: {
        Origin: "https://other.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(
      deniedPreflight.headers.get("access-control-allow-origin"),
    ).toBeNull();

    await disconnectWebsite(project.id, installation.id);

    const afterDisconnect = await request(feedbackPath, {
      method: "OPTIONS",
      headers: {
        Origin: SITE_ORIGIN,
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(
      afterDisconnect.headers.get("access-control-allow-origin"),
    ).toBeNull();

    const start = await request(
      `/embed/review/start?${new URLSearchParams({
        installation_id: installation.id,
        return_url: `${SITE_ORIGIN}/?shiplet-review=1`,
      })}`,
      { headers: OWNER_HEADERS },
    );
    expect(start.status).toBe(410);
  });

  it("does not place a review exchange credential in the installation page", async () => {
    const { installation } = await installedProject();
    const countReviewCodes = async () =>
      (
        await (env as Env).DB.prepare(
          `SELECT COUNT(*) AS count
           FROM embed_exchange_codes
           WHERE installation_id = ? AND purpose = 'review'`,
        )
          .bind(installation.id)
          .first<{ count: number }>()
      )?.count;
    const before = await countReviewCodes();
    const start = await request(
      `/embed/review/start?${new URLSearchParams({
        installation_id: installation.id,
        return_url: `${SITE_ORIGIN}/?shiplet-review=1`,
      })}`,
      { redirect: "manual", headers: OWNER_HEADERS },
    );
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location") || "");
    expect(location.origin).toBe("http://localhost");
    expect(location.searchParams.get("shiplet_embed_code")).toBeNull();
    expect(location.searchParams.get("code")).toBeNull();
    expect(await countReviewCodes()).toBe(before);
  });

  it("serves the trusted host only through its exact HttpOnly session and retires browser token exchange", async () => {
    const { project, installation } = await installedProject();
    const pageUrl = `${SITE_ORIGIN}/pricing/?shiplet-review=1`;
    const start = await request(
      `/embed/review/start?${new URLSearchParams({
        installation_id: installation.id,
        return_url: pageUrl,
      })}`,
      { redirect: "manual", headers: OWNER_HEADERS },
    );
    const location = start.headers.get("location") || "";
    const cookie = (start.headers.get("set-cookie") || "").split(";")[0];
    expect(location).toContain("/embed/review/host");
    expect(cookie).toContain(`__Host-shiplet_embed_review_${installation.id}=`);

    const anonymous = await request(location);
    expect(anonymous.status).toBe(401);

    const mismatched = new URL(location);
    mismatched.searchParams.set("installation_id", "embed_installation_other");
    const mismatchResponse = await request(mismatched.toString(), {
      headers: { Cookie: cookie },
    });
    // Scoped cookie lookup fails before revealing whether another session exists.
    expect(mismatchResponse.status).toBe(401);

    const host = await request(location, { headers: { Cookie: cookie } });
    expect(host.status).toBe(200);
    expect(host.headers.get("content-security-policy")).toContain(
      `frame-ancestors 'self' ${SITE_ORIGIN}`,
    );
    const html = await host.text();
    expect(html).toContain('data-shiplet-trusted-review-host="v1"');
    expect(html).toContain("/embed/review/feedback");
    expect(html).not.toContain(cookie.split("=")[1]);
    for (const forbidden of ["reviewToken", "presenceToken", "Authorization"])
      expect(html).not.toContain(forbidden);

    const hostUrl = new URL(location);
    const feedbackUrl = `/embed/review/feedback?${new URLSearchParams({
      installation_id: installation.id,
      page_url: pageUrl,
    })}`;
    const comment = "Embed boundary feedback";
    const clientFeedbackId = `client-${crypto.randomUUID()}`;
    const operationReceipt = await createFeedbackOperationReceipt({
      installationId: installation.id,
      projectId: project.id,
      pageUrl,
      comment,
      clientFeedbackId,
    });
    const feedbackRequest = {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "http://localhost",
        "Content-Type": "application/json",
        "x-shiplet-operation-receipt": operationReceipt,
      },
      body: JSON.stringify({
        comment,
        pageUrl,
        clientFeedbackId,
        actorUserId: "user_spoofed",
      }),
    } satisfies RequestInit;
    const wrongOrigin = await request(feedbackUrl, {
      ...feedbackRequest,
      headers: { ...feedbackRequest.headers, Origin: "https://attacker.example" },
    });
    expect(wrongOrigin.status).toBe(403);
    const created = await request(feedbackUrl, feedbackRequest);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      feedback: { submitted_by_user_id: string; page_url: string };
    };
    expect(createdBody.feedback.submitted_by_user_id).toBe(
      OWNER_HEADERS["x-shiplet-user-id"],
    );
    expect(createdBody.feedback.page_url).toBe(pageUrl);

    const mismatchedPage = await request(
      `/embed/review/feedback?${hostUrl.searchParams}`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          comment: "Wrong page",
          pageUrl: `${SITE_ORIGIN}/account/`,
          clientFeedbackId: `client-${crypto.randomUUID()}`,
        }),
      },
    );
    expect(mismatchedPage.status).toBe(403);

    const listed = await request(feedbackUrl, { headers: { Cookie: cookie } });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      feedback: Array<{ comment: string }>;
    };
    expect(listedBody.feedback.map((item) => item.comment)).toContain(
      "Embed boundary feedback",
    );

    const retiredExchange = await request(
      `/api/embed/session/exchange?installation_id=${encodeURIComponent(installation.id)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: SITE_ORIGIN,
        },
        body: JSON.stringify({}),
      },
    );
    expect(retiredExchange.status).toBe(410);
    expect(retiredExchange.headers.get("access-control-allow-origin")).toBeNull();
    const retiredBody = await retiredExchange.text();
    expect(retiredBody).not.toContain("reviewToken");
    expect(retiredBody).not.toContain("presenceToken");
  });

  it("requires exact trusted-host origin and a bound direct submission or one-time operation receipt before embedded mutation", async () => {
    const { project, installation } = await installedProject();
    const session = await startReviewSession(installation.id);
    expect(session.start.status).toBe(302);
    const feedbackPath = `/embed/review/feedback?${new URLSearchParams({
      installation_id: installation.id,
      page_url: session.pageUrl,
    })}`;
    const countFeedback = async () =>
      (
        await (env as Env).DB.prepare(
          `SELECT COUNT(*) AS count FROM review_feedback WHERE project_id = ?`,
        )
          .bind(project.id)
          .first<{ count: number }>()
      )?.count;
    const before = await countFeedback();
    const attempt = (
      comment: string,
      headers: Record<string, string>,
    ): RequestInit => ({
      method: "POST",
      headers: { Cookie: session.cookie, ...headers },
      body: JSON.stringify({
        comment,
        pageUrl: session.pageUrl,
        clientFeedbackId: `client-${crypto.randomUUID()}`,
      }),
    });
    const attemptOptions: RequestInit[] = [
      attempt("No origin", { "Content-Type": "application/json" }),
      attempt("Wrong origin JSON", {
        Origin: "https://attacker.example",
        "Content-Type": "application/json",
      }),
      attempt("Simple request CSRF", {
        Origin: SITE_ORIGIN,
        "Content-Type": "text/plain",
      }),
      attempt("Incomplete direct submission", {
        Origin: "http://localhost",
        "Content-Type": "application/json",
      }),
      attempt("Invalid operation receipt", {
        Origin: "http://localhost",
        "Content-Type": "application/json",
        "x-shiplet-operation-receipt": "malformed-test-receipt-not-a-credential",
      }),
    ];
    const attempts: Response[] = [];
    for (const options of attemptOptions) {
      attempts.push(await request(feedbackPath, options));
    }
    expect.soft(attempts.map((response) => response.status)).toEqual([
      403, 403, 403, 400, 403,
    ]);
    const incompleteSubmission = (await attempts[3].json()) as {
      error?: string;
    };
    expect(incompleteSubmission.error).toBe("review_revision_invalid");
    expect(await countFeedback()).toBe(before);
  });

  it("uses an accessible popup authentication bootstrap instead of navigating WorkOS inside the third-party frame", async () => {
    const { installation } = await installedProject();
    const response = await request(
      `/embed/review/start?${new URLSearchParams({
        installation_id: installation.id,
        return_url: `${SITE_ORIGIN}/pricing/`,
      })}`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      `frame-ancestors 'self' ${SITE_ORIGIN}`,
    );
    const html = await response.text();
    expect(html).toContain('data-shiplet-embed-auth-bootstrap="v1"');
    expect(html).toContain('type="button"');
    expect(html).toContain('data-shiplet-embed-action="annotate"');
    expect(html).not.toContain("shiplet_embed_code");
    expect(html).not.toContain("reviewToken");
  });

  it("binds the embed-auth bootstrap script to a fresh route nonce", async () => {
    const { installation } = await installedProject();
    const path = `/embed/review/start?${new URLSearchParams({
      installation_id: installation.id,
      return_url: `${SITE_ORIGIN}/pricing/`,
    })}`;
    const firstResponse = await request(path, { redirect: "manual" });
    const firstHtml = await firstResponse.text();
    const firstCsp = firstResponse.headers.get("content-security-policy") || "";
    const firstNonce =
      firstCsp.match(/script-src[^;]*'nonce-([^']+)'/)?.[1] || "";
    const firstScriptPolicy =
      firstCsp
        .split(";")
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith("script-src ")) || "";
    const firstScript =
      firstHtml.match(
        /<script\b[^>]*src="[^"]*\/api\/embed\/auth-bootstrap\.js"[^>]*>/i,
      )?.[0] || "";
    const secondResponse = await request(path, { redirect: "manual" });
    const secondCsp =
      secondResponse.headers.get("content-security-policy") || "";
    const secondNonce =
      secondCsp.match(/script-src[^;]*'nonce-([^']+)'/)?.[1] || "";

    expect(firstResponse.status).toBe(200);
    expect(firstNonce).toMatch(/^[A-Za-z0-9+/_=-]{20,}$/);
    expect(firstScript).toContain(`nonce="${firstNonce}"`);
    expect(firstScriptPolicy).toBe(`script-src 'nonce-${firstNonce}'`);
    expect(firstCsp).toContain("script-src-attr 'none'");
    expect(secondNonce).toMatch(/^[A-Za-z0-9+/_=-]{20,}$/);
    expect(secondNonce).not.toBe(firstNonce);
  });

  it("rejects an expired sign-in handoff ticket", async () => {
    const { installation } = await installedProject();
    const authorization = await request(
      `/embed/review/authorize?${new URLSearchParams({
        installation_id: installation.id,
        return_url: `${SITE_ORIGIN}/pricing/`,
      })}`,
      { headers: OWNER_HEADERS },
    );
    expect(authorization.status).toBe(200);
    const ticket = (await authorization.text()).match(
      /shiplet_embed_auth_[A-Za-z0-9_-]+/,
    )?.[0];
    expect(ticket).toBeTruthy();
    await (env as Env).DB.prepare(
      "UPDATE embed_exchange_codes SET expires_on = ? WHERE code_hash = ?",
    )
      .bind("2000-01-01T00:00:00.000Z", await sha256Hex(ticket!))
      .run();
    const redeemed = await request("/embed/review/authorize", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ installation_id: installation.id, ticket: ticket! }),
    });
    expect(redeemed.status).toBe(403);
    expect(redeemed.headers.get("set-cookie")).toBeNull();
  });

  it("keeps the active revision widget on the app host and out of the website review host", async () => {
    const { organization } = await createOrganization();
    const { project } = await createExternalProject(organization.id);
    const active = await installActiveWidgetRevision(project.id, [
      {
        path: "widget/index.html",
        mediaType: "text/html; charset=utf-8",
        content:
          '<!doctype html><html lang="en"><body><p data-widget-marker="active-revision">Active revision widget</p><script>window.example = \'src="./poster.svg"\';</script><video poster=./poster.svg></video></body></html>',
      },
      {
        path: "widget/poster.svg",
        mediaType: "image/svg+xml",
        content:
          '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>',
      },
    ]);
    const appHost = await request(`/shiplets/${project.id}/review-host`, {
      headers: OWNER_HEADERS,
    });
    expect(appHost.status).toBe(200);
    const appHtml = await appHost.text();
    expect.soft(appHtml).toContain(`data-revision-id="${active.revisionId}"`);
    expect.soft(appHtml).toContain('data-shiplet-widget-frame="v1"');
    const appWidgetUrl = appHtml.match(
      /<iframe[^>]+data-shiplet-widget-frame="v1"[^>]+src="([^"]+)"/,
    )?.[1];
    expect.soft(appWidgetUrl).toBeTruthy();
    if (appWidgetUrl) {
      const widgetResponse = await request(appWidgetUrl, {
        headers: OWNER_HEADERS,
      });
      expect.soft(widgetResponse.status).toBe(200);
      const widgetCsp =
        widgetResponse.headers.get("content-security-policy") || "";
      const widgetScriptPolicy =
        widgetCsp
          .split(";")
          .map((directive) => directive.trim())
          .find((directive) => directive.startsWith("script-src ")) || "";
      expect
        .soft(widgetScriptPolicy)
        .toMatch(/^script-src 'nonce-[A-Za-z0-9+/_=-]{20,}'$/);
      expect.soft(widgetCsp).toContain("script-src-attr 'none'");
      expect.soft(widgetCsp).toContain("worker-src blob:");
      expect.soft(widgetCsp).toContain("connect-src 'none'");
      expect.soft(widgetCsp).toContain("frame-src 'none'");
      expect.soft(widgetCsp).not.toContain("script-src http://localhost");
      const widgetHtml = await widgetResponse.text();
      expect
        .soft(widgetHtml)
        .toContain('data-shiplet-widget-compartment="worker-v1"');
      expect
        .soft(widgetHtml)
        .not.toContain("window.example = 'src=\"./poster.svg\"'");
      expect
        .soft(widgetHtml)
        .not.toContain('<script src="data:text/javascript');
    }

    const { installation } = await installWebsite(project.id);
    const session = await startReviewSession(installation.id);
    const embedHost = await request(session.location, {
      headers: { Cookie: session.cookie },
    });
    expect(embedHost.status).toBe(200);
    const embedHtml = await embedHost.text();
    expect(embedHtml).toContain(`data-revision-id="${active.revisionId}"`);
    expect(embedHtml).not.toContain('data-shiplet-widget-frame="v1"');
    expect(embedHtml).not.toContain("/embed/review/widget");
    expect(embedHtml).not.toContain("reviewToken");
    expect(embedHtml).toContain(`data-shiplet-embed-origin="${SITE_ORIGIN}"`);
    expect(embedHtml).not.toMatch(/<iframe[^>]+data-shiplet-artifact-frame/);
  });

  it("fails closed when a bypassed runtime-v1 widget contains an unsupported module graph", async () => {
    const { organization } = await createOrganization();
    const { project } = await createExternalProject(organization.id);
    const active = await installActiveWidgetRevision(project.id, [
      {
        path: "widget/index.html",
        mediaType: "text/html; charset=utf-8",
        content:
          '<!doctype html><script type="module" src="./main.js"></script>',
      },
      {
        path: "widget/main.js",
        mediaType: "text/javascript; charset=utf-8",
        content:
          'import { label } from "./chunk.js"; document.body.textContent = label;',
      },
      {
        path: "widget/chunk.js",
        mediaType: "text/javascript; charset=utf-8",
        content: 'export const label = "must not execute";',
      },
    ]);
    const host = await request(`/shiplets/${project.id}/review-host`, {
      headers: OWNER_HEADERS,
    });
    const hostHtml = await host.text();
    const widgetUrl = hostHtml.match(
      /<iframe[^>]+data-shiplet-widget-frame="v1"[^>]+src="([^"]+)"/,
    )?.[1];
    expect(widgetUrl).toBeTruthy();
    if (!widgetUrl) return;

    const widget = await request(widgetUrl, { headers: OWNER_HEADERS });

    expect(widget.status).toBe(422);
    expect(await widget.text()).toBe("Unsupported review widget dependency");
    expect(widget.headers.get("content-security-policy")).toContain(
      "script-src 'none'",
    );
    expect(hostHtml).toContain(`data-revision-id="${active.revisionId}"`);
    expect(hostHtml).toContain("shiplet-kernel-review-panel");
  });

  it("fails closed when bypassed storage uses an alternate SVG script source", async () => {
    const { organization } = await createOrganization();
    const { project } = await createExternalProject(organization.id);
    const active = await installActiveWidgetRevision(project.id, [
      {
        path: "widget/index.html",
        mediaType: "text/html; charset=utf-8",
        content:
          '<!doctype html><svg><script href="./widget.js"></script></svg>',
      },
      {
        path: "widget/widget.js",
        mediaType: "text/javascript; charset=utf-8",
        content: 'import("data:text/javascript,export default true")',
      },
    ]);
    const host = await request(`/shiplets/${project.id}/review-host`, {
      headers: OWNER_HEADERS,
    });
    const hostHtml = await host.text();
    const widgetUrl = hostHtml.match(
      /<iframe[^>]+data-shiplet-widget-frame="v1"[^>]+src="([^"]+)"/,
    )?.[1];
    expect(widgetUrl).toBeTruthy();
    if (!widgetUrl) return;

    const widget = await request(widgetUrl, { headers: OWNER_HEADERS });

    expect(widget.status).toBe(422);
    expect(await widget.text()).toBe("Unsupported review widget dependency");
    expect(widget.headers.get("content-security-policy")).toContain(
      "script-src 'none'",
    );
    expect(hostHtml).toContain(`data-revision-id="${active.revisionId}"`);
    expect(hostHtml).toContain("shiplet-kernel-review-panel");
  });

  it("renders a revoked embedded session as the accessible frame-free revoked state", async () => {
    const { project, installation } = await installedProject();
    const session = await startReviewSession(installation.id);
    await disconnectWebsite(project.id, installation.id);
    const response = await request(session.location, {
      headers: { Cookie: session.cookie },
    });
    expect(response.status).toBe(410);
    const html = await response.text();
    expect(html).toContain('data-review-state="revoked"');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("data-shiplet-artifact-frame");
  });

  it("renders an expired embedded session as the accessible frame-free expired state", async () => {
    const { installation } = await installedProject();
    const session = await startReviewSession(installation.id);
    await (env as Env).DB.prepare(
      `UPDATE embed_review_sessions SET expires_on = ? WHERE installation_id = ?`,
    )
      .bind("2000-01-01T00:00:00.000Z", installation.id)
      .run();
    const response = await request(session.location, {
      headers: { Cookie: session.cookie },
    });
    expect(response.status).toBe(401);
    const html = await response.text();
    expect(html).toContain('data-review-state="expired"');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("data-shiplet-artifact-frame");
  });

  it("renders permission denial as an accessible frame-free trusted-host state", async () => {
    const { installation } = await installedProject();
    const response = await request(
      `/embed/review/start?${new URLSearchParams({
        installation_id: installation.id,
        return_url: `${SITE_ORIGIN}/pricing/`,
      })}`,
      {
        headers: {
          "x-shiplet-user-id": "user_embed_review_outsider_state",
          "x-shiplet-user-email": "outsider-state@example.com",
        },
      },
    );
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain('data-review-state="permission_denied"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("outsider-state@example.com");
    expect(html).toContain("Sign in with another account");
    expect(html).toContain("switch_account=1");
    expect(html).not.toContain("data-shiplet-artifact-frame");
  });

  it("renders kernel storage failure as an accessible frame-free offline state", async () => {
    const { installation } = await installedProject();
    const session = await startReviewSession(installation.id);
    await (env as Env).DB.prepare(
      "ALTER TABLE embed_review_sessions RENAME TO embed_review_sessions_offline_test",
    ).run();
    let response: Response;
    try {
      response = await request(session.location, {
        headers: { Cookie: session.cookie },
      });
    } finally {
      await (env as Env).DB.prepare(
        "ALTER TABLE embed_review_sessions_offline_test RENAME TO embed_review_sessions",
      ).run();
    }
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain('data-review-state="offline"');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("data-shiplet-artifact-frame");
  });

  it("keeps different projects connected independently on the same origin", async () => {
    const { organization } = await createOrganization();
    const firstProject = await createExternalProject(organization.id);
    const secondProject = await createExternalProject(organization.id);
    const first = await installWebsite(firstProject.project.id);
    const second = await installWebsite(secondProject.project.id);
    expect(first.installation.id).not.toBe(second.installation.id);
    const rows = await (env as Env).DB.prepare(
      `SELECT id, revoked_on FROM embed_installations WHERE id IN (?, ?)`,
    )
      .bind(first.installation.id, second.installation.id)
      .all<{ id: string; revoked_on: string | null }>();
    expect(rows.results).toHaveLength(2);
    for (const row of rows.results) expect(row.revoked_on).toBeNull();
    expect((await startReviewSession(first.installation.id)).start.status).toBe(
      302,
    );
    expect(
      (await startReviewSession(second.installation.id)).start.status,
    ).toBe(302);
  });
});

describe("trusted embedded review boundary", () => {
  const baseSession = {
    installationId: "embed_installation_allowed",
    projectId: "project_allowed",
    revisionId: "revision_allowed",
    siteOrigin: SITE_ORIGIN,
    pageUrl: `${SITE_ORIGIN}/pricing/?campaign=summer`,
    actorUserId: "user_allowed",
    expiresOn: "2030-01-01T00:05:00.000Z",
    revokedOn: null,
  };
  const baseRequest = {
    installationId: baseSession.installationId,
    projectId: baseSession.projectId,
    revisionId: baseSession.revisionId,
    siteOrigin: baseSession.siteOrigin,
    pageUrl: baseSession.pageUrl,
    actorUserId: baseSession.actorUserId,
    now: new Date("2030-01-01T00:00:00.000Z"),
    operationClaimed: true,
  };

  it("Given one-time session material, When a cookie is issued, Then only a bounded partitioned HttpOnly header carries it", () => {
    const header = createEmbedReviewSessionCookieHeader({
      installationId: "embed_installation_allowed",
      sessionHandle: "opaque-test-handle-not-a-credential",
      now: new Date("2030-01-01T00:00:00.000Z"),
      expiresOn: new Date("2030-01-01T00:30:00.000Z"),
    });
    expect(header).toContain(
      "__Host-shiplet_embed_review_embed_installation_allowed=",
    );
    expect(header).toContain("Path=/");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=None");
    expect(header).toContain("Partitioned");
    expect(header).not.toContain("Domain=");
    expect(header).not.toContain("Expires=");
    const maxAge = Number(header.match(/Max-Age=(\d+)/)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(5 * 60);
  });

  it("Given concurrent installations on one top-level site, When their cookies are issued and read, Then neither overwrites or authenticates the other", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const expiresOn = new Date("2030-01-01T00:05:00.000Z");
    const firstHandle = "first-opaque-test-handle";
    const secondHandle = "second-opaque-test-handle";
    const first = createEmbedReviewSessionCookieHeader({
      installationId: "embed_installation_first",
      sessionHandle: firstHandle,
      now,
      expiresOn,
    });
    const second = createEmbedReviewSessionCookieHeader({
      installationId: "embed_installation_second",
      sessionHandle: secondHandle,
      now,
      expiresOn,
    });
    const firstPair = first.split(";", 1)[0];
    const secondPair = second.split(";", 1)[0];
    expect(firstPair.split("=", 1)[0]).not.toBe(secondPair.split("=", 1)[0]);
    const combined = `${firstPair}; ${secondPair}`;
    expect(readEmbedReviewSessionHandle(combined, "embed_installation_first")).toBe(
      firstHandle,
    );
    expect(
      readEmbedReviewSessionHandle(combined, "embed_installation_second"),
    ).toBe(secondHandle);
    expect(
      readEmbedReviewSessionHandle(combined, "embed_installation_other"),
    ).toBeNull();
    for (const unsafeInstallationId of [
      "../other",
      "contains whitespace",
      "x".repeat(161),
      "",
    ]) {
      expect(() =>
        createEmbedReviewSessionCookieHeader({
          installationId: unsafeInstallationId,
          sessionHandle: firstHandle,
          now,
          expiresOn,
        }),
      ).toThrowError(/installation/i);
      expect(readEmbedReviewSessionHandle(combined, unsafeInstallationId)).toBeNull();
    }
  });

  it("Given a page URL with credential-shaped query material, When it is bound for review, Then secrets and fragments are stripped while navigation context remains", () => {
    const normalized = normalizeEmbedReviewPageUrl(
      `${SITE_ORIGIN}/reset/?campaign=fall&page=2&utm_source=review&code=private&OAuth_Token=private&reset_password_token=private&X-Amz-Credential=private&X-Amz-Signature=private&sig=private&api_key=private&state=private#private-fragment`,
      SITE_ORIGIN,
    );
    expect(normalized).toBe(
      `${SITE_ORIGIN}/reset/?campaign=fall&page=2&utm_source=review`,
    );
  });

  it("recursively sanitizes credential-bearing URLs nested inside ordinary query values", () => {
    const nested = new URL(`${SITE_ORIGIN}/oauth/callback`);
    nested.searchParams.set("campaign", "fall");
    nested.searchParams.set("code", "private-inner-code");
    const reset = new URL(`${SITE_ORIGIN}/account/reset`);
    reset.searchParams.set("tab", "profile");
    reset.searchParams.set("reset_password_token", "private-reset-link");
    reset.hash = "private-reset-fragment";
    nested.searchParams.set("next", reset.toString());
    const outer = new URL(`${SITE_ORIGIN}/pricing/`);
    outer.searchParams.set("campaign", "summer");
    outer.searchParams.set("continue", nested.toString());
    const normalized = normalizeEmbedReviewPageUrl(outer.toString(), SITE_ORIGIN);
    expect(normalized).toBeTruthy();
    const normalizedOuter = new URL(normalized || "");
    expect(normalizedOuter.searchParams.get("campaign")).toBe("summer");
    const normalizedNested = new URL(
      normalizedOuter.searchParams.get("continue") || "",
    );
    expect(normalizedNested.searchParams.get("campaign")).toBe("fall");
    expect(normalizedNested.searchParams.get("code")).toBeNull();
    const normalizedReset = new URL(
      normalizedNested.searchParams.get("next") || "",
    );
    expect(normalizedReset.searchParams.get("tab")).toBe("profile");
    expect(normalizedReset.searchParams.get("reset_password_token")).toBeNull();
    expect(normalizedReset.hash).toBe("");
    for (const forbidden of [
      "private-inner-code",
      "private-reset-link",
      "private-reset-fragment",
    ]) {
      expect(normalized).not.toContain(forbidden);
    }
  });

  it("atomically claims an operation receipt only for its exact installation, Shiplet, revision, actor, effect, payload, request, and lifetime", async () => {
    await (env as Env).DB.prepare(
      `CREATE TABLE IF NOT EXISTS embed_review_operation_receipts (
				receipt_hash TEXT PRIMARY KEY,
				installation_id TEXT NOT NULL,
				project_id TEXT NOT NULL,
				revision_id TEXT NOT NULL,
				actor_user_id TEXT NOT NULL,
				effect TEXT NOT NULL,
				payload_digest TEXT NOT NULL,
				request_id TEXT NOT NULL,
				expires_on TEXT NOT NULL,
				claimed_on TEXT
			)`,
    ).run();
    const receiptHandle = "test-operation-receipt-handle-not-a-credential";
    const binding = {
      receiptHandle,
      installationId: "embed_installation_receipt",
      shipletId: "project_receipt",
      revisionId: "revision_receipt",
      actorUserId: "user_receipt",
      effect: "feedback.create",
      payloadDigest: `sha256:${"a".repeat(64)}`,
      requestId: "request_receipt",
      now: new Date("2030-01-01T00:00:00.000Z"),
    };
    const insertReceipt = async (
      handle: string,
      requestId: string,
      expiresOn: string,
    ) =>
      (env as Env).DB.prepare(
        `INSERT INTO embed_review_operation_receipts (
				receipt_hash, installation_id, project_id, revision_id,
				actor_user_id, effect, payload_digest, request_id, expires_on, claimed_on
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
        .bind(
          await sha256Hex(handle),
          binding.installationId,
          binding.shipletId,
          binding.revisionId,
          binding.actorUserId,
          binding.effect,
          binding.payloadDigest,
          requestId,
          expiresOn,
        )
        .run();
    await insertReceipt(
      receiptHandle,
      binding.requestId,
      "2030-01-01T00:01:00.000Z",
    );
    for (const mismatch of [
      { installationId: "embed_installation_other" },
      { shipletId: "project_other" },
      { revisionId: "revision_other" },
      { actorUserId: "user_other" },
      { effect: "revision.promote" },
      { payloadDigest: `sha256:${"b".repeat(64)}` },
      { requestId: "request_other" },
    ]) {
      expect(
        await claimEmbedReviewOperationReceipt((env as Env).DB, {
          ...binding,
          ...mismatch,
        }),
      ).toMatchObject({ ok: false });
    }
    const concurrent = await Promise.all([
      claimEmbedReviewOperationReceipt((env as Env).DB, binding),
      claimEmbedReviewOperationReceipt((env as Env).DB, binding),
    ]);
    expect(concurrent.filter((result) => result.ok)).toHaveLength(1);
    expect(
      await claimEmbedReviewOperationReceipt((env as Env).DB, binding),
    ).toMatchObject({ ok: false });

    const expiredHandle = "expired-operation-receipt-not-a-credential";
    await insertReceipt(
      expiredHandle,
      "request_expired",
      "2029-12-31T23:59:59.000Z",
    );
    expect(
      await claimEmbedReviewOperationReceipt((env as Env).DB, {
        ...binding,
        receiptHandle: expiredHandle,
        requestId: "request_expired",
      }),
    ).toMatchObject({ ok: false });
  });

  it("Given the current embed module, When its public surface is inspected, Then retired review-code and server-secret installation issuers are absent", () => {
    for (const retired of [
      "createEmbedReviewCode",
      "createEmbedConnectionCode",
      "createEmbedInstallation",
      "authenticateEmbedInstallation",
      "embedClientScript",
    ]) {
      expect(
        Object.prototype.hasOwnProperty.call(embedContracts, retired),
        retired,
      ).toBe(false);
    }
  });

  it("Given a trusted session record, When it becomes public, Then credentials and actor authority are omitted", () => {
    const publicSession = publicEmbedReviewSession({
      ...baseSession,
      sessionHandle: "private-session-material",
      reviewToken: "private-review-material",
      presenceToken: "private-presence-material",
    });
    expect(publicSession).toEqual({
      installationId: baseSession.installationId,
      projectId: baseSession.projectId,
      revisionId: baseSession.revisionId,
      siteOrigin: baseSession.siteOrigin,
      pageUrl: baseSession.pageUrl,
      expiresOn: baseSession.expiresOn,
    });
    const serialized = JSON.stringify(publicSession);
    for (const forbidden of [
      "sessionHandle",
      "reviewToken",
      "presenceToken",
      "actorUserId",
      "private-session-material",
      "private-review-material",
      "private-presence-material",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("Given a legacy session record containing a credential-bearing page URL, When it becomes public, Then the projection redacts it defensively", () => {
    const publicSession = publicEmbedReviewSession({
      ...baseSession,
      pageUrl: `${SITE_ORIGIN}/pricing/?campaign=summer&reset_token=private&X-Amz-Signature=private#private`,
      sessionHandle: "private-session-material",
      reviewToken: "private-review-material",
      presenceToken: "private-presence-material",
    });
    expect(publicSession.pageUrl).toBe(`${SITE_ORIGIN}/pricing/?campaign=summer`);
    expect(JSON.stringify(publicSession)).not.toContain("private");
  });

  it.each([
    ["wrong origin", { siteOrigin: "https://attacker.example" }],
    ["wrong installation", { installationId: "embed_installation_other" }],
    ["wrong page", { pageUrl: `${SITE_ORIGIN}/other/` }],
    ["wrong project", { projectId: "project_other" }],
    ["wrong revision", { revisionId: "revision_other" }],
    ["wrong actor", { actorUserId: "user_other" }],
    ["replayed operation", { operationClaimed: false }],
  ])(
    "Given a bound trusted session, When a request has %s, Then authority fails closed",
    (_caseName, override) => {
      expect(
        validateEmbedReviewSessionBinding(baseSession, {
          ...baseRequest,
          ...override,
        }),
      ).toMatchObject({ ok: false });
    },
  );

  it("Given a revoked or expired trusted session, When used, Then authority fails closed", () => {
    expect(validateEmbedReviewSessionBinding(baseSession, baseRequest)).toEqual({
      ok: true,
    });
    expect(
      validateEmbedReviewSessionBinding(
        { ...baseSession, revokedOn: "2030-01-01T00:00:01.000Z" },
        baseRequest,
      ),
    ).toMatchObject({ ok: false });
    expect(
      validateEmbedReviewSessionBinding(baseSession, {
        ...baseRequest,
        now: new Date("2030-01-01T00:05:00.000Z"),
      }),
    ).toMatchObject({ ok: false });
  });
});
