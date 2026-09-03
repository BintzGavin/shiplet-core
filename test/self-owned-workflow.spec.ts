import { describe, expect, it } from "vitest";

import {
  parseWorkflowSchema,
  validateWorkflowEvent,
} from "../src/self-owned/workflow";

const workflow = {
  schemaVersion: "shiplet.workflow/v1",
  statuses: [
    { name: "Needs review", category: "open" },
    { name: "Waiting on owner", category: "blocked" },
    { name: "FYI", category: "informational" },
    { name: "Approved", category: "resolved" },
  ],
  fields: [
    { name: "risk", type: "string" },
    { name: "score", type: "number" },
    { name: "ready", type: "boolean" },
    { name: "context", type: "object" },
  ],
};

describe("package-defined workflow boundary", () => {
  it("Given a declared status and fields, when an event is validated, then the canonical projection preserves them", () => {
    const schema = parseWorkflowSchema(workflow);
    const result = validateWorkflowEvent(schema, {
      status: "Waiting on owner",
      summary: "Legal review is required",
      fields: {
        risk: "medium",
        score: 4,
        ready: false,
        context: { section: "terms" },
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        status: "Waiting on owner",
        summary: "Legal review is required",
        canonicalStatusCategory: "blocked",
        fields: {
          risk: "medium",
          score: 4,
          ready: false,
          context: { section: "terms" },
        },
      },
    });
  });

  it.each([
    ["undeclared status", { status: "Shadow", summary: "No", fields: {} }, "undeclared_status"],
    ["undeclared field", { status: "Needs review", summary: "No", fields: { secretField: "x" } }, "undeclared_field"],
    ["wrong field type", { status: "Needs review", summary: "No", fields: { score: "four" } }, "invalid_field_type"],
    ["credential-shaped field", { status: "Needs review", summary: "No", fields: { context: { accessToken: "forbidden" } } }, "forbidden_payload_key"],
  ])("rejects %s", (_label, input, code) => {
    const result = validateWorkflowEvent(parseWorkflowSchema(workflow), input);
    expect(result).toEqual({ ok: false, code });
  });
});
