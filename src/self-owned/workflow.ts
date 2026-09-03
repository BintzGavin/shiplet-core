export type WorkflowStatusCategory =
  | "open"
  | "in_progress"
  | "blocked"
  | "resolved"
  | "closed"
  | "informational";

export type WorkflowFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null"
  | "any";

export type WorkflowSchema = Readonly<{
  schemaVersion: "shiplet.workflow/v1";
  statuses: ReadonlyArray<Readonly<{ name: string; category: WorkflowStatusCategory }>>;
  fields: ReadonlyArray<Readonly<{ name: string; type: WorkflowFieldType }>>;
}>;

export type ValidatedWorkflowEvent = Readonly<{
  status: string;
  summary: string;
  canonicalStatusCategory: WorkflowStatusCategory;
  fields: Readonly<Record<string, unknown>>;
}>;

const CATEGORIES = new Set<WorkflowStatusCategory>([
  "open",
  "in_progress",
  "blocked",
  "resolved",
  "closed",
  "informational",
]);
const FIELD_TYPES = new Set<WorkflowFieldType>([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
  "any",
]);
const FORBIDDEN_KEYS = new Set([
  "accesstoken",
  "authorization",
  "authorizationcode",
  "bearer",
  "claim",
  "claimurl",
  "cookie",
  "credential",
  "oauth",
  "oauthtoken",
  "password",
  "refreshtoken",
  "secret",
  "session",
  "token",
]);
const NAME = /^[A-Za-z][A-Za-z0-9 _.-]{0,127}$/;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_NODES = 2_000;
const MAX_DEPTH = 24;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

function validName(value: unknown): value is string {
  return typeof value === "string" && NAME.test(value);
}

function normalizedKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function snapshotJson(value: unknown): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("payload_too_large");
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("invalid_payload");
      return current;
    }
    if (typeof current !== "object" || seen.has(current)) {
      throw new Error("invalid_payload");
    }
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > 256) throw new Error("payload_too_large");
        return Object.freeze(current.map((entry) => visit(entry, depth + 1)));
      }
      if (
        Object.getPrototypeOf(current) !== Object.prototype &&
        Object.getPrototypeOf(current) !== null
      ) {
        throw new Error("invalid_payload");
      }
      const output = Object.create(null) as Record<string, unknown>;
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = Object.keys(descriptors).filter(
        (key) => descriptors[key]?.enumerable,
      );
      if (keys.length > 256) throw new Error("payload_too_large");
      for (const key of keys.sort()) {
        if (
          key === "__proto__" ||
          key === "constructor" ||
          key === "prototype" ||
          FORBIDDEN_KEYS.has(normalizedKey(key))
        ) {
          throw new Error("forbidden_payload_key");
        }
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor)) throw new Error("invalid_payload");
        output[key] = visit(descriptor.value, depth + 1);
      }
      return Object.freeze(output);
    } finally {
      seen.delete(current);
    }
  };
  const snapshot = visit(value, 0);
  if (
    new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
    MAX_PAYLOAD_BYTES
  ) {
    throw new Error("payload_too_large");
  }
  return snapshot;
}

function matchesType(value: unknown, type: WorkflowFieldType) {
  if (type === "any") return true;
  if (type === "null") return value === null;
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  return typeof value === type;
}

export function parseWorkflowSchema(value: unknown): WorkflowSchema {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "statuses", "fields"]) ||
    value.schemaVersion !== "shiplet.workflow/v1" ||
    !Array.isArray(value.statuses) ||
    value.statuses.length === 0 ||
    value.statuses.length > 64 ||
    !Array.isArray(value.fields) ||
    value.fields.length > 128
  ) {
    throw new TypeError("invalid_workflow_schema");
  }
  const statusNames = new Set<string>();
  const statuses = value.statuses.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ["name", "category"]) ||
      !validName(entry.name) ||
      !CATEGORIES.has(entry.category as WorkflowStatusCategory) ||
      statusNames.has(entry.name)
    ) {
      throw new TypeError("invalid_workflow_status");
    }
    statusNames.add(entry.name);
    return Object.freeze({
      name: entry.name,
      category: entry.category as WorkflowStatusCategory,
    });
  });
  const fieldNames = new Set<string>();
  const fields = value.fields.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ["name", "type"]) ||
      !validName(entry.name) ||
      !FIELD_TYPES.has(entry.type as WorkflowFieldType) ||
      fieldNames.has(entry.name)
    ) {
      throw new TypeError("invalid_workflow_field");
    }
    fieldNames.add(entry.name);
    return Object.freeze({
      name: entry.name,
      type: entry.type as WorkflowFieldType,
    });
  });
  return Object.freeze({
    schemaVersion: "shiplet.workflow/v1" as const,
    statuses: Object.freeze(statuses),
    fields: Object.freeze(fields),
  });
}

export function validateWorkflowEvent(
  schema: WorkflowSchema,
  input: unknown,
): { ok: true; value: ValidatedWorkflowEvent } | { ok: false; code: string } {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["status", "summary", "fields"]) ||
    typeof input.status !== "string"
  ) {
    return { ok: false, code: "invalid_event" };
  }
  const status = schema.statuses.find((entry) => entry.name === input.status);
  if (!status) return { ok: false, code: "undeclared_status" };
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (
    summary.length === 0 ||
    new TextEncoder().encode(summary).byteLength > 512 ||
    !isRecord(input.fields)
  ) {
    return { ok: false, code: "invalid_event" };
  }
  const declarations = new Map(schema.fields.map((field) => [field.name, field]));
  for (const [name, value] of Object.entries(input.fields)) {
    const field = declarations.get(name);
    if (!field) return { ok: false, code: "undeclared_field" };
    if (!matchesType(value, field.type)) {
      return { ok: false, code: "invalid_field_type" };
    }
  }
  try {
    const fields = snapshotJson(input.fields);
    if (!isRecord(fields)) return { ok: false, code: "invalid_event" };
    return {
      ok: true,
      value: Object.freeze({
        status: status.name,
        summary,
        canonicalStatusCategory: status.category,
        fields: fields as Readonly<Record<string, unknown>>,
      }),
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_event";
    return {
      ok: false,
      code: ["forbidden_payload_key", "payload_too_large"].includes(code)
        ? code
        : "invalid_event",
    };
  }
}
