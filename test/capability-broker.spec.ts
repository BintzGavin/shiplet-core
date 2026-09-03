import { describe, expect, it, vi } from "vitest";
import { createCapabilityBroker } from "../src/capability-broker";

type Actor = {
	kind: "human" | "agent" | "shiplet" | "system";
	id: string;
};

type TestGrant = {
	id: string;
	generation: number;
	actor: Actor;
	shipletId: string;
	revisionId: string;
	action: string;
	resource: string;
	effect: "read" | "mutation";
	approval: "none" | "trusted-human";
	expiresAt: number;
	revokedAt: number | null;
};

type AuthorizedInvocation = {
	actor: Actor;
	shipletId: string;
	revisionId: string;
	action: string;
	resource: string;
	requestId: string;
	input: unknown;
};

type AuditEvent = {
	outcome: "allowed" | "denied" | "failed";
	phase?: "intent" | "completion";
	correlationId?: string;
	effect?: "read" | "mutation";
	inputDigest?: string;
	grantGeneration?: number;
	approvalPolicy?: "trusted-human";
	approvalId?: string;
	reason?: string;
	grantId?: string;
	requestId: string;
	actor: Actor;
	shipletId: string;
	revisionId: string;
	action: string;
	resource: string;
};

const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const OPAQUE_HANDLE = "opaque_server_handle_a";
const BASE_INPUT_DIGEST =
	"sha256:d55e82d97536c2d600a019c154ebd4fdd28a8f7e3b925f5af28a3b9a7d433609";
const CANONICAL_NESTED_INPUT_DIGEST =
	"sha256:820ed44763c429685b2c3dc6798da3a2f691345e12c6c0cb4000dfa146843bad";

const actorA: Actor = { kind: "human", id: "user_a" };

type InvocationOverride = {
	trustedActor?: Actor;
	request?: ReturnType<typeof baseRequest>;
};

function baseGrant(overrides: Partial<TestGrant> = {}): TestGrant {
	return {
		id: "grant_a",
		generation: 1,
		actor: actorA,
		shipletId: "shiplet_a",
		revisionId: "revision_a1",
		action: "review.feedback.create",
		resource: "feedback:thread_a",
		effect: "mutation",
		approval: "trusted-human",
		expiresAt: NOW + 60_000,
		revokedAt: null,
		...overrides,
	};
}

function baseRequest(overrides: Record<string, unknown> = {}) {
	return {
		requestId: "request_a1",
		shipletId: "shiplet_a",
		revisionId: "revision_a1",
		action: "review.feedback.create",
		resource: "feedback:thread_a",
		input: { body: "Looks ready" },
		...overrides,
	};
}

function createHarness(options: {
	grant?: TestGrant | null;
	now?: number;
	validApprovals?: Map<string, Record<string, unknown>>;
	onVerifyApproval?: (expectedBinding: Record<string, unknown>) => void | Promise<void>;
	advanceClockDuringApprovalTo?: number;
	failAuditIntent?: boolean;
	validateActionPayload?: (invocation: AuthorizedInvocation) => boolean | Promise<boolean>;
	onAuditIntent?: (event: AuditEvent) => void | Promise<void>;
	requireExpandedAtomicBinding?: boolean;
	atomicFailureReason?: string;
	brokerLimits?: {
		maxInputBytes: number;
		maxMetadataFieldBytes: number;
	};
} = {}) {
	let currentTime = options.now ?? NOW;
	const grants = new Map<string, TestGrant>();
	if (options.grant !== null) {
		grants.set(OPAQUE_HANDLE, options.grant ?? baseGrant());
	}
	const claimedMutations = new Set<string>();
	const audits: AuditEvent[] = [];
	const resolvedHandles: string[] = [];
	const auditOrder: string[] = [];
	const approvalBindings: Record<string, unknown>[] = [];
	const atomicFinalizations: Record<string, unknown>[] = [];
	const approvalRecords =
		options.validApprovals ??
		new Map<string, Record<string, unknown>>([
			[
				"approval_from_trusted_shell",
				{
					requestId: "request_a1",
					actor: actorA,
					grantId: "grant_a",
					grantGeneration: 1,
					shipletId: "shiplet_a",
					revisionId: "revision_a1",
					action: "review.feedback.create",
					resource: "feedback:thread_a",
					effect: "mutation",
					approvalPolicy: "trusted-human",
					inputDigest: BASE_INPUT_DIGEST,
				},
			],
		]);

	const claimMutationOnce = async (grantId: string, requestId: string) => {
		const key = `${grantId}:${requestId}`;
		if (claimedMutations.has(key)) return false;
		claimedMutations.add(key);
		return true;
	};
	const grantStore = {
		resolveOpaqueHandle: async (handle: string) => {
			resolvedHandles.push(handle);
			return grants.get(handle) ?? null;
		},
		claimMutationOnce,
		revalidateAndClaim: async (attempt: Record<string, unknown>) => {
			atomicFinalizations.push(attempt);
			const handle = attempt.opaqueHandle;
			const current =
				typeof handle === "string" ? grants.get(handle) ?? null : null;
			if (!current) return { ok: false, reason: "capability_not_found" };
			if (current.revokedAt !== null) return { ok: false, reason: "revoked" };
			if (!Number.isFinite(currentTime) || currentTime >= current.expiresAt) {
				return { ok: false, reason: "expired" };
			}
			if (
				attempt.grantId !== current.id ||
				JSON.stringify(attempt.actor) !== JSON.stringify(current.actor) ||
				attempt.shipletId !== current.shipletId ||
				attempt.revisionId !== current.revisionId ||
				attempt.action !== current.action ||
				attempt.resource !== current.resource ||
				attempt.effect !== current.effect
			) {
				return { ok: false, reason: "scope_mismatch" };
			}
			if (
				options.requireExpandedAtomicBinding &&
				(attempt.grantGeneration !== current.generation ||
					attempt.approvalPolicy !== "trusted-human" ||
					typeof attempt.approvalId !== "string" ||
					typeof attempt.inputDigest !== "string")
			) {
				return { ok: false, reason: "scope_mismatch" };
			}
			if (options.atomicFailureReason !== undefined) {
				return { ok: false, reason: options.atomicFailureReason };
			}
			if (current.effect === "mutation") {
				const claimed = await claimMutationOnce(
					current.id,
					String(attempt.requestId),
				);
				if (!claimed) return { ok: false, reason: "replayed" };
			}
			return { ok: true };
		},
	};
	const brokerOptions = {
		now: () => currentTime,
		limits: options.brokerLimits ?? {
			maxInputBytes: 64_000,
			maxMetadataFieldBytes: 1_024,
		},
		grants: grantStore,
		validateActionPayload:
			options.validateActionPayload ?? (async () => true),
		approvals: {
			verifyTrustedApproval: async (
				approvalId: string,
				expectedBinding: Record<string, unknown>,
			) => {
				approvalBindings.push(expectedBinding);
				if (options.advanceClockDuringApprovalTo !== undefined) {
					currentTime = options.advanceClockDuringApprovalTo;
				}
				await options.onVerifyApproval?.(expectedBinding);
				const actual = approvalRecords.get(approvalId);
				if (actual === undefined) return false;
				for (const key of [
					"requestId",
					"actor",
					"shipletId",
					"revisionId",
					"action",
					"resource",
				]) {
					if (JSON.stringify(expectedBinding[key]) !== JSON.stringify(actual[key])) {
						return false;
					}
				}
				for (const key of [
					"grantId",
					"grantGeneration",
					"effect",
					"approvalPolicy",
					"inputDigest",
				]) {
					if (
						key in expectedBinding &&
						JSON.stringify(expectedBinding[key]) !== JSON.stringify(actual[key])
					) {
						return false;
					}
				}
				return true;
			},
		},
		audit: async (event: AuditEvent) => {
			if (options.failAuditIntent && event.phase === "intent") {
				throw new Error("durable audit intent unavailable");
			}
			audits.push(event);
			auditOrder.push(
				event.phase ? `audit:${event.phase}:${event.outcome}` : `audit:${event.outcome}`,
			);
			if (event.phase === "intent") await options.onAuditIntent?.(event);
		},
	};

	const broker = createCapabilityBroker(brokerOptions);

	return {
		broker,
		grants,
		claimedMutations,
		audits,
		resolvedHandles,
		auditOrder,
		approvalBindings,
		atomicFinalizations,
		setNow: (now: number) => {
			currentTime = now;
		},
	};
}

describe("server-side capability broker", () => {
	it("resolves an opaque handle only inside the trusted broker and does not serialize authority", async () => {
		const { broker, audits } = createHarness();

		expect(JSON.stringify(broker)).not.toContain(OPAQUE_HANDLE);
		expect(JSON.stringify(baseRequest())).not.toContain(OPAQUE_HANDLE);
		expect(baseRequest()).not.toHaveProperty("capability");
		expect(baseRequest()).not.toHaveProperty("actor");
		expect(baseRequest()).not.toHaveProperty("approvalId");

		const execute = vi.fn(async () => "created");
		const result = await broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				trustedApprovalId: "approval_from_trusted_shell",
				request: baseRequest(),
			},
			execute,
		);

		expect(result).toEqual({ ok: true, value: "created" });
		expect(execute).toHaveBeenCalledOnce();
		expect(audits).toContainEqual(
			expect.objectContaining({
				outcome: "allowed",
				grantId: "grant_a",
				requestId: "request_a1",
			}),
		);
	});

	it.each<readonly [string, InvocationOverride]>([
		["actor", { trustedActor: { kind: "human", id: "user_b" } }],
		["actor kind", { trustedActor: { kind: "agent", id: "user_a" } }],
		["Shiplet", { request: baseRequest({ shipletId: "shiplet_b" }) }],
		["revision", { request: baseRequest({ revisionId: "revision_b1" }) }],
		["action", { request: baseRequest({ action: "review.feedback.delete" }) }],
		["resource", { request: baseRequest({ resource: "feedback:thread_b" }) }],
	])("denies an exact %s binding mismatch without invoking the effect", async (_label, override) => {
		const { broker } = createHarness();
		const execute = vi.fn();
		const invocation = {
			opaqueHandle: OPAQUE_HANDLE,
			trustedActor: actorA,
			trustedApprovalId: "approval_from_trusted_shell",
			request: baseRequest(),
			...override,
		};

		const result = await broker.invoke(invocation, execute);

		expect(result).toEqual({ ok: false, code: "capability_denied" });
		expect(execute).not.toHaveBeenCalled();
	});

	it("denies guessed handles and sibling scope without falling back to ambient actor authority", async () => {
		const { broker } = createHarness();
		const execute = vi.fn();

		const guessedHandle = await broker.invoke(
			{
				opaqueHandle: "guessed_sibling_handle",
				trustedActor: actorA,
				trustedApprovalId: "approval_from_trusted_shell",
				request: baseRequest(),
			},
			execute,
		);
		const guessedSiblingResults = await Promise.all(
			[
				"state:shiplet_b/private",
				"route:/api/shiplets/shiplet_b",
				"rpc:shiplet_b",
				"deployment:shiplet-b-worker",
			].map((resource, index) =>
				broker.invoke(
					{
						opaqueHandle: OPAQUE_HANDLE,
						trustedActor: actorA,
						trustedApprovalId: "approval_from_trusted_shell",
						request: baseRequest({
							requestId: `sibling_guess_${index}`,
							shipletId: "shiplet_b",
							revisionId: "revision_b1",
							resource,
						}),
					},
					execute,
				),
			),
		);

		expect(guessedHandle).toEqual({ ok: false, code: "capability_denied" });
		expect(guessedSiblingResults).toEqual(
			Array.from({ length: 4 }, () => ({
				ok: false,
				code: "capability_denied",
			})),
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it.each([
		["expired", baseGrant({ expiresAt: NOW }), NOW],
		["revoked", baseGrant({ revokedAt: NOW - 1 }), NOW],
	] as const)("fails closed for a %s capability and records a sanitized denial", async (reason, grant, now) => {
		const { broker, audits } = createHarness({ grant, now });
		const execute = vi.fn();

		const result = await broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				trustedApprovalId: "approval_from_trusted_shell",
				request: baseRequest({ input: { body: "private payload marker" } }),
			},
			execute,
		);

		expect(result).toEqual({ ok: false, code: "capability_denied" });
		expect(execute).not.toHaveBeenCalled();
		expect(audits).toContainEqual(
			expect.objectContaining({ outcome: "denied", reason, grantId: "grant_a" }),
		);
		expect(JSON.stringify(audits)).not.toContain(OPAQUE_HANDLE);
		expect(JSON.stringify(audits)).not.toContain("private payload marker");
	});

	it("requires a separately verified trusted-shell approval for a human-attributed mutation", async () => {
		const { broker } = createHarness();
		const execute = vi.fn(async (invocation: AuthorizedInvocation) => invocation.actor);
		const hostileActor = { kind: "human", id: "organization_owner" };

		const withoutApproval = await broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				request: baseRequest({ actor: hostileActor }),
			},
			execute,
		);
		const forgedApproval = await broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				trustedApprovalId: "approval_invented_by_widget",
				request: baseRequest({ requestId: "request_a2", actor: hostileActor }),
			},
			execute,
		);
		const approved = await broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				trustedApprovalId: "approval_from_trusted_shell",
				request: baseRequest({ actor: hostileActor }),
			},
			execute,
		);

		expect(withoutApproval).toEqual({ ok: false, code: "approval_required" });
		expect(forgedApproval).toEqual({ ok: false, code: "approval_required" });
		expect(approved).toEqual({ ok: true, value: actorA });
		expect(execute).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledWith(
			expect.objectContaining({ actor: actorA }),
		);
	});

	it("requires trusted-host approval for every human mutation even when a stored grant says none", async () => {
		const unapprovedHarness = createHarness({
			grant: baseGrant({ approval: "none" }),
		});
		const unapprovedEffect = vi.fn(async () => "created");

		const unapproved = await unapprovedHarness.broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				request: baseRequest(),
			},
			unapprovedEffect,
		);

		expect(unapproved).toEqual({ ok: false, code: "approval_required" });
		expect(unapprovedEffect).not.toHaveBeenCalled();

		const approvedHarness = createHarness({
			grant: baseGrant({ approval: "none" }),
		});
		const approvedEffect = vi.fn(async () => "created");
		const approved = await approvedHarness.broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				trustedApprovalId: "approval_from_trusted_shell",
				request: baseRequest(),
			},
			approvedEffect,
		);

		expect(approved).toEqual({ ok: true, value: "created" });
		expect(approvedHarness.approvalBindings).toHaveLength(1);
		expect(approvedEffect).toHaveBeenCalledOnce();
	});

	it("binds approval to the grant, effect, and canonical digest of the exact input", async () => {
		const approvalRecords = new Map<string, Record<string, unknown>>([
			[
				"approval_for_canonical_input",
				{
					requestId: "request_digest",
					actor: actorA,
					grantId: "grant_a",
					grantGeneration: 1,
					shipletId: "shiplet_a",
					revisionId: "revision_a1",
					action: "review.feedback.create",
					resource: "feedback:thread_a",
					effect: "mutation",
					approvalPolicy: "trusted-human",
					inputDigest: CANONICAL_NESTED_INPUT_DIGEST,
				},
			],
		]);
		const approvedHarness = createHarness({
			validApprovals: approvalRecords,
		});
		const executeApproved = vi.fn(async () => "created");

		const approved = await approvedHarness.broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				trustedApprovalId: "approval_for_canonical_input",
				request: baseRequest({
					requestId: "request_digest",
					input: {
						meta: { z: 1, a: 2 },
						body: "Looks ready",
					},
				}),
			},
			executeApproved,
		);

		expect(approved).toEqual({ ok: true, value: "created" });
		expect(approvedHarness.approvalBindings).toContainEqual(
			expect.objectContaining({
				grantId: "grant_a",
				effect: "mutation",
				inputDigest: CANONICAL_NESTED_INPUT_DIGEST,
			}),
		);

		const tamperedHarness = createHarness({
			validApprovals: approvalRecords,
		});
		const executeTampered = vi.fn();
		const tampered = await tamperedHarness.broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				trustedApprovalId: "approval_for_canonical_input",
				request: baseRequest({
					requestId: "request_digest",
					input: {
						meta: { a: 2, z: 1 },
						body: "Changed after approval",
					},
				}),
			},
			executeTampered,
		);

		expect(tampered).toEqual({ ok: false, code: "approval_required" });
		expect(executeTampered).not.toHaveBeenCalled();
	});

	it.each(["revoked", "expired"] as const)(
		"atomically revalidates a capability that becomes %s while approval is awaited",
		async (transition) => {
			const grant = baseGrant();
			const harness = createHarness({
				grant,
				...(transition === "revoked"
					? {
						onVerifyApproval: () => {
							grant.revokedAt = NOW;
						},
					}
					: { advanceClockDuringApprovalTo: grant.expiresAt }),
			});
			const execute = vi.fn();

			const result = await harness.broker.invoke(
				{
					opaqueHandle: OPAQUE_HANDLE,
					trustedActor: actorA,
					trustedApprovalId: "approval_from_trusted_shell",
					request: baseRequest(),
				},
				execute,
			);

			expect(result).toEqual({ ok: false, code: "capability_denied" });
			expect(harness.atomicFinalizations).toHaveLength(1);
			expect(execute).not.toHaveBeenCalled();
		},
	);

	it("persists a durable audit intent before an effect and refuses the effect when that write fails", async () => {
		const { broker } = createHarness({ failAuditIntent: true });
		const execute = vi.fn(async () => "created");

		const result = await broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				trustedApprovalId: "approval_from_trusted_shell",
				request: baseRequest(),
			},
			execute,
		);

		expect(result).toEqual({ ok: false, code: "audit_unavailable" });
		expect(execute).not.toHaveBeenCalled();
	});

	it("correlates audit intent and successful completion around the effect", async () => {
		const harness = createHarness();
		const execute = vi.fn(async () => {
			harness.auditOrder.push("effect");
			return "created";
		});

		const result = await harness.broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				trustedApprovalId: "approval_from_trusted_shell",
				request: baseRequest(),
			},
			execute,
		);

		expect(result).toEqual({ ok: true, value: "created" });
		expect(harness.auditOrder).toEqual([
			"audit:intent:allowed",
			"effect",
			"audit:completion:allowed",
		]);
		const [intent, completion] = harness.audits;
		expect(intent.correlationId).toBeTruthy();
		expect(completion.correlationId).toBe(intent.correlationId);
	});

	it("correlates audit intent and failed completion when the executor fails", async () => {
		const harness = createHarness();
		const execute = vi.fn(async () => {
			throw new Error("fixture failure");
		});

		const result = await harness.broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				trustedApprovalId: "approval_from_trusted_shell",
				request: baseRequest(),
			},
			execute,
		);

		expect(result).toEqual({ ok: false, code: "execution_failed" });
		const [intent, completion] = harness.audits;
		expect(intent).toEqual(expect.objectContaining({ phase: "intent" }));
		expect(completion).toEqual(
			expect.objectContaining({ phase: "completion", outcome: "failed" }),
		);
		expect(completion.correlationId).toBe(intent.correlationId);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"fails closed when the trusted clock returns %s",
		async (now) => {
			const { broker } = createHarness({ now });
			const execute = vi.fn();

			const result = await broker.invoke(
				{
					opaqueHandle: OPAQUE_HANDLE,
					trustedActor: actorA,
					trustedApprovalId: "approval_from_trusted_shell",
					request: baseRequest(),
				},
				execute,
			);

			expect(result).toEqual({ ok: false, code: "capability_denied" });
			expect(execute).not.toHaveBeenCalled();
		},
	);

	it("normalizes the executor actor to exactly kind and ID", async () => {
		const { broker, audits } = createHarness();
		const actorWithSmuggledField = {
			...actorA,
			platformSession: "must-not-propagate",
		};
		const execute = vi.fn(
			async (invocation: AuthorizedInvocation) => invocation.actor,
		);

		const result = await broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorWithSmuggledField,
				trustedApprovalId: "approval_from_trusted_shell",
				request: baseRequest(),
			},
			execute,
		);

		expect(result).toEqual({ ok: true, value: actorA });
		expect(execute).toHaveBeenCalledWith(
			expect.objectContaining({ actor: actorA }),
		);
		expect(execute.mock.calls[0]?.[0].actor).not.toHaveProperty(
			"platformSession",
		);
		expect(JSON.stringify(audits)).not.toContain("must-not-propagate");
	});

	it("rejects an action-specific payload before approval or execution", async () => {
		const validateActionPayload = vi.fn(
			async (invocation: AuthorizedInvocation) =>
				invocation.action !== "review.feedback.create" ||
				typeof (invocation.input as { body?: unknown })?.body === "string",
		);
		const { broker } = createHarness({ validateActionPayload });
		const execute = vi.fn();

		const result = await broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				trustedApprovalId: "approval_from_trusted_shell",
				request: baseRequest({ input: { unexpected: true } }),
			},
			execute,
		);

		expect(result).toEqual({ ok: false, code: "capability_denied" });
		expect(validateActionPayload).toHaveBeenCalledOnce();
		expect(execute).not.toHaveBeenCalled();
	});

	it("uses one bounded deeply immutable input snapshot across validation, approval, audit, claim, and execution", async () => {
		const mutableInput = {
			meta: { z: 1, a: 2 },
			body: "Looks ready",
		};
		const approvalRecords = new Map<string, Record<string, unknown>>([
			[
				"approval_for_snapshot",
				{
					requestId: "request_snapshot",
					actor: actorA,
					grantId: "grant_a",
					grantGeneration: 1,
					shipletId: "shiplet_a",
					revisionId: "revision_a1",
					action: "review.feedback.create",
					resource: "feedback:thread_a",
					effect: "mutation",
					approvalPolicy: "trusted-human",
					inputDigest: CANONICAL_NESTED_INPUT_DIGEST,
				},
			],
		]);
		let validatedInput: unknown;
		const harness = createHarness({
			validApprovals: approvalRecords,
			validateActionPayload: async (invocation) => {
				validatedInput = invocation.input;
				return true;
			},
			onVerifyApproval: () => {
				mutableInput.body = "Changed while approval was awaited";
				mutableInput.meta.a = 99;
			},
			onAuditIntent: () => {
				mutableInput.body = "Changed while audit intent was awaited";
				mutableInput.meta.z = 99;
			},
		});
		const execute = vi.fn(async (invocation: AuthorizedInvocation) => invocation.input);

		const result = await harness.broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				trustedApprovalId: "approval_for_snapshot",
				request: baseRequest({
					requestId: "request_snapshot",
					input: mutableInput,
				}),
			},
			execute,
		);

		expect(result).toEqual({
			ok: true,
			value: { meta: { z: 1, a: 2 }, body: "Looks ready" },
		});
		const executedInput = execute.mock.calls[0]?.[0].input;
		expect(validatedInput).toBe(executedInput);
		expect(Object.isFrozen(executedInput)).toBe(true);
		expect(
			Object.isFrozen((executedInput as { meta: object }).meta),
		).toBe(true);
		expect(harness.approvalBindings[0]?.inputDigest).toBe(
			CANONICAL_NESTED_INPUT_DIGEST,
		);
		expect(harness.atomicFinalizations[0]?.inputDigest).toBe(
			CANONICAL_NESTED_INPUT_DIGEST,
		);
		expect(
			harness.audits.find((event) => event.phase === "intent")?.inputDigest,
		).toBe(CANONICAL_NESTED_INPUT_DIGEST);
	});

	it.each([
		{ kind: "human", id: "actor_human" },
		{ kind: "agent", id: "actor_agent" },
		{ kind: "shiplet", id: "actor_shiplet" },
		{ kind: "system", id: "actor_system" },
	] satisfies Actor[])(
		"requires trusted approval for a $kind mutation even when its grant says none",
		async (actor) => {
			const { broker } = createHarness({
				grant: baseGrant({ actor, approval: "none" }),
			});
			const execute = vi.fn();

			const result = await broker.invoke(
				{
					opaqueHandle: OPAQUE_HANDLE,
					trustedActor: actor,
					request: baseRequest(),
				},
				execute,
			);

			expect(result).toEqual({ ok: false, code: "approval_required" });
			expect(execute).not.toHaveBeenCalled();
		},
	);

	it("binds deeply immutable approval, audit, and atomic claim evidence to one grant generation", async () => {
		const grant = baseGrant();
		const harness = createHarness({
			grant,
			requireExpandedAtomicBinding: true,
			onVerifyApproval: () => {
				grant.generation += 1;
			},
		});
		const execute = vi.fn();

		const result = await harness.broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				trustedApprovalId: "approval_from_trusted_shell",
				request: baseRequest(),
			},
			execute,
		);

		expect(result).toEqual({ ok: false, code: "capability_denied" });
		const approval = harness.approvalBindings[0];
		expect(approval).toEqual(
			expect.objectContaining({
				grantGeneration: 1,
				effect: "mutation",
				approvalPolicy: "trusted-human",
				inputDigest: BASE_INPUT_DIGEST,
			}),
		);
		expect(Object.isFrozen(approval)).toBe(true);
		expect(Object.isFrozen(approval.actor)).toBe(true);

		const intent = harness.audits.find((event) => event.phase === "intent");
		expect(intent).toEqual(
			expect.objectContaining({
				grantGeneration: 1,
				effect: "mutation",
				approvalPolicy: "trusted-human",
				approvalId: "approval_from_trusted_shell",
				inputDigest: BASE_INPUT_DIGEST,
			}),
		);
		expect(Object.isFrozen(intent)).toBe(true);
		expect(Object.isFrozen(intent?.actor)).toBe(true);

		const atomicAttempt = harness.atomicFinalizations[0];
		expect(atomicAttempt).toEqual(
			expect.objectContaining({
				grantGeneration: 1,
				effect: "mutation",
				approvalPolicy: "trusted-human",
				approvalId: "approval_from_trusted_shell",
				inputDigest: BASE_INPUT_DIGEST,
			}),
		);
		expect(Object.isFrozen(atomicAttempt)).toBe(true);
		expect(Object.isFrozen(atomicAttempt.actor)).toBe(true);
		expect(execute).not.toHaveBeenCalled();
	});

	it("rejects negative zero in capability input instead of colliding with positive zero", async () => {
		const { broker } = createHarness({
			grant: baseGrant({ effect: "read", approval: "none" }),
		});
		const execute = vi.fn();

		const result = await broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				request: baseRequest({ input: { value: -0 } }),
			},
			execute,
		);

		expect(result).toEqual({ ok: false, code: "capability_denied" });
		expect(execute).not.toHaveBeenCalled();
	});

	it.each([
		["object keys", { ["🔒".repeat(64)]: true }],
		["string values", { body: "🔒".repeat(64) }],
	] as const)(
		"bounds capability input %s by UTF-8 bytes before validation, durable claim, or execution",
		async (_label, input) => {
			const validateActionPayload = vi.fn(async () => true);
			const harness = createHarness({
				grant: baseGrant({ effect: "read", approval: "none" }),
				validateActionPayload,
				brokerLimits: {
					maxInputBytes: 128,
					maxMetadataFieldBytes: 1_024,
				},
			});
			const execute = vi.fn(async () => "must not execute");

			const result = await harness.broker.invoke(
				{
					opaqueHandle: OPAQUE_HANDLE,
					trustedActor: actorA,
					request: baseRequest({ input }),
				},
				execute,
			);

			expect(result).toEqual({ ok: false, code: "capability_denied" });
			expect(validateActionPayload).not.toHaveBeenCalled();
			expect(harness.atomicFinalizations).toHaveLength(0);
			expect(execute).not.toHaveBeenCalled();
		},
	);

	it.each([
		["opaque handle", "opaqueHandle"],
		["request ID", "requestId"],
		["Shiplet ID", "shipletId"],
		["revision ID", "revisionId"],
		["action", "action"],
		["resource", "resource"],
		["actor ID", "actorId"],
		["approval ID", "approvalId"],
	] as const)(
		"bounds the %s by UTF-8 bytes before capability-store access",
		async (_label, field) => {
			const oversized = "💥".repeat(20);
			let opaqueHandle = OPAQUE_HANDLE;
			let trustedActor: Actor = actorA;
			let trustedApprovalId: string | undefined;
			let grant = baseGrant({ effect: "read", approval: "none" });
			let request = baseRequest();
			let validApprovals: Map<string, Record<string, unknown>> | undefined;

			switch (field) {
				case "opaqueHandle":
					opaqueHandle = oversized;
					break;
				case "requestId":
					request = baseRequest({ requestId: oversized });
					break;
				case "shipletId":
					grant = baseGrant({
						effect: "read",
						approval: "none",
						shipletId: oversized,
					});
					request = baseRequest({ shipletId: oversized });
					break;
				case "revisionId":
					grant = baseGrant({
						effect: "read",
						approval: "none",
						revisionId: oversized,
					});
					request = baseRequest({ revisionId: oversized });
					break;
				case "action":
					grant = baseGrant({
						effect: "read",
						approval: "none",
						action: oversized,
					});
					request = baseRequest({ action: oversized });
					break;
				case "resource":
					grant = baseGrant({
						effect: "read",
						approval: "none",
						resource: oversized,
					});
					request = baseRequest({ resource: oversized });
					break;
				case "actorId":
					trustedActor = { kind: "agent", id: oversized };
					grant = baseGrant({
						effect: "read",
						approval: "none",
						actor: trustedActor,
					});
					break;
				case "approvalId":
					trustedApprovalId = oversized;
					grant = baseGrant();
					validApprovals = new Map([
						[
							oversized,
							{
								requestId: "request_a1",
								actor: actorA,
								grantId: "grant_a",
								grantGeneration: 1,
								shipletId: "shiplet_a",
								revisionId: "revision_a1",
								action: "review.feedback.create",
								resource: "feedback:thread_a",
								effect: "mutation",
								approvalPolicy: "trusted-human",
								inputDigest: BASE_INPUT_DIGEST,
							},
						],
					]);
					break;
			}

			const harness = createHarness({
				grant,
				validApprovals,
				brokerLimits: {
					maxInputBytes: 64_000,
					maxMetadataFieldBytes: 32,
				},
			});
			if (field === "opaqueHandle") {
				harness.grants.set(opaqueHandle, grant);
			}
			const execute = vi.fn(async () => "must not execute");

			const result = await harness.broker.invoke(
				{
					opaqueHandle,
					trustedActor,
					trustedApprovalId,
					request,
				},
				execute,
			);

			expect(result).toEqual({ ok: false, code: "capability_denied" });
			expect(harness.resolvedHandles).toHaveLength(0);
			expect(harness.atomicFinalizations).toHaveLength(0);
			expect(execute).not.toHaveBeenCalled();
		},
	);

	it("snapshots every invocation metadata field before the first awaited trust operation", async () => {
		const invocation = {
			opaqueHandle: OPAQUE_HANDLE,
			trustedActor: { ...actorA },
			trustedApprovalId: "approval_from_trusted_shell",
			request: baseRequest(),
		};
		const harness = createHarness({
			requireExpandedAtomicBinding: true,
			onVerifyApproval: () => {
				invocation.opaqueHandle = "mutated_handle";
				invocation.trustedActor.id = "mutated_actor";
				invocation.trustedApprovalId = "mutated_approval";
				invocation.request.requestId = "mutated_request";
				invocation.request.shipletId = "mutated_shiplet";
				invocation.request.revisionId = "mutated_revision";
				invocation.request.action = "mutated.action";
				invocation.request.resource = "mutated:resource";
			},
		});
		const execute = vi.fn(async (authorized: AuthorizedInvocation) => authorized);

		const result = await harness.broker.invoke(invocation, execute);

		expect(result).toMatchObject({
			ok: true,
			value: {
				actor: actorA,
				requestId: "request_a1",
				shipletId: "shiplet_a",
				revisionId: "revision_a1",
				action: "review.feedback.create",
				resource: "feedback:thread_a",
			},
		});
		expect(harness.atomicFinalizations[0]).toMatchObject({
			opaqueHandle: OPAQUE_HANDLE,
			approvalId: "approval_from_trusted_shell",
			actor: actorA,
			requestId: "request_a1",
			shipletId: "shiplet_a",
			revisionId: "revision_a1",
			action: "review.feedback.create",
			resource: "feedback:thread_a",
		});
	});

	it("rejects oversized grant-store metadata before approval, audit intent, or execution", async () => {
		const harness = createHarness({
			grant: baseGrant({ id: "g".repeat(128) }),
			brokerLimits: {
				maxInputBytes: 64_000,
				maxMetadataFieldBytes: 32,
			},
		});
		const execute = vi.fn();

		const result = await harness.broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				trustedApprovalId: "approval_from_trusted_shell",
				request: baseRequest(),
			},
			execute,
		);

		expect(result).toEqual({ ok: false, code: "capability_denied" });
		expect(harness.approvalBindings).toHaveLength(0);
		expect(harness.atomicFinalizations).toHaveLength(0);
		expect(execute).not.toHaveBeenCalled();
	});

	it("maps untrusted atomic-store denial text to a bounded closed audit reason", async () => {
		const harness = createHarness({
			grant: baseGrant({ effect: "read", approval: "none" }),
			atomicFailureReason: "untrusted-store-reason".repeat(100),
			brokerLimits: {
				maxInputBytes: 64_000,
				maxMetadataFieldBytes: 32,
			},
		});
		const execute = vi.fn();

		const result = await harness.broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				request: baseRequest(),
			},
			execute,
		);

		expect(result).toEqual({ ok: false, code: "capability_denied" });
		expect(harness.audits.at(-1)?.reason).toBe("grant_store_denied");
		expect(harness.audits.at(-1)?.reason?.length).toBeLessThanOrEqual(32);
		expect(execute).not.toHaveBeenCalled();
	});

	it("executes a mutation request ID at most once, including under a concurrent replay", async () => {
		const { broker } = createHarness();
		const execute = vi.fn(async () => "created");
		const invocation = {
			opaqueHandle: OPAQUE_HANDLE,
			trustedActor: actorA,
			trustedApprovalId: "approval_from_trusted_shell",
			request: baseRequest(),
		};

		const results = await Promise.all([
			broker.invoke(invocation, execute),
			broker.invoke(invocation, execute),
		]);

		expect(results).toContainEqual({ ok: true, value: "created" });
		expect(results).toContainEqual({ ok: false, code: "replayed" });
		expect(execute).toHaveBeenCalledOnce();
	});

	it("allows a fresh mutation request ID only with an approval bound to that exact request", async () => {
		const approvals = new Map<string, Record<string, unknown>>([
			[
				"approval_request_a2",
				{
					requestId: "request_a2",
					actor: actorA,
					grantId: "grant_a",
					grantGeneration: 1,
					shipletId: "shiplet_a",
					revisionId: "revision_a1",
					action: "review.feedback.create",
					resource: "feedback:thread_a",
					effect: "mutation",
					approvalPolicy: "trusted-human",
					inputDigest: BASE_INPUT_DIGEST,
				},
			],
		]);
		const { broker } = createHarness({ validApprovals: approvals });
		const execute = vi.fn(async () => "created");

		const wrongRequestApproval = await broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				trustedApprovalId: "approval_request_a2",
				request: baseRequest(),
			},
			execute,
		);
		const exactRequestApproval = await broker.invoke(
			{
				opaqueHandle: OPAQUE_HANDLE,
				trustedActor: actorA,
				trustedApprovalId: "approval_request_a2",
				request: baseRequest({ requestId: "request_a2" }),
			},
			execute,
		);

		expect(wrongRequestApproval).toEqual({ ok: false, code: "approval_required" });
		expect(exactRequestApproval).toEqual({ ok: true, value: "created" });
		expect(execute).toHaveBeenCalledOnce();
	});
});
