import { describe, expect, it } from "vitest";

import {
  SUPPORT_ENTRYPOINTS,
  assertSupportReleaseExpectation,
  createSupportEntrypointContract,
  verifySupportEntrypointContracts,
} from "../src/cloudflare-support/service-contract";

const controlVersion = "11111111-1111-4111-8111-111111111111";
const runtimeVersion = "22222222-2222-4222-8222-222222222222";
const releaseTag = "shiplet-0123456789abcdef0123456789abcdef01234567";

describe("external support-service attestation", () => {
  it("creates one value-free contract for every exact named entrypoint", () => {
    const contracts = SUPPORT_ENTRYPOINTS.map((expected) =>
      createSupportEntrypointContract({
        ...expected,
        metadata: {
          id:
            expected.service === "shiplet-cloudflare-control-plane"
              ? controlVersion
              : runtimeVersion,
          tag: releaseTag,
        },
      }),
    );

    expect(
      verifySupportEntrypointContracts({
        contracts,
        expectedControlPlaneVersionId: controlVersion,
        expectedRuntimeGatewayVersionId: runtimeVersion,
        expectedVersionTag: releaseTag,
      }),
    ).toEqual({ ok: true, contracts });
    expect(JSON.stringify(contracts)).not.toMatch(
      /token|credential|authorization|claim.?url|secret/i,
    );
  });

  it("rejects missing, shadowed, malformed, or version-drifted entrypoints", () => {
    const valid = SUPPORT_ENTRYPOINTS.map((expected) =>
      createSupportEntrypointContract({
        ...expected,
        metadata: {
          id:
            expected.service === "shiplet-cloudflare-control-plane"
              ? controlVersion
              : runtimeVersion,
        },
      }),
    );
    for (const contracts of [
      valid.slice(1),
      [valid[0], valid[0], ...valid.slice(2)],
      [valid[1], valid[0], ...valid.slice(2)],
      valid.map((contract, index) =>
        index === 0 ? { ...contract, entrypoint: "KernelShadow" } : contract,
      ),
      valid.map((contract, index) =>
        index === 4 ? { ...contract, versionId: controlVersion } : contract,
      ),
    ]) {
      expect(
        verifySupportEntrypointContracts({
          contracts,
          expectedControlPlaneVersionId: controlVersion,
          expectedRuntimeGatewayVersionId: runtimeVersion,
          expectedVersionTag: releaseTag,
        }),
      ).toEqual({ ok: false, reason: "support_contract_mismatch" });
    }

    expect(() =>
      createSupportEntrypointContract({
        ...SUPPORT_ENTRYPOINTS[0],
        metadata: { id: "not-a-version" },
      }),
    ).toThrow("support_version_metadata_invalid");

    expect(
      verifySupportEntrypointContracts({
        contracts: valid,
        expectedControlPlaneVersionId: controlVersion,
        expectedRuntimeGatewayVersionId: runtimeVersion,
        expectedVersionTag: releaseTag,
      }),
    ).toEqual({ ok: false, reason: "support_contract_mismatch" });

    expect(() =>
      assertSupportReleaseExpectation(
        { id: controlVersion, tag: releaseTag },
        { versionId: controlVersion, versionTag: releaseTag },
      ),
    ).not.toThrow();
    for (const expectation of [
      { versionId: runtimeVersion, versionTag: releaseTag },
      { versionId: controlVersion, versionTag: "shiplet-other-release" },
    ]) {
      expect(() =>
        assertSupportReleaseExpectation(
          { id: controlVersion, tag: releaseTag },
          expectation,
        ),
      ).toThrow("support_release_mismatch");
    }
  });
});
