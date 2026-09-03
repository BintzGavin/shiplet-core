import {
  CLOUDFLARE_API_ORIGIN,
  type CloudflareRedactingRequest,
  type CloudflareStaticAsset,
} from "../cloudflare-production-adapters";

const ACCOUNT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const SCRIPT_IDENTIFIER =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PACKAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const OPAQUE_VALUE = /^[\x21-\x7e]{16,4096}$/;
const COMPLETION_HANDLE = /^[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_ASSETS = 10_000;
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

type GrantTransportBinding = Readonly<{
  accountId: string;
  scriptName: string;
  operation: string;
  revisionId: string;
  packageDigest: string;
}>;

type CredentialMaterial = Readonly<{ accessToken: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
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
    throw new TypeError("cloudflare_asset_invalid");
  }
  try {
    const decoded = Uint8Array.from(atob(value), (character) =>
      character.charCodeAt(0),
    );
    if (encodeBase64(decoded) !== value) {
      throw new TypeError("cloudflare_asset_invalid");
    }
    return decoded;
  } catch {
    throw new TypeError("cloudflare_asset_invalid");
  }
}

async function responseBytes(response: Response) {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_RESPONSE_BYTES
    ) {
      throw new Error("cloudflare_provider_response_invalid");
    }
  }
  if (!response.body) {
    throw new Error("cloudflare_provider_response_invalid");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("cloudflare_provider_response_invalid");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function responseJson(response: Response) {
  const bytes = await responseBytes(response);
  try {
    return {
      body: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown,
      byteLength: bytes.byteLength,
    };
  } catch {
    throw new Error("cloudflare_provider_response_invalid");
  }
}

function allowedProviderRoute(
  binding: GrantTransportBinding,
  method: string,
  url: URL,
) {
  const api = new URL(CLOUDFLARE_API_ORIGIN);
  if (
    url.origin !== api.origin ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return false;
  }
  const root = `${api.pathname}/accounts/${binding.accountId}`;
  const scriptRoot = `${root}/workers/scripts/${binding.scriptName}`;
  const workerRoot = `${root}/workers/workers/${binding.scriptName}`;
  const rules: Record<string, Array<[string, RegExp]>> = {
    "worker.inspect": [
      ["GET", new RegExp(`^${scriptRoot}/script-settings$`)],
    ],
    "worker.script.initialize": [
      ["POST", new RegExp(`^${root}/workers/workers$`)],
      ["POST", new RegExp(`^${scriptRoot}/versions$`)],
    ],
    "worker.version.upload": [
      ["POST", new RegExp(`^${scriptRoot}/versions$`)],
    ],
    "worker.candidate.prove": [
      [
        "GET",
        new RegExp(
          `^${workerRoot}/versions/[0-9a-f]{8}-[0-9a-f-]{27}$`,
          "i",
        ),
      ],
    ],
    "worker.deployment.promote": [
      ["POST", new RegExp(`^${scriptRoot}/deployments$`)],
    ],
    "worker.deployment.rollback": [
      ["POST", new RegExp(`^${scriptRoot}/deployments$`)],
    ],
    "worker.deployment.compensate": [
      ["POST", new RegExp(`^${scriptRoot}/deployments$`)],
    ],
    "worker.version.cleanup": [
      [
        "DELETE",
        new RegExp(
          `^${workerRoot}/versions/[0-9a-f]{8}-[0-9a-f-]{27}$`,
          "i",
        ),
      ],
    ],
  };
  return Boolean(
    rules[binding.operation]?.some(
      ([expectedMethod, path]) =>
        method === expectedMethod && path.test(url.pathname),
    ),
  );
}

function providerHeaders(credential: CredentialMaterial) {
  const headers = new Headers({ accept: "application/json" });
  headers.set("authorization", ["Bearer", credential.accessToken].join(" "));
  return headers;
}

function contentBytes(asset: CloudflareStaticAsset) {
  const bytes =
    asset.encoding === "base64"
      ? decodeBase64(asset.content)
      : new TextEncoder().encode(asset.content);
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new TypeError("cloudflare_asset_invalid");
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

async function assetHash(asset: CloudflareStaticAsset, bytes: Uint8Array) {
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

function completionId() {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function createCloudflareGrantTransport(input: {
  credential: CredentialMaterial;
  binding: GrantTransportBinding;
  fetch: typeof fetch;
}) {
  if (
    !isRecord(input.credential) ||
    typeof input.credential.accessToken !== "string" ||
    !OPAQUE_VALUE.test(input.credential.accessToken) ||
    !ACCOUNT_IDENTIFIER.test(input.binding.accountId) ||
    !SCRIPT_IDENTIFIER.test(input.binding.scriptName) ||
    !IDENTIFIER.test(input.binding.revisionId) ||
    !PACKAGE_DIGEST.test(input.binding.packageDigest)
  ) {
    throw new TypeError("cloudflare_provider_binding_invalid");
  }
  const completions = new Map<string, string>();

  const authorizedFetch = async (request: Request) => {
    return input.fetch(
      new Request(request, {
        redirect: "manual",
      }),
    );
  };

  return Object.freeze({
    async requestBytes(request: CloudflareRedactingRequest) {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        throw new Error("cloudflare_provider_route_denied");
      }
      if (!allowedProviderRoute(input.binding, request.method, url)) {
        throw new Error("cloudflare_provider_route_denied");
      }
      const headers = providerHeaders(input.credential);
      let body: BodyInit | undefined;
      if (request.body?.kind === "json") {
        headers.set("content-type", "application/json");
        body = JSON.stringify(request.body.value);
      } else if (request.body?.kind === "worker_version") {
        if (
          request.body.serialization.kind !==
            "cloudflare_worker_version_multipart" ||
          request.body.serialization.completionAssertion !==
            "opaque_transport_substitution" ||
          !isRecord(request.body.metadata) ||
          request.body.modules.length === 0 ||
          request.body.modules.length > 1_000
        ) {
          throw new TypeError("cloudflare_provider_body_invalid");
        }
        const metadata = structuredClone(request.body.metadata);
        if (request.body.assetCompletion !== undefined) {
          if (
            !isRecord(request.body.assetCompletion) ||
            Reflect.ownKeys(request.body.assetCompletion).length !== 1 ||
            typeof request.body.assetCompletion.handle !== "string" ||
            !COMPLETION_HANDLE.test(request.body.assetCompletion.handle)
          ) {
            throw new TypeError("cloudflare_asset_completion_invalid");
          }
          const completion = completions.get(request.body.assetCompletion.handle);
          if (!completion || !isRecord(metadata.assets)) {
            throw new TypeError("cloudflare_asset_completion_invalid");
          }
          metadata.assets.jwt = completion;
          completions.delete(request.body.assetCompletion.handle);
        }
        const form = new FormData();
        form.append(
          "metadata",
          new Blob([JSON.stringify(metadata)], { type: "application/json" }),
        );
        const names = new Set<string>();
        for (const module of request.body.modules) {
          if (
            !module.name ||
            names.has(module.name) ||
            !module.mediaType ||
            typeof module.content !== "string"
          ) {
            throw new TypeError("cloudflare_provider_body_invalid");
          }
          names.add(module.name);
          const bytes =
            module.encoding === "base64"
              ? decodeBase64(module.content)
              : new TextEncoder().encode(module.content);
          form.append(
            module.name,
            new Blob([bytes as Uint8Array<ArrayBuffer>], {
              type: module.mediaType,
            }),
            module.name,
          );
        }
        body = form;
      } else if (request.body !== undefined) {
        throw new TypeError("cloudflare_provider_body_invalid");
      }
      const response = await authorizedFetch(
        new Request(url, {
          method: request.method,
          headers,
          body,
        }),
      );
      return {
        status: response.status,
        bytes: await responseBytes(response),
      };
    },

    async uploadStaticAssets(request: {
      accountId: string;
      scriptName: string;
      revisionId: string;
      packageDigest: string;
      manifestEndpoint: string;
      uploadEndpoint: string;
      serialization: {
        kind: "cloudflare_static_assets_multipart";
        completionAssertion: "opaque_transport_substitution";
      };
      assets: CloudflareStaticAsset[];
    }) {
      const expectedManifest = `${CLOUDFLARE_API_ORIGIN}/accounts/${input.binding.accountId}/workers/scripts/${input.binding.scriptName}/assets-upload-session`;
      const expectedUpload = `${CLOUDFLARE_API_ORIGIN}/accounts/${input.binding.accountId}/workers/assets/upload?base64=true`;
      if (
        !["worker.script.initialize", "worker.version.upload"].includes(
          input.binding.operation,
        ) ||
        request.accountId !== input.binding.accountId ||
        request.scriptName !== input.binding.scriptName ||
        request.revisionId !== input.binding.revisionId ||
        request.packageDigest !== input.binding.packageDigest ||
        request.manifestEndpoint !== expectedManifest ||
        request.uploadEndpoint !== expectedUpload ||
        request.serialization.kind !== "cloudflare_static_assets_multipart" ||
        request.serialization.completionAssertion !==
          "opaque_transport_substitution" ||
        request.assets.length === 0 ||
        request.assets.length > MAX_ASSETS
      ) {
        throw new TypeError("cloudflare_asset_request_invalid");
      }
      const entries = new Map<
        string,
        { asset: CloudflareStaticAsset; bytes: Uint8Array }
      >();
      const manifest: Record<string, { hash: string; size: number }> = {};
      let decodedBytes = 0;
      for (const asset of request.assets) {
        if (
          !asset.path.startsWith("/") ||
          Object.hasOwn(manifest, asset.path) ||
          !asset.mediaType
        ) {
          throw new TypeError("cloudflare_asset_invalid");
        }
        const bytes = contentBytes(asset);
        decodedBytes += bytes.byteLength;
        if (decodedBytes > MAX_BUNDLE_BYTES) {
          throw new TypeError("cloudflare_asset_invalid");
        }
        const hash = await assetHash(asset, bytes);
        if (entries.has(hash)) throw new TypeError("cloudflare_asset_invalid");
        entries.set(hash, { asset, bytes });
        manifest[asset.path] = { hash, size: bytes.byteLength };
      }
      const manifestHeaders = providerHeaders(input.credential);
      manifestHeaders.set("content-type", "application/json");
      const manifestResponse = await authorizedFetch(
        new Request(request.manifestEndpoint, {
          method: "POST",
          headers: manifestHeaders,
          body: JSON.stringify({ manifest }),
        }),
      );
      const manifestResult = await responseJson(manifestResponse);
      if (
        manifestResponse.status < 200 ||
        manifestResponse.status > 299 ||
        !isRecord(manifestResult.body) ||
        manifestResult.body.success !== true ||
        !isRecord(manifestResult.body.result) ||
        !Array.isArray(manifestResult.body.result.buckets) ||
        typeof manifestResult.body.result.jwt !== "string" ||
        !OPAQUE_VALUE.test(manifestResult.body.result.jwt)
      ) {
        throw new Error("cloudflare_asset_upload_failed");
      }
      const buckets = manifestResult.body.result.buckets;
      const requestedHashes = new Set<string>();
      for (const bucket of buckets) {
        if (!Array.isArray(bucket) || bucket.length === 0) {
          throw new Error("cloudflare_asset_upload_failed");
        }
        for (const hash of bucket) {
          if (
            typeof hash !== "string" ||
            !entries.has(hash) ||
            requestedHashes.has(hash)
          ) {
            throw new Error("cloudflare_asset_upload_failed");
          }
          requestedHashes.add(hash);
        }
      }
      let completion = manifestResult.body.result.jwt;
      let serializedBodyBytes = manifestResult.byteLength;
      for (const bucket of buckets) {
        const form = new FormData();
        for (const hash of bucket as string[]) {
          const entry = entries.get(hash)!;
          const encoded = encodeBase64(entry.bytes);
          serializedBodyBytes += encoded.length;
          form.append(
            hash,
            new Blob([encoded], { type: entry.asset.mediaType }),
            hash,
          );
        }
        const uploadHeaders = new Headers({ accept: "application/json" });
        uploadHeaders.set("authorization", ["Bearer", completion].join(" "));
        const response = await authorizedFetch(
          new Request(request.uploadEndpoint, {
            method: "POST",
            headers: uploadHeaders,
            body: form,
          }),
        );
        const parsed = await responseJson(response);
        serializedBodyBytes += parsed.byteLength;
        if (
          response.status < 200 ||
          response.status > 299 ||
          !isRecord(parsed.body) ||
          parsed.body.success !== true ||
          !isRecord(parsed.body.result)
        ) {
          throw new Error("cloudflare_asset_upload_failed");
        }
        if (typeof parsed.body.result.jwt === "string") {
          if (!OPAQUE_VALUE.test(parsed.body.result.jwt)) {
            throw new Error("cloudflare_asset_upload_failed");
          }
          completion = parsed.body.result.jwt;
        }
      }
      if (serializedBodyBytes > MAX_RESPONSE_BYTES) {
        throw new Error("cloudflare_asset_upload_failed");
      }
      const handle = completionId();
      completions.set(handle, completion);
      return {
        completion: Object.freeze({ handle }),
        manifestDigest: request.packageDigest,
        serializedBodyBytes,
      };
    },
  });
}
