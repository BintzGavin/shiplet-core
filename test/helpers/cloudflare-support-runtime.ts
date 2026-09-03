import { SUPPORT_ENTRYPOINTS } from "../../src/cloudflare-support/service-contract";

export const SUPPORT_CONTROL_VERSION = "11111111-1111-4111-8111-111111111111";
export const SUPPORT_RUNTIME_VERSION = "22222222-2222-4222-8222-222222222222";
export const SUPPORT_RELEASE_TAG =
  "shiplet-0123456789abcdef0123456789abcdef01234567";

export function supportContract(index: number) {
  const expected = SUPPORT_ENTRYPOINTS[index];
  if (!expected) throw new Error("support_fixture_entrypoint_missing");
  return {
    schemaVersion: "shiplet.support/v1" as const,
    ...expected,
    versionId:
      expected.service === "shiplet-cloudflare-control-plane"
        ? SUPPORT_CONTROL_VERSION
        : SUPPORT_RUNTIME_VERSION,
    versionTag: SUPPORT_RELEASE_TAG,
  };
}

export function supportAttestationBindings(
  overrides: Record<string, unknown> = {},
) {
  return {
    CLOUDFLARE_CONTROL_PLANE_VERSION_ID: SUPPORT_CONTROL_VERSION,
    CLOUDFLARE_RUNTIME_GATEWAY_VERSION_ID: SUPPORT_RUNTIME_VERSION,
    CLOUDFLARE_SUPPORT_RELEASE_TAG: SUPPORT_RELEASE_TAG,
    CLOUDFLARE_OAUTH_CONTROL_PLANE: {
      contract: async () => supportContract(0),
      begin: async () => ({ ok: false as const, reason: "not_used" }),
      finalize: async () => ({ ok: false as const, reason: "not_used" }),
      acknowledge: async () => ({ ok: false as const, reason: "not_used" }),
      revoke: async () => ({ ok: false as const, reason: "not_used" }),
    },
    CLOUDFLARE_GRANT_VAULT_RPC: {
      contract: async () => supportContract(1),
    },
    CLOUDFLARE_TEMPORARY_ACCOUNT_RPC: {
      contract: async () => supportContract(2),
    },
    CLOUDFLARE_VERSION_HEALTH_RPC: {
      contract: async () => supportContract(3),
    },
    CLOUDFLARE_CUSTOM_MCP_RUNTIME_RPC: {
      contract: async () => supportContract(4),
    },
    ...overrides,
  };
}
