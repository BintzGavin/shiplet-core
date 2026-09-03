export type CapabilityActorKind = "human" | "agent" | "shiplet" | "system";

export interface CapabilityActor {
	kind: CapabilityActorKind;
	id: string;
}

export type CapabilityEffect = "read" | "mutation";
export type CapabilityApproval = "none" | "trusted-human";

export interface CapabilityGrant {
	id: string;
	generation: number;
	actor: CapabilityActor;
	shipletId: string;
	revisionId: string;
	action: string;
	resource: string;
	effect: CapabilityEffect;
	approval: CapabilityApproval;
	expiresAt: number;
	revokedAt: number | null;
}

export interface CapabilityRequest {
	requestId: string;
	shipletId: string;
	revisionId: string;
	action: string;
	resource: string;
	input: unknown;
}

export interface AuthorizedCapabilityInvocation {
	actor: CapabilityActor;
	shipletId: string;
	revisionId: string;
	action: string;
	resource: string;
	requestId: string;
	input: unknown;
}

export interface CapabilityGrantStore {
	/**
	 * Resolve an opaque handle inside the trusted kernel. The handle must never be
	 * serialized into a frame message or returned by a public API.
	 */
	resolveOpaqueHandle(handle: string): Promise<CapabilityGrant | null>;

	/**
	 * Re-resolve and atomically authorize the use after all awaited approval work.
	 * Persistent implementations must check current scope, expiry, and revocation
	 * in the same transaction that claims a mutation request ID.
	 */
	revalidateAndClaim(
		attempt: AtomicCapabilityUse,
	): Promise<AtomicCapabilityUseResult>;

	/** @deprecated Use revalidateAndClaim so revocation cannot race the claim. */
	claimMutationOnce?(grantId: string, requestId: string): Promise<boolean>;
}

export interface AtomicCapabilityUse extends Record<string, unknown> {
	opaqueHandle: string;
	grantId: string;
	grantGeneration: number;
	actor: CapabilityActor;
	shipletId: string;
	revisionId: string;
	action: string;
	resource: string;
	effect: CapabilityEffect;
	approvalPolicy: CapabilityApproval;
	approvalId: string | null;
	inputDigest: string;
	requestId: string;
	now: number;
}

export interface AtomicCapabilityUseResult {
	ok: boolean;
	reason?: string;
}

export interface TrustedApprovalBinding extends Record<string, unknown> {
	requestId: string;
	actor: CapabilityActor;
	grantId: string;
	grantGeneration: number;
	shipletId: string;
	revisionId: string;
	action: string;
	resource: string;
	effect: CapabilityEffect;
	approvalPolicy: CapabilityApproval;
	inputDigest: string;
}

export interface TrustedApprovalVerifier {
	verifyTrustedApproval(
		approvalId: string,
		expectedBinding: TrustedApprovalBinding,
	): Promise<boolean>;
}

export type CapabilityAuditOutcome = "allowed" | "denied" | "failed";

export interface CapabilityAuditEvent {
	outcome: CapabilityAuditOutcome;
	phase: "intent" | "completion";
	correlationId: string;
	reason?: string;
	grantId?: string;
	grantGeneration: number;
	effect: CapabilityEffect;
	inputDigest?: string;
	approvalPolicy?: "trusted-human";
	approvalId?: string;
	requestId: string;
	actor: CapabilityActor;
	shipletId: string;
	revisionId: string;
	action: string;
	resource: string;
}

export interface CapabilityBrokerOptions {
	now: () => number;
	limits: CapabilityBrokerLimits;
	grants: CapabilityGrantStore;
	approvals: TrustedApprovalVerifier;
	validateActionPayload: (
		invocation: AuthorizedCapabilityInvocation,
	) => boolean | Promise<boolean>;
	audit: (event: CapabilityAuditEvent) => Promise<void>;
}

export interface CapabilityBrokerLimits {
	maxInputBytes: number;
	maxMetadataFieldBytes: number;
}

export interface CapabilityInvocation {
	opaqueHandle: string;
	trustedActor: CapabilityActor;
	trustedApprovalId?: string;
	request: CapabilityRequest;
}

export type CapabilityInvocationResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			code:
				| "capability_denied"
				| "approval_required"
				| "replayed"
				| "audit_unavailable"
				| "execution_failed";
	  };

export interface CapabilityBroker {
	invoke<T>(
		invocation: CapabilityInvocation,
		execute: (authorized: AuthorizedCapabilityInvocation) => Promise<T>,
	): Promise<CapabilityInvocationResult<T>>;
	invokeBound<T>(
		invocation: CapabilityInvocation,
		requirements: CapabilityBoundRequirements,
		execute: (authorized: AuthorizedCapabilityInvocation) => Promise<T>,
	): Promise<CapabilityInvocationResult<T>>;
}

export interface CapabilityBoundRequirements {
	effect: CapabilityEffect;
	approval: CapabilityApproval;
}

type DenialReason =
	| "invalid_request"
	| "capability_not_found"
	| "actor_mismatch"
	| "shiplet_mismatch"
	| "revision_mismatch"
	| "action_mismatch"
	| "resource_mismatch"
	| "expired"
	| "revoked"
	| "approval_required"
	| "replayed"
	| "invalid_action_payload"
	| "grant_store_unavailable"
	| "grant_store_denied"
	| "scope_mismatch"
	| "approval_store_unavailable";

const TRUSTED_ATOMIC_DENIAL_REASONS = new Set<DenialReason>([
	"capability_not_found",
	"expired",
	"grant_store_unavailable",
	"replayed",
	"revoked",
	"scope_mismatch",
]);

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isActor(value: unknown): value is CapabilityActor {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const actor = value as Partial<CapabilityActor>;
	return (
		(actor.kind === "human" ||
			actor.kind === "agent" ||
			actor.kind === "shiplet" ||
			actor.kind === "system") &&
		isNonEmptyString(actor.id)
	);
}

function isRequest(value: unknown): value is CapabilityRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const request = value as Partial<CapabilityRequest>;
	return (
		isNonEmptyString(request.requestId) &&
		isNonEmptyString(request.shipletId) &&
		isNonEmptyString(request.revisionId) &&
		isNonEmptyString(request.action) &&
		isNonEmptyString(request.resource) &&
		Object.prototype.hasOwnProperty.call(request, "input")
	);
}

function isGrant(value: unknown): value is CapabilityGrant {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const grant = value as Partial<CapabilityGrant>;
	return (
		isNonEmptyString(grant.id) &&
		Number.isSafeInteger(grant.generation) &&
		(grant.generation as number) > 0 &&
		isActor(grant.actor) &&
		isNonEmptyString(grant.shipletId) &&
		isNonEmptyString(grant.revisionId) &&
		isNonEmptyString(grant.action) &&
		isNonEmptyString(grant.resource) &&
		(grant.effect === "read" || grant.effect === "mutation") &&
		(grant.approval === "none" || grant.approval === "trusted-human") &&
		typeof grant.expiresAt === "number" &&
		Number.isFinite(grant.expiresAt) &&
		(grant.revokedAt === null ||
			(typeof grant.revokedAt === "number" && Number.isFinite(grant.revokedAt)))
	);
}

function actorsMatch(left: CapabilityActor, right: CapabilityActor): boolean {
	return left.kind === right.kind && left.id === right.id;
}

function normalizeActor(actor: CapabilityActor): CapabilityActor {
	return Object.freeze({ kind: actor.kind, id: actor.id });
}

function snapshotGrant(grant: CapabilityGrant): CapabilityGrant {
	return Object.freeze({
		id: grant.id,
		generation: grant.generation,
		actor: normalizeActor(grant.actor),
		shipletId: grant.shipletId,
		revisionId: grant.revisionId,
		action: grant.action,
		resource: grant.resource,
		effect: grant.effect,
		approval: grant.approval,
		expiresAt: grant.expiresAt,
		revokedAt: grant.revokedAt,
	});
}

type JsonSnapshot =
	| string
	| number
	| boolean
	| null
	| readonly JsonSnapshot[]
	| { readonly [key: string]: JsonSnapshot };

type JsonSnapshotState = {
	nodes: number;
	stringUnits: number;
	canonicalBytes: number;
	maximumBytes: number;
	ancestors: Set<object>;
};

const MAX_CANONICAL_INPUT_NODES = 10_000;
const MAX_CANONICAL_INPUT_DEPTH = 64;
const MAX_CANONICAL_INPUT_STRING_UNITS = 1_000_000;
const MAX_CANONICAL_INPUT_PROPERTIES = 256;

type JsonSnapshotResult = {
	value: JsonSnapshot;
	canonical: string;
};

function addCanonicalBytes(state: JsonSnapshotState, amount: number): boolean {
	if (amount > state.maximumBytes - state.canonicalBytes) return false;
	state.canonicalBytes += amount;
	return true;
}

function addJsonStringBytes(
	value: string,
	state: JsonSnapshotState,
): boolean {
	if (!addCanonicalBytes(state, 2)) return false;
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		let bytes: number;
		if (unit === 0x22 || unit === 0x5c) {
			bytes = 2;
		} else if (unit <= 0x1f) {
			bytes =
				unit === 0x08 ||
				unit === 0x09 ||
				unit === 0x0a ||
				unit === 0x0c ||
				unit === 0x0d
					? 2
					: 6;
		} else if (unit <= 0x7f) {
			bytes = 1;
		} else if (unit <= 0x7ff) {
			bytes = 2;
		} else if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes = 4;
				index += 1;
			} else {
				bytes = 6;
			}
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			bytes = 6;
		} else {
			bytes = 3;
		}
		if (!addCanonicalBytes(state, bytes)) return false;
	}
	return true;
}

function isUtf8WithinLimit(value: string, maximumBytes: number): boolean {
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit <= 0x7f) {
			bytes += 1;
		} else if (unit <= 0x7ff) {
			bytes += 2;
		} else if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
		if (bytes > maximumBytes) return false;
	}
	return true;
}

function hasBoundedInvocationMetadata(
	invocation: CapabilityInvocation,
	maximumBytes: number,
): boolean {
	const metadata = [
		invocation.opaqueHandle,
		invocation.trustedActor.id,
		invocation.request.requestId,
		invocation.request.shipletId,
		invocation.request.revisionId,
		invocation.request.action,
		invocation.request.resource,
	];
	if (invocation.trustedApprovalId !== undefined) {
		if (!isNonEmptyString(invocation.trustedApprovalId)) return false;
		metadata.push(invocation.trustedApprovalId);
	}
	return metadata.every((value) => isUtf8WithinLimit(value, maximumBytes));
}

function hasBoundedGrantMetadata(
	grant: CapabilityGrant,
	maximumBytes: number,
): boolean {
	return [
		grant.id,
		grant.actor.id,
		grant.shipletId,
		grant.revisionId,
		grant.action,
		grant.resource,
	].every((value) => isUtf8WithinLimit(value, maximumBytes));
}

function normalizeAtomicDenialReason(reason: unknown): DenialReason {
	return typeof reason === "string" &&
		TRUSTED_ATOMIC_DENIAL_REASONS.has(reason as DenialReason)
		? (reason as DenialReason)
		: "grant_store_denied";
}

function normalizeJsonSnapshot(
	value: unknown,
	state: JsonSnapshotState,
	depth = 0,
): JsonSnapshotResult | null {
	state.nodes += 1;
	if (
		state.nodes > MAX_CANONICAL_INPUT_NODES ||
		depth > MAX_CANONICAL_INPUT_DEPTH
	) {
		return null;
	}
	if (value === null || typeof value === "boolean") {
		if (!addCanonicalBytes(state, value === null ? 4 : value ? 4 : 5)) {
			return null;
		}
		return { value, canonical: JSON.stringify(value) };
	}
	if (typeof value === "string") {
		state.stringUnits += value.length;
		if (
			state.stringUnits > MAX_CANONICAL_INPUT_STRING_UNITS ||
			!addJsonStringBytes(value, state)
		) {
			return null;
		}
		return { value, canonical: JSON.stringify(value) };
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value) || Object.is(value, -0)) return null;
		const canonical = JSON.stringify(value);
		return addCanonicalBytes(state, canonical.length)
			? { value, canonical }
			: null;
	}
	if (typeof value !== "object" || state.ancestors.has(value)) return null;

	state.ancestors.add(value);
	if (Array.isArray(value)) {
		const ownKeys = Reflect.ownKeys(value);
		if (
			ownKeys.some((key) => typeof key !== "string") ||
			ownKeys.length !== value.length + 1
		) {
			state.ancestors.delete(value);
			return null;
		}
		const entries: JsonSnapshot[] = [];
		const canonicalEntries: string[] = [];
		if (!addCanonicalBytes(state, 1)) {
			state.ancestors.delete(value);
			return null;
		}
		for (let index = 0; index < value.length; index += 1) {
			if (index > 0 && !addCanonicalBytes(state, 1)) {
				state.ancestors.delete(value);
				return null;
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				state.ancestors.delete(value);
				return null;
			}
			const normalized = normalizeJsonSnapshot(
				descriptor.value,
				state,
				depth + 1,
			);
			if (normalized === null) {
				state.ancestors.delete(value);
				return null;
			}
			entries.push(normalized.value);
			canonicalEntries.push(normalized.canonical);
		}
		if (!addCanonicalBytes(state, 1)) {
			state.ancestors.delete(value);
			return null;
		}
		state.ancestors.delete(value);
		return {
			value: Object.freeze(entries),
			canonical: `[${canonicalEntries.join(",")}]`,
		};
	}

	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		state.ancestors.delete(value);
		return null;
	}
	const ownKeys = Reflect.ownKeys(value);
	const enumerableKeys = Object.keys(value);
	if (
		ownKeys.some((key) => typeof key !== "string") ||
		ownKeys.length !== enumerableKeys.length ||
		enumerableKeys.length > MAX_CANONICAL_INPUT_PROPERTIES
	) {
		state.ancestors.delete(value);
		return null;
	}
	const snapshot: Record<string, JsonSnapshot> = {};
	const canonicalEntries: string[] = [];
	if (!addCanonicalBytes(state, 1)) {
		state.ancestors.delete(value);
		return null;
	}
	for (const [index, key] of enumerableKeys.sort().entries()) {
		if (key === "__proto__" || key === "prototype" || key === "constructor") {
			state.ancestors.delete(value);
			return null;
		}
		if (
			(index > 0 && !addCanonicalBytes(state, 1)) ||
			!addJsonStringBytes(key, state) ||
			!addCanonicalBytes(state, 1)
		) {
			state.ancestors.delete(value);
			return null;
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
			state.ancestors.delete(value);
			return null;
		}
		const normalized = normalizeJsonSnapshot(
			descriptor.value,
			state,
			depth + 1,
		);
		if (normalized === null) {
			state.ancestors.delete(value);
			return null;
		}
		snapshot[key] = normalized.value;
		canonicalEntries.push(`${JSON.stringify(key)}:${normalized.canonical}`);
	}
	if (!addCanonicalBytes(state, 1)) {
		state.ancestors.delete(value);
		return null;
	}
	state.ancestors.delete(value);
	return {
		value: Object.freeze(snapshot),
		canonical: `{${canonicalEntries.join(",")}}`,
	};
}

async function canonicalInputDigest(canonical: string): Promise<string> {
	const encoded = new TextEncoder().encode(canonical);
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", Uint8Array.from(encoded).buffer),
	);
	return `sha256:${Array.from(digest, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")}`;
}

function approvalBinding(
	grant: CapabilityGrant,
	request: CapabilityRequest,
	inputDigest: string,
): TrustedApprovalBinding {
	return Object.freeze({
		requestId: request.requestId,
		actor: normalizeActor(grant.actor),
		grantId: grant.id,
		grantGeneration: grant.generation,
		shipletId: grant.shipletId,
		revisionId: grant.revisionId,
		action: grant.action,
		resource: grant.resource,
		effect: grant.effect,
		approvalPolicy: "trusted-human",
		inputDigest,
	});
}

function boundedAuditString(
	value: unknown,
	fallback: string,
	maximumBytes: number,
): string {
	return isNonEmptyString(value) && isUtf8WithinLimit(value, maximumBytes)
		? value
		: fallback;
}

function sanitizedAuditEvent(
	invocation: CapabilityInvocation,
	outcome: CapabilityAuditOutcome,
	phase: "intent" | "completion",
	correlationId: string,
	reason?: string,
	grant?: CapabilityGrant,
	evidence?: {
		inputDigest: string;
		approvalPolicy: CapabilityApproval;
		approvalId: string | null;
	},
	maximumMetadataBytes = 1_024,
): CapabilityAuditEvent {
	const safeInvocation =
		typeof invocation === "object" && invocation !== null
			? (invocation as Partial<CapabilityInvocation>)
			: {};
	const request =
		typeof safeInvocation.request === "object" &&
		safeInvocation.request !== null
			? (safeInvocation.request as Partial<CapabilityRequest>)
			: {};
	const approvalPolicy =
		evidence?.approvalPolicy ??
		(grant?.effect === "mutation" || grant?.approval === "trusted-human"
			? "trusted-human"
			: "none");
	const auditActor: CapabilityActor =
		isActor(safeInvocation.trustedActor) &&
		isUtf8WithinLimit(safeInvocation.trustedActor.id, maximumMetadataBytes)
		? normalizeActor(safeInvocation.trustedActor)
		: normalizeActor({ kind: "system", id: "invalid_actor" });
	return Object.freeze({
		outcome,
		phase,
		correlationId,
		...(reason ? { reason } : {}),
		...(grant && isUtf8WithinLimit(grant.id, maximumMetadataBytes)
			? { grantId: grant.id }
			: {}),
		grantGeneration: grant?.generation ?? 0,
		effect: grant?.effect ?? "read",
		...(evidence ? { inputDigest: evidence.inputDigest } : {}),
		...(approvalPolicy === "trusted-human"
			? {
					approvalPolicy,
					...(isNonEmptyString(evidence?.approvalId) &&
					isUtf8WithinLimit(evidence.approvalId, maximumMetadataBytes)
						? { approvalId: evidence.approvalId }
						: isNonEmptyString(safeInvocation.trustedApprovalId) &&
							isUtf8WithinLimit(
								safeInvocation.trustedApprovalId,
								maximumMetadataBytes,
							)
							? { approvalId: safeInvocation.trustedApprovalId }
							: {}),
				}
			: {}),
		requestId: boundedAuditString(
			request?.requestId,
			"invalid_request",
			maximumMetadataBytes,
		),
		actor: auditActor,
		shipletId: boundedAuditString(
			request?.shipletId,
			"invalid_shiplet",
			maximumMetadataBytes,
		),
		revisionId: boundedAuditString(
			request?.revisionId,
			"invalid_revision",
			maximumMetadataBytes,
		),
		action: boundedAuditString(
			request?.action,
			"invalid_action",
			maximumMetadataBytes,
		),
		resource: boundedAuditString(
			request?.resource,
			"invalid_resource",
			maximumMetadataBytes,
		),
	});
}

export function createCapabilityBroker(
	options: CapabilityBrokerOptions,
): CapabilityBroker {
	if (
		typeof options !== "object" ||
		options === null ||
		typeof options.limits !== "object" ||
		options.limits === null ||
		!Number.isSafeInteger(options.limits.maxInputBytes) ||
		options.limits.maxInputBytes <= 0 ||
		!Number.isSafeInteger(options.limits.maxMetadataFieldBytes) ||
		options.limits.maxMetadataFieldBytes <= 0
	) {
		throw new TypeError("Invalid capability broker limits");
	}

	function correlationIdFor(
		invocation: CapabilityInvocation,
		grant?: CapabilityGrant,
	): string {
		const requestId = boundedAuditString(
			invocation?.request?.requestId,
			"invalid_request",
			options.limits.maxMetadataFieldBytes,
		);
		const grantId = boundedAuditString(
			grant?.id,
			"unresolved",
			options.limits.maxMetadataFieldBytes,
		);
		return `capability:${grantId}:${requestId}`;
	}

	async function deny<T>(
		invocation: CapabilityInvocation,
		reason: DenialReason,
		grant?: CapabilityGrant,
		publicCode: "capability_denied" | "approval_required" | "replayed" =
			"capability_denied",
	): Promise<CapabilityInvocationResult<T>> {
		try {
			await options.audit(
				sanitizedAuditEvent(
					invocation,
					"denied",
					"completion",
						correlationIdFor(invocation, grant),
						reason,
						grant,
						undefined,
						options.limits.maxMetadataFieldBytes,
					),
			);
		} catch {
			return { ok: false, code: "audit_unavailable" };
		}
		return { ok: false, code: publicCode };
	}

	async function completeAudit(
		invocation: CapabilityInvocation,
		grant: CapabilityGrant,
		correlationId: string,
		outcome: CapabilityAuditOutcome,
		reason?: string,
		evidence?: {
			inputDigest: string;
			approvalPolicy: CapabilityApproval;
			approvalId: string | null;
		},
	): Promise<boolean> {
		try {
			await options.audit(
				sanitizedAuditEvent(
					invocation,
					outcome,
					"completion",
						correlationId,
						reason,
						grant,
						evidence,
						options.limits.maxMetadataFieldBytes,
					),
			);
			return true;
		} catch {
			return false;
		}
	}

	async function invokeWithRequirements<T>(
			invocation: CapabilityInvocation,
			execute: (authorized: AuthorizedCapabilityInvocation) => Promise<T>,
			requirements?: CapabilityBoundRequirements,
		): Promise<CapabilityInvocationResult<T>> {
			if (
				typeof invocation !== "object" ||
				invocation === null ||
				!isNonEmptyString(invocation.opaqueHandle) ||
				!isActor(invocation.trustedActor) ||
				!isRequest(invocation.request) ||
				typeof execute !== "function"
			) {
				return deny(invocation, "invalid_request");
			}
			if (
				!hasBoundedInvocationMetadata(
					invocation,
					options.limits.maxMetadataFieldBytes,
				)
			) {
				return deny(invocation, "invalid_request");
			}

			const snapshot = normalizeJsonSnapshot(invocation.request.input, {
				nodes: 0,
				stringUnits: 0,
				canonicalBytes: 0,
				maximumBytes: options.limits.maxInputBytes,
				ancestors: new Set<object>(),
			});
			if (snapshot === null) {
				return deny(invocation, "invalid_action_payload");
			}
			const stableInvocation: CapabilityInvocation = Object.freeze({
				opaqueHandle: invocation.opaqueHandle,
				trustedActor: normalizeActor(invocation.trustedActor),
				...(invocation.trustedApprovalId === undefined
					? {}
					: { trustedApprovalId: invocation.trustedApprovalId }),
				request: Object.freeze({
					requestId: invocation.request.requestId,
					shipletId: invocation.request.shipletId,
					revisionId: invocation.request.revisionId,
					action: invocation.request.action,
					resource: invocation.request.resource,
					input: snapshot.value,
				}),
			});
			const request = stableInvocation.request;

			let resolved: CapabilityGrant | null;
			try {
				resolved = await options.grants.resolveOpaqueHandle(
					stableInvocation.opaqueHandle,
				);
			} catch {
				return deny(stableInvocation, "grant_store_unavailable");
			}
			if (!isGrant(resolved)) {
				return deny(stableInvocation, "capability_not_found");
			}
			const grant = snapshotGrant(resolved);
			if (
				!hasBoundedGrantMetadata(
					grant,
					options.limits.maxMetadataFieldBytes,
				)
			) {
				return deny(stableInvocation, "capability_not_found");
			}
			if (
				requirements &&
				(grant.effect !== requirements.effect ||
					grant.approval !== requirements.approval)
			) {
				return deny(stableInvocation, "scope_mismatch", grant);
			}
			const trustedActor = stableInvocation.trustedActor;

			if (!actorsMatch(grant.actor, trustedActor)) {
				return deny(stableInvocation, "actor_mismatch", grant);
			}
			if (grant.shipletId !== request.shipletId) {
				return deny(stableInvocation, "shiplet_mismatch", grant);
			}
			if (grant.revisionId !== request.revisionId) {
				return deny(stableInvocation, "revision_mismatch", grant);
			}
			if (grant.action !== request.action) {
				return deny(stableInvocation, "action_mismatch", grant);
			}
			if (grant.resource !== request.resource) {
				return deny(stableInvocation, "resource_mismatch", grant);
			}

			let now: number;
			try {
				now = options.now();
			} catch {
				return deny(stableInvocation, "expired", grant);
			}
			if (!Number.isFinite(now) || now >= grant.expiresAt) {
				return deny(stableInvocation, "expired", grant);
			}
			if (grant.revokedAt !== null) {
				return deny(stableInvocation, "revoked", grant);
			}

			const authorized: AuthorizedCapabilityInvocation = Object.freeze({
				actor: trustedActor,
				shipletId: request.shipletId,
				revisionId: request.revisionId,
				action: request.action,
				resource: request.resource,
				requestId: request.requestId,
				input: snapshot.value,
			});
			let payloadValid = false;
			try {
				payloadValid = await options.validateActionPayload(authorized);
			} catch {
				payloadValid = false;
			}
			if (!payloadValid) {
				return deny(stableInvocation, "invalid_action_payload", grant);
			}

			const inputDigest = await canonicalInputDigest(snapshot.canonical);

			const requiresTrustedApproval =
				grant.effect === "mutation" || grant.approval === "trusted-human";
			if (requiresTrustedApproval) {
				if (!isNonEmptyString(stableInvocation.trustedApprovalId)) {
					return deny(
						stableInvocation,
						"approval_required",
						grant,
						"approval_required",
					);
				}
				let approved = false;
				try {
					approved = await options.approvals.verifyTrustedApproval(
						stableInvocation.trustedApprovalId,
						approvalBinding(grant, request, inputDigest),
					);
				} catch {
					return deny(
						stableInvocation,
						"approval_store_unavailable",
						grant,
						"approval_required",
					);
				}
				if (!approved) {
					return deny(
						stableInvocation,
						"approval_required",
						grant,
						"approval_required",
					);
				}
			}
			const evidence = Object.freeze({
				inputDigest,
				approvalPolicy: requiresTrustedApproval
					? ("trusted-human" as const)
					: grant.approval,
				approvalId: requiresTrustedApproval
					? (stableInvocation.trustedApprovalId as string)
					: null,
			});

			const correlationId = correlationIdFor(stableInvocation, grant);
			try {
				await options.audit(
					sanitizedAuditEvent(
						stableInvocation,
						"allowed",
						"intent",
							correlationId,
							undefined,
							grant,
							evidence,
							options.limits.maxMetadataFieldBytes,
						),
				);
			} catch {
				return { ok: false, code: "audit_unavailable" };
			}

			let finalNow: number;
			try {
				finalNow = options.now();
			} catch {
				finalNow = Number.NaN;
			}
			if (!Number.isFinite(finalNow)) {
				const audited = await completeAudit(
					stableInvocation,
					grant,
					correlationId,
					"denied",
					"expired",
					evidence,
				);
				return audited
					? { ok: false, code: "capability_denied" }
					: { ok: false, code: "audit_unavailable" };
			}

			let finalized: AtomicCapabilityUseResult;
			try {
				finalized = await options.grants.revalidateAndClaim(Object.freeze({
					opaqueHandle: stableInvocation.opaqueHandle,
					grantId: grant.id,
					grantGeneration: grant.generation,
					actor: trustedActor,
					shipletId: request.shipletId,
					revisionId: request.revisionId,
					action: request.action,
					resource: request.resource,
					effect: grant.effect,
					approvalPolicy: evidence.approvalPolicy,
					approvalId: evidence.approvalId,
					inputDigest,
					requestId: request.requestId,
					now: finalNow,
				}));
			} catch {
				finalized = { ok: false, reason: "grant_store_unavailable" };
			}
			if (!finalized.ok) {
				const denialReason = normalizeAtomicDenialReason(finalized.reason);
				const publicCode =
					denialReason === "replayed" ? "replayed" : "capability_denied";
				const audited = await completeAudit(
					stableInvocation,
					grant,
					correlationId,
					"denied",
					denialReason,
					evidence,
				);
				return audited
					? { ok: false, code: publicCode }
					: { ok: false, code: "audit_unavailable" };
			}

			let value: T;
			try {
				value = await execute(authorized);
			} catch {
				const audited = await completeAudit(
					stableInvocation,
					grant,
					correlationId,
					"failed",
					"execution_failed",
					evidence,
				);
				return audited
					? { ok: false, code: "execution_failed" }
					: { ok: false, code: "audit_unavailable" };
			}
			const audited = await completeAudit(
				stableInvocation,
				grant,
				correlationId,
				"allowed",
				undefined,
				evidence,
			);
			return audited
				? { ok: true, value }
				: { ok: false, code: "audit_unavailable" };
	}

	return Object.freeze({
		invoke<T>(
			invocation: CapabilityInvocation,
			execute: (authorized: AuthorizedCapabilityInvocation) => Promise<T>,
		) {
			return invokeWithRequirements<T>(invocation, execute);
		},
		invokeBound<T>(
			invocation: CapabilityInvocation,
			requirements: CapabilityBoundRequirements,
			execute: (authorized: AuthorizedCapabilityInvocation) => Promise<T>,
		) {
			if (
				!requirements ||
				(requirements.effect !== "read" && requirements.effect !== "mutation") ||
				(requirements.approval !== "none" &&
					requirements.approval !== "trusted-human") ||
				(requirements.effect === "mutation" &&
					requirements.approval !== "trusted-human")
			) {
				return deny<T>(invocation, "scope_mismatch");
			}
			return invokeWithRequirements<T>(invocation, execute, Object.freeze({
				effect: requirements.effect,
				approval: requirements.approval,
			}));
		},
	});
}
