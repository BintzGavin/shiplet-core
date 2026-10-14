// @vitest-environment node

import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

type BootstrapOptions = {
	apiUrl: string;
	purpose: "session" | "step-up";
	sessionCache: boolean;
	sessionTtlSeconds?: number;
};
type SessionFetch = typeof fetch & { revoke?: () => Promise<void> };
type SessionStatus = {
	origin: string;
	account: { id: string; email: string };
	expiresOn: string;
	storage: string;
	reused?: boolean;
};

const { runCli } = require("../src/cli/shiplet.cjs") as {
	runCli(options: {
		argv: string[];
		env: Record<string, string | undefined>;
		fetch: typeof fetch;
		sessionBootstrap?: (options: BootstrapOptions) => Promise<SessionFetch>;
		sessionCache?: {
			login(options: unknown): Promise<SessionStatus>;
			status(options: unknown): Promise<SessionStatus | null>;
			logout(options: unknown): Promise<{
				origin: string;
				hadSession: boolean;
				revocation: string;
				expiresOn?: string;
			}>;
		};
		stdout: { write(chunk: string): void };
		stderr: { write(chunk: string): void };
	}): Promise<number>;
};

const API_URL = "http://127.0.0.1:43301";

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

function recordingBootstrap() {
	const calls: BootstrapOptions[] = [];
	const bootstrap = vi.fn(async (options: BootstrapOptions) => {
		calls.push(options);
		const sessionFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const pathname = new URL(String(url)).pathname;
			if (pathname === "/api/shiplets/project_A/drafts") {
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
			return new Response(
				JSON.stringify({
					deployment: {
						id: "deployment_A",
						revisionId: "revision_A",
						targetId: "target_A",
					},
					operation: {
						id: "operation_A",
						kind: "deploy",
						status: "committed",
						idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as SessionFetch;
		if (options.purpose === "step-up") sessionFetch.revoke = vi.fn(async () => {});
		return sessionFetch;
	});
	return { bootstrap, calls };
}

async function run(
	argv: string[],
	extra: Partial<Parameters<typeof runCli>[0]> = {},
) {
	const stdout = writable();
	const stderr = writable();
	const exitCode = await runCli({
		argv: [...argv, "--api-url", API_URL],
		env: {},
		fetch: vi.fn() as unknown as typeof fetch,
		stdout,
		stderr,
		...extra,
	});
	return { exitCode, stdout: stdout.value(), stderr: stderr.value() };
}

describe("CLI reusable session wiring", () => {
	it("asks for a reusable two hour session for revision commands", async () => {
		const { bootstrap, calls } = recordingBootstrap();
		const result = await run(["fork", "project_A", "--json"], {
			sessionBootstrap: bootstrap,
		});
		expect(result.exitCode).toBe(0);
		expect(calls).toEqual([
			expect.objectContaining({
				apiUrl: API_URL,
				purpose: "session",
				sessionCache: true,
				sessionTtlSeconds: 7200,
			}),
		]);
	});

	it("takes the lifetime from --session-ttl or SHIPLET_CLI_SESSION_TTL", async () => {
		const flag = recordingBootstrap();
		await run(["fork", "project_A", "--session-ttl", "90m", "--json"], {
			sessionBootstrap: flag.bootstrap,
		});
		expect(flag.calls[0].sessionTtlSeconds).toBe(5400);

		const fromEnv = recordingBootstrap();
		await run(["fork", "project_A", "--json"], {
			env: { SHIPLET_CLI_SESSION_TTL: "1h" },
			sessionBootstrap: fromEnv.bootstrap,
		});
		expect(fromEnv.calls[0].sessionTtlSeconds).toBe(3600);

		const invalid = recordingBootstrap();
		const rejected = await run(["fork", "project_A", "--session-ttl", "12h"], {
			sessionBootstrap: invalid.bootstrap,
		});
		expect(rejected.exitCode).toBe(1);
		expect(rejected.stderr).toMatch(/between 5 minutes and 8 hours/);
		expect(invalid.calls).toEqual([]);
	});

	it("keeps the per-command flow with --no-session-cache", async () => {
		const { bootstrap, calls } = recordingBootstrap();
		await run(["fork", "project_A", "--no-session-cache", "--json"], {
			sessionBootstrap: bootstrap,
		});
		expect(calls[0]).toMatchObject({ purpose: "session", sessionCache: false });
	});

	it("asks deploy for a fresh step-up approval and revokes it afterward", async () => {
		const { bootstrap, calls } = recordingBootstrap();
		const result = await run(
			["deploy", "revision_A", "--target", "target_A", "--approve", "--json"],
			{ sessionBootstrap: bootstrap },
		);
		expect(result.exitCode).toBe(0);
		expect(calls).toEqual([
			expect.objectContaining({ purpose: "step-up", sessionTtlSeconds: undefined }),
		]);
		const stepUp = (await bootstrap.mock.results[0].value) as SessionFetch;
		expect(stepUp.revoke).toHaveBeenCalledOnce();
	});

	it.each([
		["deploy", ["revision_A", "--target", "target_A", "--approve"]],
		["promote", ["draft_A", "--expected-active", "revision_A", "--approve"]],
		["rollback", ["project_A", "--revision", "revision_A", "--expected-active", "revision_B", "--approve"]],
	])("rejects session cache flags on %s", async (command, args) => {
		for (const flag of [["--session-ttl", "2h"], ["--no-session-cache"]]) {
			const result = await run([command, ...args, ...flag]);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toMatch(new RegExp(`${flag[0]} is not valid for shiplet ${command}`));
		}
	});

	it("still rejects raw organization keys for deploy before any network access", async () => {
		const { bootstrap, calls } = recordingBootstrap();
		const network = vi.fn();
		const result = await run(
			["deploy", "revision_A", "--target", "target_A", "--approve"],
			{
				env: { SHIPLET_API_KEY: "shiplet_org_key_example" },
				fetch: network as unknown as typeof fetch,
				sessionBootstrap: bootstrap,
			},
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/cannot authorize deploy, promote, or rollback/);
		expect(network).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
	});

	it("shows the saved session's account, origin, and expiry without the credential", async () => {
		const status: SessionStatus = {
			origin: API_URL,
			account: { id: "user_A", email: "person@example.com" },
			expiresOn: new Date(Date.now() + 90 * 60_000).toISOString(),
			storage: "macOS Keychain",
		};
		const sessionCache = {
			login: vi.fn(async () => ({ ...status, reused: false })),
			status: vi.fn(async () => status),
			logout: vi.fn(),
		};
		const human = await run(["whoami"], { sessionCache });
		expect(human.exitCode).toBe(0);
		expect(human.stdout).toContain("person@example.com");
		expect(human.stdout).toContain(API_URL);
		expect(human.stdout).toMatch(/Expires: .*\(in 1h 30m\)|\(in 1h 29m\)/);
		expect(human.stdout).toContain("macOS Keychain");

		const json = await run(["whoami", "--json"], { sessionCache });
		expect(JSON.parse(json.stdout)).toMatchObject({
			signedIn: true,
			origin: API_URL,
			account: { email: "person@example.com" },
		});

		const login = await run(["login", "--session-ttl", "1h", "--json"], { sessionCache });
		expect(login.exitCode).toBe(0);
		expect(sessionCache.login).toHaveBeenCalledWith(
			expect.objectContaining({ apiUrl: API_URL, sessionTtlSeconds: 3600 }),
		);
		expect(`${human.stdout}${json.stdout}${login.stdout}`).not.toMatch(/shiplet_cli_session_/);
	});

	it("reports no session and exits nonzero from whoami", async () => {
		const sessionCache = {
			login: vi.fn(),
			status: vi.fn(async () => null),
			logout: vi.fn(),
		};
		const result = await run(["whoami"], { sessionCache });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toMatch(/Not signed in/);
	});

	it.each([
		["revoked", 0, /Revoked the Shiplet CLI session/],
		["already-ended", 0, /had already ended/],
		["none", 0, /No saved Shiplet CLI session/],
		["unconfirmed", 1, /did not confirm revocation/],
	] as const)("reports a %s logout", async (revocation, exitCode, message) => {
		const sessionCache = {
			login: vi.fn(),
			status: vi.fn(),
			logout: vi.fn(async () => ({
				origin: API_URL,
				hadSession: revocation !== "none",
				revocation,
				expiresOn: new Date(Date.now() + 60_000).toISOString(),
			})),
		};
		const result = await run(["logout"], { sessionCache });
		expect(result.exitCode).toBe(exitCode);
		expect(result.stdout).toMatch(message);
	});

	it("rejects arguments and credential flags on session commands", async () => {
		const sessionCache = { login: vi.fn(), status: vi.fn(), logout: vi.fn() };
		expect((await run(["logout", "extra"], { sessionCache })).stderr).toMatch(/takes no arguments/);
		expect((await run(["whoami", "--token", "x"], { sessionCache })).stderr).toMatch(/--token is not valid/);
		expect((await run(["logout", "--session-ttl", "2h"], { sessionCache })).stderr).toMatch(/--session-ttl is not valid/);
	});
});
