/** Provider-owned implementation. The only external effect is the injected caller's MCP execute. */
export type Connection = { server?: string; origin?: string };
export type ArtifactFile = {
  path: string;
  content: string;
  mediaType?: string;
  encoding?: "utf8" | "base64";
};
export type ReviewRef = {
  projectId: string;
  revisionId: string;
  origin: string;
  reviewUrl: string;
  previewUrl: string;
  artifactUrl: string;
};
export type Checkpoint = {
  projectId: string;
  baseRevisionId: string;
  draftId: string;
  draftVersion: number;
};
export type Candidate = ReviewRef & {
  baseRevisionId: string;
  draftId: string;
  draftVersion: number;
  feedbackIds: string[];
};
export type EvidenceCheck = {
  feedbackId: string;
  path: string;
  includes?: string;
  excludes?: string;
};
type PackageFile = ArtifactFile & {
  encoding: "utf8" | "base64";
  size: number;
  sha256: string;
  mediaType: string;
};
type Package = {
  manifest: { staticFirst: boolean; entrypoints: { artifact: string } };
  files: PackageFile[];
};
type Ticket = {
  id: string;
  project_id: string;
  source_revision_id?: string | null;
  status: string;
  [key: string]: unknown;
};
export class ShipletError extends Error {
  constructor(
    public code: string,
    public status?: number,
    public checkpoint?: Checkpoint,
  ) {
    super(code);
    this.name = "ShipletError";
  }
}
function recoverable(
  error: unknown,
  fallback: string,
  recovery: { checkpoint?: Checkpoint; publishedProjectId?: string },
) {
  const failure = error instanceof ShipletError ? error : new ShipletError(fallback);
  // Kody transports Error.message across its execution boundary. Keep the
  // acknowledged recovery data there as well as on the local error object.
  return Object.assign(failure, recovery, {
    message: JSON.stringify({ code: failure.code, status: failure.status, ...recovery }),
  });
}
function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function identifier(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value))
    throw new ShipletError("invalid_identifier");
  return encodeURIComponent(value);
}
function assetPath(value: string) {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[?#\x00-\x1f]/.test(value) ||
    value.split("/").some((s) => !s || s === "." || s === ".." || s.startsWith("."))
  )
    throw new ShipletError("invalid_artifact_path");
  return value;
}
function bytes(file: ArtifactFile) {
  if (typeof file.content !== "string") throw new ShipletError("invalid_file_content");
  if (file.encoding && !["utf8", "base64"].includes(file.encoding))
    throw new ShipletError("invalid_file_encoding");
  return file.encoding === "base64"
    ? Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(file.content);
}
function base64(value: Uint8Array) {
  let binary = "";
  for (let n = 0; n < value.length; n += 16384)
    binary += String.fromCharCode(...value.subarray(n, n + 16384));
  return btoa(binary);
}
async function packageFile(file: ArtifactFile): Promise<PackageFile> {
  const data = bytes(file);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return {
    ...file,
    path: `artifact/${assetPath(file.path)}`,
    encoding: file.encoding ?? "utf8",
    mediaType: file.mediaType ?? mediaType(file.path),
    size: data.length,
    sha256: Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join(""),
  };
}
function mediaType(path: string) {
  const extension = path.split(".").pop();
  return (
    (
      {
        html: "text/html; charset=utf-8",
        css: "text/css; charset=utf-8",
        js: "text/javascript; charset=utf-8",
        json: "application/json",
        svg: "image/svg+xml",
        txt: "text/plain; charset=utf-8",
      } as Record<string, string>
    )[extension ?? ""] ?? "application/octet-stream"
  );
}
function files(input: ArtifactFile[]) {
  if (!Array.isArray(input) || !input.length || input.length > 1024)
    throw new ShipletError("invalid_files");
  const paths = input.map((file) => assetPath(file.path));
  if (new Set(paths).size !== paths.length) throw new ShipletError("duplicate_file_path");
  input.forEach(bytes);
  return input;
}
function staticPackage(value: unknown): Package {
  if (
    !record(value) ||
    value.manifest?.staticFirst !== true ||
    !Array.isArray(value.files) ||
    !value.manifest?.entrypoints?.artifact?.startsWith("artifact/")
  )
    throw new ShipletError("static_package_required");
  return value as Package;
}
function unwrap(value: unknown): Record<string, any> {
  if (!record(value)) throw new ShipletError("invalid_mcp_response");
  if (value.isError || value.__mcpIsError) {
    const message = (value.__mcpContent ?? value.content)?.find(
      (part: any) => part.type === "text",
    )?.text;
    const statuses: Record<string, number> = {
      "Error: Request invalid": 400,
      "Error: Authorization denied": 403,
      "Error: Operation unavailable": 404,
      "Error: Request conflict": 409,
      "Error: Request failed": 502,
    };
    throw new ShipletError("mcp_error", statuses[message]);
  }
  if (value.error) throw new ShipletError("mcp_error", value.error.code);
  let payload: unknown = value.__mcpStructuredContent ?? value.structuredContent;
  if (payload === undefined) {
    const texts = (value.__mcpContent ?? value.content)?.filter(
      (part: any) => part.type === "text",
    );
    if (!texts || texts.length !== 1) throw new ShipletError("invalid_mcp_response");
    try {
      payload = JSON.parse(texts[0].text);
    } catch {
      throw new ShipletError("invalid_mcp_response");
    }
  }
  if (!record(payload)) throw new ShipletError("invalid_mcp_response");
  return payload;
}

export function createShipletClient(options: {
  origin: string;
  execute: (input: { code: string }) => Promise<unknown>;
}) {
  const origin = new URL(options.origin).origin;
  if (!/^https?:$/.test(new URL(origin).protocol)) throw new ShipletError("invalid_origin");
  const url = (path: unknown) => {
    try {
      if (typeof path !== "string" || !path.trim()) throw new Error();
      const resolved = new URL(path, origin);
      if (resolved.origin !== origin || resolved.username || resolved.password) throw new Error();
      return resolved.toString();
    } catch {
      throw new ShipletError("invalid_response_url");
    }
  };
  async function request(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, unknown>,
    idempotencyKey?: string,
  ) {
    // A JSON literal is required by Shiplet's parser. Reviewer strings can never become code.
    const call = {
      method,
      path,
      ...(body === undefined ? {} : { body }),
      ...(query ? { query } : {}),
      ...(idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : {}),
    };
    const value = unwrap(
      await options.execute({
        code: `async () => await codemode.request(${JSON.stringify(call)})`,
      }),
    );
    if (value.ok === false && value.code !== "trusted_approval_required")
      throw new ShipletError(value.code ?? "api_rejected");
    return value;
  }
  function validateRef(ref: Pick<ReviewRef, "projectId" | "revisionId"> & Partial<ReviewRef>) {
    identifier(ref.projectId);
    identifier(ref.revisionId);
    if (ref.origin && ref.origin !== origin) throw new ShipletError("connection_mismatch");
  }
  async function active(projectId: string) {
    const result = await request("GET", `/api/shiplets/${identifier(projectId)}/package`);
    staticPackage(result.package);
    if (typeof result.revision?.id !== "string" || result.revision.shipletId !== projectId)
      throw new ShipletError("invalid_revision_response");
    return result;
  }
  async function selected(ref: ReviewRef, feedbackIds: string[]) {
    if (
      !Array.isArray(feedbackIds) ||
      feedbackIds.length > 250 ||
      new Set(feedbackIds).size !== feedbackIds.length
    )
      throw new ShipletError("invalid_feedback_ids");
    const result: Ticket[] = [];
    for (const id of feedbackIds) {
      const { feedback } = await request(
        "GET",
        `/api/projects/${identifier(ref.projectId)}/review-feedback/${identifier(id)}`,
      );
      if (!feedback || feedback.id !== id || feedback.project_id !== ref.projectId)
        throw new ShipletError("feedback_not_found");
      if (!feedback.source_revision_id) throw new ShipletError("unknown_feedback_revision");
      if (feedback.source_revision_id !== ref.revisionId)
        throw new ShipletError("wrong_feedback_revision");
      result.push(feedback);
    }
    return result;
  }
  return {
    async list() {
      return request("GET", "/api/shiplets");
    },
    async publish(input: {
      name: string;
      organizationId?: string;
      subdomain: string;
      visibility: "private" | "public";
      files: ArtifactFile[];
    }) {
      if (!["private", "public"].includes(input.visibility))
        throw new ShipletError("explicit_visibility_required");
      if (!files(input.files).some((f) => f.path === "index.html"))
        throw new ShipletError("index_html_required");
      const published = await request("POST", "/api/shiplets", {
        name: input.name,
        organization_id: input.organizationId,
        subdomain: input.subdomain,
        visibility: input.visibility,
        assets: input.files.map((file) => ({
          path: file.path,
          content: base64(bytes(file)),
          contentType: file.mediaType ?? mediaType(file.path),
        })),
      });
      const projectId = published.project?.id;
      if (typeof projectId !== "string") throw new ShipletError("invalid_publish_response");
      try {
        const current = await active(projectId);
        return {
          projectId,
          revisionId: current.revision.id,
          origin,
          reviewUrl: url(published.reviewUrl),
          previewUrl: url(published.previewUrl),
          artifactUrl: url(published.artifactUrl),
        } as ReviewRef;
      } catch (error) {
        // Creation is not idempotent. Preserve the acknowledged identity for recovery.
        throw recoverable(error, "publish_read_failed", { publishedProjectId: projectId });
      }
    },
    async inspect(input: { projectId: string }) {
      return active(input.projectId);
    },
    async feedback(input: {
      ref: ReviewRef;
      status?: string;
      includeClosed?: boolean;
      pageUrl?: string;
      revisionId?: string;
      limit?: number;
      cursor?: string;
    }) {
      validateRef(input.ref);
      const { ref, ...query } = input;
      const page = await request(
        "GET",
        `/api/projects/${identifier(ref.projectId)}/review-feedback`,
        undefined,
        query,
      );
      if (
        !Array.isArray(page.feedback) ||
        !(page.nextCursor === null || typeof page.nextCursor === "string")
      )
        throw new ShipletError("unsupported_feedback_contract");
      return {
        projectId: ref.projectId,
        referenceRevisionId: ref.revisionId,
        nextCursor: page.nextCursor as string | null,
        feedback: page.feedback.map((ticket: Ticket) => {
          if (ticket.project_id !== ref.projectId) throw new ShipletError("cross_project_response");
          return {
            ...ticket,
            revisionRelation: !ticket.source_revision_id
              ? "unknown"
              : ticket.source_revision_id === ref.revisionId
                ? "matches_reference"
                : "other_revision",
          };
        }),
      };
    },
    async prepareRevision(input: {
      ref: ReviewRef;
      feedbackIds: string[];
      changes: ArtifactFile[];
      checkpoint?: Checkpoint;
    }) {
      const { ref } = input;
      validateRef(ref);
      files(input.changes);
      const current = await active(ref.projectId);
      if (current.revision.id !== ref.revisionId) throw new ShipletError("stale_revision");
      await selected(ref, input.feedbackIds);
      let checkpoint = input.checkpoint;
      if (
        checkpoint &&
        (checkpoint.projectId !== ref.projectId || checkpoint.baseRevisionId !== ref.revisionId)
      )
        throw new ShipletError("checkpoint_mismatch");
      try {
        if (!checkpoint) {
          const { draft } = await request(
            "POST",
            `/api/shiplets/${identifier(ref.projectId)}/drafts`,
            { fromRevisionId: ref.revisionId },
          );
          checkpoint = {
            projectId: ref.projectId,
            baseRevisionId: ref.revisionId,
            draftId: draft.id,
            draftVersion: draft.version,
          };
        }
        const draftPath = `/api/drafts/${identifier(checkpoint.draftId)}`;
        const exported = await request("GET", `${draftPath}/package`);
        if (
          exported.draft?.shipletId !== ref.projectId ||
          exported.draft?.baseRevisionId !== ref.revisionId ||
          exported.draft?.version !== checkpoint.draftVersion
        )
          throw new ShipletError("draft_conflict");
        const proposed = staticPackage(exported.package);
        const updates = await Promise.all(input.changes.map(packageFile));
        proposed.files = [
          ...proposed.files.filter((f) => !updates.some((u) => u.path === f.path)),
          ...updates,
        ];
        const { draft } = await request("PUT", `${draftPath}/package`, {
          expectedVersion: checkpoint.draftVersion,
          package: proposed,
        });
        checkpoint = { ...checkpoint, draftVersion: draft.version };
        const { validation } = await request("POST", `${draftPath}/validate`, {
          expectedVersion: checkpoint.draftVersion,
        });
        if (!validation?.ok || !validation.revisionId || !validation.previewUrl)
          throw new ShipletError("revision_validation_failed");
        return {
          ...ref,
          ...checkpoint,
          revisionId: validation.revisionId,
          previewUrl: url(validation.previewUrl),
          feedbackIds: [...input.feedbackIds],
        } as Candidate;
      } catch (error) {
        throw recoverable(error, "revision_failed", { checkpoint });
      }
    },
    async inspectDraft(input: { projectId: string; draftId: string }) {
      const result = await request("GET", `/api/drafts/${identifier(input.draftId)}/package`);
      if (result.draft?.shipletId !== input.projectId)
        throw new ShipletError("checkpoint_mismatch");
      return result;
    },
    async activateRevision(input: {
      candidate: Candidate;
      approvalRequestId?: string;
      idempotencyKey: string;
      approval?: boolean;
    }) {
      const { candidate } = input;
      validateRef(candidate);
      if (!input.idempotencyKey) throw new ShipletError("idempotency_key_required");
      const draft = await request("GET", `/api/drafts/${identifier(candidate.draftId)}/package`);
      if (
        draft.draft?.shipletId !== candidate.projectId ||
        draft.draft?.baseRevisionId !== candidate.baseRevisionId ||
        draft.draft?.version !== candidate.draftVersion ||
        draft.draft?.validatedRevisionId !== candidate.revisionId
      )
        throw new ShipletError("candidate_conflict");
      const result = await request(
        "POST",
        `/api/drafts/${identifier(candidate.draftId)}/promote`,
        {
          expectedActiveRevisionId: candidate.baseRevisionId,
          approvalRequestId: input.approvalRequestId,
          ...(input.approval === true ? { approval: true } : {}),
        },
        undefined,
        input.idempotencyKey,
      );
      if (result.code === "trusted_approval_required")
        return {
          state: "approval_required" as const,
          candidate,
          approvalRequestId: result.approval.approvalRequestId,
          approvalUrl: url(result.approval.confirmationPath),
          expiresAt: result.approval.expiresAt,
        };
      if (result.revision?.id !== candidate.revisionId)
        throw new ShipletError("invalid_promotion_response");
      return { ...candidate, state: "active" as const };
    },
    async verifyRevision(input: { candidate: Candidate; checks: EvidenceCheck[] }) {
      const { candidate, checks } = input;
      validateRef(candidate);
      if (!Array.isArray(checks) || checks.length < 1 || checks.length > 250)
        throw new ShipletError("evidence_checks_required");
      for (const check of checks) {
        assetPath(check.path);
        if (
          (!check.includes && !check.excludes) ||
          !candidate.feedbackIds.includes(check.feedbackId)
        )
          throw new ShipletError("invalid_evidence_check");
      }
      const tickets = await selected({ ...candidate, revisionId: candidate.baseRevisionId }, [
        ...new Set(checks.map((c) => c.feedbackId)),
      ]);
      const path = `/api/shiplets/${identifier(candidate.projectId)}/revisions/`;
      const before = await request("GET", `${path}${identifier(candidate.baseRevisionId)}/package`);
      const after = await request("GET", `${path}${identifier(candidate.revisionId)}/package`);
      if (
        before.revision?.id !== candidate.baseRevisionId ||
        after.revision?.id !== candidate.revisionId ||
        after.revision?.parentRevisionId !== candidate.baseRevisionId
      )
        throw new ShipletError("revision_lineage_mismatch");
      const source = staticPackage(before.package),
        target = staticPackage(after.package);
      function passes(pkg: Package, check: EvidenceCheck) {
        const file = pkg.files.find((f) => f.path === `artifact/${check.path}`);
        if (!file) return false;
        const content = new TextDecoder().decode(bytes(file));
        return (
          (!check.includes || content.includes(check.includes)) &&
          (!check.excludes || !content.includes(check.excludes))
        );
      }
      return {
        projectId: candidate.projectId,
        sourceRevisionId: candidate.baseRevisionId,
        candidateRevisionId: candidate.revisionId,
        evidenceKind: "artifact_text_checks" as const,
        reviewRequired: true,
        results: checks.map((check) => ({
          ...check,
          status: tickets.find((t) => t.id === check.feedbackId)!.status,
          sourcePassed: passes(source, check),
          candidatePassed: passes(target, check),
          outcome: !passes(target, check)
            ? "checks_failed"
            : passes(source, check)
              ? "unchanged_checks"
              : "changed_checks_passed",
        })),
      };
    },
  };
}
