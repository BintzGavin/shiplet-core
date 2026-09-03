/** Revision-aware Workers for Platforms invocation and outbound policy. */

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SCRIPT_IDENTIFIER =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
const PACKAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const STRIPPED_HEADER = /^(?:authorization|cookie|forwarded|proxy-authorization|proxy-authenticate|via|cf-|x-forwarded-|x-real-ip|x-shiplet-)/i;

export type ManagedRevisionBinding = Readonly<{
  shipletId: string;
  revisionId: string;
  packageDigest: string;
  activationGeneration: number;
}>;

export type ActiveManagedRevision = ManagedRevisionBinding &
  Readonly<{ scriptName: string }>;

export type ManagedOutboundContext = Readonly<{
  policy: "deny_by_default";
  shiplet: string;
  revision: string;
  generation: string;
}>;

function validRevisionBinding(value: ManagedRevisionBinding) {
  return (
    IDENTIFIER.test(value.shipletId) &&
    IDENTIFIER.test(value.revisionId) &&
    PACKAGE_DIGEST.test(value.packageDigest) &&
    Number.isSafeInteger(value.activationGeneration) &&
    value.activationGeneration > 0
  );
}

function sameRevision(
  expected: ManagedRevisionBinding,
  active: ActiveManagedRevision,
) {
  return (
    expected.shipletId === active.shipletId &&
    expected.revisionId === active.revisionId &&
    expected.packageDigest === active.packageDigest &&
    expected.activationGeneration === active.activationGeneration
  );
}

function stripAuthorityHeaders(headers: Headers) {
  const sanitized = new Headers();
  headers.forEach((value, name) => {
    if (!STRIPPED_HEADER.test(name)) sanitized.append(name, value);
  });
  return sanitized;
}

export async function createManagedDispatchInvocation(input: {
  request: Request;
  expected: ManagedRevisionBinding;
  active: ActiveManagedRevision;
  limits: { cpuMs: number; subRequests: number };
}) {
  if (
    !validRevisionBinding(input.expected) ||
    !validRevisionBinding(input.active) ||
    !SCRIPT_IDENTIFIER.test(input.active.scriptName) ||
    !sameRevision(input.expected, input.active) ||
    !Number.isSafeInteger(input.limits.cpuMs) ||
    input.limits.cpuMs <= 0 ||
    input.limits.cpuMs > 30_000 ||
    !Number.isSafeInteger(input.limits.subRequests) ||
    input.limits.subRequests < 0 ||
    input.limits.subRequests > 1_000
  ) {
    throw new TypeError("managed_revision_binding_mismatch");
  }
  const context = Object.freeze({
    policy: "deny_by_default" as const,
    shiplet: input.active.shipletId,
    revision: input.active.revisionId,
    generation: String(input.active.activationGeneration),
  });
  const request = new Request(input.request, {
    headers: stripAuthorityHeaders(input.request.headers),
    redirect: "manual",
  });
  return Object.freeze({
    scriptName: input.active.scriptName,
    request,
    active: Object.freeze({ ...input.active }),
    options: Object.freeze({
      limits: Object.freeze({ ...input.limits }),
      outbound: context,
    }),
  });
}

export type ManagedEgressGrant = Readonly<{
  origin: string;
  methods: readonly string[];
}>;

function validContext(value: ManagedOutboundContext) {
  return (
    value.policy === "deny_by_default" &&
    IDENTIFIER.test(value.shiplet) &&
    IDENTIFIER.test(value.revision) &&
    /^(?:[1-9][0-9]{0,14})$/.test(value.generation)
  );
}

function normalizedGrant(grant: ManagedEgressGrant) {
  try {
    const url = new URL(grant.origin);
    const methods = [...new Set(grant.methods)];
    if (
      url.protocol !== "https:" ||
      url.origin !== grant.origin ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !url.hostname.includes(".") ||
      /^\[?[0-9a-f:.]+\]?$/i.test(url.hostname) ||
      methods.length === 0 ||
      methods.length !== grant.methods.length ||
      methods.some(
        (method) =>
          !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method),
      )
    ) {
      return null;
    }
    return { origin: url.origin, methods: new Set(methods) };
  } catch {
    return null;
  }
}

function deniedOutboundResponse() {
  return new Response("Outbound request denied", {
    status: 403,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

export async function handleManagedOutboundRequest(input: {
  request: Request;
  context: ManagedOutboundContext;
  allow: readonly ManagedEgressGrant[];
  fetch: typeof fetch;
}) {
  if (!validContext(input.context) || input.allow.length > 32) {
    return deniedOutboundResponse();
  }
  let url: URL;
  try {
    url = new URL(input.request.url);
  } catch {
    return deniedOutboundResponse();
  }
  const grants = input.allow.map(normalizedGrant);
  if (grants.some((grant) => grant === null)) {
    return deniedOutboundResponse();
  }
  const allowed = grants.some(
    (grant) =>
      grant?.origin === url.origin && grant.methods.has(input.request.method),
  );
  if (
    !allowed ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return deniedOutboundResponse();
  }
  const request = new Request(input.request, {
    headers: stripAuthorityHeaders(input.request.headers),
    redirect: "manual",
  });
  return input.fetch(request);
}
