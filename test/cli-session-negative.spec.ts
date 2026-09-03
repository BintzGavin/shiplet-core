// @vitest-environment node

import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { runCli } = require("../src/cli/shiplet.cjs") as {
	runCli(options: {
		argv: string[];
		env: Record<string, string | undefined>;
		cwd?: string;
		fetch: typeof fetch;
		sessionBootstrap: (options: {
			apiUrl: string;
			fetch: typeof fetch;
			stdout: { write(chunk: string): void };
		}) => Promise<SessionFetch>;
		stdout: { write(chunk: string): void };
		stderr: { write(chunk: string): void };
	}): Promise<number>;
};
const { createScopedSessionFetch } = require("../src/cli/scoped-session-fetch.cjs") as {
	createScopedSessionFetch(options: {
		apiUrl: string;
		accessToken: string;
		fetch: typeof fetch;
	}): SessionFetch;
};

type SessionFetch = typeof fetch & { revoke(): Promise<void> };

const temporaryPaths: string[] = [];

afterEach(async () => {
	for (const target of temporaryPaths.splice(0)) {
		await rm(target, { recursive: true, force: true });
	}
});

function writable() {
	let output = "";
	return {
		write(chunk: string) {
			output += chunk;
		},
		value() {
			return output;
		},
	};
}

function successfulCommandSession(command: "fork" | "publish") {
	const sessionFetch = vi.fn(async (url: string | URL | Request) => {
		const pathname = new URL(String(url)).pathname;
		if (command === "fork" && pathname === "/api/shiplets/project_A/drafts") {
			return new Response(
				JSON.stringify({
					draft: {
						id: "draft_A",
						shipletId: "project_A",
						baseRevisionId: "revision_A",
						version: 1,
					},
				}),
				{ status: 201, headers: { "content-type": "application/json" } },
			);
		}
		if (command === "publish" && pathname === "/api/shiplets") {
			return new Response(
				JSON.stringify({ ok: true, project: { id: "project_A" } }),
				{ status: 201, headers: { "content-type": "application/json" } },
			);
		}
		return new Response(null, { status: 404 });
	}) as unknown as SessionFetch;
	sessionFetch.revoke = vi.fn(async () => {
		throw new Error("Shiplet CLI session revocation was not confirmed.");
	});
	return sessionFetch;
}

describe("CLI browser-session negative boundaries", () => {
	it("Given an operational Shiplet request receives a cross-origin redirect, When the scoped session sends it, Then the redirect is not followed and no authority reaches the other origin", async () => {
		let outsideRequests = 0;
		let outsideReceivedAuthorization = false;
		let revocationAttempts = 0;
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const pathname = new URL(String(url)).pathname;
			if (pathname === "/api/cli/session/revoke") {
				revocationAttempts += 1;
				return new Response(null, { status: 503 });
			}
			if (init?.redirect !== "error") {
				outsideRequests += 1;
				outsideReceivedAuthorization = new Headers(init?.headers).has(
					"authorization",
				);
				return new Response("outside");
			}
			throw new Error("redirect blocked");
		}) as unknown as typeof fetch;
		const sessionFetch = createScopedSessionFetch({
			apiUrl: "http://127.0.0.1:43117",
			accessToken: `shiplet_cli_session_${randomBytes(24).toString("hex")}`,
			fetch: fetchImpl,
		});

		await expect(
			sessionFetch("http://127.0.0.1:43117/api/shiplets"),
		).rejects.toThrow("redirect blocked");
		expect(outsideRequests).toBe(0);
		expect(outsideReceivedAuthorization).toBe(false);
		await expect(sessionFetch.revoke()).rejects.toThrow(/not confirmed/i);
		expect(revocationAttempts).toBe(2);
	});

	it.each(["fork", "publish"] as const)(
		"Given a successful %s request after browser-session revocation is unconfirmed, When the CLI completes its owned session, Then it emits a partial result and exits nonzero without printing authority",
		async (command) => {
			const stdout = writable();
			const stderr = writable();
			const sessionFetch = successfulCommandSession(command);
			let cwd: string | undefined;
			let argv = [
				"fork",
				"project_A",
				"--api-url",
				"http://127.0.0.1:43118",
				"--json",
			];
			if (command === "publish") {
				cwd = await mkdtemp(path.join(tmpdir(), "shiplet-cli-session-negative-"));
				temporaryPaths.push(cwd);
				await writeFile(
					path.join(cwd, "index.html"),
					"<!doctype html><title>Safe</title>",
				);
				argv = [
					"publish",
					"index.html",
					"--api-url",
					"http://127.0.0.1:43118",
					"--json",
				];
			}

			const exitCode = await runCli({
				argv,
				env: {},
				cwd,
				fetch: vi.fn() as unknown as typeof fetch,
				sessionBootstrap: async () => sessionFetch,
				stdout,
				stderr,
			});

			expect(sessionFetch.revoke).toHaveBeenCalledOnce();
			expect(exitCode).toBe(1);
			expect(stdout.value()).not.toMatch(/forked|prepared .* for review/i);
			expect(stderr.value()).toMatch(
				/completed.*revocation.*not confirmed|partial|unconfirmed/i,
			);
			expect(`${stdout.value()}${stderr.value()}`).not.toMatch(
				/shiplet_cli_session_|authorization\s*:|bearer\s+/i,
			);
		},
	);
});
