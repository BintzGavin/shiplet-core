import { describe, expect, it } from "vitest";

import checkedIn from "../openapi.json";

const spec = checkedIn as Record<string, any>;
const paths = spec.paths as Record<string, Record<string, Record<string, any>>>;
const schemas = spec.components.schemas as Record<string, Record<string, any>>;

function operation(path: string, method: string) {
  const candidate = paths[path]?.[method];
  expect(candidate, `${method.toUpperCase()} ${path}`).toBeDefined();
  return candidate;
}

describe("focused public OpenAPI contract", () => {
  it("describes only the review product, not its internal package lifecycle", () => {
    const serialized = JSON.stringify(spec);
    for (const retiredPath of [
      "/api/shiplets/{projectId}/package",
      "/api/shiplets/{projectId}/drafts",
      "/api/drafts/{draftId}/validate",
      "/api/drafts/{draftId}/promote",
      "/api/shiplets/{projectId}/rollback",
      "/api/revisions/{revisionId}/deployments",
      "/api/cloudflare/oauth/start",
    ]) {
      expect(paths).not.toHaveProperty(retiredPath);
    }
    expect(serialized).not.toContain("ShipletPackage");
    expect(serialized).not.toContain("PromotionRequest");
    expect(serialized).not.toContain("DeploymentRequest");
    expect(spec.info.description).toMatch(/prepare an artifact/i);
    expect(spec.info.description).toMatch(/review layer/i);
  });

  it("publishes the complete bounded review-layer workflow", () => {
    expect(
      operation("/api/shiplets/{projectId}/review-layer", "get")[
        "x-shiplet-scopes"
      ],
    ).toEqual(["shiplets:read"]);
    expect(
      operation("/api/shiplets/{projectId}/review-layer/previews", "post")
        .requestBody.content["application/json"].schema,
    ).toEqual({ $ref: "#/components/schemas/ReviewLayerPreviewRequest" });
    expect(
      operation(
        "/api/shiplets/{projectId}/review-layer/previews/{previewId}/apply",
        "post",
      ).requestBody.content["application/json"].schema,
    ).toEqual({ $ref: "#/components/schemas/ReviewLayerApplyRequest" });

    expect(schemas.ReviewLayerFile).toMatchObject({
      required: ["path", "mediaType", "encoding", "content"],
      additionalProperties: false,
    });
    expect(schemas.ReviewLayerFile.properties).not.toHaveProperty("sha256");
    expect(schemas.ReviewLayerPreviewRequest.properties.changes).toMatchObject({
      minItems: 1,
      maxItems: 64,
    });
    expect(schemas.ReviewLayerApplyRequest).toMatchObject({
      required: ["expectedVersion", "approval"],
      properties: { approval: { const: true } },
      additionalProperties: false,
    });
  });

  it("marks exactly the trusted-host operations available to Code Mode", () => {
    const supported = new Set([
      "get /api/shiplets",
      "post /api/shiplets",
      "get /api/shiplets/{projectId}/review-layer",
      "post /api/shiplets/{projectId}/review-layer/previews",
      "post /api/shiplets/{projectId}/review-layer/previews/{previewId}/apply",
      "post /api/projects/{projectId}/archive",
      "post /api/projects/{projectId}/restore",
      "post /api/projects/archive",
      "get /api/projects/{projectId}/review-feedback",
      "post /api/projects/{projectId}/review-feedback",
      "get /api/projects/{projectId}/review-feedback/{feedbackId}",
      "post /api/projects/{projectId}/review-feedback/{feedbackId}/replies",
      "post /api/projects/{projectId}/review-feedback/{feedbackId}/status",
    ]);

    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, candidate] of Object.entries(pathItem)) {
        const key = `${method} ${path}`;
        expect(candidate["x-shiplet-code-mode"], key).toBe(supported.has(key));
      }
    }
  });

  it("declares useful success schemas and exact bearer scopes", () => {
    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, candidate] of Object.entries(pathItem)) {
        const success = Object.entries(candidate.responses ?? {}).find(
          ([status]) => /^2\d\d$/.test(status),
        )?.[1] as any;
        expect(
          success?.content?.["application/json"]?.schema ??
            success?.content?.["image/png"]?.schema,
          `${method.toUpperCase()} ${path}`,
        ).toBeDefined();

        const effectiveSecurity = candidate.security ?? spec.security;
        const acceptsBearer = effectiveSecurity.some((requirement: object) =>
          Object.hasOwn(requirement, "bearerAuth"),
        );
        if (acceptsBearer) {
          expect(
            Array.isArray(candidate["x-shiplet-scopes"]),
            `${method.toUpperCase()} ${path}`,
          ).toBe(true);
        }
      }
    }
  });

  it("keeps feedback inputs and credential types explicit", () => {
    expect(schemas.FeedbackCreateRequest.required).toEqual(
      expect.arrayContaining(["comment", "pageUrl", "clientFeedbackId"]),
    );
    expect(schemas.FeedbackReplyRequest.required).toEqual(["comment"]);
    expect(schemas.FeedbackStatusRequest.properties.status.enum).toEqual([
      "New",
      "In Progress",
      "Blocked",
      "Done",
      "Dropped",
    ]);
    expect(spec.components.securitySchemes.browserSession.name).toBe(
      "__Host-shiplet_session",
    );
    expect(operation("/api/mcp", "post").security).toEqual([
      { bearerAuth: [] },
      { oauthAccessToken: [] },
    ]);
  });
});
