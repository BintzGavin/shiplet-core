import { describe, expect, it, vi } from "vitest";

import {
  createCustomMcpAuthorityPolicy,
  customMcpCapabilityPolicy,
  type CustomMcpActorAuthoritySnapshot,
} from "../src/custom-mcp-authority-policy";

function snapshot(
  overrides: Partial<CustomMcpActorAuthoritySnapshot> = {},
): CustomMcpActorAuthoritySnapshot {
  return Object.freeze({
    active: true,
    canView: true,
    canEdit: true,
    scopes: Object.freeze([
      "mcp" as const,
      "shiplets:read" as const,
      "shiplets:write" as const,
      "feedback:read" as const,
      "feedback:write" as const,
    ]),
    ...overrides,
  });
}

describe("custom MCP actor authority policy", () => {
  it("Given an agent lacks feedback:read, When a handler asks to read feedback, Then approval cannot widen the token scope", async () => {
    const resolveAuthority = vi.fn(async () =>
      snapshot({ scopes: Object.freeze(["mcp", "shiplets:read"]) }),
    );
    const policy = createCustomMcpAuthorityPolicy({ resolveAuthority });

    await expect(
      policy.authorizeCapability({
        actor: { kind: "agent", id: "agent_A" },
        shipletId: "shiplet_A",
        capability: "review.feedback.read",
      }),
    ).resolves.toBe(false);
    expect(resolveAuthority).toHaveBeenCalledOnce();
  });

  it("Given a project rule is revoked after grant creation, When effect-time policy runs, Then the same actor fails closed", async () => {
    const resolveAuthority = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({ active: false, canView: false }));
    const policy = createCustomMcpAuthorityPolicy({ resolveAuthority });
    const request = {
      actor: { kind: "agent" as const, id: "agent_A" },
      shipletId: "shiplet_A",
      capability: "state.read:review",
    };

    await expect(policy.authorizeCapability(request)).resolves.toBe(true);
    await expect(policy.authorizeCapability(request)).resolves.toBe(false);
  });

  it("Given an approver loses edit access, When an approved mutation reaches the effect boundary, Then it is denied", async () => {
    const policy = createCustomMcpAuthorityPolicy({
      resolveAuthority: vi.fn(async () =>
        snapshot({ active: true, canView: true, canEdit: false, scopes: [] }),
      ),
    });

    await expect(
      policy.authorizeTrustedApprover({
        actor: { kind: "human", id: "human_A" },
        shipletId: "shiplet_A",
      }),
    ).resolves.toBe(false);
  });

  it("maps every supported capability to explicit actor scopes and access", () => {
    expect(customMcpCapabilityPolicy("state.read:review")).toEqual({
      access: "view",
      agentScopes: ["mcp", "shiplets:read"],
    });
    expect(customMcpCapabilityPolicy("state.write")).toEqual({
      access: "edit",
      agentScopes: ["mcp", "shiplets:write"],
    });
    expect(customMcpCapabilityPolicy("review.feedback.read")).toEqual({
      access: "view",
      agentScopes: ["mcp", "shiplets:read", "feedback:read"],
    });
    expect(customMcpCapabilityPolicy("review.feedback.write")).toEqual({
      access: "edit",
      agentScopes: ["mcp", "shiplets:write", "feedback:write"],
    });
    expect(customMcpCapabilityPolicy("workflow.event:create")).toEqual({
      access: "edit",
      agentScopes: ["mcp", "shiplets:write"],
    });
    expect(customMcpCapabilityPolicy("egress.fetch")).toBeNull();
  });
});
