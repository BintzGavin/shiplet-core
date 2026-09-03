import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
	createD1RevisionDeploymentPreparationStore,
	ensureRevisionDeploymentCoordinatorSchema,
	type RevisionDeploymentPreparation,
} from "../src/revision-deployment-coordinator";

function preparation(
	overrides: Partial<RevisionDeploymentPreparation> = {},
): RevisionDeploymentPreparation {
	const suffix = crypto.randomUUID();
	return {
		id: `deployment_${suffix}`,
		version: 1,
		state: "prepared",
		shipletId: `project_${suffix}`,
		targetId: `target_${suffix}`,
		revisionId: `revision_${suffix}`,
		reason: "promotion",
		actorId: `user_${suffix}`,
		targetGeneration: 1,
		targetFingerprint: `sha256:${"a".repeat(64)}`,
		connectionId: `connection_${suffix}`,
		providerAccountId: `account_${suffix}`,
		providerResourceName: `shiplet-${suffix}`,
		providerVersionId: `version_${suffix}`,
		packageDigest: `sha256:${"b".repeat(64)}`,
		createdAt: 1_800_000_000_000,
		...overrides,
	};
}

describe("D1 revision deployment preparation store", () => {
	it("persists exact opaque receipts and compare-and-sets only the mutable lifecycle", async () => {
		await ensureRevisionDeploymentCoordinatorSchema((env as Env).DB);
		const store = createD1RevisionDeploymentPreparationStore({
			db: (env as Env).DB,
		});
		const initial = preparation();
		expect(await store.insert(initial)).toBe(true);
		expect(await store.get(initial.id)).toEqual(initial);

		const next = {
			...initial,
			version: 2,
			state: "activating" as const,
		};
		expect(
			await store.compareAndSet({
				id: initial.id,
				expectedVersion: 1,
				next,
			}),
		).toBe(true);
		expect(
			await store.compareAndSet({
				id: initial.id,
				expectedVersion: 1,
				next: { ...next, state: "activated" },
			}),
		).toBe(false);
		expect(await store.get(initial.id)).toEqual(next);
	});

	it("serializes concurrent active preparation for one exact target/revision/reason", async () => {
		await ensureRevisionDeploymentCoordinatorSchema((env as Env).DB);
		const store = createD1RevisionDeploymentPreparationStore({
			db: (env as Env).DB,
		});
		const first = preparation();
		const competing = preparation({
			shipletId: first.shipletId,
			targetId: first.targetId,
			revisionId: first.revisionId,
			reason: first.reason,
		});
		const outcomes = await Promise.all([
			store.insert(first),
			store.insert(competing),
		]);
		expect(outcomes.sort()).toEqual([false, true]);
	});

	it("rejects any compare-and-set that changes the authority tuple", async () => {
		await ensureRevisionDeploymentCoordinatorSchema((env as Env).DB);
		const store = createD1RevisionDeploymentPreparationStore({
			db: (env as Env).DB,
		});
		const initial = preparation();
		expect(await store.insert(initial)).toBe(true);
		await expect(
			store.compareAndSet({
				id: initial.id,
				expectedVersion: 1,
				next: {
					...initial,
					version: 2,
					state: "activating",
					shipletId: `project_${crypto.randomUUID()}`,
				},
			}),
		).rejects.toThrow(/authority tuple/i);
		expect(await store.get(initial.id)).toEqual(initial);
	});
});
