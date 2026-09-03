export type KernelAdminAuditActor = {
  kind: "human" | "agent" | "system";
  id: string;
};

export type KernelAdminAuditOutcome =
  | "intent"
  | "succeeded"
  | "denied"
  | "failed";

export type KernelAdminAuditInput = {
  organizationId: string;
  projectId?: string | null;
  actor: KernelAdminAuditActor;
  action: string;
  outcome: KernelAdminAuditOutcome;
  metadata?: Record<string, unknown>;
  occurredOn?: string;
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ACTION_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){1,7}$/;
const FORBIDDEN_METADATA_KEY = /(?:access|refresh|oauth|bearer|authorization|password|secret|credential|cookie|claim|code|state)[_-]?(?:token|url|value|hash|header|key)?/i;
const MAX_METADATA_BYTES = 4_096;

function safeMetadataValue(value: unknown, depth: number): unknown {
  if (depth > 4) throw new TypeError("Kernel audit metadata is too deeply nested");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Kernel audit metadata contains a non-finite number");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 256) throw new TypeError("Kernel audit metadata string is too long");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 20) throw new TypeError("Kernel audit metadata array is too large");
    return value.map((item) => safeMetadataValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") {
    throw new TypeError("Kernel audit metadata must be JSON-compatible");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 24) throw new TypeError("Kernel audit metadata has too many fields");
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
      throw new TypeError("Kernel audit metadata key is invalid");
    }
    if (FORBIDDEN_METADATA_KEY.test(key) && !/^(?:tokenId|invitationId|intentEventId)$/.test(key)) {
      throw new TypeError("Kernel audit metadata contains a credential-shaped key");
    }
    output[key] = safeMetadataValue(item, depth + 1);
  }
  return output;
}

function validateInput(input: KernelAdminAuditInput) {
  if (!ID_PATTERN.test(input.organizationId)) throw new TypeError("Invalid audit organization ID");
  if (input.projectId && !ID_PATTERN.test(input.projectId)) throw new TypeError("Invalid audit project ID");
  if (!ID_PATTERN.test(input.actor.id)) throw new TypeError("Invalid audit actor ID");
  if (!ACTION_PATTERN.test(input.action) || input.action.length > 96) {
    throw new TypeError("Invalid kernel audit action");
  }
  const metadata = safeMetadataValue(input.metadata || {}, 0) as Record<string, unknown>;
  const metadataJson = JSON.stringify(metadata);
  if (new TextEncoder().encode(metadataJson).byteLength > MAX_METADATA_BYTES) {
    throw new TypeError("Kernel audit metadata is too large");
  }
  const occurredOn = input.occurredOn || new Date().toISOString();
  if (!Number.isFinite(Date.parse(occurredOn))) throw new TypeError("Invalid audit timestamp");
  return { metadataJson, occurredOn };
}

export async function appendKernelAdminAuditEvent(
  db: D1Database,
  input: KernelAdminAuditInput,
) {
  const { metadataJson, occurredOn } = validateInput(input);
  const id = `kernel_audit_${crypto.randomUUID().replace(/-/g, "")}`;
  await db
    .prepare(
      `INSERT INTO kernel_admin_audit_events (
       id, organization_id, project_id, actor_kind, actor_id,
       action, outcome, metadata_json, occurred_on
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.organizationId,
      input.projectId || null,
      input.actor.kind,
      input.actor.id,
      input.action,
      input.outcome,
      metadataJson,
      occurredOn,
    )
    .run();
  return Object.freeze({ id, occurredOn });
}

export async function requireAuditedOrganizationAdministrator<T>(input: {
  db: D1Database;
  organizationId: string;
  projectId?: string | null;
  actorId: string;
  action: string;
  authorize: () => Promise<T>;
}) {
  try {
    return await input.authorize();
  } catch (error) {
    await appendKernelAdminAuditEvent(input.db, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      actor: { kind: "human", id: input.actorId },
      action: input.action,
      outcome: "denied",
      metadata: { reason: error instanceof Response ? `http_${error.status}` : "authorization_failed" },
    });
    throw error;
  }
}

export async function runAuditedKernelAdminAction<T>(input: {
  db: D1Database;
  organizationId: string;
  projectId?: string | null;
  actorId: string;
  action: string;
  targetKind: string;
  operation: () => Promise<T>;
}) {
  const intent = await appendKernelAdminAuditEvent(input.db, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    actor: { kind: "human", id: input.actorId },
    action: input.action,
    outcome: "intent",
    metadata: { targetKind: input.targetKind },
  });
  try {
    const result = await input.operation();
    await appendKernelAdminAuditEvent(input.db, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      actor: { kind: "human", id: input.actorId },
      action: input.action,
      outcome: "succeeded",
      metadata: { targetKind: input.targetKind, intentEventId: intent.id },
    });
    return result;
  } catch (error) {
    await appendKernelAdminAuditEvent(input.db, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      actor: { kind: "human", id: input.actorId },
      action: input.action,
      outcome: "failed",
      metadata: { targetKind: input.targetKind, intentEventId: intent.id },
    });
    throw error;
  }
}
