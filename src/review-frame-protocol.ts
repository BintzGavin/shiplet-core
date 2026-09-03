export const REVIEW_FRAME_SCHEMA_VERSION = "shiplet.review-frame/v1" as const;

export interface ReviewFrameBinding {
	channelId: string;
	bootstrapNonce: string;
	shipletId: string;
	revisionId: string;
	expiresAt: number;
}

export interface ReviewFrameBootstrap {
	schemaVersion: typeof REVIEW_FRAME_SCHEMA_VERSION;
	type: "host.bootstrap";
	channelId: string;
	nonce: string;
	shipletId: string;
	revisionId: string;
	expiresAt: number;
}

export interface ReviewFrameReady {
	schemaVersion: typeof REVIEW_FRAME_SCHEMA_VERSION;
	type: "frame.ready";
	channelId: string;
	nonce: string;
	shipletId: string;
	revisionId: string;
}

export interface ReviewFrameRpcRequest {
	schemaVersion: typeof REVIEW_FRAME_SCHEMA_VERSION;
	type: "rpc.request";
	channelId: string;
	requestId: string;
	sequence: number;
	shipletId: string;
	revisionId: string;
	action: string;
	resource: string;
	payload: JsonValue;
}

export type ReviewFrameRpcResult =
	| { ok: true; payload: JsonValue }
	| {
			ok: false;
			code:
				| "permission_denied"
				| "invalid_request"
				| "expired"
				| "unavailable"
				| "internal_error";
			message: string;
	  };

export interface ReviewFrameRpcResponse {
	schemaVersion: typeof REVIEW_FRAME_SCHEMA_VERSION;
	type: "rpc.response";
	channelId: string;
	requestId: string;
	shipletId: string;
	revisionId: string;
	result: ReviewFrameRpcResult;
}

export interface ReviewFrameResponseInput {
	requestId: string;
	result: ReviewFrameRpcResult;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };

export type ReviewFrameProtocolRejectionCode =
	| "channel_not_ready"
	| "source_mismatch"
	| "origin_mismatch"
	| "channel_mismatch"
	| "scope_mismatch"
	| "malformed_message"
	| "message_too_large"
	| "payload_too_deep"
	| "payload_limit_exceeded"
	| "expired"
	| "replayed"
	| "channel_limit_exceeded";

export type ReviewFrameResponseRejectionCode =
	| ReviewFrameProtocolRejectionCode
	| "correlation_mismatch";

export type ReviewFrameProtocolRejection = {
	ok: false;
	code: ReviewFrameProtocolRejectionCode;
};

export type ReviewFrameBootstrapResult =
	| { ok: true }
	| ReviewFrameProtocolRejection;

export type ReviewFrameRequestResult =
	| { ok: true; request: ReviewFrameRpcRequest }
	| ReviewFrameProtocolRejection;

export type ReviewFrameResponseResult =
	| { ok: true; response: ReviewFrameRpcResponse }
	| { ok: false; code: ReviewFrameResponseRejectionCode };

export interface ReviewFrameProtocolLimits {
	maxMessageBytes: number;
	maxPayloadDepth: number;
	maxPayloadNodes: number;
	maxPropertiesPerObject: number;
	maxAttemptedRequestsPerChannel: number;
	maxAttemptedBytesPerChannel: number;
	maxRequestsPerChannel?: number;
}

export interface ReviewFrameProtocolOptions extends ReviewFrameBinding {
	sourceWindow: object;
	bootstrapOrigin: string;
	port: object;
	now: () => number;
	limits: ReviewFrameProtocolLimits;
}

export interface ReviewFrameBootstrapEvent {
	sourceWindow: object;
	origin: string;
	data: unknown;
}

export interface ReviewFramePortEvent {
	port: object;
	data: unknown;
}

export interface ReviewFrameEncodedPortEvent {
	port: object;
	data: Uint8Array;
}

export type ReviewFrameEncodedResponseResult =
	| { ok: true; bytes: Uint8Array }
	| { ok: false; code: ReviewFrameResponseRejectionCode };

export interface ReviewFrameProtocol {
	acceptBootstrap(event: ReviewFrameBootstrapEvent): ReviewFrameBootstrapResult;
	acceptRequest(event: ReviewFramePortEvent): ReviewFrameRequestResult;
	acceptEncodedRequest(
		event: ReviewFrameEncodedPortEvent,
	): ReviewFrameRequestResult;
	createResponse(input: ReviewFrameResponseInput): ReviewFrameResponseResult;
	createEncodedResponse(
		input: ReviewFrameResponseInput,
	): ReviewFrameEncodedResponseResult;
}

const READY_KEYS = new Set([
	"schemaVersion",
	"type",
	"channelId",
	"nonce",
	"shipletId",
	"revisionId",
]);

const REQUEST_KEYS = new Set([
	"schemaVersion",
	"type",
	"channelId",
	"requestId",
	"sequence",
	"shipletId",
	"revisionId",
	"action",
	"resource",
	"payload",
]);

const RESPONSE_INPUT_KEYS = new Set(["requestId", "result"]);
const SUCCESS_RESULT_KEYS = new Set(["ok", "payload"]);
const ERROR_RESULT_KEYS = new Set(["ok", "code", "message"]);
const RESPONSE_ERROR_CODES = new Set([
	"permission_denied",
	"invalid_request",
	"expired",
	"unavailable",
	"internal_error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	expected: ReadonlySet<string>,
): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isBoundedString(value: unknown, maximum = 256): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= maximum
	);
}

type PreflightState = {
	bytes: number;
	nodes: number;
	exceeded: boolean;
	deferred: boolean;
	ancestors: Set<object>;
};

function addPreflightBytes(
	state: PreflightState,
	amount: number,
	cap: number,
): void {
	if (state.exceeded || state.deferred) return;
	state.bytes += amount;
	if (state.bytes > cap) state.exceeded = true;
}

function addJsonStringBytes(
	value: string,
	state: PreflightState,
	cap: number,
): void {
	addPreflightBytes(state, 2, cap);
	for (let index = 0; index < value.length && !state.exceeded; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit === 0x22 || unit === 0x5c) {
			addPreflightBytes(state, 2, cap);
		} else if (unit <= 0x1f) {
			addPreflightBytes(
				state,
				unit === 0x08 ||
					unit === 0x09 ||
					unit === 0x0a ||
					unit === 0x0c ||
					unit === 0x0d
					? 2
					: 6,
				cap,
			);
		} else if (unit <= 0x7f) {
			addPreflightBytes(state, 1, cap);
		} else if (unit <= 0x7ff) {
			addPreflightBytes(state, 2, cap);
		} else if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				addPreflightBytes(state, 4, cap);
				index += 1;
			} else {
				addPreflightBytes(state, 6, cap);
			}
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			addPreflightBytes(state, 6, cap);
		} else {
			addPreflightBytes(state, 3, cap);
		}
	}
}

function preflightJsonValue(
	value: unknown,
	state: PreflightState,
	cap: number,
	limits: PayloadLimits,
	depth = 1,
): void {
	if (state.exceeded || state.deferred) return;
	state.nodes += 1;
	if (state.nodes > limits.maximumNodes || depth > limits.maximumDepth) {
		state.deferred = true;
		return;
	}
	if (value === null) {
		addPreflightBytes(state, 4, cap);
		return;
	}
	if (typeof value === "boolean") {
		addPreflightBytes(state, value ? 4 : 5, cap);
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value) || Object.is(value, -0)) {
			state.deferred = true;
			return;
		}
		addPreflightBytes(state, JSON.stringify(value).length, cap);
		return;
	}
	if (typeof value === "string") {
		addJsonStringBytes(value, state, cap);
		return;
	}
	if (typeof value !== "object" || state.ancestors.has(value)) {
		state.deferred = true;
		return;
	}

	state.ancestors.add(value);
	if (Array.isArray(value)) {
		if (value.length > limits.maximumNodes - state.nodes) {
			state.deferred = true;
			state.ancestors.delete(value);
			return;
		}
		addPreflightBytes(state, 1, cap);
		for (let index = 0; index < value.length; index += 1) {
			if (index > 0) addPreflightBytes(state, 1, cap);
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (!descriptor || !("value" in descriptor)) {
				state.deferred = true;
				break;
			}
			preflightJsonValue(
				descriptor.value,
				state,
				cap,
				limits,
				depth + 1,
			);
		}
		addPreflightBytes(state, 1, cap);
		state.ancestors.delete(value);
		return;
	}

	const keys = Object.keys(value);
	if (
		keys.length > limits.maximumPropertiesPerObject ||
		keys.length > limits.maximumNodes - state.nodes
	) {
		state.deferred = true;
		state.ancestors.delete(value);
		return;
	}
	addPreflightBytes(state, 1, cap);
	for (let index = 0; index < keys.length; index += 1) {
		if (index > 0) addPreflightBytes(state, 1, cap);
		const key = keys[index];
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) {
			state.deferred = true;
			break;
		}
		addJsonStringBytes(key, state, cap);
		addPreflightBytes(state, 1, cap);
		preflightJsonValue(
			descriptor.value,
			state,
			cap,
			limits,
			depth + 1,
		);
	}
	addPreflightBytes(state, 1, cap);
	state.ancestors.delete(value);
}

function preflightJsonBytes(
	value: unknown,
	cap: number,
	limits: PayloadLimits,
): { bytes: number; exceeded: boolean; deferred: boolean } {
	const state: PreflightState = {
		bytes: 0,
		nodes: 0,
		exceeded: false,
		deferred: false,
		ancestors: new Set<object>(),
	};
	preflightJsonValue(value, state, cap, limits);
	return {
		bytes: state.exceeded ? cap + 1 : state.bytes,
		exceeded: state.exceeded,
		deferred: state.deferred,
	};
}

type PayloadValidation =
	| { ok: true; value: JsonValue }
	| {
			ok: false;
			code:
				| "malformed_message"
				| "payload_too_deep"
				| "payload_limit_exceeded";
	  };

type PayloadLimits = {
	maximumDepth: number;
	maximumNodes: number;
	maximumPropertiesPerObject: number;
};

type PayloadState = {
	nodes: number;
	ancestors: Set<object>;
};

function validatePayload(
	value: unknown,
	limits: PayloadLimits,
	state: PayloadState,
	depth = 1,
): PayloadValidation {
	state.nodes += 1;
	if (state.nodes > limits.maximumNodes) {
		return { ok: false, code: "payload_limit_exceeded" };
	}
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return { ok: true, value };
	}
	if (typeof value === "number") {
		return Number.isFinite(value) && !Object.is(value, -0)
			? { ok: true, value }
			: { ok: false, code: "malformed_message" };
	}
	if (typeof value !== "object") {
		return { ok: false, code: "malformed_message" };
	}
	if (depth > limits.maximumDepth) {
		return { ok: false, code: "payload_too_deep" };
	}
	if (state.ancestors.has(value)) {
		return { ok: false, code: "malformed_message" };
	}

	state.ancestors.add(value);
	if (Array.isArray(value)) {
		if (value.length > limits.maximumNodes - state.nodes) {
			state.ancestors.delete(value);
			return { ok: false, code: "payload_limit_exceeded" };
		}
		const normalized: JsonValue[] = [];
		for (const item of value) {
			const itemResult = validatePayload(item, limits, state, depth + 1);
			if (!itemResult.ok) {
				state.ancestors.delete(value);
				return itemResult;
			}
			normalized.push(itemResult.value);
		}
		state.ancestors.delete(value);
		return { ok: true, value: normalized };
	}

	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		state.ancestors.delete(value);
		return { ok: false, code: "malformed_message" };
	}
	const normalized: Record<string, JsonValue> = {};
	const keys = Object.keys(value);
	if (
		keys.length > limits.maximumPropertiesPerObject ||
		keys.length > limits.maximumNodes - state.nodes
	) {
		state.ancestors.delete(value);
		return { ok: false, code: "payload_limit_exceeded" };
	}
	for (const key of keys) {
		if (
			!isBoundedString(key) ||
			key === "__proto__" ||
			key === "prototype" ||
			key === "constructor"
		) {
			state.ancestors.delete(value);
			return { ok: false, code: "malformed_message" };
		}
		const nestedResult = validatePayload(
			(value as Record<string, unknown>)[key],
			limits,
			state,
			depth + 1,
		);
		if (!nestedResult.ok) {
			state.ancestors.delete(value);
			return nestedResult;
		}
		normalized[key] = nestedResult.value;
	}
	state.ancestors.delete(value);
	return { ok: true, value: normalized };
}

function parseReady(value: unknown): ReviewFrameReady | null {
	if (!isRecord(value) || !hasExactKeys(value, READY_KEYS)) return null;
	if (
		value.schemaVersion !== REVIEW_FRAME_SCHEMA_VERSION ||
		value.type !== "frame.ready" ||
		!isBoundedString(value.channelId) ||
		!isBoundedString(value.nonce) ||
		!isBoundedString(value.shipletId) ||
		!isBoundedString(value.revisionId)
	) {
		return null;
	}
	return {
		schemaVersion: REVIEW_FRAME_SCHEMA_VERSION,
		type: "frame.ready",
		channelId: value.channelId,
		nonce: value.nonce,
		shipletId: value.shipletId,
		revisionId: value.revisionId,
	};
}

function parseRequest(
	value: unknown,
	limits: PayloadLimits,
):
	| { ok: true; request: ReviewFrameRpcRequest }
	| {
			ok: false;
			code:
				| "malformed_message"
				| "payload_too_deep"
				| "payload_limit_exceeded";
	  } {
	if (!isRecord(value) || !hasExactKeys(value, REQUEST_KEYS)) {
		return { ok: false, code: "malformed_message" };
	}
	if (
		value.schemaVersion !== REVIEW_FRAME_SCHEMA_VERSION ||
		value.type !== "rpc.request" ||
		!isBoundedString(value.channelId) ||
		!isBoundedString(value.requestId, 128) ||
		!Number.isSafeInteger(value.sequence) ||
		(value.sequence as number) <= 0 ||
		!isBoundedString(value.shipletId) ||
		!isBoundedString(value.revisionId) ||
		!isBoundedString(value.action) ||
		!isBoundedString(value.resource, 1_024)
	) {
		return { ok: false, code: "malformed_message" };
	}
	const payload = validatePayload(
		value.payload,
		limits,
		{ nodes: 0, ancestors: new Set<object>() },
	);
	if (!payload.ok) return payload;
	return {
		ok: true,
		request: {
			schemaVersion: REVIEW_FRAME_SCHEMA_VERSION,
			type: "rpc.request",
			channelId: value.channelId,
			requestId: value.requestId,
			sequence: value.sequence as number,
			shipletId: value.shipletId,
			revisionId: value.revisionId,
			action: value.action,
			resource: value.resource,
			payload: payload.value,
		},
	};
}

function parseResponseInput(
	value: unknown,
	limits: PayloadLimits,
): { requestId: string; result: ReviewFrameRpcResult } | null {
	if (!isRecord(value) || !hasExactKeys(value, RESPONSE_INPUT_KEYS)) return null;
	if (!isBoundedString(value.requestId, 128) || !isRecord(value.result)) {
		return null;
	}
	if (value.result.ok === true) {
		if (!hasExactKeys(value.result, SUCCESS_RESULT_KEYS)) return null;
		const payload = validatePayload(
			value.result.payload,
			limits,
			{ nodes: 0, ancestors: new Set<object>() },
		);
		if (!payload.ok) return null;
		return {
			requestId: value.requestId,
			result: { ok: true, payload: payload.value },
		};
	}
	if (
		value.result.ok !== false ||
		!hasExactKeys(value.result, ERROR_RESULT_KEYS) ||
		!isBoundedString(value.result.code, 64) ||
		!RESPONSE_ERROR_CODES.has(value.result.code) ||
		!isBoundedString(value.result.message, 512)
	) {
		return null;
	}
	return {
		requestId: value.requestId,
		result: {
			ok: false,
			code: value.result.code as Extract<
				ReviewFrameRpcResult,
				{ ok: false }
			>["code"],
			message: value.result.message,
		},
	};
}

function assertBinding(binding: ReviewFrameBinding): void {
	if (
		!isBoundedString(binding.channelId) ||
		!isBoundedString(binding.bootstrapNonce) ||
		!isBoundedString(binding.shipletId) ||
		!isBoundedString(binding.revisionId) ||
		!Number.isFinite(binding.expiresAt)
	) {
		throw new TypeError("Invalid review frame binding");
	}
}

export function createReviewFrameBootstrap(
	binding: ReviewFrameBinding,
): ReviewFrameBootstrap {
	assertBinding(binding);
	return {
		schemaVersion: REVIEW_FRAME_SCHEMA_VERSION,
		type: "host.bootstrap",
		channelId: binding.channelId,
		nonce: binding.bootstrapNonce,
		shipletId: binding.shipletId,
		revisionId: binding.revisionId,
		expiresAt: binding.expiresAt,
	};
}

export function createReviewFrameProtocol(
	options: ReviewFrameProtocolOptions,
): ReviewFrameProtocol {
	assertBinding(options);
	if (
		typeof options.sourceWindow !== "object" ||
		options.sourceWindow === null ||
		typeof options.port !== "object" ||
		options.port === null ||
		!isBoundedString(options.bootstrapOrigin, 2_048) ||
		typeof options.now !== "function" ||
		typeof options.limits !== "object" ||
		options.limits === null ||
		!isNonNegativeLimit(options.limits.maxMessageBytes) ||
		!isNonNegativeLimit(options.limits.maxPayloadDepth) ||
		!isNonNegativeLimit(options.limits.maxPayloadNodes) ||
		!isNonNegativeLimit(options.limits.maxPropertiesPerObject) ||
		!isNonNegativeLimit(
			options.limits.maxAttemptedRequestsPerChannel,
		) ||
		!isNonNegativeLimit(options.limits.maxAttemptedBytesPerChannel) ||
		(options.limits.maxRequestsPerChannel !== undefined &&
			!isNonNegativeLimit(options.limits.maxRequestsPerChannel))
	) {
		throw new TypeError("Invalid review frame protocol options");
	}

	const maximumRequests = options.limits.maxRequestsPerChannel ?? 1_024;
	const payloadLimits: PayloadLimits = {
		maximumDepth: options.limits.maxPayloadDepth,
		maximumNodes: options.limits.maxPayloadNodes,
		maximumPropertiesPerObject: options.limits.maxPropertiesPerObject,
	};
	const bootstrapEnvelopeLimits: PayloadLimits = {
		maximumDepth: Math.max(2, payloadLimits.maximumDepth),
		maximumNodes: Math.max(READY_KEYS.size + 1, payloadLimits.maximumNodes),
		maximumPropertiesPerObject: Math.max(
			READY_KEYS.size,
			payloadLimits.maximumPropertiesPerObject,
		),
	};
	const requestEnvelopeLimits: PayloadLimits = {
		maximumDepth: payloadLimits.maximumDepth + 1,
		maximumNodes: payloadLimits.maximumNodes + REQUEST_KEYS.size,
		maximumPropertiesPerObject: Math.max(
			REQUEST_KEYS.size,
			payloadLimits.maximumPropertiesPerObject,
		),
	};
	const responseEnvelopeLimits: PayloadLimits = {
		maximumDepth: payloadLimits.maximumDepth + 2,
		maximumNodes: payloadLimits.maximumNodes + 10,
		maximumPropertiesPerObject: Math.max(
			7,
			payloadLimits.maximumPropertiesPerObject,
		),
	};
	const seenRequestIds = new Set<string>();
	const pendingRequestIds = new Set<string>();
	const completedRequestIds = new Set<string>();
	let bootstrapAccepted = false;
	let lastSequence = 0;
	let attemptedRequests = 0;
	let attemptedBytes = 0;
	let channelClosed = false;
	const chargeAttempt = (
		charge: number,
		countAttempt: boolean,
	): { ok: true; byteLimitExceeded: boolean } | ReviewFrameProtocolRejection => {
		if (channelClosed) {
			return { ok: false, code: "channel_limit_exceeded" };
		}
		if (countAttempt) {
			attemptedRequests += 1;
			if (
				attemptedRequests > options.limits.maxAttemptedRequestsPerChannel
			) {
				channelClosed = true;
				return { ok: false, code: "channel_limit_exceeded" };
			}
		}
		if (charge > options.limits.maxAttemptedBytesPerChannel - attemptedBytes) {
			channelClosed = true;
			return { ok: true, byteLimitExceeded: true };
		}
		attemptedBytes += charge;
		return { ok: true, byteLimitExceeded: false };
	};
	const meterEnvelope = (
		data: unknown,
		limits: PayloadLimits,
		countAttempt: boolean,
	):
		| {
				ok: true;
				preflight: ReturnType<typeof preflightJsonBytes>;
				byteLimitExceeded: boolean;
		  }
		| ReviewFrameProtocolRejection => {
		const preflight = preflightJsonBytes(
			data,
			options.limits.maxMessageBytes,
			limits,
		);
		const charge =
			preflight.exceeded || preflight.deferred
				? options.limits.maxMessageBytes + 1
				: preflight.bytes;
		const charged = chargeAttempt(charge, countAttempt);
		return charged.ok
			? {
					ok: true,
					preflight,
					byteLimitExceeded: charged.byteLimitExceeded,
				}
			: charged;
	};
	const meterEncodedBytes = (
		byteLength: number,
		countAttempt: boolean,
	):
		| { ok: true; byteLimitExceeded: boolean; messageLimitExceeded: boolean }
		| ReviewFrameProtocolRejection => {
		const charged = chargeAttempt(byteLength, countAttempt);
		return charged.ok
			? {
					ok: true,
					byteLimitExceeded: charged.byteLimitExceeded,
					messageLimitExceeded:
						byteLength > options.limits.maxMessageBytes,
				}
			: charged;
	};
	const channelExpired = (): boolean => {
		let now: number;
		try {
			now = options.now();
		} catch {
			return true;
		}
		return !Number.isFinite(now) || now >= options.expiresAt;
	};
	const finishParsedRequest = (
		request: ReviewFrameRpcRequest,
	): ReviewFrameRequestResult => {
		if (request.channelId !== options.channelId) {
			return { ok: false, code: "channel_mismatch" };
		}
		if (
			request.shipletId !== options.shipletId ||
			request.revisionId !== options.revisionId
		) {
			return { ok: false, code: "scope_mismatch" };
		}
		if (
			request.sequence <= lastSequence ||
			seenRequestIds.has(request.requestId)
		) {
			return { ok: false, code: "replayed" };
		}
		if (seenRequestIds.size >= maximumRequests) {
			return { ok: false, code: "channel_limit_exceeded" };
		}

		lastSequence = request.sequence;
		seenRequestIds.add(request.requestId);
		pendingRequestIds.add(request.requestId);
		return { ok: true, request };
	};
	type PreparedResponse =
		| { ok: true; response: ReviewFrameRpcResponse; requestId: string }
		| { ok: false; code: ReviewFrameResponseRejectionCode };
	const prepareResponse = (input: ReviewFrameResponseInput): PreparedResponse => {
		if (!bootstrapAccepted) {
			return { ok: false, code: "channel_not_ready" };
		}
		if (channelExpired()) return { ok: false, code: "expired" };
		if (channelClosed) {
			return { ok: false, code: "channel_limit_exceeded" };
		}
		const parsed = parseResponseInput(input, payloadLimits);
		if (!parsed) return { ok: false, code: "malformed_message" };
		if (completedRequestIds.has(parsed.requestId)) {
			return { ok: false, code: "replayed" };
		}
		if (!pendingRequestIds.has(parsed.requestId)) {
			return { ok: false, code: "correlation_mismatch" };
		}
		const response: ReviewFrameRpcResponse = {
			schemaVersion: REVIEW_FRAME_SCHEMA_VERSION,
			type: "rpc.response",
			channelId: options.channelId,
			requestId: parsed.requestId,
			shipletId: options.shipletId,
			revisionId: options.revisionId,
			result: parsed.result,
		};
		const metered = meterEnvelope(response, responseEnvelopeLimits, false);
		if (!metered.ok) return metered;
		if (metered.byteLimitExceeded) {
			return { ok: false, code: "channel_limit_exceeded" };
		}
		if (metered.preflight.exceeded || metered.preflight.deferred) {
			return { ok: false, code: "message_too_large" };
		}
		return { ok: true, response, requestId: parsed.requestId };
	};
	const commitResponse = (requestId: string): void => {
		pendingRequestIds.delete(requestId);
		completedRequestIds.add(requestId);
	};

	return {
		acceptBootstrap(event): ReviewFrameBootstrapResult {
			if (event.sourceWindow !== options.sourceWindow) {
				return { ok: false, code: "source_mismatch" };
			}
			if (event.origin !== options.bootstrapOrigin) {
				return { ok: false, code: "origin_mismatch" };
			}
			const metered = meterEnvelope(
				event.data,
				bootstrapEnvelopeLimits,
				true,
			);
			if (!metered.ok) return metered;
			if (metered.byteLimitExceeded) {
				return { ok: false, code: "channel_limit_exceeded" };
			}
			if (metered.preflight.exceeded || metered.preflight.deferred) {
				return { ok: false, code: "message_too_large" };
			}
			if (bootstrapAccepted) return { ok: false, code: "replayed" };
			const ready = parseReady(event.data);
			if (!ready) return { ok: false, code: "malformed_message" };
			if (channelExpired()) {
				return { ok: false, code: "expired" };
			}
			if (ready.channelId !== options.channelId) {
				return { ok: false, code: "channel_mismatch" };
			}
			if (
				ready.nonce !== options.bootstrapNonce ||
				ready.shipletId !== options.shipletId ||
				ready.revisionId !== options.revisionId
			) {
				return { ok: false, code: "scope_mismatch" };
			}
			bootstrapAccepted = true;
			return { ok: true };
		},

		acceptRequest(event): ReviewFrameRequestResult {
			if (event.port !== options.port) {
				return { ok: false, code: "channel_mismatch" };
			}
			const metered = meterEnvelope(
				event.data,
				requestEnvelopeLimits,
				true,
			);
			if (!metered.ok) return metered;
			if (!bootstrapAccepted) {
				return { ok: false, code: "channel_not_ready" };
			}
			if (channelExpired()) {
				return { ok: false, code: "expired" };
			}
			const parsed = parseRequest(event.data, payloadLimits);
			if (!parsed.ok) return parsed;
			if (metered.byteLimitExceeded) {
				return { ok: false, code: "channel_limit_exceeded" };
			}
			if (metered.preflight.exceeded || metered.preflight.deferred) {
				return { ok: false, code: "message_too_large" };
			}
			return finishParsedRequest(parsed.request);
		},

		acceptEncodedRequest(event): ReviewFrameRequestResult {
			if (event.port !== options.port) {
				return { ok: false, code: "channel_mismatch" };
			}
			if (!(event.data instanceof Uint8Array)) {
				return { ok: false, code: "malformed_message" };
			}
			const metered = meterEncodedBytes(event.data.byteLength, true);
			if (!metered.ok) return metered;
			if (metered.byteLimitExceeded) {
				return { ok: false, code: "channel_limit_exceeded" };
			}
			if (metered.messageLimitExceeded) {
				return { ok: false, code: "message_too_large" };
			}
			if (!bootstrapAccepted) {
				return { ok: false, code: "channel_not_ready" };
			}
			if (channelExpired()) {
				return { ok: false, code: "expired" };
			}
			let decoded: unknown;
			try {
				const json = new TextDecoder("utf-8", { fatal: true }).decode(event.data);
				decoded = JSON.parse(json) as unknown;
			} catch {
				return { ok: false, code: "malformed_message" };
			}
			const parsed = parseRequest(decoded, payloadLimits);
			return parsed.ok ? finishParsedRequest(parsed.request) : parsed;
		},

		createResponse(input): ReviewFrameResponseResult {
			const prepared = prepareResponse(input);
			if (!prepared.ok) return prepared;
			commitResponse(prepared.requestId);
			return { ok: true, response: prepared.response };
		},

		createEncodedResponse(input): ReviewFrameEncodedResponseResult {
			const prepared = prepareResponse(input);
			if (!prepared.ok) return prepared;
			const bytes = new TextEncoder().encode(JSON.stringify(prepared.response));
			if (bytes.byteLength > options.limits.maxMessageBytes) {
				return { ok: false, code: "message_too_large" };
			}
			commitResponse(prepared.requestId);
			return { ok: true, bytes };
		},
	};
}

function isNonNegativeLimit(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}
