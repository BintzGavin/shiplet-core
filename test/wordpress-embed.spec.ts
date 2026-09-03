import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import * as embedContracts from "../src/embed";

type FutureEmbedContracts = {
  createEmbedReviewSessionCookieHeader: (input: {
    installationId: string;
    sessionHandle: string;
    now: Date;
    expiresOn: Date;
  }) => string;
  readEmbedReviewSessionHandle: (
    cookieHeader: string | null,
    installationId: string,
  ) => string | null;
  normalizeEmbedReviewPageUrl: (
    value: unknown,
    expectedOrigin: string,
  ) => string | null;
  claimEmbedReviewOperationReceipt: (
    db: D1Database,
    input: {
      receiptHandle: string;
      installationId: string;
      shipletId: string;
      revisionId: string;
      actorUserId: string;
      effect: string;
      payloadDigest: string;
      requestId: string;
      now: Date;
    },
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  publicEmbedReviewSession: (input: {
    installationId: string;
    projectId: string;
    revisionId: string;
    siteOrigin: string;
    pageUrl: string;
    actorUserId: string;
    sessionHandle: string;
    reviewToken: string;
    presenceToken: string;
    expiresOn: string;
  }) => Record<string, unknown>;
  validateEmbedReviewSessionBinding: (
    session: {
      installationId: string;
      projectId: string;
      revisionId: string;
      siteOrigin: string;
      pageUrl: string;
      actorUserId: string;
      expiresOn: string;
      revokedOn: string | null;
    },
    request: {
      installationId: string;
      projectId: string;
      revisionId: string;
      siteOrigin: string;
      pageUrl: string;
      actorUserId: string;
      now: Date;
      operationClaimed: boolean;
    },
  ) => { ok: true } | { ok: false; reason: string };
};

const futureEmbedContracts = embedContracts as typeof embedContracts &
  FutureEmbedContracts;

const OWNER_HEADERS = {
  "x-shiplet-user-id": "user_wordpress_owner",
  "x-shiplet-user-email": "wordpress-owner@example.com",
};

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
    body: JSON.stringify({ name: `WordPress ${crypto.randomUUID()}` }),
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
      name: "Client WordPress site",
      organization_id: organizationId,
      subdomain: `wordpress-${crypto.randomUUID().slice(0, 8)}`,
      external_url: "https://client.example.com/",
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    project: { id: string; name: string };
  };
}

function connectUrl(projectId: string, state = "wordpress-state") {
  const params = new URLSearchParams({
    site_url: "https://client.example.com/",
    site_name: "Client site",
    return_url:
      "https://client.example.com/wp-admin/admin-post.php?action=shiplet_connect_callback",
    state,
    project_id: projectId,
  });
  return `/embed/connect?${params.toString()}`;
}

async function connectInstallation(projectId: string) {
  const getResponse = await request(connectUrl(projectId), {
    headers: OWNER_HEADERS,
  });
  expect(getResponse.status).toBe(200);
  const connectHtml = await getResponse.text();
  expect(connectHtml).toContain("Connect Client site");
  expect(connectHtml).toContain("Client WordPress site");

  const body = new URLSearchParams({
    site_url: "https://client.example.com/",
    site_name: "Client site",
    return_url:
      "https://client.example.com/wp-admin/admin-post.php?action=shiplet_connect_callback",
    state: "wordpress-state",
    project_id: projectId,
  });
  const confirmResponse = await request("/embed/connect", {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://shiplet.cc",
      ...OWNER_HEADERS,
    },
    body,
  });
  expect(confirmResponse.status).toBe(302);
  const callbackUrl = new URL(confirmResponse.headers.get("location") || "");
  expect(callbackUrl.origin).toBe("https://client.example.com");
  expect(callbackUrl.searchParams.get("state")).toBe("wordpress-state");
  const code = callbackUrl.searchParams.get("shiplet_code");
  expect(code).toMatch(/^shiplet_embed_connect_/);

  const exchangeResponse = await request("/api/embed/installations/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      siteUrl: "https://client.example.com/",
    }),
  });
  expect(exchangeResponse.status).toBe(201);
  const installation = (await exchangeResponse.json()) as {
    installation: {
      id: string;
      projectId: string;
      projectName: string;
      siteOrigin: string;
    };
    secret: string;
  };
  expect(installation.installation).toMatchObject({
    projectId,
    projectName: "Client WordPress site",
    siteOrigin: "https://client.example.com",
  });
  expect(installation.secret).toMatch(/^shiplet_embed_install_/);
  return { ...installation, code };
}

async function startReviewSession(
  installationId: string,
  pageUrl = "https://client.example.com/pricing/?campaign=summer",
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
  widgetFiles: Array<{ path: string; mediaType: string; content: string }> = [
    {
      path: "widget/index.html",
      mediaType: "text/html; charset=utf-8",
      content:
        '<!doctype html><html lang="en"><body><p data-widget-marker="active-revision">Active revision widget</p></body></html>',
    },
  ],
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
    throw new Error(
      "Published WordPress Shiplet is missing its initial revision",
    );
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

describe("WordPress embed installations", () => {
  it("rejects insecure production sites and cross-origin callbacks", async () => {
    const insecure = await request(
      `/embed/connect?${new URLSearchParams({
        site_url: "http://client.example.com/",
        site_name: "Insecure client",
        return_url:
          "http://client.example.com/wp-admin/admin-post.php?action=shiplet_connect_callback",
        state: "state",
      })}`,
      { headers: OWNER_HEADERS },
    );
    expect(insecure.status).toBe(400);

    const crossOrigin = await request(
      `/embed/connect?${new URLSearchParams({
        site_url: "https://client.example.com/",
        site_name: "Client",
        return_url:
          "https://attacker.example/wp-admin/admin-post.php?action=shiplet_connect_callback",
        state: "state",
      })}`,
      { headers: OWNER_HEADERS },
    );
    expect(crossOrigin.status).toBe(400);
  });

  it("connects an exact site origin through a single-use server exchange", async () => {
    const { organization } = await createOrganization();
    const { project } = await createExternalProject(organization.id);
    const connected = await connectInstallation(project.id);

    const replay = await request("/api/embed/installations/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: connected.code,
        siteUrl: "https://client.example.com/",
      }),
    });
    expect(replay.status).toBe(401);

    const row = await (env as Env).DB.prepare(
      `SELECT secret_hash
			 FROM embed_installations
			 WHERE id = ?`,
    )
      .bind(connected.installation.id)
      .first<{ secret_hash: string }>();
    expect(row?.secret_hash).toBeTruthy();
    expect(row?.secret_hash).not.toContain(connected.secret);
  });

  it("creates one external-URL project when the administrator chooses a new project", async () => {
    const { organization } = await createOrganization();
    const body = new URLSearchParams({
      site_url: "https://new-client.example.com/",
      site_name: "New client site",
      return_url:
        "https://new-client.example.com/wp-admin/admin-post.php?action=shiplet_connect_callback",
      state: "new-project-state",
      project_id: "new",
      organization_id: organization.id,
    });
    const confirm = await request("/embed/connect", {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://shiplet.cc",
        ...OWNER_HEADERS,
      },
      body,
    });
    expect(confirm.status).toBe(302);
    const callback = new URL(confirm.headers.get("location") || "");
    const exchange = await request("/api/embed/installations/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: callback.searchParams.get("shiplet_code"),
        siteUrl: "https://new-client.example.com/",
      }),
    });
    expect(exchange.status).toBe(201);
    const connected = (await exchange.json()) as {
      installation: { projectId: string; projectName: string };
    };
    expect(connected.installation.projectName).toBe("New client site");
    const project = await (env as Env).DB.prepare(
      `SELECT source_type, external_origin_url
			 FROM projects
			 WHERE id = ?`,
    )
      .bind(connected.installation.projectId)
      .first<{ source_type: string; external_origin_url: string }>();
    expect(project).toEqual({
      source_type: "external_url",
      external_origin_url: "https://new-client.example.com",
    });
  });

  it("establishes review authority only inside an app-origin trusted frame", async () => {
    const { organization } = await createOrganization();
    const { project } = await createExternalProject(organization.id);
    const connected = await connectInstallation(project.id);
    const returnUrl =
      "https://client.example.com/pricing/?shiplet-review=1&campaign=summer";

    const denied = await request(
      `/embed/review/start?${new URLSearchParams({
        installation_id: connected.installation.id,
        return_url: returnUrl,
      })}`,
      {
        headers: {
          "x-shiplet-user-id": "user_wordpress_outsider",
          "x-shiplet-user-email": "outsider@example.com",
        },
      },
    );
    expect(denied.status).toBe(403);

    const start = await request(
      `/embed/review/start?${new URLSearchParams({
        installation_id: connected.installation.id,
        return_url: returnUrl,
      })}`,
      { redirect: "manual", headers: OWNER_HEADERS },
    );
    expect(start.status).toBe(302);
    const trustedHost = new URL(start.headers.get("location") || "");
    expect(trustedHost.origin).toBe("http://localhost");
    expect(trustedHost.pathname).toBe("/embed/review/host");
    expect(trustedHost.searchParams.get("installation_id")).toBe(
      connected.installation.id,
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
    expect(cookie).toContain(
      `__Host-shiplet_embed_review_${connected.installation.id}=`,
    );
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

  it("never grants arbitrary installation pages direct review API CORS authority", async () => {
    const { organization } = await createOrganization();
    const { project } = await createExternalProject(organization.id);
    const connected = await connectInstallation(project.id);
    const feedbackPath = `/api/projects/${project.id}/review-feedback`;

    const clientPagePreflight = await request(feedbackPath, {
      method: "OPTIONS",
      headers: {
        Origin: "https://client.example.com",
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

    const disconnected = await request(
      `/api/embed/installations/${connected.installation.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${connected.secret}` },
      },
    );
    expect(disconnected.status).toBe(200);

    const afterDisconnect = await request(feedbackPath, {
      method: "OPTIONS",
      headers: {
        Origin: "https://client.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(
      afterDisconnect.headers.get("access-control-allow-origin"),
    ).toBeNull();

    const start = await request(
      `/embed/review/start?${new URLSearchParams({
        installation_id: connected.installation.id,
        return_url: "https://client.example.com/?shiplet-review=1",
      })}`,
      { headers: OWNER_HEADERS },
    );
    expect(start.status).toBe(410);
  });

  it("does not place a review exchange credential in the installation page", async () => {
    const { organization } = await createOrganization();
    const { project } = await createExternalProject(organization.id);
    const connected = await connectInstallation(project.id);
    const before = await (env as Env).DB.prepare(
      `SELECT COUNT(*) AS count
			 FROM embed_exchange_codes
			 WHERE installation_id = ? AND purpose = 'review'`,
    )
      .bind(connected.installation.id)
      .first<{ count: number }>();
    const start = await request(
      `/embed/review/start?${new URLSearchParams({
        installation_id: connected.installation.id,
        return_url: "https://client.example.com/?shiplet-review=1",
      })}`,
      { redirect: "manual", headers: OWNER_HEADERS },
    );
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location") || "");
    expect(location.origin).toBe("http://localhost");
    expect(location.searchParams.get("shiplet_embed_code")).toBeNull();
    expect(location.searchParams.get("code")).toBeNull();
    const after = await (env as Env).DB.prepare(
      `SELECT COUNT(*) AS count
			 FROM embed_exchange_codes
			 WHERE installation_id = ? AND purpose = 'review'`,
    )
      .bind(connected.installation.id)
      .first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it("serves the trusted host only through its exact HttpOnly session and retires browser token exchange", async () => {
    const { organization } = await createOrganization();
    const { project } = await createExternalProject(organization.id);
    const connected = await connectInstallation(project.id);
    const pageUrl = "https://client.example.com/pricing/?shiplet-review=1";
    const start = await request(
      `/embed/review/start?${new URLSearchParams({
        installation_id: connected.installation.id,
        return_url: pageUrl,
      })}`,
      { redirect: "manual", headers: OWNER_HEADERS },
    );
    const location = start.headers.get("location") || "";
    const cookie = (start.headers.get("set-cookie") || "").split(";")[0];
    expect(location).toContain("/embed/review/host");
    expect(cookie).toContain(
      `__Host-shiplet_embed_review_${connected.installation.id}=`,
    );

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
      "frame-ancestors 'self' https://client.example.com",
    );
    const html = await host.text();
    expect(html).toContain('data-shiplet-trusted-review-host="v1"');
    expect(html).toContain("/embed/review/feedback");
    expect(html).not.toContain(cookie.split("=")[1]);
    for (const forbidden of ["reviewToken", "presenceToken", "Authorization"])
      expect(html).not.toContain(forbidden);

    const hostUrl = new URL(location);
    const feedbackUrl = `/embed/review/feedback?${new URLSearchParams({
      installation_id: connected.installation.id,
      page_url: pageUrl,
    })}`;
    const comment = "Embed boundary feedback";
    const clientFeedbackId = `client-${crypto.randomUUID()}`;
    const operationReceipt = await createFeedbackOperationReceipt({
      installationId: connected.installation.id,
      projectId: project.id,
      pageUrl,
      comment,
      clientFeedbackId,
    });
    const created = await request(feedbackUrl, {
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
    });
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
          pageUrl: "https://client.example.com/account/",
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
      `/api/embed/session/exchange?installation_id=${encodeURIComponent(connected.installation.id)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://client.example.com",
        },
        body: JSON.stringify({}),
      },
    );
    expect(retiredExchange.status).toBe(410);
    const retiredBody = await retiredExchange.text();
    expect(retiredBody).not.toContain("reviewToken");
    expect(retiredBody).not.toContain("presenceToken");
  });

  it("requires exact trusted-host origin and a one-time operation receipt before any embedded mutation", async () => {
    const { organization } = await createOrganization();
    const { project } = await createExternalProject(organization.id);
    const connected = await connectInstallation(project.id);
    const session = await startReviewSession(connected.installation.id);
    expect(session.start.status).toBe(302);
    const feedbackPath = `/embed/review/feedback?${new URLSearchParams({
      installation_id: connected.installation.id,
      page_url: session.pageUrl,
    })}`;
    const before = await (env as Env).DB.prepare(
      `SELECT COUNT(*) AS count FROM review_feedback WHERE project_id = ?`,
    )
      .bind(project.id)
      .first<{ count: number }>();
    const attemptOptions: RequestInit[] = [
      {
        method: "POST",
        headers: {
          Cookie: session.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          comment: "No origin",
          pageUrl: session.pageUrl,
          clientFeedbackId: `client-${crypto.randomUUID()}`,
        }),
      },
      {
        method: "POST",
        headers: {
          Cookie: session.cookie,
          Origin: "https://attacker.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          comment: "Wrong origin JSON",
          pageUrl: session.pageUrl,
          clientFeedbackId: `client-${crypto.randomUUID()}`,
        }),
      },
      {
        method: "POST",
        headers: {
          Cookie: session.cookie,
          Origin: "https://client.example.com",
          "Content-Type": "text/plain",
        },
        body: JSON.stringify({
          comment: "Simple request CSRF",
          pageUrl: session.pageUrl,
          clientFeedbackId: `client-${crypto.randomUUID()}`,
        }),
      },
      {
        method: "POST",
        headers: {
          Cookie: session.cookie,
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          comment: "Missing operation receipt",
          pageUrl: session.pageUrl,
          clientFeedbackId: `client-${crypto.randomUUID()}`,
        }),
      },
      {
        method: "POST",
        headers: {
          Cookie: session.cookie,
          Origin: "http://localhost",
          "Content-Type": "application/json",
          "x-shiplet-operation-receipt":
            "malformed-test-receipt-not-a-credential",
        },
        body: JSON.stringify({
          comment: "Invalid operation receipt",
          pageUrl: session.pageUrl,
          clientFeedbackId: `client-${crypto.randomUUID()}`,
        }),
      },
    ];
    const attempts: Response[] = [];
    for (const options of attemptOptions) {
      attempts.push(await request(feedbackPath, options));
    }
    for (const attempt of attempts) {
      expect.soft(attempt.status).toBe(403);
    }
    const after = await (env as Env).DB.prepare(
      `SELECT COUNT(*) AS count FROM review_feedback WHERE project_id = ?`,
    )
      .bind(project.id)
      .first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it("uses an accessible popup authentication bootstrap instead of navigating WorkOS inside the third-party frame", async () => {
    const { organization } = await createOrganization();
    const { project } = await createExternalProject(organization.id);
    const connected = await connectInstallation(project.id);
    const response = await request(
      `/embed/review/start?${new URLSearchParams({
        installation_id: connected.installation.id,
        return_url: "https://client.example.com/pricing/",
      })}`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'self' https://client.example.com",
    );
    const html = await response.text();
    expect(html).toContain('data-shiplet-embed-auth-bootstrap="v1"');
    expect(html).toContain('type="button"');
    expect(html).toContain("Open secure Shiplet sign-in");
    expect(html).not.toContain("shiplet_embed_code");
    expect(html).not.toContain("reviewToken");
  });

  it("binds the embed-auth bootstrap script to a fresh route nonce", async () => {
    const { organization } = await createOrganization();
    const { project } = await createExternalProject(organization.id);
    const connected = await connectInstallation(project.id);
    const path = `/embed/review/start?${new URLSearchParams({
      installation_id: connected.installation.id,
      return_url: "https://client.example.com/pricing/",
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

  it("resolves the active revision custom widget through a sandboxed credential-free route", async () => {
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

    const connected = await connectInstallation(project.id);
    const session = await startReviewSession(connected.installation.id);
    const embedHost = await request(session.location, {
      headers: { Cookie: session.cookie },
    });
    expect(embedHost.status).toBe(200);
    const embedHtml = await embedHost.text();
    expect.soft(embedHtml).toContain(`data-revision-id="${active.revisionId}"`);
    expect.soft(embedHtml).toContain('data-shiplet-widget-frame="v1"');
    expect(embedHtml).not.toContain("reviewToken");
    const contextUrl = embedHtml
      .match(
        /<iframe[^>]+data-shiplet-artifact-frame="v1"[^>]+src="([^"]+)"/,
      )?.[1]
      ?.replaceAll("&amp;", "&");
    expect.soft(contextUrl).toBeTruthy();
    if (contextUrl) {
      const contextResponse = await request(contextUrl, {
        headers: { Cookie: session.cookie },
      });
      expect.soft(contextResponse.status).toBe(200);
      const contextCsp =
        contextResponse.headers.get("content-security-policy") || "";
      const contextSandbox =
        contextCsp
          .split(";")
          .map((directive) => directive.trim())
          .find((directive) => directive.startsWith("sandbox")) || "";
      expect.soft(contextSandbox).toBe("sandbox");
      expect.soft(contextCsp).toContain("script-src 'none'");
      expect.soft(contextCsp).toContain("script-src-attr 'none'");
      expect.soft(contextCsp).not.toContain("'unsafe-inline'");
    }
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
    const { organization } = await createOrganization();
    const { project } = await createExternalProject(organization.id);
    const connected = await connectInstallation(project.id);
    const session = await startReviewSession(connected.installation.id);
    await request(`/api/embed/installations/${connected.installation.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${connected.secret}` },
    });
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
    const { organization } = await createOrganization();
    const { project } = await createExternalProject(organization.id);
    const connected = await connectInstallation(project.id);
    const session = await startReviewSession(connected.installation.id);
    await (env as Env).DB.prepare(
      `UPDATE embed_review_sessions SET expires_on = ? WHERE installation_id = ?`,
    )
      .bind("2000-01-01T00:00:00.000Z", connected.installation.id)
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
    const { organization } = await createOrganization();
    const { project } = await createExternalProject(organization.id);
    const connected = await connectInstallation(project.id);
    const response = await request(
      `/embed/review/start?${new URLSearchParams({
        installation_id: connected.installation.id,
        return_url: "https://client.example.com/pricing/",
      })}`,
      {
        headers: {
          "x-shiplet-user-id": "user_wordpress_outsider_state",
          "x-shiplet-user-email": "outsider-state@example.com",
        },
      },
    );
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain('data-review-state="permission_denied"');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("data-shiplet-artifact-frame");
  });

  it("renders kernel storage failure as an accessible frame-free offline state", async () => {
    const { organization } = await createOrganization();
    const { project } = await createExternalProject(organization.id);
    const connected = await connectInstallation(project.id);
    const session = await startReviewSession(connected.installation.id);
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

  it("keeps exactly one active installation per site origin across reconnects", async () => {
    const { organization } = await createOrganization();
    const firstProject = await createExternalProject(organization.id);
    const secondProject = await createExternalProject(organization.id);
    const first = await connectInstallation(firstProject.project.id);
    const second = await connectInstallation(secondProject.project.id);
    const rows = await (env as Env).DB.prepare(
      `SELECT id, revoked_on FROM embed_installations
			 WHERE id IN (?, ?) ORDER BY created_on`,
    )
      .bind(first.installation.id, second.installation.id)
      .all<{ id: string; revoked_on: string | null }>();
    expect(rows.results).toHaveLength(2);
    expect(
      rows.results.find((row) => row.id === first.installation.id)?.revoked_on,
    ).toBeTruthy();
    expect(
      rows.results.find((row) => row.id === second.installation.id)?.revoked_on,
    ).toBeNull();
    const retiredStart = await request(
      `/embed/review/start?${new URLSearchParams({
        installation_id: first.installation.id,
        return_url: "https://client.example.com/pricing/",
      })}`,
      { headers: OWNER_HEADERS },
    );
    expect(retiredStart.status).toBe(410);
    const activeStart = await startReviewSession(second.installation.id);
    expect(activeStart.start.status).toBe(302);
  });

  it("serves a credential-free bootstrap for an app-origin trusted iframe", async () => {
    const response = await request("/api/embed/client.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/javascript",
    );
    const script = await response.text();
    expect(script).toContain("__SHIPLET_EMBED__");
    expect(script).toContain("/embed/review/start");
    for (const forbidden of [
      "__SHIPLET_REVIEW__",
      "reviewToken",
      "presenceToken",
      "sessionStorage",
      "localStorage",
      "/api/review/client.js",
      "/api/embed/session/exchange",
      "Authorization",
    ]) {
      expect(script).not.toContain(forbidden);
    }
  });
});

describe("trusted WordPress review boundary", () => {
  const baseSession = {
    installationId: "embed_installation_allowed",
    projectId: "project_allowed",
    revisionId: "revision_allowed",
    siteOrigin: "https://client.example.com",
    pageUrl: "https://client.example.com/pricing/?campaign=summer",
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
    const createCookie =
      futureEmbedContracts.createEmbedReviewSessionCookieHeader;
    if (typeof createCookie !== "function") {
      expect(typeof createCookie).toBe("function");
      return;
    }
    const header = createCookie({
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
    const createCookie =
      futureEmbedContracts.createEmbedReviewSessionCookieHeader;
    const readCookie = futureEmbedContracts.readEmbedReviewSessionHandle;
    const now = new Date("2030-01-01T00:00:00.000Z");
    const expiresOn = new Date("2030-01-01T00:05:00.000Z");
    const firstHandle = "first-opaque-test-handle";
    const secondHandle = "second-opaque-test-handle";
    const first = createCookie({
      installationId: "embed_installation_first",
      sessionHandle: firstHandle,
      now,
      expiresOn,
    });
    const second = createCookie({
      installationId: "embed_installation_second",
      sessionHandle: secondHandle,
      now,
      expiresOn,
    });
    const firstPair = first.split(";", 1)[0];
    const secondPair = second.split(";", 1)[0];
    expect(firstPair.split("=", 1)[0]).not.toBe(secondPair.split("=", 1)[0]);
    const combined = `${firstPair}; ${secondPair}`;
    expect(readCookie(combined, "embed_installation_first")).toBe(firstHandle);
    expect(readCookie(combined, "embed_installation_second")).toBe(
      secondHandle,
    );
    expect(readCookie(combined, "embed_installation_other")).toBeNull();
    for (const unsafeInstallationId of [
      "../other",
      "contains whitespace",
      "x".repeat(161),
      "",
    ]) {
      expect(() =>
        createCookie({
          installationId: unsafeInstallationId,
          sessionHandle: firstHandle,
          now,
          expiresOn,
        }),
      ).toThrowError(/installation/i);
      expect(readCookie(combined, unsafeInstallationId)).toBeNull();
    }
  });

  it("Given a page URL with credential-shaped query material, When it is bound for review, Then secrets and fragments are stripped while navigation context remains", () => {
    const normalize = futureEmbedContracts.normalizeEmbedReviewPageUrl;
    if (typeof normalize !== "function") {
      expect(typeof normalize).toBe("function");
      return;
    }
    const normalized = normalize(
      "https://client.example.com/reset/?campaign=fall&page=2&utm_source=review&code=private&OAuth_Token=private&reset_password_token=private&X-Amz-Credential=private&X-Amz-Signature=private&sig=private&api_key=private&state=private#private-fragment",
      "https://client.example.com",
    );
    expect(normalized).toBe(
      "https://client.example.com/reset/?campaign=fall&page=2&utm_source=review",
    );
  });

  it("recursively sanitizes credential-bearing URLs nested inside ordinary query values", () => {
    const normalize = futureEmbedContracts.normalizeEmbedReviewPageUrl;
    const nested = new URL("https://client.example.com/oauth/callback");
    nested.searchParams.set("campaign", "fall");
    nested.searchParams.set("code", "private-inner-code");
    const reset = new URL("https://client.example.com/account/reset");
    reset.searchParams.set("tab", "profile");
    reset.searchParams.set("reset_password_token", "private-reset-link");
    reset.hash = "private-reset-fragment";
    nested.searchParams.set("next", reset.toString());
    const outer = new URL("https://client.example.com/pricing/");
    outer.searchParams.set("campaign", "summer");
    outer.searchParams.set("continue", nested.toString());
    const normalized = normalize(
      outer.toString(),
      "https://client.example.com",
    );
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
    const claim = futureEmbedContracts.claimEmbedReviewOperationReceipt;
    if (typeof claim !== "function") {
      expect.soft(typeof claim).toBe("function");
      return;
    }
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
    const receiptHash = await sha256Hex(receiptHandle);
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
    await (env as Env).DB.prepare(
      `INSERT INTO embed_review_operation_receipts (
				receipt_hash, installation_id, project_id, revision_id,
				actor_user_id, effect, payload_digest, request_id, expires_on, claimed_on
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
      .bind(
        receiptHash,
        binding.installationId,
        binding.shipletId,
        binding.revisionId,
        binding.actorUserId,
        binding.effect,
        binding.payloadDigest,
        binding.requestId,
        "2030-01-01T00:01:00.000Z",
      )
      .run();
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
        await claim((env as Env).DB, { ...binding, ...mismatch }),
      ).toMatchObject({
        ok: false,
      });
    }
    const concurrent = await Promise.all([
      claim((env as Env).DB, binding),
      claim((env as Env).DB, binding),
    ]);
    expect(concurrent.filter((result) => result.ok)).toHaveLength(1);
    expect(await claim((env as Env).DB, binding)).toMatchObject({ ok: false });

    const expiredHandle = "expired-operation-receipt-not-a-credential";
    await (env as Env).DB.prepare(
      `INSERT INTO embed_review_operation_receipts (
				receipt_hash, installation_id, project_id, revision_id,
				actor_user_id, effect, payload_digest, request_id, expires_on, claimed_on
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
      .bind(
        await sha256Hex(expiredHandle),
        binding.installationId,
        binding.shipletId,
        binding.revisionId,
        binding.actorUserId,
        binding.effect,
        binding.payloadDigest,
        "request_expired",
        "2029-12-31T23:59:59.000Z",
      )
      .run();
    expect(
      await claim((env as Env).DB, {
        ...binding,
        receiptHandle: expiredHandle,
        requestId: "request_expired",
      }),
    ).toMatchObject({ ok: false });
  });

  it("Given the current embed module, When its public surface is inspected, Then the retired browser review-code issuer is absent", () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        embedContracts,
        "createEmbedReviewCode",
      ),
    ).toBe(false);
  });

  it("Given a trusted session record, When it becomes public, Then credentials and actor authority are omitted", () => {
    const project = futureEmbedContracts.publicEmbedReviewSession;
    if (typeof project !== "function") {
      expect(typeof project).toBe("function");
      return;
    }
    const publicSession = project({
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
    const project = futureEmbedContracts.publicEmbedReviewSession;
    const publicSession = project({
      ...baseSession,
      pageUrl:
        "https://client.example.com/pricing/?campaign=summer&reset_token=private&X-Amz-Signature=private#private",
      sessionHandle: "private-session-material",
      reviewToken: "private-review-material",
      presenceToken: "private-presence-material",
    });
    expect(publicSession.pageUrl).toBe(
      "https://client.example.com/pricing/?campaign=summer",
    );
    expect(JSON.stringify(publicSession)).not.toContain("private");
  });

  it.each([
    ["wrong origin", { siteOrigin: "https://attacker.example" }],
    ["wrong installation", { installationId: "embed_installation_other" }],
    ["wrong page", { pageUrl: "https://client.example.com/other/" }],
    ["wrong project", { projectId: "project_other" }],
    ["wrong revision", { revisionId: "revision_other" }],
    ["wrong actor", { actorUserId: "user_other" }],
    ["replayed operation", { operationClaimed: false }],
  ])(
    "Given a bound trusted session, When a request has %s, Then authority fails closed",
    (_caseName, override) => {
      const validate = futureEmbedContracts.validateEmbedReviewSessionBinding;
      if (typeof validate !== "function") {
        expect(typeof validate).toBe("function");
        return;
      }
      expect(
        validate(baseSession, { ...baseRequest, ...override }),
      ).toMatchObject({ ok: false });
    },
  );

  it("Given a revoked or expired trusted session, When used, Then authority fails closed", () => {
    const validate = futureEmbedContracts.validateEmbedReviewSessionBinding;
    if (typeof validate !== "function") {
      expect(typeof validate).toBe("function");
      return;
    }
    expect(
      validate(
        { ...baseSession, revokedOn: "2030-01-01T00:00:01.000Z" },
        baseRequest,
      ),
    ).toMatchObject({ ok: false });
    expect(
      validate(baseSession, {
        ...baseRequest,
        now: new Date("2030-01-01T00:05:00.000Z"),
      }),
    ).toMatchObject({ ok: false });
  });

  it("Given hostile installation-page JavaScript, When the bootstrap runs, Then only the configured app-origin frame is mounted without credentials", () => {
    const script = embedContracts.embedClientScript();
    const appended: Array<Record<string, unknown>> = [];
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const navigate = vi.fn();
    const fetchCall = vi.fn();
    const location = {
      href: "https://client.example.com/pricing/?campaign=summer&page=2&code=private&reset_password_token=private&X-Amz-Signature=private#private-fragment",
      assign: navigate,
    };
    const document = {
      currentScript: {
        src: "https://shiplet.cc/api/embed/client.js",
      },
      querySelector: vi.fn(() => null),
      createElement: vi.fn((tagName: string) => {
        const attributes = new Map<string, string>();
        return {
          tagName: tagName.toUpperCase(),
          dataset: {},
          style: {},
          setAttribute(name: string, value: string) {
            attributes.set(name, value);
          },
          getAttribute(name: string) {
            return attributes.get(name) || null;
          },
        };
      }),
      body: {
        appendChild(element: Record<string, unknown>) {
          appended.push(element);
          return element;
        },
      },
      head: {
        appendChild(element: Record<string, unknown>) {
          appended.push(element);
          return element;
        },
      },
    };
    const hostileWindow = {
      __SHIPLET_EMBED__: {
        installationId: "embed_installation_allowed",
        apiBaseUrl: "https://attacker.example",
      },
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners.set(type, [...(listeners.get(type) || []), listener]);
      },
    };
    const execute = new Function(
      "window",
      "document",
      "location",
      "sessionStorage",
      "localStorage",
      "history",
      "fetch",
      "URL",
      script,
    );
    execute(
      hostileWindow,
      document,
      location,
      { getItem: vi.fn(), setItem: vi.fn() },
      { getItem: vi.fn(), setItem: vi.fn() },
      { replaceState: vi.fn(), state: null },
      fetchCall,
      URL,
    );

    const iframe = appended.find((element) => element.tagName === "IFRAME");
    expect(iframe).toBeDefined();
    const iframeSrc = new URL(String(iframe?.src || ""));
    expect(iframeSrc.origin).toBe("https://shiplet.cc");
    expect(iframeSrc.pathname).toBe("/embed/review/start");
    expect(iframeSrc.searchParams.get("installation_id")).toBe(
      "embed_installation_allowed",
    );
    expect(iframeSrc.searchParams.get("return_url")).toBe(
      "https://client.example.com/pricing/?campaign=summer&page=2",
    );
    for (const forbiddenParam of [
      "shiplet_embed_code",
      "code",
      "token",
      "session",
      "capability",
    ]) {
      expect(iframeSrc.searchParams.has(forbiddenParam)).toBe(false);
    }
    expect(iframe?.title).toBe("Review this page in Shiplet");
    const sandbox = String(
      (
        iframe as {
          getAttribute?: (name: string) => string | null;
        }
      )?.getAttribute?.("sandbox") || "",
    );
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-forms");
    expect(sandbox).toContain("allow-same-origin");
    expect(sandbox).toContain("allow-popups");
    expect(sandbox).toContain("allow-popups-to-escape-sandbox");
    expect(sandbox).not.toContain("allow-modals");
    expect(sandbox).not.toContain("allow-downloads");
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(navigate).not.toHaveBeenCalled();
    expect(fetchCall).not.toHaveBeenCalled();

    for (const listener of listeners.get("message") || []) {
      listener({
        origin: "https://client.example.com",
        source: hostileWindow,
        data: {
          type: "shiplet.feedback.create",
          actor: { kind: "human", id: "user_allowed" },
        },
      });
    }
    expect(fetchCall).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(
      (hostileWindow as Record<string, unknown>).__SHIPLET_REVIEW__,
    ).toBeUndefined();
  });
});
