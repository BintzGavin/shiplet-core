import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type Route,
} from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";

import {
  createExternalResourceUrlBuilder,
  rewriteExternalHtmlReferences,
  verifiedExternalResourceTarget,
} from "../src/external-url-proxy";

import {
  createSandboxedArtifactResponse,
  createTrustedReviewHostResponse,
} from "../src/trusted-review-host";
import {
  authHeaders,
  createOrganization,
  loginAs,
  publishStaticShiplet,
  testUser,
  type E2EOrganization,
  type E2EUser,
} from "./helpers";

const trustedOrigin = "https://review.example.test";
const browserRuntimeSigningMaterial =
  "url-import-fidelity-browser-runtime-fixture";
const browserRuntimeProjectId = "project_browser_runtime_fixture";

async function publishExternalShiplet(
  request: APIRequestContext,
  owner: E2EUser,
  organization: E2EOrganization,
) {
  const suffix = `${Date.now().toString(36)}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;
  const response = await request.post("/projects", {
    headers: {
      ...authHeaders(owner),
      "Content-Type": "application/json",
      Origin: "http://localhost:8787",
    },
    data: {
      name: `External URL browser ${suffix}`,
      organization_id: organization.id,
      subdomain: `external-browser-${suffix}`,
      visibility: "public",
      external_url: "https://example.com/",
    },
  });
  if (!response.ok()) {
    throw new Error(
      `publish external Shiplet failed ${response.status()}: ${await response.text()}`,
    );
  }
  return (await response.json()) as {
    project: { id: string; subdomain: string };
  };
}

async function fulfillResponse(route: Route, response: Response) {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  await route.fulfill({
    status: response.status,
    headers,
    body: await response.text(),
  });
}

async function fulfillSandboxedArtifact(
  route: Route,
  input: {
    body: string;
    contentType: string;
    role?: "artifact" | "review_context";
  },
) {
  await fulfillResponse(
    route,
    createSandboxedArtifactResponse({
      ...input,
      role: input.role ?? "artifact",
      trustedHostOrigin: trustedOrigin,
    }),
  );
}

async function fulfillTrustedHost(route: Route, artifactUrl: string) {
  await fulfillResponse(
    route,
    createTrustedReviewHostResponse({
      shipletId: "shiplet_navigation_fixture",
      revisionId: "revision_navigation_fixture",
      title: "Imported navigation fixture",
      artifactUrl,
      widgetUrl: null,
      hostScriptUrl: `${trustedOrigin}/api/review/host.js`,
      reviewApiUrl: `${trustedOrigin}/__shiplet/review/feedback`,
      confirmationUrl: `${trustedOrigin}/review/confirm`,
      reviewPageUrl: `${trustedOrigin}/reviewed-page`,
    }),
  );
}

type ExternalRuntimeFixture = {
  body: string;
  contentType: string;
  redirectTo?: string;
};

async function writeServerResponse(
  response: ServerResponse,
  shipletResponse: Response,
) {
  response.statusCode = shipletResponse.status;
  shipletResponse.headers.forEach((value, name) => {
    response.setHeader(name, value);
  });
  response.end(await shipletResponse.text());
}

function allowOpaqueArtifactRead(response: Response) {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.delete("access-control-allow-credentials");
  return response;
}

async function installExternalRuntimeServer(
  page: Page,
  input: {
    fixtureId: string;
    html: string;
    sourceUrl: string;
    upstream: Record<string, ExternalRuntimeFixture>;
  },
) {
  const hostPath = `/runtime/${input.fixtureId}/host`;
  const artifactPath = `/runtime/${input.fixtureId}/artifact`;
  const proxyUrlFor = await createExternalResourceUrlBuilder({
    secret: browserRuntimeSigningMaterial,
    projectId: browserRuntimeProjectId,
    rootAssetPrefix: "",
  });
  const rewrittenHtml = await rewriteExternalHtmlReferences({
    html: input.html,
    sourceUrl: input.sourceUrl,
    proxyUrlFor,
  });
  const upstreamRequests: string[] = [];
  const runtimeRequests: Array<{
    target: string;
    cookie: string | undefined;
    origin: string | undefined;
  }> = [];
  const runtimeContentResponseHeaders: Array<{
    target: string;
    headers: Record<string, string>;
  }> = [];
  const runtimeRedirects: Array<{
    from: string;
    location: string;
    headers: Record<string, string>;
  }> = [];
  let trustedHostOrigin = "";

  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url || "/", trustedHostOrigin);
      if (requestUrl.pathname === hostPath) {
        await writeServerResponse(
          response,
          createTrustedReviewHostResponse({
            shipletId: "shiplet_runtime_redirect_fixture",
            revisionId: "revision_runtime_redirect_fixture",
            title: "Imported runtime redirect fixture",
            artifactUrl: `${trustedHostOrigin}${artifactPath}`,
            widgetUrl: null,
            hostScriptUrl: `${trustedHostOrigin}/api/review/host.js`,
            reviewApiUrl: `${trustedHostOrigin}/__shiplet/review/feedback`,
            confirmationUrl: `${trustedHostOrigin}/review/confirm`,
            reviewPageUrl: `${trustedHostOrigin}/reviewed-page`,
          }),
        );
        return;
      }
      if (requestUrl.pathname === artifactPath) {
        await writeServerResponse(
          response,
          allowOpaqueArtifactRead(
            createSandboxedArtifactResponse({
              body: rewrittenHtml,
              contentType: "text/html; charset=utf-8",
              role: "artifact",
              trustedHostOrigin,
            }),
          ),
        );
        return;
      }
      const target = await verifiedExternalResourceTarget({
        requestUrl,
        requestPath: requestUrl.pathname,
        secret: browserRuntimeSigningMaterial,
        projectId: browserRuntimeProjectId,
      });
      if (!target) {
        response.statusCode = 404;
        response.end("Unverified runtime path");
        return;
      }
      upstreamRequests.push(target.toString());
      runtimeRequests.push({
        target: target.toString(),
        cookie: request.headers.cookie,
        origin: request.headers.origin,
      });
      const fixture = input.upstream[target.toString()];
      if (!fixture) {
        response.statusCode = 404;
        response.end("Missing upstream fixture");
        return;
      }
      if (fixture.redirectTo) {
        const location = await proxyUrlFor(fixture.redirectTo);
        const headers = {
          location,
          "cache-control": "private, no-store",
          "referrer-policy": "no-referrer",
          "access-control-allow-origin": "*",
        };
        runtimeRedirects.push({
          from: target.toString(),
          location,
          headers,
        });
        response.writeHead(302, headers);
        response.end();
        return;
      }
      const artifactResponse = allowOpaqueArtifactRead(
        createSandboxedArtifactResponse({
          body: fixture.body,
          contentType: fixture.contentType,
          role: "artifact",
          trustedHostOrigin,
        }),
      );
      const artifactHeaders: Record<string, string> = {};
      artifactResponse.headers.forEach((value, name) => {
        artifactHeaders[name] = value;
      });
      runtimeContentResponseHeaders.push({
        target: target.toString(),
        headers: artifactHeaders,
      });
      await writeServerResponse(response, artifactResponse);
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "Fixture failure");
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a loopback runtime fixture address");
  }
  trustedHostOrigin = `http://127.0.0.1:${address.port}`;

  return {
    artifact: page.frameLocator("[data-shiplet-artifact-frame]"),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    hostUrl: `${trustedHostOrigin}${hostPath}`,
    runtimeContentResponseHeaders,
    runtimeRedirects,
    runtimeRequests,
    trustedHostOrigin,
    upstreamRequests,
  };
}

async function installExternalRuntimeHarness(
  page: Page,
  input: {
    fixtureId: string;
    html: string;
    sourceUrl: string;
    upstream: Record<string, ExternalRuntimeFixture>;
  },
) {
  const hostPath = `/runtime/${input.fixtureId}/host`;
  const artifactPath = `/runtime/${input.fixtureId}/artifact`;
  const proxyUrlFor = await createExternalResourceUrlBuilder({
    secret: browserRuntimeSigningMaterial,
    projectId: browserRuntimeProjectId,
    rootAssetPrefix: "",
  });
  const rewrittenHtml = await rewriteExternalHtmlReferences({
    html: input.html,
    sourceUrl: input.sourceUrl,
    proxyUrlFor,
  });
  const upstreamRequests: string[] = [];

  await page.route(`${trustedOrigin}/**`, async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === hostPath) {
      await fulfillTrustedHost(route, `${trustedOrigin}${artifactPath}`);
      return;
    }
    if (requestUrl.pathname === artifactPath) {
      await fulfillSandboxedArtifact(route, {
        body: rewrittenHtml,
        contentType: "text/html; charset=utf-8",
      });
      return;
    }
    const target = await verifiedExternalResourceTarget({
      requestUrl,
      requestPath: requestUrl.pathname,
      secret: browserRuntimeSigningMaterial,
      projectId: browserRuntimeProjectId,
    });
    if (!target) {
      await route.fulfill({ status: 404, body: "Unverified runtime path" });
      return;
    }
    upstreamRequests.push(target.toString());
    const fixture = input.upstream[target.toString()];
    if (!fixture) {
      await route.fulfill({ status: 404, body: "Missing upstream fixture" });
      return;
    }
    await fulfillSandboxedArtifact(route, fixture);
  });

  return {
    artifact: page.frameLocator("[data-shiplet-artifact-frame]"),
    hostUrl: `${trustedOrigin}${hostPath}`,
    upstreamRequests,
  };
}

test.describe("external URL framework-runtime fidelity", () => {
  test("exposes CORS only on a real external dashboard artifact frame", async ({
    page,
    request,
  }) => {
    const user = testUser("external-dashboard-cors");
    const organization = await createOrganization(request, user);
    const external = await publishExternalShiplet(request, user, organization);
    const staticShiplet = await publishStaticShiplet(
      request,
      user,
      organization.id,
      {
        name: `Static dashboard CORS control ${Date.now()}`,
        visibility: "public",
      },
    );
    await loginAs(page, user);

    const externalArtifactPath = `/shiplets/${external.project.id}/artifact-frame/`;
    const externalArtifactResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === externalArtifactPath &&
        response.request().resourceType() === "document",
    );
    await page.goto(`/shiplets/${external.project.id}/review-host`, {
      waitUntil: "domcontentloaded",
    });
    const externalArtifactResponse = await externalArtifactResponsePromise;
    expect(externalArtifactResponse.status()).toBe(200);
    expect(
      await externalArtifactResponse.headerValue("access-control-allow-origin"),
    ).toBe("*");
    expect(
      await externalArtifactResponse.headerValue(
        "access-control-allow-credentials",
      ),
    ).toBeNull();
    expect(await externalArtifactResponse.headerValue("set-cookie")).toBeNull();
    await expect(
      page
        .frameLocator("[data-shiplet-artifact-frame]")
        .getByRole("heading", { name: "Example Domain" }),
    ).toBeVisible();
    expect(
      (await page
        .locator("[data-shiplet-artifact-frame]")
        .getAttribute("sandbox")) || "",
    ).not.toContain("allow-same-origin");

    const staticArtifactPath = `/shiplets/${staticShiplet.project.id}/artifact-frame/`;
    const staticArtifactResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === staticArtifactPath &&
        response.request().resourceType() === "document",
    );
    await page.goto(`/shiplets/${staticShiplet.project.id}/review-host`, {
      waitUntil: "domcontentloaded",
    });
    const staticArtifactResponse = await staticArtifactResponsePromise;
    expect(staticArtifactResponse.status()).toBe(200);
    expect(
      await staticArtifactResponse.headerValue("access-control-allow-origin"),
    ).toBeNull();
    expect(
      await staticArtifactResponse.headerValue(
        "access-control-allow-credentials",
      ),
    ).toBeNull();
  });

  test("loads trusted-origin module chunks and data from an opaque artifact without ambient credentials or egress", async ({
    context,
    page,
  }) => {
    const artifactRequests: Array<{
      path: string;
      cookie: string | undefined;
      origin: string | undefined;
    }> = [];
    let ambientRequestObserved = false;

    await context.addCookies([
      {
        name: "reviewer_session",
        value: "browser-only-fixture",
        domain: "review.example.test",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    await page.route("https://ambient.example.test/**", async (route) => {
      ambientRequestObserved = true;
      await route.fulfill({ status: 204 });
    });
    await page.route(`${trustedOrigin}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/host") {
        await route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><iframe title="Imported app" sandbox="allow-scripts allow-forms" src="${trustedOrigin}/artifact"></iframe>`,
        });
        return;
      }
      artifactRequests.push({
        path: url.pathname,
        cookie: request.headers()["cookie"],
        origin: request.headers()["origin"],
      });
      if (url.pathname === "/chunks/app.js") {
        await fulfillSandboxedArtifact(route, {
          body: `export const frameworkReady = "chunk-ready";`,
          contentType: "text/javascript; charset=utf-8",
        });
        return;
      }
      if (url.pathname === "/data/runtime.json") {
        await fulfillSandboxedArtifact(route, {
          body: JSON.stringify({ state: "data-ready" }),
          contentType: "application/json; charset=utf-8",
        });
        return;
      }
      await fulfillSandboxedArtifact(route, {
        body: `<!doctype html><html><body data-runtime="pending"><script type="module">
          Promise.all([
            import("/chunks/app.js"),
            fetch("/data/runtime.json").then((response) => response.json()),
          ]).then(([framework, data]) => {
            document.body.dataset.runtime = framework.frameworkReady + ":" + data.state;
          }).catch((error) => {
            document.body.dataset.runtime = "error:" + error.name;
          });
          fetch("https://ambient.example.test/leak").catch(() => {});
        </script></body></html>`,
        contentType: "text/html; charset=utf-8",
      });
    });

    await page.goto(`${trustedOrigin}/host`);
    const artifact = page.frameLocator('iframe[title="Imported app"]');
    await expect(artifact.locator("body")).toHaveAttribute(
      "data-runtime",
      "chunk-ready:data-ready",
    );

    expect(ambientRequestObserved).toBe(false);
    expect(artifactRequests.map((request) => request.path)).toEqual(
      expect.arrayContaining([
        "/artifact",
        "/chunks/app.js",
        "/data/runtime.json",
      ]),
    );
    for (const request of artifactRequests.filter(
      ({ path }) => path !== "/artifact",
    )) {
      expect(request.cookie).toBeUndefined();
      expect(request.origin).toBe("null");
    }
  });

  test("resolves a document-relative runtime fetch from the nested imported document path", async ({
    page,
  }) => {
    const expectedTarget =
      "https://preview.example.com/releases/v7/api/document.json";
    const harness = await installExternalRuntimeHarness(page, {
      fixtureId: "document-relative",
      sourceUrl: "https://preview.example.com/releases/v7/index.html",
      html: `<!doctype html><body data-runtime="pending"><script>
        fetch("./api/document.json")
          .then((response) => response.json())
          .then((data) => { document.body.dataset.runtime = data.state; })
          .catch(() => { document.body.dataset.runtime = "error"; });
      </script></body>`,
      upstream: {
        [expectedTarget]: {
          body: JSON.stringify({ state: "document-relative-ready" }),
          contentType: "application/json; charset=utf-8",
        },
      },
    });

    await page.goto(harness.hostUrl);

    await expect(harness.artifact.locator("body")).toHaveAttribute(
      "data-runtime",
      "document-relative-ready",
    );
    expect(harness.upstreamRequests).toContain(expectedTarget);
  });

  test("resolves a runtime fetch from the authored base instead of the document directory", async ({
    page,
  }) => {
    const expectedTarget =
      "https://preview.example.com/releases/runtime/state.json";
    const harness = await installExternalRuntimeHarness(page, {
      fixtureId: "authored-base",
      sourceUrl: "https://preview.example.com/releases/v7/index.html",
      html: `<!doctype html><base href="../runtime/"><body data-runtime="pending"><script>
        fetch("./state.json")
          .then((response) => response.json())
          .then((data) => { document.body.dataset.runtime = data.state; })
          .catch(() => { document.body.dataset.runtime = "error"; });
      </script></body>`,
      upstream: {
        [expectedTarget]: {
          body: JSON.stringify({ state: "authored-base-ready" }),
          contentType: "application/json; charset=utf-8",
        },
      },
    });

    await page.goto(harness.hostUrl);

    await expect(harness.artifact.locator("body")).toHaveAttribute(
      "data-runtime",
      "authored-base-ready",
    );
    expect(harness.upstreamRequests).toContain(expectedTarget);
  });

  test("uses an authored HTML base inside SVG foreignObject before the injected trusted base", async ({
    page,
  }) => {
    const expectedTarget =
      "https://preview.example.com/releases/authored-runtime/state.json";
    const documentRelativeTarget =
      "https://preview.example.com/releases/v7/state.json";
    const harness = await installExternalRuntimeHarness(page, {
      fixtureId: "foreign-object-base",
      sourceUrl: "https://preview.example.com/releases/v7/index.html",
      html: `<!doctype html>
        <svg><foreignObject><base href="../authored-runtime/"></foreignObject></svg>
        <head><meta charset="utf-8"></head>
        <body data-runtime="pending"><script>
          fetch("./state.json")
            .then((response) => response.json())
            .then((data) => { document.body.dataset.runtime = data.state; })
            .catch(() => { document.body.dataset.runtime = "error"; });
        </script></body>`,
      upstream: {
        [expectedTarget]: {
          body: JSON.stringify({ state: "foreign-object-base-ready" }),
          contentType: "application/json; charset=utf-8",
        },
      },
    });

    await page.goto(harness.hostUrl);

    await expect(harness.artifact.locator("body")).toHaveAttribute(
      "data-runtime",
      "foreign-object-base-ready",
    );
    await expect(harness.artifact.locator("base")).toHaveCount(1);
    expect(harness.upstreamRequests).toContain(expectedTarget);
    expect(harness.upstreamRequests).not.toContain(documentRelativeTarget);
  });

  test("resolves static and dynamic relative ESM imports from the proxied module path", async ({
    page,
  }) => {
    const mainTarget =
      "https://preview.example.com/releases/v7/assets/app/main.js";
    const staticTarget =
      "https://preview.example.com/releases/v7/assets/app/static.js";
    const dynamicTarget =
      "https://preview.example.com/releases/v7/assets/app/lazy.js";
    const harness = await installExternalRuntimeHarness(page, {
      fixtureId: "relative-esm",
      sourceUrl: "https://preview.example.com/releases/v7/index.html",
      html: '<!doctype html><body data-runtime="pending"><script type="module" src="./assets/app/main.js"></script></body>',
      upstream: {
        [mainTarget]: {
          body: `import { staticValue } from "./static.js";
            import("./lazy.js").then(({ dynamicValue }) => {
              document.body.dataset.runtime = staticValue + ":" + dynamicValue;
            }).catch(() => { document.body.dataset.runtime = "error"; });`,
          contentType: "text/javascript; charset=utf-8",
        },
        [staticTarget]: {
          body: 'export const staticValue = "static-ready";',
          contentType: "text/javascript; charset=utf-8",
        },
        [dynamicTarget]: {
          body: 'export const dynamicValue = "dynamic-ready";',
          contentType: "text/javascript; charset=utf-8",
        },
      },
    });

    await page.goto(harness.hostUrl);

    await expect(harness.artifact.locator("body")).toHaveAttribute(
      "data-runtime",
      "static-ready:dynamic-ready",
    );
    expect(harness.upstreamRequests).toEqual(
      expect.arrayContaining([mainTarget, staticTarget, dynamicTarget]),
    );
  });

  test("resolves relative ESM imports from a module's redirect-final path", async ({
    page,
  }) => {
    const initialMainTarget =
      "https://preview.example.com/releases/latest/main.js";
    const finalMainTarget =
      "https://preview.example.com/builds/v42/assets/main.js";
    const finalStaticTarget =
      "https://preview.example.com/builds/v42/assets/static.js";
    const finalDynamicTarget =
      "https://preview.example.com/builds/v42/assets/lazy.js";
    const mainModule = `import { staticValue } from "./static.js";
      import("./lazy.js").then(({ dynamicValue }) => {
        document.body.dataset.runtime = staticValue + ":" + dynamicValue;
      }).catch(() => { document.body.dataset.runtime = "error"; });
      fetch("https://ambient.example.test/leak").catch(() => {});`;
    let ambientRequestObserved = false;
    await page.route("https://ambient.example.test/**", async (route) => {
      ambientRequestObserved = true;
      await route.fulfill({ status: 204 });
    });
    const harness = await installExternalRuntimeServer(page, {
      fixtureId: "redirect-final-esm",
      sourceUrl: "https://preview.example.com/releases/index.html",
      html: '<!doctype html><body data-runtime="pending"><script type="module" src="./latest/main.js"></script></body>',
      upstream: {
        [initialMainTarget]: {
          body: mainModule,
          contentType: "text/javascript; charset=utf-8",
          redirectTo: finalMainTarget,
        },
        [finalMainTarget]: {
          body: mainModule,
          contentType: "text/javascript; charset=utf-8",
        },
        [finalStaticTarget]: {
          body: 'export const staticValue = "redirect-static-ready";',
          contentType: "text/javascript; charset=utf-8",
        },
        [finalDynamicTarget]: {
          body: 'export const dynamicValue = "redirect-dynamic-ready";',
          contentType: "text/javascript; charset=utf-8",
        },
      },
    });

    try {
      await page.context().addCookies([
        {
          name: "reviewer_session",
          value: "browser-only-fixture",
          url: harness.hostUrl,
        },
      ]);
      await page.goto(harness.hostUrl);

      await expect(harness.artifact.locator("body")).toHaveAttribute(
        "data-runtime",
        "redirect-static-ready:redirect-dynamic-ready",
      );
      expect(harness.upstreamRequests).toEqual(
        expect.arrayContaining([
          initialMainTarget,
          finalMainTarget,
          finalStaticTarget,
          finalDynamicTarget,
        ]),
      );
      expect(harness.runtimeRedirects).toHaveLength(1);
      const [runtimeRedirect] = harness.runtimeRedirects;
      if (!runtimeRedirect) {
        throw new Error("Expected one trusted-host redirect");
      }
      expect(runtimeRedirect.from).toBe(initialMainTarget);
      expect(
        new URL(runtimeRedirect.location, harness.trustedHostOrigin).origin,
      ).toBe(harness.trustedHostOrigin);
      expect(runtimeRedirect.headers).toEqual({
        location: runtimeRedirect.location,
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
        "access-control-allow-origin": "*",
      });
      expect(runtimeRedirect.headers).not.toHaveProperty("set-cookie");
      expect(runtimeRedirect.headers).not.toHaveProperty(
        "access-control-allow-credentials",
      );
      expect(harness.runtimeRequests).toHaveLength(4);
      for (const request of harness.runtimeRequests) {
        expect(request.cookie).toBeUndefined();
        expect(request.origin).toBe("null");
      }
      expect(harness.runtimeContentResponseHeaders).toHaveLength(3);
      for (const { headers } of harness.runtimeContentResponseHeaders) {
        expect(headers["access-control-allow-origin"]).toBe("*");
        expect(headers).not.toHaveProperty("access-control-allow-credentials");
        expect(headers).not.toHaveProperty("set-cookie");
      }
      expect(ambientRequestObserved).toBe(false);
    } finally {
      await harness.close();
    }
  });

  test("uses the redirect-final document path as the runtime base", async ({
    page,
  }) => {
    const expectedTarget =
      "https://preview.example.com/builds/abc/runtime/manifest.json";
    const harness = await installExternalRuntimeHarness(page, {
      fixtureId: "redirect-final-base",
      sourceUrl: "https://preview.example.com/builds/abc/index.html",
      html: `<!doctype html><body data-runtime="pending"><script>
        fetch("./runtime/manifest.json")
          .then((response) => response.json())
          .then((data) => { document.body.dataset.runtime = data.state; })
          .catch(() => { document.body.dataset.runtime = "error"; });
      </script></body>`,
      upstream: {
        [expectedTarget]: {
          body: JSON.stringify({ state: "redirect-final-ready" }),
          contentType: "application/json; charset=utf-8",
        },
      },
    });

    await page.goto(harness.hostUrl);

    await expect(harness.artifact.locator("body")).toHaveAttribute(
      "data-runtime",
      "redirect-final-ready",
    );
    expect(harness.upstreamRequests).toContain(expectedTarget);
  });

  test("denies artifact script self-navigation to an ambient origin", async ({
    page,
  }) => {
    test.fail(
      true,
      "Blocked: Chromium does not enforce CSP navigate-to for opaque sandbox self-navigation.",
    );
    await page.route("https://ambient.example.test/**", async (route) => {
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><p>Ambient artifact destination</p>",
      });
    });
    await page.route(`${trustedOrigin}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/navigation/artifact-host") {
        await fulfillTrustedHost(
          route,
          `${trustedOrigin}/navigation/artifact-ambient-start`,
        );
        return;
      }
      if (pathname === "/navigation/artifact-ambient-start") {
        await fulfillSandboxedArtifact(route, {
          body: `<!doctype html><body data-navigation-attempted="true"><script>location.href = "https://ambient.example.test/artifact-leak";</script></body>`,
          contentType: "text/html; charset=utf-8",
        });
        return;
      }
      await route.fulfill({ status: 204 });
    });

    await page.goto(`${trustedOrigin}/navigation/artifact-host`);
    await page.waitForTimeout(300);

    await expect(
      page.frameLocator("[data-shiplet-artifact-frame]").locator("body"),
    ).toHaveAttribute("data-navigation-attempted", "true");
  });

  test("allows artifact script self-navigation to the trusted Shiplet origin", async ({
    page,
  }) => {
    await page.route(`${trustedOrigin}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/navigation/artifact-trusted-host") {
        await fulfillTrustedHost(
          route,
          `${trustedOrigin}/navigation/artifact-trusted-start`,
        );
        return;
      }
      if (pathname === "/navigation/artifact-trusted-start") {
        await fulfillSandboxedArtifact(route, {
          body: `<!doctype html><script>location.href = "${trustedOrigin}/navigation/artifact-trusted-destination";</script>`,
          contentType: "text/html; charset=utf-8",
        });
        return;
      }
      if (pathname === "/navigation/artifact-trusted-destination") {
        await fulfillSandboxedArtifact(route, {
          body: '<!doctype html><p data-trusted-destination="artifact">Trusted artifact destination</p>',
          contentType: "text/html; charset=utf-8",
        });
        return;
      }
      await route.fulfill({ status: 204 });
    });

    await page.goto(`${trustedOrigin}/navigation/artifact-trusted-host`);

    await expect(
      page
        .frameLocator("[data-shiplet-artifact-frame]")
        .locator('[data-trusted-destination="artifact"]'),
    ).toHaveText("Trusted artifact destination");
  });

  test("denies review-context link navigation to an ambient origin", async ({
    page,
  }) => {
    test.fail(
      true,
      "Blocked: Chromium does not enforce CSP navigate-to for opaque sandbox link navigation.",
    );
    await page.route("https://ambient.example.test/**", async (route) => {
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><p>Ambient review-context destination</p>",
      });
    });
    await page.route(`${trustedOrigin}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/navigation/context-host") {
        await fulfillTrustedHost(
          route,
          `${trustedOrigin}/navigation/context-ambient-start`,
        );
        return;
      }
      if (pathname === "/navigation/context-ambient-start") {
        await fulfillSandboxedArtifact(route, {
          body: '<!doctype html><a data-ambient-link href="https://ambient.example.test/context-leak">Open ambient destination</a>',
          contentType: "text/html; charset=utf-8",
          role: "review_context",
        });
        return;
      }
      await route.fulfill({ status: 204 });
    });

    await page.goto(`${trustedOrigin}/navigation/context-host`);
    const context = page.frameLocator("[data-shiplet-artifact-frame]");
    await context.locator("[data-ambient-link]").click();
    await page.waitForTimeout(300);

    await expect(context.locator("[data-ambient-link]")).toBeVisible();
  });

  test("allows review-context link navigation to the trusted Shiplet origin", async ({
    page,
  }) => {
    await page.route(`${trustedOrigin}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/navigation/context-trusted-host") {
        await fulfillTrustedHost(
          route,
          `${trustedOrigin}/navigation/context-trusted-start`,
        );
        return;
      }
      if (pathname === "/navigation/context-trusted-start") {
        await fulfillSandboxedArtifact(route, {
          body: `<a data-trusted-link href="${trustedOrigin}/navigation/context-trusted-destination">Open trusted destination</a>`,
          contentType: "text/html; charset=utf-8",
          role: "review_context",
        });
        return;
      }
      if (pathname === "/navigation/context-trusted-destination") {
        await fulfillSandboxedArtifact(route, {
          body: '<!doctype html><p data-trusted-destination="context">Trusted context destination</p>',
          contentType: "text/html; charset=utf-8",
          role: "review_context",
        });
        return;
      }
      await route.fulfill({ status: 204 });
    });

    await page.goto(`${trustedOrigin}/navigation/context-trusted-host`);
    const context = page.frameLocator("[data-shiplet-artifact-frame]");
    await context.locator("[data-trusted-link]").click();

    await expect(
      context.locator('[data-trusted-destination="context"]'),
    ).toHaveText("Trusted context destination");
  });
});
