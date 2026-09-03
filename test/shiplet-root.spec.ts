import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ShipletRoot } from "../src/shiplet-root";
import type { ReviewLayer } from "../src/review-layer";

const ACTOR = { kind: "human" as const, id: "user_shiplet_root_owner" };

function projectId(label: string) {
  return `project_${label}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function layer(version: string, heading: string): ReviewLayer {
  return {
    version,
    entryPath: "index.html",
    files: [
      {
        path: "index.html",
        mediaType: "text/html; charset=utf-8",
        encoding: "utf8",
        content: `<!doctype html><h1>${heading}</h1>`,
      },
    ],
  };
}

function root(id: string) {
  return (env as Env).SHIPLET_ROOT.getByName(id);
}

describe("ShipletRoot contract", () => {
  it("is exported as the per-Shiplet durable authority", () => {
    expect(ShipletRoot).toBeTypeOf("function");
  });

  it("initializes idempotently and refuses identity reassignment", async () => {
    const id = projectId("identity");
    const stub = root(id);
    const initial = await stub.initialize({
      projectId: id,
      layer: layer("default:revision_1", "Initial"),
      actor: ACTOR,
    });
    const repeated = await stub.initialize({
      projectId: id,
      layer: layer("default:revision_2", "Must not replace"),
      actor: ACTOR,
    });

    expect(repeated).toEqual(initial);
    await runInDurableObject(stub, async (instance) => {
      await expect(
        (instance as ShipletRoot).initialize({
          projectId: projectId("other"),
          layer: layer("default:revision_3", "Other"),
          actor: ACTOR,
        }),
      ).rejects.toThrow("shiplet_root_identity_conflict");
    });
    expect((await stub.health(id)).auditEvents).toBe(1);
  });

  it("isolates Shiplet state by deterministic object identity", async () => {
    const firstId = projectId("first");
    const secondId = projectId("second");
    const first = root(firstId);
    const second = root(secondId);
    await first.initialize({
      projectId: firstId,
      layer: layer("default:first", "First"),
      actor: ACTOR,
    });
    await second.initialize({
      projectId: secondId,
      layer: layer("default:second", "Second"),
      actor: ACTOR,
    });

    const preview = await first.prepareReviewLayerPreview({
      projectId: firstId,
      fallback: layer("ignored", "Ignored"),
      baseVersion: "default:first",
      changes: [
        {
          op: "put",
          path: "index.html",
          mediaType: "text/html; charset=utf-8",
          encoding: "utf8",
          content: "<!doctype html><h1>First changed</h1>",
        },
      ],
      actor: ACTOR,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error(preview.code);
    expect(
      await first.applyReviewLayerPreview({
        projectId: firstId,
        previewId: preview.previewId,
        expectedVersion: "default:first",
        actor: ACTOR,
      }),
    ).toMatchObject({ ok: true });

    const untouched = await second.readReviewLayer({
      projectId: secondId,
      layer: layer("ignored", "Ignored"),
      actor: ACTOR,
    });
    expect(untouched.reviewLayer).toEqual(layer("default:second", "Second"));
  });

  it("allows only one competing preview to win a version fence", async () => {
    const id = projectId("fence");
    const stub = root(id);
    const fallback = layer("default:fence", "Base");
    await stub.initialize({ projectId: id, layer: fallback, actor: ACTOR });
    const changes = (heading: string) => [
      {
        op: "put",
        path: "index.html",
        mediaType: "text/html; charset=utf-8",
        encoding: "utf8",
        content: `<!doctype html><h1>${heading}</h1>`,
      },
    ];
    const first = await stub.prepareReviewLayerPreview({
      projectId: id,
      fallback,
      baseVersion: fallback.version,
      changes: changes("Winner"),
      actor: ACTOR,
    });
    const second = await stub.prepareReviewLayerPreview({
      projectId: id,
      fallback,
      baseVersion: fallback.version,
      changes: changes("Stale"),
      actor: ACTOR,
    });
    if (!first.ok || !second.ok) throw new Error("preview setup failed");

    const winner = await stub.applyReviewLayerPreview({
      projectId: id,
      previewId: first.previewId,
      expectedVersion: fallback.version,
      actor: ACTOR,
    });
    const stale = await stub.applyReviewLayerPreview({
      projectId: id,
      previewId: second.previewId,
      expectedVersion: fallback.version,
      actor: ACTOR,
    });
    expect(winner).toMatchObject({ ok: true });
    expect(stale).toEqual({ ok: false, code: "review_layer_conflict" });
  });

  it("copies inherited state with provenance and independent versioning", async () => {
    const sourceId = projectId("source");
    const childId = projectId("child");
    const sourceLayer = layer("review_layer_source", "Source");
    await root(sourceId).initialize({
      projectId: sourceId,
      layer: sourceLayer,
      actor: ACTOR,
    });

    const child = await root(childId).initialize({
      projectId: childId,
      layer: sourceLayer,
      actor: ACTOR,
      provenance: {
        sourceShipletId: sourceId,
        sourceVersion: sourceLayer.version,
      },
    });
    expect(child.provenance).toEqual({
      sourceShipletId: sourceId,
      sourceVersion: sourceLayer.version,
    });
    expect(child.reviewLayer.version).not.toBe(sourceLayer.version);
    expect(child.reviewLayer.files).toEqual(sourceLayer.files);
  });
});
