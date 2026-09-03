import type { CapabilityActor } from "./capability-broker";
import type { OrganizationApiScope } from "./org-api-tokens";

export type CustomMcpActorAuthoritySnapshot = Readonly<{
  active: boolean;
  canView: boolean;
  canEdit: boolean;
  scopes: readonly OrganizationApiScope[];
}>;

export type CustomMcpCapabilityPolicy = Readonly<{
  access: "view" | "edit";
  agentScopes: readonly OrganizationApiScope[];
}>;

const POLICIES: Readonly<Record<string, CustomMcpCapabilityPolicy>> =
  Object.freeze({
    "state.read:review": Object.freeze({
      access: "view",
      agentScopes: Object.freeze([
        "mcp" as const,
        "shiplets:read" as const,
      ]),
    }),
    "state.write": Object.freeze({
      access: "edit",
      agentScopes: Object.freeze([
        "mcp" as const,
        "shiplets:write" as const,
      ]),
    }),
    "review.feedback.read": Object.freeze({
      access: "view",
      agentScopes: Object.freeze([
        "mcp" as const,
        "shiplets:read" as const,
        "feedback:read" as const,
      ]),
    }),
    "review.feedback.write": Object.freeze({
      access: "edit",
      agentScopes: Object.freeze([
        "mcp" as const,
        "shiplets:write" as const,
        "feedback:write" as const,
      ]),
    }),
    "workflow.event:create": Object.freeze({
      access: "edit",
      agentScopes: Object.freeze([
        "mcp" as const,
        "shiplets:write" as const,
      ]),
    }),
  });

export function customMcpCapabilityPolicy(
  capability: string,
): CustomMcpCapabilityPolicy | null {
  return POLICIES[capability] ?? null;
}

export function createCustomMcpAuthorityPolicy(input: {
  resolveAuthority(request: {
    actor: CapabilityActor;
    shipletId: string;
  }): Promise<CustomMcpActorAuthoritySnapshot | null>;
}) {
  if (typeof input?.resolveAuthority !== "function") {
    throw new TypeError("custom_mcp_authority_resolver_required");
  }
  const resolve = async (request: {
    actor: CapabilityActor;
    shipletId: string;
  }) => {
    try {
      return await input.resolveAuthority(
        Object.freeze({
          actor: Object.freeze({ ...request.actor }),
          shipletId: request.shipletId,
        }),
      );
    } catch {
      return null;
    }
  };
  return Object.freeze({
    async authorizeCapability(request: {
      actor: CapabilityActor;
      shipletId: string;
      capability: string;
    }) {
      const required = customMcpCapabilityPolicy(request.capability);
      if (!required) return false;
      const authority = await resolve(request);
      if (!authority?.active) return false;
      if (request.actor.kind === "agent") {
        return (
          (required.access === "view"
            ? authority.canView
            : authority.canEdit) &&
          required.agentScopes.every((scope) =>
            authority.scopes.includes(scope),
          )
        );
      }
      if (request.actor.kind !== "human") return false;
      return required.access === "view"
        ? authority.canView
        : authority.canEdit;
    },

    async authorizeTrustedApprover(request: {
      actor: CapabilityActor;
      shipletId: string;
    }) {
      if (request.actor.kind !== "human") return false;
      const authority = await resolve(request);
      return Boolean(authority?.active && authority.canEdit);
    },
  });
}
