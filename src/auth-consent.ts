import type { Env } from "./env";

const INVITATION_CONSENT_PREFIX = "shiplet_invite_consent_v1";
const DEFAULT_CONSENT_TTL_SECONDS = 10 * 60;

export interface InvitationConsent {
	projectId: string;
	invitationId?: string | null;
	returnTo: string;
	issuedAt: number;
	expiresAt: number;
	nonce: string;
}

export type InvitationConsentVerification =
	| { ok: true; consent: InvitationConsent }
	| {
			ok: false;
			reason:
				| "missing"
				| "malformed"
				| "invalid_signature"
				| "expired"
				| "invalid_payload";
	  };

function consentSecret(env: Env) {
	const secret =
		env.SHIPLET_REVIEW_TOKEN_SECRET ||
		(env.SHIPLET_AUTH_MODE === "test"
			? "shiplet-test-review-capability-secret"
			: "");
	if (!secret) {
		throw new Response("Invitation consent signing is not configured", {
			status: 500,
		});
	}
	return secret;
}

function base64UrlEncode(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
	try {
		const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
		const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
		const binary = atob(`${normalized}${padding}`);
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		return null;
	}
}

async function consentKey(env: Env) {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(consentSecret(env)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

function encodedConsentPayload(consent: InvitationConsent) {
	return base64UrlEncode(
		new TextEncoder().encode(
			JSON.stringify({
				project_id: consent.projectId,
				invitation_id: consent.invitationId || undefined,
				return_to: consent.returnTo,
				iat: consent.issuedAt,
				exp: consent.expiresAt,
				nonce: consent.nonce,
			}),
		),
	);
}

export async function createInvitationConsentToken(
	env: Env,
	options: {
		projectId: string;
		invitationId?: string | null;
		returnTo: string;
		expiresInSeconds?: number;
		nowSeconds?: number;
	},
) {
	const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
	const consent: InvitationConsent = {
		projectId: options.projectId,
		invitationId: options.invitationId || null,
		returnTo: options.returnTo,
		issuedAt: nowSeconds,
		expiresAt:
			nowSeconds +
			(options.expiresInSeconds ?? DEFAULT_CONSENT_TTL_SECONDS),
		nonce: crypto.randomUUID(),
	};
	const payload = encodedConsentPayload(consent);
	const signature = await crypto.subtle.sign(
		"HMAC",
		await consentKey(env),
		new TextEncoder().encode(`${INVITATION_CONSENT_PREFIX}.${payload}`),
	);
	return `${INVITATION_CONSENT_PREFIX}.${payload}.${base64UrlEncode(
		new Uint8Array(signature),
	)}`;
}

function parseConsentPayload(payload: string): InvitationConsent | null {
	const bytes = base64UrlDecode(payload);
	if (!bytes) return null;
	try {
		const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<
			string,
			unknown
		>;
		if (
			typeof value.project_id !== "string" ||
			!value.project_id ||
			typeof value.return_to !== "string" ||
			!value.return_to ||
			typeof value.iat !== "number" ||
			typeof value.exp !== "number" ||
			typeof value.nonce !== "string" ||
			!value.nonce ||
			(value.invitation_id !== undefined &&
				typeof value.invitation_id !== "string")
		) {
			return null;
		}
		return {
			projectId: value.project_id,
			invitationId:
				typeof value.invitation_id === "string"
					? value.invitation_id
					: null,
			returnTo: value.return_to,
			issuedAt: value.iat,
			expiresAt: value.exp,
			nonce: value.nonce,
		};
	} catch {
		return null;
	}
}

export async function verifyInvitationConsentToken(
	env: Env,
	token: string | null | undefined,
	options: { nowSeconds?: number } = {},
): Promise<InvitationConsentVerification> {
	if (!token) return { ok: false, reason: "missing" };
	const [prefix, payload, signature, ...remainder] = token.split(".");
	if (
		prefix !== INVITATION_CONSENT_PREFIX ||
		!payload ||
		!signature ||
		remainder.length > 0
	) {
		return { ok: false, reason: "malformed" };
	}
	const signatureBytes = base64UrlDecode(signature);
	if (!signatureBytes) return { ok: false, reason: "malformed" };
	const signatureValid = await crypto.subtle.verify(
		"HMAC",
		await consentKey(env),
		signatureBytes,
		new TextEncoder().encode(`${INVITATION_CONSENT_PREFIX}.${payload}`),
	);
	if (!signatureValid) return { ok: false, reason: "invalid_signature" };
	const consent = parseConsentPayload(payload);
	if (!consent) return { ok: false, reason: "invalid_payload" };
	const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
	if (consent.expiresAt <= nowSeconds || consent.issuedAt > nowSeconds + 60) {
		return { ok: false, reason: "expired" };
	}
	return { ok: true, consent };
}
