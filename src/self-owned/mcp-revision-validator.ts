import {
  compileCustomMcpRegistry,
  KERNEL_MCP_TOOL_NAMES,
  normalizePortablePackageMcpManifest,
  type CustomMcpLimits,
} from "../custom-mcp";
import {
  digestShipletPackageContent,
  type ShipletPackageFile,
} from "./package";
import type { RevisionMcpManifestValidator } from "./revisions";

function packageFileBytes(file: ShipletPackageFile): Uint8Array {
  if (file.encoding === "utf8") {
    return new TextEncoder().encode(file.content);
  }
  const binary = atob(file.content);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function createRevisionMcpManifestValidator(input: {
  supportedRuntimeVersions: readonly string[];
  supportedCapabilities: readonly string[];
  limits: CustomMcpLimits;
}): RevisionMcpManifestValidator {
  const supportedRuntimeVersions = Object.freeze([
    ...input.supportedRuntimeVersions,
  ]);
  const supportedCapabilities = Object.freeze([...input.supportedCapabilities]);
  const limits = Object.freeze({ ...input.limits });
  return Object.freeze({
    async validate(validationInput) {
      if (validationInput.signal.aborted) {
        return { ok: false, errors: [{ code: "mcp_validation_aborted" }] };
      }
      const manifestPath = validationInput.package.manifest.entrypoints.mcp;
      const manifestFile = validationInput.package.files.find(
        (file) => file.path === manifestPath,
      );
      if (!manifestFile) {
        return {
          ok: false,
          errors: [{ code: "missing_manifest", path: manifestPath }],
        };
      }
      const normalized = normalizePortablePackageMcpManifest({
        manifestBytes: packageFileBytes(manifestFile),
        packageRuntimeCompatibility:
          validationInput.package.manifest.runtimeCompatibility,
        limits: {
          maxManifestBytes: limits.maxManifestBytes,
          maxTools: limits.maxTools,
        },
      });
      if (!normalized.ok) {
        return { ok: false, errors: [normalized.error] };
      }
      const handlerFiles = Object.create(null) as Record<string, Uint8Array>;
      for (const file of validationInput.package.files) {
        if (
          file.path.startsWith("mcp/handlers/") &&
          file.path.endsWith(".js")
        ) {
          handlerFiles[file.path] = packageFileBytes(file);
        }
      }
      const compiled = compileCustomMcpRegistry({
        manifestBytes: normalized.manifestBytes,
        shipletId: validationInput.shipletId,
        revisionId: validationInput.revisionId,
        packageDigest: `sha256:${await digestShipletPackageContent(
          validationInput.package,
        )}`,
        packageRuntimeCompatibility:
          validationInput.package.manifest.runtimeCompatibility,
        packageRequestedCapabilities:
          validationInput.package.manifest.requestedCapabilities,
        handlerFiles: Object.freeze(handlerFiles),
        supportedRuntimeVersions,
        supportedCapabilities,
        reservedKernelTools: KERNEL_MCP_TOOL_NAMES,
        limits,
      });
      return compiled.ok
        ? { ok: true, errors: [] }
        : { ok: false, errors: [compiled.error] };
    },
  });
}
