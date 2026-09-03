import { CLOUDFLARE_API_ORIGIN } from "../cloudflare-production-adapters";
import {
  solveCloudflarePreviewChallenge,
  validateTemporaryProvisioningResponse,
} from "./control-plane";

const PREVIEW_ENDPOINT = `${CLOUDFLARE_API_ORIGIN}/provisioning/previews`;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ASSETS = 1_000;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
const SCRIPT_NAME =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OPAQUE_VALUE = /^[\x21-\x7e]{16,4096}$/;
const COMPATIBILITY_DATE = /^20[0-9]{2}-[01][0-9]-[0-3][0-9]$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StaticAsset = Readonly<{
  path: string;
  mediaType: string;
  content: string;
  encoding?: "utf8" | "base64";
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function encodeBase64(bytes: Uint8Array) {
  let output = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 16_384) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(output);
}

function decodeBase64(value: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new TypeError("temporary_asset_invalid");
  }
  try {
    const bytes = Uint8Array.from(atob(value), (character) =>
      character.charCodeAt(0),
    );
    if (encodeBase64(bytes) !== value) {
      throw new TypeError("temporary_asset_invalid");
    }
    return bytes;
  } catch {
    throw new TypeError("temporary_asset_invalid");
  }
}

function contentBytes(asset: StaticAsset) {
  const bytes =
    asset.encoding === "base64"
      ? decodeBase64(asset.content)
      : new TextEncoder().encode(asset.content);
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new TypeError("temporary_asset_invalid");
  }
  return bytes;
}

function extension(path: string) {
  const file = path.split("/").at(-1) ?? "";
  const dot = file.lastIndexOf(".");
  return dot <= 0 || dot === file.length - 1
    ? ""
    : file.slice(dot + 1).toLowerCase();
}

async function assetHash(asset: StaticAsset, bytes: Uint8Array) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${encodeBase64(bytes)}${extension(asset.path)}`),
    ),
  );
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

async function boundedJson(
  response: Response,
  options: { allowEmpty?: boolean } = {},
) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      throw new Error("temporary_provider_response_invalid");
    }
  }
  if (!response.body) {
    if (options.allowEmpty) return { body: null, byteLength: 0 };
    throw new Error("temporary_provider_response_invalid");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    byteLength += next.value.byteLength;
    if (byteLength > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("temporary_provider_response_invalid");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (byteLength === 0 && options.allowEmpty) {
    return { body: null, byteLength: 0 };
  }
  try {
    return {
      body: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown,
      byteLength,
    };
  } catch {
    throw new Error("temporary_provider_response_invalid");
  }
}

function bearer(value: string) {
  if (!OPAQUE_VALUE.test(value)) {
    throw new TypeError("temporary_authority_invalid");
  }
  const headers = new Headers({ accept: "application/json" });
  headers.set("authorization", ["Bearer", value].join(" "));
  return headers;
}

function successful(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.success === true;
}

function validateRequest(input: {
  termsOfService: string;
  privacyPolicy: string;
  acceptTermsOfService: string;
  scriptName: string;
  compatibilityDate: string;
  staticAssets: readonly StaticAsset[];
}) {
  if (
    input.termsOfService !== "https://www.cloudflare.com/terms/" ||
    input.privacyPolicy !== "https://www.cloudflare.com/privacypolicy/" ||
    input.acceptTermsOfService !== "yes" ||
    !SCRIPT_NAME.test(input.scriptName) ||
    !COMPATIBILITY_DATE.test(input.compatibilityDate) ||
    input.staticAssets.length === 0 ||
    input.staticAssets.length > MAX_ASSETS
  ) {
    throw new TypeError("temporary_deployment_invalid");
  }
}

export function createCloudflareTemporaryTransport(input: {
  fetch: typeof fetch;
  now(): number;
}) {
  const send = (request: Request) =>
    input.fetch(new Request(request, { redirect: "manual" }));

  const provisionAccount = async (request: {
    termsOfService: string;
    privacyPolicy: string;
    acceptTermsOfService: "yes";
  }) => {
    if (
      request.termsOfService !== "https://www.cloudflare.com/terms/" ||
      request.privacyPolicy !== "https://www.cloudflare.com/privacypolicy/" ||
      request.acceptTermsOfService !== "yes"
    ) {
      throw new TypeError("temporary_deployment_invalid");
    }
    const now = input.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("temporary_clock_invalid");
    }
    let serializedBodyBytes = 0;
    const challengeResponse = await send(
      new Request(`${PREVIEW_ENDPOINT}/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    const challenge = await boundedJson(challengeResponse);
    serializedBodyBytes += challenge.byteLength;
    if (
      challengeResponse.status < 200 ||
      challengeResponse.status > 299 ||
      !successful(challenge.body) ||
      !isRecord(challenge.body.result)
    ) {
      throw new Error("temporary_challenge_failed");
    }
    const solved = await solveCloudflarePreviewChallenge({
      challengeToken: String(challenge.body.result.challengeToken ?? ""),
      seed: String(challenge.body.result.seed ?? ""),
      k: Number(challenge.body.result.k),
      g: Number(challenge.body.result.g),
    });
    let provisioningResponse: Response;
    try {
      provisioningResponse = await send(
        new Request(PREVIEW_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            termsOfService: request.termsOfService,
            privacyPolicy: request.privacyPolicy,
            acceptTermsOfService: request.acceptTermsOfService,
            ...solved,
          }),
        }),
      );
    } catch {
      throw new Error("temporary_provisioning_outcome_ambiguous");
    }
    let provisioning: Awaited<ReturnType<typeof boundedJson>>;
    try {
      provisioning = await boundedJson(provisioningResponse);
    } catch {
      throw new Error(
        provisioningResponse.status >= 200 && provisioningResponse.status <= 299
          ? "temporary_provisioning_outcome_ambiguous"
          : "temporary_provisioning_failed",
      );
    }
    serializedBodyBytes += provisioning.byteLength;
    if (
      provisioningResponse.status < 200 ||
      provisioningResponse.status > 299
    ) {
      throw new Error("temporary_provisioning_failed");
    }
    const provisioned = validateTemporaryProvisioningResponse(
      provisioning.body,
      now,
    );
    return Object.freeze({
      public: provisioned.public,
      sensitive: provisioned.sensitive,
      serializedBodyBytes,
    });
  };

  const inspectStaticDeployment = async (request: {
    accountId: string;
    apiToken: string;
    scriptName: string;
    packageDigest: string;
  }) => {
    if (
      !ACCOUNT_ID.test(request.accountId) ||
      !SCRIPT_NAME.test(request.scriptName) ||
      !/^sha256:[a-f0-9]{64}$/.test(request.packageDigest)
    ) {
      throw new TypeError("temporary_deployment_invalid");
    }
    const root = `${CLOUDFLARE_API_ORIGIN}/accounts/${request.accountId}`;
    const scriptRoot = `${root}/workers/scripts/${request.scriptName}`;
    let serializedBodyBytes = 0;
    const settingsResponse = await send(
      new Request(`${scriptRoot}/settings`, {
        headers: bearer(request.apiToken),
      }),
    );
    const settings = await boundedJson(settingsResponse, { allowEmpty: true });
    serializedBodyBytes += settings.byteLength;
    if (settingsResponse.status === 404) {
      return {
        ok: false as const,
        reason: "temporary_deployment_unproven" as const,
      };
    }
    const settingsResult =
      isRecord(settings.body) && isRecord(settings.body.result)
        ? settings.body.result
        : null;
    if (
      settingsResponse.status < 200 ||
      settingsResponse.status > 299 ||
      !successful(settings.body) ||
      !settingsResult ||
      !isRecord(settingsResult.annotations) ||
      settingsResult.annotations["workers/tag"] !== request.packageDigest
    ) {
      return {
        ok: false as const,
        reason: "temporary_deployment_unproven" as const,
      };
    }
    const deploymentsResponse = await send(
      new Request(`${scriptRoot}/deployments`, {
        headers: bearer(request.apiToken),
      }),
    );
    const deployments = await boundedJson(deploymentsResponse);
    serializedBodyBytes += deployments.byteLength;
    const deploymentsResult =
      isRecord(deployments.body) && isRecord(deployments.body.result)
        ? deployments.body.result
        : null;
    const latest =
      deploymentsResult && Array.isArray(deploymentsResult.deployments)
        ? deploymentsResult.deployments[0]
        : null;
    if (
      deploymentsResponse.status < 200 ||
      deploymentsResponse.status > 299 ||
      !successful(deployments.body) ||
      !isRecord(latest) ||
      !UUID.test(String(latest.id ?? "")) ||
      latest.strategy !== "percentage" ||
      !Array.isArray(latest.versions) ||
      latest.versions.length !== 1 ||
      !isRecord(latest.versions[0]) ||
      latest.versions[0].percentage !== 100 ||
      !UUID.test(String(latest.versions[0].version_id ?? ""))
    ) {
      return {
        ok: false as const,
        reason: "temporary_deployment_unproven" as const,
      };
    }
    const subdomainResponse = await send(
      new Request(`${root}/workers/subdomain`, {
        headers: bearer(request.apiToken),
      }),
    );
    const subdomainResult = await boundedJson(subdomainResponse);
    serializedBodyBytes += subdomainResult.byteLength;
    const subdomain =
      isRecord(subdomainResult.body) && isRecord(subdomainResult.body.result)
        ? subdomainResult.body.result.subdomain
        : null;
    if (
      subdomainResponse.status < 200 ||
      subdomainResponse.status > 299 ||
      !successful(subdomainResult.body) ||
      typeof subdomain !== "string" ||
      !SUBDOMAIN.test(subdomain)
    ) {
      return {
        ok: false as const,
        reason: "temporary_deployment_unproven" as const,
      };
    }
    return Object.freeze({
      ok: true as const,
      deployment: Object.freeze({
        providerDeploymentId: String(latest.id),
        providerVersionId: String(latest.versions[0].version_id),
        workersDevUrl: `https://${request.scriptName}.${subdomain}.workers.dev/`,
        serializedBodyBytes,
      }),
    });
  };

  const deployStaticToProvisionedAccount = async (request: {
    accountId: string;
    apiToken: string;
    scriptName: string;
    compatibilityDate: string;
    packageDigest: string;
    staticAssets: readonly StaticAsset[];
  }) => {
    validateRequest({
      termsOfService: "https://www.cloudflare.com/terms/",
      privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
      acceptTermsOfService: "yes",
      scriptName: request.scriptName,
      compatibilityDate: request.compatibilityDate,
      staticAssets: request.staticAssets,
    });
    if (
      !ACCOUNT_ID.test(request.accountId) ||
      !/^sha256:[a-f0-9]{64}$/.test(request.packageDigest)
    ) {
      throw new TypeError("temporary_deployment_invalid");
    }
    let serializedBodyBytes = 0;
    const entries = new Map<
      string,
      { asset: StaticAsset; bytes: Uint8Array }
    >();
    const paths = new Set<string>();
    const manifest: Record<string, { hash: string; size: number }> = {};
    let bundleBytes = 0;
    for (const asset of request.staticAssets) {
      if (
        !asset.path.startsWith("/") ||
        asset.path.includes("\\") ||
        asset.path.includes("\0") ||
        paths.has(asset.path) ||
        asset.mediaType !== asset.mediaType.toLowerCase() ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(asset.mediaType)
      ) {
        throw new TypeError("temporary_asset_invalid");
      }
      paths.add(asset.path);
      const bytes = contentBytes(asset);
      bundleBytes += bytes.byteLength;
      if (bundleBytes > MAX_BUNDLE_BYTES) {
        throw new TypeError("temporary_asset_invalid");
      }
      const hash = await assetHash(asset, bytes);
      const prior = entries.get(hash);
      if (
        prior &&
        (prior.asset.mediaType !== asset.mediaType ||
          encodeBase64(prior.bytes) !== encodeBase64(bytes))
      ) {
        throw new TypeError("temporary_asset_invalid");
      }
      entries.set(hash, { asset, bytes });
      manifest[asset.path] = { hash, size: bytes.byteLength };
    }
    const root = `${CLOUDFLARE_API_ORIGIN}/accounts/${request.accountId}`;
    const scriptRoot = `${root}/workers/scripts/${request.scriptName}`;
    const manifestHeaders = bearer(request.apiToken);
    manifestHeaders.set("content-type", "application/json");
    const manifestResponse = await send(
      new Request(`${scriptRoot}/assets-upload-session`, {
        method: "POST",
        headers: manifestHeaders,
        body: JSON.stringify({ manifest }),
      }),
    );
    const manifestResult = await boundedJson(manifestResponse);
    serializedBodyBytes += manifestResult.byteLength;
    if (
      manifestResponse.status < 200 ||
      manifestResponse.status > 299 ||
      !successful(manifestResult.body) ||
      !isRecord(manifestResult.body.result) ||
      !Array.isArray(manifestResult.body.result.buckets) ||
      typeof manifestResult.body.result.jwt !== "string" ||
      !OPAQUE_VALUE.test(manifestResult.body.result.jwt)
    ) {
      throw new Error("temporary_asset_upload_failed");
    }
    let completion = manifestResult.body.result.jwt;
    const requested = new Set<string>();
    for (const bucket of manifestResult.body.result.buckets) {
      if (!Array.isArray(bucket) || bucket.length === 0) {
        throw new Error("temporary_asset_upload_failed");
      }
      const form = new FormData();
      for (const hash of bucket) {
        if (
          typeof hash !== "string" ||
          requested.has(hash) ||
          !entries.has(hash)
        ) {
          throw new Error("temporary_asset_upload_failed");
        }
        requested.add(hash);
        const entry = entries.get(hash)!;
        form.append(
          hash,
          new Blob([encodeBase64(entry.bytes)], { type: entry.asset.mediaType }),
          hash,
        );
      }
      const uploadResponse = await send(
        new Request(`${root}/workers/assets/upload?base64=true`, {
          method: "POST",
          headers: bearer(completion),
          body: form,
        }),
      );
      const upload = await boundedJson(uploadResponse);
      serializedBodyBytes += upload.byteLength;
      if (
        uploadResponse.status < 200 ||
        uploadResponse.status > 299 ||
        !successful(upload.body) ||
        !isRecord(upload.body.result) ||
        typeof upload.body.result.jwt !== "string" ||
        !OPAQUE_VALUE.test(upload.body.result.jwt)
      ) {
        throw new Error("temporary_asset_upload_failed");
      }
      completion = upload.body.result.jwt;
    }
    const mainModule = "__shiplet_static.mjs";
    const form = new FormData();
    form.append(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            main_module: mainModule,
            compatibility_date: request.compatibilityDate,
            annotations: { "workers/tag": request.packageDigest },
            assets: {
              jwt: completion,
              config: {
                html_handling: "auto-trailing-slash",
                not_found_handling: "404-page",
              },
            },
            bindings: [],
          }),
        ],
        { type: "application/json" },
      ),
    );
    form.append(
      mainModule,
      new Blob(
        [
          "export default { fetch() { return new Response('Not found', { status: 404 }); } };",
        ],
        { type: "application/javascript+module" },
      ),
      mainModule,
    );
    const deploymentResponse = await send(
      new Request(scriptRoot, {
        method: "PUT",
        headers: bearer(request.apiToken),
        body: form,
      }),
    );
    const deployment = await boundedJson(deploymentResponse);
    serializedBodyBytes += deployment.byteLength;
    if (
      deploymentResponse.status < 200 ||
      deploymentResponse.status > 299 ||
      !successful(deployment.body)
    ) {
      throw new Error("temporary_deployment_failed");
    }
    const inspected = await inspectStaticDeployment(request);
    if (!inspected.ok) throw new Error(inspected.reason);
    return Object.freeze({
      ...inspected.deployment,
      serializedBodyBytes:
        serializedBodyBytes + inspected.deployment.serializedBodyBytes,
    });
  };

  return Object.freeze({
    provisionAccount,
    deployStaticToProvisionedAccount,
    inspectStaticDeployment,

    async provisionAndDeploy(request: {
      termsOfService: string;
      privacyPolicy: string;
      acceptTermsOfService: "yes";
      scriptName: string;
      compatibilityDate: string;
      staticAssets: readonly StaticAsset[];
    }) {
      validateRequest(request);
      const provisioned = await provisionAccount(request);
      const deployed = await deployStaticToProvisionedAccount({
        accountId: provisioned.public.accountId,
        apiToken: provisioned.sensitive.apiToken,
        scriptName: request.scriptName,
        compatibilityDate: request.compatibilityDate,
        packageDigest: `sha256:${"0".repeat(64)}`,
        staticAssets: request.staticAssets,
      });
      return Object.freeze({
        public: Object.freeze({
          ...provisioned.public,
          workersDevUrl: deployed.workersDevUrl,
          serializedBodyBytes:
            provisioned.serializedBodyBytes + deployed.serializedBodyBytes,
        }),
        sensitive: provisioned.sensitive,
      });
    },

    async deleteScript(request: {
      accountId: string;
      apiToken: string;
      scriptName: string;
    }) {
      if (
        !ACCOUNT_ID.test(request.accountId) ||
        !SCRIPT_NAME.test(request.scriptName)
      ) {
        throw new TypeError("temporary_cleanup_invalid");
      }
      const response = await send(
        new Request(
          `${CLOUDFLARE_API_ORIGIN}/accounts/${request.accountId}/workers/scripts/${request.scriptName}`,
          { method: "DELETE", headers: bearer(request.apiToken) },
        ),
      );
      const parsed = await boundedJson(response, { allowEmpty: true });
      if (response.status === 404) {
        const inspection = await send(
          new Request(
            `${CLOUDFLARE_API_ORIGIN}/accounts/${request.accountId}/workers/scripts/${request.scriptName}`,
            { method: "GET", headers: bearer(request.apiToken) },
          ),
        );
        const inspected = await boundedJson(inspection, { allowEmpty: true });
        if (inspection.status !== 404) {
          throw new Error("temporary_cleanup_failed");
        }
        return {
          success: true as const,
          serializedBodyBytes: parsed.byteLength + inspected.byteLength,
        };
      }
      if (
        response.status < 200 ||
        response.status > 299 ||
        (parsed.body !== null && !successful(parsed.body))
      ) {
        throw new Error("temporary_cleanup_failed");
      }
      return { success: true as const, serializedBodyBytes: parsed.byteLength };
    },
  });
}
