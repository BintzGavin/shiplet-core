import {
  CLOUDFLARE_API_ORIGIN,
  CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS,
  type CloudflareOAuthRedactingFetch,
} from "../cloudflare-production-adapters";

const MAX_OAUTH_BODY_BYTES = 256 * 1024;
const ACCOUNT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const OPAQUE_VALUE = /^[\x21-\x7e]{16,4096}$/;

type OAuthMaterial = Readonly<{
  accessToken: string;
  refreshToken?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
async function readBoundedBytes(response: Response, maximumBytes: number) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      throw new Error("cloudflare_oauth_response_invalid");
    }
  }
  if (!response.body) throw new Error("cloudflare_oauth_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error("cloudflare_oauth_response_too_large");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "cloudflare_oauth_response_too_large"
    ) {
      throw error;
    }
    throw new Error("cloudflare_oauth_response_invalid");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedJson(response: Response) {
  const bytes = await readBoundedBytes(response, MAX_OAUTH_BODY_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new Error("cloudflare_oauth_response_invalid");
  }
  return { body, bytes: bytes.byteLength };
}

function parseScopes(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("cloudflare_oauth_response_invalid");
  }
  const scopes = [...new Set(value.split(/\s+/).filter(Boolean))].sort();
  if (
    scopes.length === 0 ||
    scopes.some((scope) => !/^[a-z][a-z0-9._-]{0,127}$/.test(scope))
  ) {
    throw new Error("cloudflare_oauth_response_invalid");
  }
  return scopes;
}

function parseMaterial(
  body: unknown,
  now: number,
  previousRefresh?: string,
): { material: OAuthMaterial; scopes: string[]; expiresAt: number } {
  if (!isRecord(body)) throw new Error("cloudflare_oauth_response_invalid");
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token ?? previousRefresh;
  const expiresIn = body.expires_in;
  if (
    typeof accessToken !== "string" ||
    !OPAQUE_VALUE.test(accessToken) ||
    (refreshToken !== undefined &&
      (typeof refreshToken !== "string" || !OPAQUE_VALUE.test(refreshToken))) ||
    !Number.isSafeInteger(expiresIn) ||
    (expiresIn as number) <= 0 ||
    (expiresIn as number) > 31_536_000
  ) {
    throw new Error("cloudflare_oauth_response_invalid");
  }
  const expiresAt = now + (expiresIn as number) * 1_000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new Error("cloudflare_oauth_response_invalid");
  }
  return {
    material: Object.freeze({
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
    }),
    scopes: parseScopes(body.scope),
    expiresAt,
  };
}

function materialFrom(value: object): OAuthMaterial {
  if (
    !isRecord(value) ||
    typeof value.accessToken !== "string" ||
    !OPAQUE_VALUE.test(value.accessToken) ||
    (value.refreshToken !== undefined &&
      (typeof value.refreshToken !== "string" ||
        !OPAQUE_VALUE.test(value.refreshToken)))
  ) {
    throw new Error("cloudflare_oauth_material_invalid");
  }
  return value as OAuthMaterial;
}

function formWithOpaqueValue(
  serialized: string,
  field: string,
  value: string,
) {
  const form = new URLSearchParams(serialized);
  if (form.has(field)) throw new Error("cloudflare_oauth_request_invalid");
  form.set(field, value);
  return form.toString();
}

async function postForm(input: {
  fetch: typeof fetch;
  url: string;
  body: string;
}) {
  return input.fetch(
    new Request(input.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: input.body,
      redirect: "manual",
    }),
  );
}

async function selectedAccounts(input: {
  fetch: typeof fetch;
  accessToken: string;
}) {
  const headers = new Headers({ accept: "application/json" });
  headers.set("authorization", ["Bearer", input.accessToken].join(" "));
  const response = await input.fetch(
    new Request(`${CLOUDFLARE_API_ORIGIN}/accounts?per_page=5`, {
      headers,
      redirect: "manual",
    }),
  );
  const parsed = await readBoundedJson(response);
  if (
    response.status !== 200 ||
    !isRecord(parsed.body) ||
    parsed.body.success !== true ||
    !Array.isArray(parsed.body.result) ||
    parsed.body.result.length !== 1 ||
    !isRecord(parsed.body.result[0]) ||
    !ACCOUNT_IDENTIFIER.test(String(parsed.body.result[0].id ?? "")) ||
    typeof parsed.body.result[0].name !== "string" ||
    parsed.body.result[0].name.trim().length === 0 ||
    parsed.body.result[0].name.length > 256
  ) {
    throw new Error("cloudflare_oauth_account_selection_invalid");
  }
  return {
    accounts: [
      {
        id: parsed.body.result[0].id as string,
        label: parsed.body.result[0].name.trim(),
      },
    ],
    bytes: parsed.bytes,
  };
}

export function createCloudflareOAuthRedactingFetch(input: {
  fetch: typeof fetch;
  now(): number;
}): CloudflareOAuthRedactingFetch {
  return Object.freeze({
    async exchange(request) {
      if (
        request.endpoint !== CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS.token ||
        request.method !== "POST" ||
        request.contentType !== "application/x-www-form-urlencoded" ||
        request.grantType !== "authorization_code" ||
        request.redactedFields[0] !== "code" ||
        request.redactedFields[1] !== "code_verifier"
      ) {
        throw new Error("cloudflare_oauth_request_invalid");
      }
      const response = await postForm({
        fetch: input.fetch,
        url: request.endpoint,
        body: request.form,
      });
      const parsed = await readBoundedJson(response);
      if (response.status !== 200) {
        throw new Error("cloudflare_oauth_exchange_failed");
      }
      const now = input.now();
      const token = parseMaterial(parsed.body, now);
      const accounts = await selectedAccounts({
        fetch: input.fetch,
        accessToken: token.material.accessToken,
      });
      return {
        material: token.material,
        accounts: accounts.accounts,
        scopes: token.scopes,
        expiresAt: token.expiresAt,
        serializedBodyBytes: parsed.bytes + accounts.bytes,
      };
    },

    async refresh(request) {
      if (
        request.endpoint !== CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS.token ||
        request.method !== "POST" ||
        request.contentType !== "application/x-www-form-urlencoded" ||
        request.grantType !== "refresh_token" ||
        request.opaqueSubstitution.field !== "refresh_token"
      ) {
        throw new Error("cloudflare_oauth_request_invalid");
      }
      const current = materialFrom(request.opaqueSubstitution.material);
      if (!current.refreshToken) {
        throw new Error("cloudflare_oauth_refresh_unavailable");
      }
      const response = await postForm({
        fetch: input.fetch,
        url: request.endpoint,
        body: formWithOpaqueValue(
          request.form,
          "refresh_token",
          current.refreshToken,
        ),
      });
      const parsed = await readBoundedJson(response);
      if (response.status !== 200) {
        throw new Error("cloudflare_oauth_refresh_failed");
      }
      const token = parseMaterial(parsed.body, input.now(), current.refreshToken);
      return {
        material: token.material,
        expiresAt: token.expiresAt,
        serializedBodyBytes: parsed.bytes,
      };
    },

    async revoke(request) {
      if (
        request.endpoint !== CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS.revoke ||
        request.method !== "POST" ||
        request.contentType !== "application/x-www-form-urlencoded" ||
        request.opaqueSubstitution.field !== "token"
      ) {
        throw new Error("cloudflare_oauth_request_invalid");
      }
      const current = materialFrom(request.opaqueSubstitution.material);
      const response = await postForm({
        fetch: input.fetch,
        url: request.endpoint,
        body: formWithOpaqueValue(request.form, "token", current.accessToken),
      });
      const bytes = await readBoundedBytes(response, MAX_OAUTH_BODY_BYTES);
      if (response.status < 200 || response.status > 299) {
        throw new Error("cloudflare_oauth_revoke_failed");
      }
      return { serializedBodyBytes: bytes.byteLength };
    },
  });
}
