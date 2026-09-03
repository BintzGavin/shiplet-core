import type { JWTPayload } from "jose";
import type { ShipletUser } from "./store";

const MAX_SUBJECT_ID_BYTES = 256;
const MAX_CLIENT_ID_BYTES = 512;
const MAX_GRANT_ID_BYTES = 256;
const MAX_AGENT_REGISTRATION_ID_BYTES = 220;
const MAX_ORGANIZATION_ID_BYTES = 256;
const MAX_PERMISSION_BYTES = 128;
const MAX_PERMISSIONS = 64;
const MAX_SCOPE_CLAIM_BYTES = 8_192;

const RECOGNIZED_AGENT_REGISTRATION_PERMISSIONS = new Set([
	"mcp",
	"shiplets:read",
	"shiplets:write",
	"shiplets:archive",
	"shiplets:promote",
	"shiplets:rollback",
	"feedback:read",
	"feedback:write",
]);

export interface VerifiedMcpOAuthClaims {
	subjectId: string;
	clientId: string;
	grantId: string;
	organizationId: string | null;
	permissions: readonly string[];
}

export interface McpOAuthPrincipal {
	kind: "agent";
	credentialKind: "oauth_client";
	actorId: string;
	actor: Readonly<{ kind: "agent"; id: string }>;
	subject: ShipletUser;
	clientId: string;
	grantId: string;
	organizationId: string | null;
	permissions: readonly string[];
}

export interface VerifiedAgentRegistrationClaims {
	registrationId: string;
	subjectId: string;
	organizationId: string;
	permissions: readonly string[];
}

export interface McpAgentRegistrationPrincipal {
	kind: "agent";
	credentialKind: "agent_registration";
	actorId: string;
	actor: Readonly<{ kind: "agent"; id: string }>;
	subject: ShipletUser;
	registrationId: string;
	organizationId: string;
	permissions: readonly string[];
}

export type AuthenticatedMcpAgentPrincipal =
	| McpOAuthPrincipal
	| McpAgentRegistrationPrincipal;

/**
 * Parse claims only after the caller has verified the JWT signature, issuer,
 * audience, and temporal claims with jose. WorkOS documents these claims as:
 * sub (user), client_id (application context), sid (session/application
 * consent), org_id (selected organization), and permissions (authorized
 * operations).
 */
export function parseVerifiedMcpOAuthClaims(
	payload: JWTPayload,
	requiredPermissions: readonly string[] = [],
): VerifiedMcpOAuthClaims {
	const subjectId = boundedIdentity(payload.sub, MAX_SUBJECT_ID_BYTES);
	const clientId = boundedIdentity(payload.client_id, MAX_CLIENT_ID_BYTES);
	const grantId = boundedIdentity(payload.sid, MAX_GRANT_ID_BYTES);
	const organizationId = optionalIdentity(
		payload.org_id,
		MAX_ORGANIZATION_ID_BYTES,
	);

	if (!subjectId || !clientId || !grantId || subjectId === clientId) {
		throw new Error("Invalid delegated MCP OAuth identity claims.");
	}

	const permissions = parsePermissions(payload.permissions);
	const required = parseRequiredPermissions(requiredPermissions);
	if (required.some((permission) => !permissions.includes(permission))) {
		throw new Error("Missing required delegated MCP OAuth permission.");
	}

	return Object.freeze({
		subjectId,
		clientId,
		grantId,
		organizationId,
		permissions,
	});
}

export function createMcpOAuthPrincipal(
	subject: ShipletUser,
	claims: VerifiedMcpOAuthClaims,
	options: { authenticatedProviderSubjectId?: string } = {},
): McpOAuthPrincipal {
	const authenticatedProviderSubjectId =
		options.authenticatedProviderSubjectId || subject.id;
	if (authenticatedProviderSubjectId !== claims.subjectId) {
		throw new Error("Delegated MCP OAuth subject mismatch.");
	}
	const actorId = `mcp-oauth:${claims.clientId}:${claims.grantId}`;
	const actor = Object.freeze({ kind: "agent" as const, id: actorId });
	return Object.freeze({
		kind: "agent" as const,
		credentialKind: "oauth_client" as const,
		actorId,
		actor,
		subject,
		clientId: claims.clientId,
		grantId: claims.grantId,
		organizationId: claims.organizationId,
		permissions: claims.permissions,
	});
}

/**
 * Parse a claimed WorkOS Agent Registration token only after jose has verified
 * its signature, issuer, audience, and temporal claims. A claimed registration
 * identifies the stable agent in `sub`, its delegated human in `act.sub`, its
 * exact organization in `org_id`, and granted operations in `scope`.
 */
export function parseVerifiedAgentRegistrationClaims(
	payload: JWTPayload,
	requiredPermissions: readonly string[] = [],
): VerifiedAgentRegistrationClaims {
	const registrationId = boundedIdentity(
		payload.sub,
		MAX_AGENT_REGISTRATION_ID_BYTES,
	);
	const act = payload.act;
	if (!act || typeof act !== "object" || Array.isArray(act)) {
		throw new Error("Claimed agent registration is required.");
	}
	const subjectId = boundedIdentity(
		(act as Record<string, unknown>).sub,
		MAX_SUBJECT_ID_BYTES,
	);
	const organizationId = boundedIdentity(
		payload.org_id,
		MAX_ORGANIZATION_ID_BYTES,
	);
	if (
		!registrationId ||
		!subjectId ||
		!organizationId ||
		registrationId === subjectId
	) {
		throw new Error("Invalid claimed agent registration identity.");
	}

	const permissions = parseAgentRegistrationPermissions(payload.scope);
	const required = parseRequiredPermissions(requiredPermissions);
	if (required.some((permission) => !permissions.includes(permission))) {
		throw new Error("Missing required agent registration permission.");
	}
	return Object.freeze({
		registrationId,
		subjectId,
		organizationId,
		permissions,
	});
}

export function createMcpAgentRegistrationPrincipal(
	subject: ShipletUser,
	claims: VerifiedAgentRegistrationClaims,
	options: { authenticatedProviderSubjectId?: string } = {},
): McpAgentRegistrationPrincipal {
	const authenticatedProviderSubjectId =
		options.authenticatedProviderSubjectId || subject.id;
	if (authenticatedProviderSubjectId !== claims.subjectId) {
		throw new Error("Agent registration delegated subject mismatch.");
	}
	const actorId = `workos-agent-registration:${claims.registrationId}`;
	const actor = Object.freeze({ kind: "agent" as const, id: actorId });
	return Object.freeze({
		kind: "agent" as const,
		credentialKind: "agent_registration" as const,
		actorId,
		actor,
		subject,
		registrationId: claims.registrationId,
		organizationId: claims.organizationId,
		permissions: claims.permissions,
	});
}

function boundedIdentity(value: unknown, maxBytes: number) {
	if (typeof value !== "string") return null;
	if (value.length < 1 || value.length > maxBytes) return null;
	if (!/^[\x21-\x7e]+$/.test(value)) return null;
	return value;
}

function optionalIdentity(value: unknown, maxBytes: number) {
	if (value === undefined) return null;
	const identity = boundedIdentity(value, maxBytes);
	if (!identity) throw new Error("Invalid optional MCP OAuth identity claim.");
	return identity;
}

function parsePermissions(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.length > MAX_PERMISSIONS) {
		throw new Error("Invalid delegated MCP OAuth permissions claim.");
	}
	const permissions: string[] = [];
	for (const candidate of value) {
		if (
			typeof candidate !== "string" ||
			candidate.length < 1 ||
			candidate.length > MAX_PERMISSION_BYTES ||
			!/^[a-zA-Z0-9][a-zA-Z0-9_.:*-]*$/.test(candidate) ||
			permissions.includes(candidate)
		) {
			throw new Error("Invalid delegated MCP OAuth permission.");
		}
		permissions.push(candidate);
	}
	return Object.freeze(permissions);
}

function parseAgentRegistrationPermissions(value: unknown): readonly string[] {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > MAX_SCOPE_CLAIM_BYTES ||
		value !== value.trim()
	) {
		throw new Error("Invalid agent registration scope claim.");
	}
	const declared = parsePermissions(value.split(" "));
	return Object.freeze(
		declared.filter((permission) =>
			RECOGNIZED_AGENT_REGISTRATION_PERMISSIONS.has(permission),
		),
	);
}

function parseRequiredPermissions(value: readonly string[]) {
	return parsePermissions([...value]);
}
