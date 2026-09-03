import { describe, expect, it, vi } from "vitest";
import {
	createReviewFrameBootstrap,
	createReviewFrameProtocol,
} from "../src/review-frame-protocol";
import {
	createReadyMessage as createHostileReadyMessage,
	createRequestMessage as createHostileRequestMessage,
} from "./fixtures/hostile-widget/messages.js";

const NOW = Date.parse("2026-08-05T12:00:00.000Z");

const binding = {
	channelId: "channel_widget_a",
	bootstrapNonce: "nonce_widget_a",
	shipletId: "shiplet_a",
	revisionId: "revision_a1",
	expiresAt: NOW + 60_000,
};

type BootstrapOverride = {
	source?: "other";
	origin?: string;
	data?: ReturnType<typeof ready>;
};

type RequestOverride = {
	port?: "other";
	data?: ReturnType<typeof rpcRequest>;
};

type ResponseFactory = {
	createResponse(input: {
		requestId: string;
		result:
			| { ok: true; payload: unknown }
			| { ok: false; code: string; message: string };
	}): unknown;
};

type EncodedTransport = {
	acceptEncodedRequest(event: { port: object; data: Uint8Array }): unknown;
	createEncodedResponse(input: {
		requestId: string;
		result:
			| { ok: true; payload: unknown }
			| { ok: false; code: string; message: string };
	}): unknown;
};

function ready(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: "shiplet.review-frame/v1",
		type: "frame.ready",
		channelId: binding.channelId,
		nonce: binding.bootstrapNonce,
		shipletId: binding.shipletId,
		revisionId: binding.revisionId,
		...overrides,
	};
}

function rpcRequest(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: "shiplet.review-frame/v1",
		type: "rpc.request",
		channelId: binding.channelId,
		requestId: "request_1",
		sequence: 1,
		shipletId: binding.shipletId,
		revisionId: binding.revisionId,
		action: "review.feedback.list",
		resource: "feedback:shiplet_a",
		payload: {},
		...overrides,
	};
}

function createHarness(options: {
	now?: number;
	maxMessageBytes?: number;
	maxPayloadDepth?: number;
	maxPayloadNodes?: number;
	maxPropertiesPerObject?: number;
	maxAttemptedRequestsPerChannel?: number;
	maxAttemptedBytesPerChannel?: number;
} = {}) {
	const sourceWindow = {};
	const otherWindow = {};
	const port = {};
	const otherPort = {};
	let currentTime = options.now ?? NOW;
	const limits = {
		maxMessageBytes: options.maxMessageBytes ?? 4_096,
		maxPayloadDepth: options.maxPayloadDepth ?? 6,
		maxPayloadNodes: options.maxPayloadNodes ?? 256,
		maxPropertiesPerObject: options.maxPropertiesPerObject ?? 64,
		maxAttemptedRequestsPerChannel:
			options.maxAttemptedRequestsPerChannel ?? 512,
		maxAttemptedBytesPerChannel:
			options.maxAttemptedBytesPerChannel ?? 1_000_000,
	};
	const protocol = createReviewFrameProtocol({
		...binding,
		sourceWindow,
		bootstrapOrigin: "null",
		port,
		now: () => currentTime,
		limits,
	});
	return {
		protocol,
		sourceWindow,
		otherWindow,
		port,
		otherPort,
		setNow: (now: number) => {
			currentTime = now;
		},
	};
}

function establish(protocol: ReturnType<typeof createReviewFrameProtocol>, sourceWindow: object) {
	const result = protocol.acceptBootstrap({
		sourceWindow,
		origin: "null",
		data: ready(),
	});
	expect(result).toEqual({ ok: true });
}

describe("review frame bootstrap", () => {
	it("serializes only public scope and a one-time bootstrap nonce, never ambient authority", () => {
		const bootstrap = createReviewFrameBootstrap(binding);

		expect(bootstrap).toEqual({
			schemaVersion: "shiplet.review-frame/v1",
			type: "host.bootstrap",
			channelId: binding.channelId,
			nonce: binding.bootstrapNonce,
			shipletId: binding.shipletId,
			revisionId: binding.revisionId,
			expiresAt: binding.expiresAt,
		});
		const serialized = JSON.stringify(bootstrap).toLowerCase();
		for (const forbidden of [
			"token",
			"authorization",
			"cookie",
			"oauth",
			"claimurl",
			"credential",
			"actor",
			"approvalid",
			"capability",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	it.each<readonly [string, BootstrapOverride]>([
		["wrong source window", { source: "other" }],
		["wrong opaque origin", { origin: "https://shiplet.cc" }],
		["wrong schema version", { data: ready({ schemaVersion: "shiplet.review-frame/v2" }) }],
		["wrong channel", { data: ready({ channelId: "channel_other" }) }],
		["wrong nonce", { data: ready({ nonce: "nonce_other" }) }],
		["wrong Shiplet", { data: ready({ shipletId: "shiplet_b" }) }],
		["wrong revision", { data: ready({ revisionId: "revision_b1" }) }],
		["unknown authority field", { data: ready({ capability: "forged" }) }],
	])("rejects a bootstrap with the %s", (_label, override) => {
		const { protocol, sourceWindow, otherWindow } = createHarness();
		const result = protocol.acceptBootstrap({
			sourceWindow: override.source === "other" ? otherWindow : sourceWindow,
			origin: override.origin ?? "null",
			data: override.data ?? ready(),
		});

		expect(result.ok).toBe(false);
	});

	it("consumes the bootstrap nonce exactly once", () => {
		const { protocol, sourceWindow } = createHarness();
		const event = { sourceWindow, origin: "null", data: ready() };

		expect(protocol.acceptBootstrap(event)).toEqual({ ok: true });
		expect(protocol.acceptBootstrap(event)).toEqual({
			ok: false,
			code: "replayed",
		});
	});
});

describe("review frame RPC", () => {
	it("executes the hostile widget message contract against the isolated channel boundary", () => {
		const { protocol, sourceWindow, port } = createHarness();
		const hostileScope = {
			channelId: binding.channelId,
			nonce: binding.bootstrapNonce,
			shipletId: binding.shipletId,
			revisionId: binding.revisionId,
		};

		expect(
			protocol.acceptBootstrap({
				sourceWindow,
				origin: "null",
				data: createHostileReadyMessage(hostileScope),
			}),
		).toEqual({ ok: true });

		const forgedHumanPayload = createHostileRequestMessage(
			hostileScope,
			"hostile_human_1",
			1,
			"review.feedback.create",
			"feedback:shiplet_a",
			{
				body: "Attempted unapproved attribution",
				actor: { kind: "human", id: "organization_owner" },
				approvalId: "invented_by_widget",
			},
		);
		expect(protocol.acceptRequest({ port, data: forgedHumanPayload }).ok).toBe(
			true,
		);

		const siblingScopeRequest = createHostileRequestMessage(
			{ ...hostileScope, shipletId: "guessed_sibling" },
			"hostile_sibling_2",
			2,
			"state.read",
			"state:guessed_sibling/private",
			{},
		);
		expect(protocol.acceptRequest({ port, data: siblingScopeRequest }).ok).toBe(
			false,
		);

		const topLevelAuthoritySmuggling = {
			...createHostileRequestMessage(
				hostileScope,
				"hostile_smuggle_3",
				3,
				"review.feedback.create",
				"feedback:shiplet_a",
				{},
			),
			actor: { kind: "human", id: "organization_owner" },
			approvalId: "invented_by_widget",
		};
		expect(
			protocol.acceptRequest({ port, data: topLevelAuthoritySmuggling }).ok,
		).toBe(false);
	});

	it("accepts a strict typed request only on the bound port and scope", () => {
		const { protocol, sourceWindow, port } = createHarness();
		establish(protocol, sourceWindow);

		const result = protocol.acceptRequest({ port, data: rpcRequest() });

		expect(result).toEqual({ ok: true, request: rpcRequest() });
	});

	it("rejects requests before the trusted bootstrap completes", () => {
		const { protocol, port } = createHarness();

		expect(protocol.acceptRequest({ port, data: rpcRequest() })).toEqual({
			ok: false,
			code: "channel_not_ready",
		});
	});

	it("meters correct-port requests before readiness and permanently closes the channel", () => {
		const { protocol, sourceWindow, port } = createHarness({
			maxAttemptedRequestsPerChannel: 2,
		});

		expect(protocol.acceptRequest({ port, data: rpcRequest() })).toEqual({
			ok: false,
			code: "channel_not_ready",
		});
		expect(
			protocol.acceptRequest({
				port,
				data: rpcRequest({ requestId: "request_2", sequence: 2 }),
			}),
		).toEqual({ ok: false, code: "channel_not_ready" });
		expect(
			protocol.acceptBootstrap({ sourceWindow, origin: "null", data: ready() }),
		).toEqual({ ok: false, code: "channel_limit_exceeded" });
	});

	it.each<readonly [string, RequestOverride]>([
		["wrong port", { port: "other" }],
		["wrong channel", { data: rpcRequest({ channelId: "channel_other" }) }],
		["wrong Shiplet", { data: rpcRequest({ shipletId: "shiplet_b" }) }],
		["wrong revision", { data: rpcRequest({ revisionId: "revision_b1" }) }],
	])("rejects a request with the %s", (_label, override) => {
		const { protocol, sourceWindow, port, otherPort } = createHarness();
		establish(protocol, sourceWindow);

		const result = protocol.acceptRequest({
			port: override.port === "other" ? otherPort : port,
			data: override.data ?? rpcRequest(),
		});

		expect(result.ok).toBe(false);
	});

	it("rejects non-monotonic sequences and duplicate request IDs", () => {
		const { protocol, sourceWindow, port } = createHarness();
		establish(protocol, sourceWindow);

		expect(protocol.acceptRequest({ port, data: rpcRequest() }).ok).toBe(true);
		expect(
			protocol.acceptRequest({
				port,
				data: rpcRequest({ requestId: "request_2", sequence: 1 }),
			}),
		).toEqual({ ok: false, code: "replayed" });
		expect(
			protocol.acceptRequest({
				port,
				data: rpcRequest({ requestId: "request_1", sequence: 2 }),
			}),
		).toEqual({ ok: false, code: "replayed" });
	});

	it("rejects an expired channel assertion", () => {
		const { protocol, sourceWindow, port, setNow } = createHarness();
		establish(protocol, sourceWindow);
		setNow(binding.expiresAt);

		expect(protocol.acceptRequest({ port, data: rpcRequest() })).toEqual({
			ok: false,
			code: "expired",
		});
	});

	it.each([
		["null", null],
		["array", []],
		["unknown type", rpcRequest({ type: "rpc.result" })],
		["blank request ID", rpcRequest({ requestId: "" })],
		["fractional sequence", rpcRequest({ sequence: 1.5 })],
		["unknown field", rpcRequest({ unexpected: true })],
		["child-supplied actor", rpcRequest({ actor: { kind: "human", id: "user_a" } })],
		["child-supplied approval", rpcRequest({ approvalId: "forged" })],
		["child-supplied capability", rpcRequest({ capability: "forged" })],
		["negative zero payload", rpcRequest({ payload: { value: -0 } })],
	])("rejects malformed input: %s", (_label, data) => {
		const { protocol, sourceWindow, port } = createHarness();
		establish(protocol, sourceWindow);

		expect(protocol.acceptRequest({ port, data }).ok).toBe(false);
	});

	it("rejects oversized messages before dispatch", () => {
		const { protocol, sourceWindow, port } = createHarness({
			maxMessageBytes: 320,
		});
		establish(protocol, sourceWindow);

		const result = protocol.acceptRequest({
			port,
			data: rpcRequest({ payload: { body: "x".repeat(1_024) } }),
		});

		expect(result).toEqual({ ok: false, code: "message_too_large" });
	});

	it("rejects payloads deeper than the declared protocol limit", () => {
		const { protocol, sourceWindow, port } = createHarness({
			maxPayloadDepth: 3,
		});
		establish(protocol, sourceWindow);

		const result = protocol.acceptRequest({
			port,
			data: rpcRequest({
				payload: { one: { two: { three: { four: true } } } },
			}),
		});

		expect(result).toEqual({ ok: false, code: "payload_too_deep" });
	});

	it("rejects a payload that exceeds the total node budget", () => {
		const { protocol, sourceWindow, port } = createHarness({
			maxMessageBytes: 1_000_000,
			maxPayloadNodes: 8,
		});
		establish(protocol, sourceWindow);

		const result = protocol.acceptRequest({
			port,
			data: rpcRequest({ payload: Array.from({ length: 64 }, (_, index) => index) }),
		});

		expect(result).toEqual({
			ok: false,
			code: "payload_limit_exceeded",
		});
	});

	it("rejects an over-wide object before reading or copying every property", () => {
		let propertyReads = 0;
		const wideTarget = Object.fromEntries(
			Array.from({ length: 128 }, (_, index) => [`field_${index}`, index]),
		);
		const widePayload = new Proxy(wideTarget, {
			get(target, property, receiver) {
				if (typeof property === "string" && property.startsWith("field_")) {
					propertyReads += 1;
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const { protocol, sourceWindow, port } = createHarness({
			maxMessageBytes: 1_000_000,
			maxPayloadNodes: 1_000,
			maxPropertiesPerObject: 8,
		});
		establish(protocol, sourceWindow);

		const result = protocol.acceptRequest({
			port,
			data: rpcRequest({ payload: widePayload }),
		});

		expect(result).toEqual({
			ok: false,
			code: "payload_limit_exceeded",
		});
		expect(propertyReads).toBeLessThan(128);
	});

	it("rejects one oversized string without encoding a full duplicate of it", () => {
		const NativeTextEncoder = TextEncoder;
		const encodedLengths: number[] = [];
		const oversized = "x".repeat(128_000);
		vi.stubGlobal(
			"TextEncoder",
			class {
				encode(value = "") {
					encodedLengths.push(value.length);
					return new NativeTextEncoder().encode(value);
				}
			},
		);
		try {
			const { protocol, sourceWindow, port } = createHarness({
				maxMessageBytes: 512,
			});
			establish(protocol, sourceWindow);

			const result = protocol.acceptRequest({
				port,
				data: rpcRequest({ payload: { body: oversized } }),
			});

			expect(result).toEqual({ ok: false, code: "message_too_large" });
			expect(Math.max(...encodedLengths)).toBeLessThan(oversized.length);
		} finally {
			vi.stubGlobal("TextEncoder", NativeTextEncoder);
		}
	});

	it("fails closed when envelope preflight defers before an oversized request leaf", () => {
		const { protocol, sourceWindow, port } = createHarness({
			maxMessageBytes: 512,
			maxPayloadNodes: 4,
		});
		establish(protocol, sourceWindow);

		const result = protocol.acceptRequest({
			port,
			data: rpcRequest({
				payload: { nested: { body: "x".repeat(64_000) } },
			}),
		});

		expect(result).toEqual({ ok: false, code: "message_too_large" });
	});

	it("fails closed when envelope preflight defers before an oversized response leaf", () => {
		const { protocol, sourceWindow, port } = createHarness({
			maxMessageBytes: 512,
			maxPayloadNodes: 4,
		});
		establish(protocol, sourceWindow);
		expect(protocol.acceptRequest({ port, data: rpcRequest() }).ok).toBe(true);
		const responder = protocol as typeof protocol & Partial<ResponseFactory>;
		expect(responder.createResponse).toBeTypeOf("function");
		if (!responder.createResponse) return;

		const result = responder.createResponse({
			requestId: "request_1",
			result: {
				ok: true,
				payload: { nested: { body: "x".repeat(64_000) } },
			},
		});

		expect(result).toEqual({ ok: false, code: "message_too_large" });
	});

	it("charges a conservative byte count for deferred oversized requests and closes permanently", () => {
		const { protocol, sourceWindow, port } = createHarness({
			maxMessageBytes: 512,
			maxPayloadNodes: 4,
			maxAttemptedRequestsPerChannel: 10,
			maxAttemptedBytesPerChannel: 900,
		});
		establish(protocol, sourceWindow);
		const oversized = (requestId: string) =>
			rpcRequest({
				requestId,
				payload: { nested: { body: "x".repeat(64_000) } },
			});

		expect(
			protocol.acceptRequest({ port, data: oversized("oversized_1") }),
		).toEqual({ ok: false, code: "message_too_large" });
		expect(
			protocol.acceptRequest({ port, data: oversized("oversized_2") }),
		).toEqual({ ok: false, code: "channel_limit_exceeded" });
		expect(protocol.acceptRequest({ port, data: rpcRequest() })).toEqual({
			ok: false,
			code: "channel_limit_exceeded",
		});
	});

	it("closes a channel after cumulative malformed request attempts", () => {
		const { protocol, sourceWindow, port } = createHarness({
			maxAttemptedRequestsPerChannel: 2,
		});
		establish(protocol, sourceWindow);

		expect(protocol.acceptRequest({ port, data: null }).ok).toBe(false);
		expect(protocol.acceptRequest({ port, data: { unexpected: true } }).ok).toBe(
			false,
		);
		expect(protocol.acceptRequest({ port, data: rpcRequest() })).toEqual({
			ok: false,
			code: "channel_limit_exceeded",
		});
	});

	it("closes a channel after the cumulative attempted-byte budget is exhausted", () => {
		const malformed = rpcRequest({
			unexpected: true,
			payload: { body: "x".repeat(160) },
		});
		const malformedBytes = new TextEncoder().encode(
			JSON.stringify(malformed),
		).byteLength;
		const { protocol, sourceWindow, port } = createHarness({
			maxMessageBytes: 1_000_000,
			maxAttemptedBytesPerChannel: malformedBytes * 2 + 1,
		});
		establish(protocol, sourceWindow);

		expect(protocol.acceptRequest({ port, data: malformed }).ok).toBe(false);
		expect(protocol.acceptRequest({ port, data: malformed }).ok).toBe(false);
		expect(protocol.acceptRequest({ port, data: rpcRequest() })).toEqual({
			ok: false,
			code: "channel_limit_exceeded",
		});
	});

	it("counts malformed bootstrap attempts and permanently closes before a later valid bootstrap", () => {
		const { protocol, sourceWindow } = createHarness({
			maxAttemptedRequestsPerChannel: 2,
		});

		expect(
			protocol.acceptBootstrap({ sourceWindow, origin: "null", data: null }).ok,
		).toBe(false);
		expect(
			protocol.acceptBootstrap({
				sourceWindow,
				origin: "null",
				data: { unexpected: true },
			}).ok,
		).toBe(false);
		expect(
			protocol.acceptBootstrap({ sourceWindow, origin: "null", data: ready() }),
		).toEqual({ ok: false, code: "channel_limit_exceeded" });
	});

	it("meters bootstrap replays and permanently closes the established channel", () => {
		const { protocol, sourceWindow, port } = createHarness({
			maxAttemptedRequestsPerChannel: 3,
		});
		const bootstrap = { sourceWindow, origin: "null", data: ready() };

		expect(protocol.acceptBootstrap(bootstrap)).toEqual({ ok: true });
		expect(protocol.acceptBootstrap(bootstrap)).toEqual({
			ok: false,
			code: "replayed",
		});
		expect(protocol.acceptBootstrap(bootstrap)).toEqual({
			ok: false,
			code: "replayed",
		});
		expect(protocol.acceptRequest({ port, data: rpcRequest() })).toEqual({
			ok: false,
			code: "channel_limit_exceeded",
		});
	});

	it("meters expired requests and keeps expiry terminal", () => {
		const { protocol, sourceWindow, port, setNow } = createHarness({
			maxAttemptedRequestsPerChannel: 3,
		});
		establish(protocol, sourceWindow);
		setNow(binding.expiresAt);

		expect(protocol.acceptRequest({ port, data: rpcRequest() })).toEqual({
			ok: false,
			code: "expired",
		});
		expect(
			protocol.acceptRequest({
				port,
				data: rpcRequest({ requestId: "request_2", sequence: 2 }),
			}),
		).toEqual({ ok: false, code: "expired" });
		expect(
			protocol.acceptRequest({
				port,
				data: rpcRequest({ requestId: "request_3", sequence: 3 }),
			}),
		).toEqual({ ok: false, code: "channel_limit_exceeded" });
	});

	it("charges malformed bootstrap bytes and permanently closes before a later valid bootstrap", () => {
		const malformed = ready({
			unexpected: true,
			padding: "x".repeat(300),
		});
		const malformedBytes = new TextEncoder().encode(
			JSON.stringify(malformed),
		).byteLength;
		const { protocol, sourceWindow } = createHarness({
			maxMessageBytes: 1_000_000,
			maxAttemptedRequestsPerChannel: 10,
			maxAttemptedBytesPerChannel: malformedBytes * 2 - 1,
		});

		expect(
			protocol.acceptBootstrap({
				sourceWindow,
				origin: "null",
				data: malformed,
			}).ok,
		).toBe(false);
		expect(
			protocol.acceptBootstrap({
				sourceWindow,
				origin: "null",
				data: malformed,
			}).ok,
		).toBe(false);
		expect(
			protocol.acceptBootstrap({ sourceWindow, origin: "null", data: ready() }),
		).toEqual({ ok: false, code: "channel_limit_exceeded" });
	});

	it("creates typed success and error envelopes only for pending correlated requests", () => {
		const { protocol, sourceWindow, port } = createHarness();
		establish(protocol, sourceWindow);
		expect(protocol.acceptRequest({ port, data: rpcRequest() }).ok).toBe(true);
		expect(
			protocol.acceptRequest({
				port,
				data: rpcRequest({ requestId: "request_2", sequence: 2 }),
			}).ok,
		).toBe(true);

		const responder = protocol as typeof protocol & Partial<ResponseFactory>;
		expect(responder.createResponse).toBeTypeOf("function");
		if (!responder.createResponse) return;

		expect(
			responder.createResponse({
				requestId: "unknown_request",
				result: { ok: true, payload: {} },
			}),
		).toEqual({ ok: false, code: "correlation_mismatch" });
		expect(
			responder.createResponse({
				requestId: "request_1",
				result: { ok: true, payload: { items: [] } },
			}),
		).toEqual({
			ok: true,
			response: {
				schemaVersion: "shiplet.review-frame/v1",
				type: "rpc.response",
				channelId: binding.channelId,
				requestId: "request_1",
				shipletId: binding.shipletId,
				revisionId: binding.revisionId,
				result: { ok: true, payload: { items: [] } },
			},
		});
		expect(
			responder.createResponse({
				requestId: "request_2",
				result: {
					ok: false,
					code: "permission_denied",
					message: "Trusted approval is required.",
				},
			}),
		).toEqual(
			expect.objectContaining({
				ok: true,
				response: expect.objectContaining({
					type: "rpc.response",
					requestId: "request_2",
					result: {
						ok: false,
						code: "permission_denied",
						message: "Trusted approval is required.",
					},
				}),
			}),
		);
		expect(
			responder.createResponse({
				requestId: "request_1",
				result: { ok: true, payload: {} },
			}),
		).toEqual({ ok: false, code: "replayed" });
	});

	it("offers a pre-sized byte transport that rejects oversized messages before JSON object allocation", () => {
		const { protocol, sourceWindow, port } = createHarness({
			maxMessageBytes: 512,
		});
		establish(protocol, sourceWindow);
		const transport = protocol as typeof protocol & Partial<EncodedTransport>;
		expect(transport.acceptEncodedRequest).toBeTypeOf("function");
		expect(transport.createEncodedResponse).toBeTypeOf("function");
		if (!transport.acceptEncodedRequest || !transport.createEncodedResponse) return;

		expect(
			transport.acceptEncodedRequest({ port, data: new Uint8Array(513) }),
		).toEqual({ ok: false, code: "message_too_large" });
		const encoded = new TextEncoder().encode(JSON.stringify(rpcRequest()));
		expect(transport.acceptEncodedRequest({ port, data: encoded })).toEqual({
			ok: true,
			request: rpcRequest(),
		});
		const response = transport.createEncodedResponse({
			requestId: "request_1",
			result: { ok: true, payload: { items: [] } },
		});
		expect(response).toMatchObject({ ok: true, bytes: expect.any(Uint8Array) });
	});
});
