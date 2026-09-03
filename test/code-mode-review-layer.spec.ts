import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";

const OWNER_HEADERS = {
  "x-shiplet-user-id": "user_review_layer_owner",
  "x-shiplet-user-email": "review-layer-owner@example.com",
};

async function request(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  let response: Response;
  try {
    response = await app.fetch(
      new Request(`http://localhost${path}`, init),
      env as Env,
      context,
    );
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    response = error;
  }
  await waitOnExecutionContext(context);
  return response;
}

async function createShiplet(
  extra: Record<string, unknown> = {},
) {
  const organizationResponse = await request("/api/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
    body: JSON.stringify({ name: `Review layer ${crypto.randomUUID()}` }),
  });
  const { organization } = (await organizationResponse.json()) as {
    organization: { id: string };
  };
  const response = await request("/api/shiplets", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
    body: JSON.stringify({
      name: "Review layer Shiplet",
      organization_id: organization.id,
      subdomain: `review-layer-${crypto.randomUUID().slice(0, 8)}`,
      visibility: "private",
      assets: [
        {
          path: "index.html",
          content: btoa("<!doctype html><h1>Artifact stays separate</h1>"),
        },
      ],
      ...extra,
    }),
  });
  expect(response.status).toBe(201);
  const result = (await response.json()) as {
    project: { id: string; subdomain: string };
  };
  return { ...result, organizationId: organization.id };
}

async function mcp(body: Record<string, unknown>) {
  const response = await request("/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
    body: JSON.stringify(body),
  });
  return {
    response,
    value: (await response.json()) as Record<string, any>,
  };
}

async function execute(code: string) {
  const result = await mcp({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name: "execute", arguments: { code } },
  });
  const text = result.value.result?.content?.[0]?.text;
  return {
    ...result,
    output: typeof text === "string" ? JSON.parse(text) : undefined,
  };
}

describe("strict Code Mode review-layer contract", () => {
  it("always exposes exactly search and execute, even for Shiplet-scoped discovery", async () => {
    const { project } = await createShiplet();
    const listed = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { shipletId: project.id, ignored: "value" },
    });

    expect(listed.response.status).toBe(200);
    expect(
      listed.value.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(["search", "execute"]);
  });

  it("creates an independent review layer from an accessible source Shiplet", async () => {
    const { project: source, organizationId } = await createShiplet();
    const current = (await (
      await request(`/api/shiplets/${source.id}/review-layer`, {
        headers: OWNER_HEADERS,
      })
    ).json()) as { version: string };
    const previewResponse = await request(
      `/api/shiplets/${source.id}/review-layer/previews`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
        body: JSON.stringify({
          baseVersion: current.version,
          changes: [
            {
              op: "put",
              path: "index.html",
              mediaType: "text/html; charset=utf-8",
              encoding: "utf8",
              content: "<!doctype html><h1>Inherited review setup</h1>",
            },
          ],
        }),
      },
    );
    const preview = (await previewResponse.json()) as { previewId: string };
    await request(
      `/api/shiplets/${source.id}/review-layer/previews/${preview.previewId}/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
        body: JSON.stringify({
          expectedVersion: current.version,
          approval: true,
        }),
      },
    );
    const sourceLayer = (await (
      await request(`/api/shiplets/${source.id}/review-layer`, {
        headers: OWNER_HEADERS,
      })
    ).json()) as {
      version: string;
      files: Array<{ path: string; content: string }>;
    };

    const { project: child } = await createShiplet({
      organization_id: organizationId,
      review_layer_source_shiplet_id: source.id,
    });
    const childLayer = (await (
      await request(`/api/shiplets/${child.id}/review-layer`, {
        headers: OWNER_HEADERS,
      })
    ).json()) as typeof sourceLayer;
    expect(childLayer.version).not.toBe(sourceLayer.version);
    expect(childLayer.files).toEqual(sourceLayer.files);
  });

  it("searches the OpenAPI document progressively instead of returning the complete spec", async () => {
    const searched = await mcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "search",
        arguments: {
          code: `async () => {
            const spec = await codemode.spec();
            return Object.entries(spec.paths)
              .filter(([path]) => path.includes("review-layer"))
              .map(([path, operations]) => ({ path, methods: Object.keys(operations) }));
          }`,
        },
      },
    });

    const result = JSON.parse(searched.value.result.content[0].text);
    expect(result).toEqual([
      {
        path: "/api/shiplets/{projectId}/review-layer",
        methods: ["get"],
      },
      {
        path: "/api/shiplets/{projectId}/review-layer/previews",
        methods: ["post"],
      },
      {
        path:
          "/api/shiplets/{projectId}/review-layer/previews/{previewId}/apply",
        methods: ["post"],
      },
    ]);
  });

  it("reads only widget-relative files and composes the API result inside execute", async () => {
    const { project } = await createShiplet();
    const result = await execute(`async () => {
      const layer = await codemode.request({
        method: "GET",
        path: "/api/shiplets/${project.id}/review-layer"
      });
      return {
        version: layer.version,
        paths: layer.files.map((file) => file.path),
        leakedPackage: Object.hasOwn(layer, "package")
      };
    }`);

    expect(result.value.error).toBeUndefined();
    expect(result.output).toMatchObject({
      version: expect.any(String),
      paths: ["index.html"],
      leakedPackage: false,
    });
  });

  it("previews and atomically applies bounded review-layer changes without changing the artifact", async () => {
    const { project } = await createShiplet();
    const currentResponse = await request(
      `/api/shiplets/${project.id}/review-layer`,
      { headers: OWNER_HEADERS },
    );
    expect(currentResponse.status).toBe(200);
    const current = (await currentResponse.json()) as {
      version: string;
      files: Array<{ path: string; content: string }>;
    };
    expect(current.files.map((file) => file.path)).toEqual(["index.html"]);
    expect(JSON.stringify(current)).not.toContain("artifact/");
    expect(JSON.stringify(current)).not.toContain("shiplet.package");

    const previewResponse = await request(
      `/api/shiplets/${project.id}/review-layer/previews`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
        body: JSON.stringify({
          baseVersion: current.version,
          changes: [
            {
              op: "put",
              path: "index.html",
              mediaType: "text/html; charset=utf-8",
              encoding: "utf8",
              content: "<!doctype html><h1>Custom review toolbar</h1>",
            },
            {
              op: "put",
              path: "styles.css",
              mediaType: "text/css; charset=utf-8",
              encoding: "utf8",
              content: "h1 { color: rebeccapurple; }",
            },
          ],
        }),
      },
    );
    expect(previewResponse.status).toBe(201);
    const preview = (await previewResponse.json()) as {
      previewId: string;
      previewUrl: string;
      baseVersion: string;
      diagnostics: unknown[];
    };
    expect(preview).toMatchObject({
      previewId: expect.any(String),
      previewUrl: expect.stringContaining("/preview"),
      baseVersion: current.version,
      diagnostics: [],
    });

    const unchanged = (await (
      await request(`/api/shiplets/${project.id}/review-layer`, {
        headers: OWNER_HEADERS,
      })
    ).json()) as typeof current;
    expect(unchanged).toEqual(current);

    const appliedResponse = await request(
      `/api/shiplets/${project.id}/review-layer/previews/${preview.previewId}/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
        body: JSON.stringify({
          expectedVersion: current.version,
          approval: true,
        }),
      },
    );
    expect(appliedResponse.status).toBe(200);
    const applied = (await appliedResponse.json()) as {
      reviewLayer: {
        version: string;
        files: Array<{ path: string; content: string }>;
      };
    };
    expect(applied.reviewLayer.version).not.toBe(current.version);
    expect(applied.reviewLayer.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "index.html",
          content: "<!doctype html><h1>Custom review toolbar</h1>",
        }),
        expect.objectContaining({
          path: "styles.css",
          content: "h1 { color: rebeccapurple; }",
        }),
      ]),
    );

    const packageResponse = await request(`/api/shiplets/${project.id}/package`, {
      headers: OWNER_HEADERS,
    });
    const internalPackage = (await packageResponse.json()) as {
      package: { files: Array<{ path: string; content: string }> };
    };
    expect(
      internalPackage.package.files.find(
        (file) => file.path === "artifact/index.html",
      )?.content,
    ).not.toContain("Custom review toolbar");
  });

  it("rejects escaping paths without changing the active review layer", async () => {
    const { project } = await createShiplet();
    const current = (await (
      await request(`/api/shiplets/${project.id}/review-layer`, {
        headers: OWNER_HEADERS,
      })
    ).json()) as { version: string; files: unknown[] };

    const invalidResponse = await request(
      `/api/shiplets/${project.id}/review-layer/previews`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
        body: JSON.stringify({
          baseVersion: current.version,
          changes: [
            {
              op: "put",
              path: "../artifact/index.html",
              mediaType: "text/html",
              encoding: "utf8",
              content: "not allowed",
            },
          ],
        }),
      },
    );
    expect(invalidResponse.status).toBe(422);
    expect(await invalidResponse.json()).toMatchObject({
      code: "review_layer_invalid",
      diagnostics: [
        expect.objectContaining({
          path: "../artifact/index.html",
          code: "invalid_path",
        }),
      ],
    });

    const stillCurrent = await request(`/api/shiplets/${project.id}/review-layer`, {
      headers: OWNER_HEADERS,
    });
    expect(await stillCurrent.json()).toEqual(current);
  });

  it("rejects a stale preview after another preview wins the version fence", async () => {
    const { project } = await createShiplet();
    const current = (await (
      await request(`/api/shiplets/${project.id}/review-layer`, {
        headers: OWNER_HEADERS,
      })
    ).json()) as { version: string };

    async function preview(label: string) {
      const response = await request(
        `/api/shiplets/${project.id}/review-layer/previews`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
          body: JSON.stringify({
            baseVersion: current.version,
            changes: [
              {
                op: "put",
                path: "index.html",
                mediaType: "text/html; charset=utf-8",
                encoding: "utf8",
                content: `<!doctype html><h1>${label}</h1>`,
              },
            ],
          }),
        },
      );
      expect(response.status).toBe(201);
      return (await response.json()) as { previewId: string };
    }

    const winner = await preview("Winner");
    const stale = await preview("Stale");
    const apply = (previewId: string) =>
      request(
        `/api/shiplets/${project.id}/review-layer/previews/${previewId}/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...OWNER_HEADERS },
          body: JSON.stringify({
            expectedVersion: current.version,
            approval: true,
          }),
        },
      );

    expect((await apply(winner.previewId)).status).toBe(200);
    expect((await apply(stale.previewId)).status).toBe(409);
  });
});
