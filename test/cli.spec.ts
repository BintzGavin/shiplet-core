// @vitest-environment node

import {
	mkdtemp,
	mkdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
// @ts-expect-error Vite's raw loader supplies the candidate CommonJS source.
import cliCandidateSource from "../src/cli/shiplet.cjs?raw";

const require = createRequire(import.meta.url);
const cli = require("../src/cli/shiplet.cjs") as {
	runCli(options: {
		argv: string[];
		env?: Record<string, string | undefined>;
		cwd?: string;
		fetch?: typeof fetch;
		sessionFetch?: typeof fetch;
		stdout?: { write(chunk: string): void };
		stderr?: { write(chunk: string): void };
	}): Promise<number>;
};
type PortablePackageFileFixture = {
	path: string;
	mediaType: string;
	encoding: "utf8" | "base64";
	content: string;
	sha256: string;
	size: number;
	[key: string]: unknown;
};

type PortablePackageFixture = {
	mediaType: string;
	manifest: {
		schemaVersion: string;
		runtimeCompatibility: string;
		entrypoints: Record<string, string>;
		requestedCapabilities: string[];
		limits: Record<string, number>;
		staticFirst: boolean;
		[key: string]: unknown;
	};
	files: PortablePackageFileFixture[];
	[key: string]: unknown;
};
const completePackageFixture =
	require("./fixtures/packages/complete-v1.json") as PortablePackageFixture;

const tmpPaths: string[] = [];

afterEach(async () => {
	while (tmpPaths.length > 0) {
		const tmpPath = tmpPaths.pop();
		if (tmpPath) await rm(tmpPath, { recursive: true, force: true });
	}
});

async function makeTempDir() {
	const directory = await mkdtemp(path.join(tmpdir(), "shiplet-cli-"));
	tmpPaths.push(directory);
	return directory;
}

function cloneCompletePackage(): PortablePackageFixture {
	return structuredClone(completePackageFixture);
}

function utf8File(
	filePath: string,
	content: string,
): PortablePackageFileFixture {
	const bytes = Buffer.from(content, "utf8");
	return {
		path: filePath,
		mediaType: filePath.endsWith(".json") ? "application/json" : "text/plain",
		encoding: "utf8",
		content,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		size: bytes.byteLength,
	};
}

function replaceUtf8File(
	packageFixture: PortablePackageFixture,
	filePath: string,
	content: string,
) {
	const index = packageFixture.files.findIndex(
		(file) => file.path === filePath,
	);
	if (index === -1) throw new Error(`Missing fixture file: ${filePath}`);
	const existingMediaType = packageFixture.files[index].mediaType;
	packageFixture.files[index] = {
		...packageFixture.files[index],
		...utf8File(filePath, content),
		mediaType: existingMediaType,
	};
}

function moveArtifactEntrypoint(
	packageFixture: PortablePackageFixture,
	artifactPath: string,
) {
	const artifact = packageFixture.files.find(
		(file) => file.path === packageFixture.manifest.entrypoints.artifact,
	);
	if (!artifact) throw new Error("Fixture artifact entrypoint is missing");
	artifact.path = artifactPath;
	packageFixture.manifest.entrypoints.artifact = artifactPath;
	replaceUtf8File(
		packageFixture,
		"validation/manifest.json",
		`${JSON.stringify({
			schemaVersion: "shiplet.validation/v1",
			checks: [{ kind: "file-exists", path: artifactPath }],
		})}\n`,
	);
	return sortPackageFiles(packageFixture);
}

function sortPackageFiles(packageFixture: PortablePackageFixture) {
	packageFixture.files.sort((left, right) =>
		left.path.localeCompare(right.path),
	);
	return packageFixture;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, canonicalize(child)]),
	);
}

function canonicalPackageDigest(packageFixture: PortablePackageFixture) {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(packageFixture)))
		.digest("hex");
}

function activePackagePayload(
	packageFixture: PortablePackageFixture = completePackageFixture,
) {
	return {
		package: packageFixture,
		shipletId: "project_A",
		revision: {
			id: "revision_A",
			digest: canonicalPackageDigest(packageFixture),
		},
	};
}

function committedEffectNetwork(
	command: "deploy" | "promote" | "rollback",
	payload: Record<string, unknown>,
) {
	return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		const idempotencyKey = String(
			(init?.headers as Record<string, string>)?.["idempotency-key"] || "",
		);
		return new Response(
			JSON.stringify({
				...payload,
				operation: {
					id: "operation_A",
					kind: command,
					status: "committed",
					idempotencyKey,
				},
			}),
			{ headers: { "content-type": "application/json" } },
		);
	});
}

async function writePackageEnvelope(
	directory: string,
	packageFixture: PortablePackageFixture = cloneCompletePackage(),
) {
	const packagePath = path.join(directory, "package.json");
	await writeFile(packagePath, JSON.stringify(packageFixture));
	return packagePath;
}

async function writeMaterializedPackage(
	directory: string,
	packageFixture: PortablePackageFixture = cloneCompletePackage(),
) {
	await mkdir(directory, { recursive: true });
	for (const file of packageFixture.files) {
		const outputPath = path.join(directory, ...file.path.split("/"));
		await mkdir(path.dirname(outputPath), { recursive: true });
		await writeFile(
			outputPath,
			file.encoding === "base64"
				? Buffer.from(file.content, "base64")
				: file.content,
		);
	}
	await writeFile(
		path.join(directory, "shiplet.json"),
		`${JSON.stringify(packageFixture.manifest, null, 2)}\n`,
	);
}

async function validateEnvelope(packageFixture: PortablePackageFixture) {
	const directory = await makeTempDir();
	const packagePath = await writePackageEnvelope(directory, packageFixture);
	const stdout = createWritable();
	const stderr = createWritable();
	const network = vi.fn();
	const exitCode = await cli.runCli({
		argv: ["validate", packagePath, "--json"],
		env: {},
		fetch: network as unknown as typeof fetch,
		stdout,
		stderr,
	});
	return { exitCode, stdout, stderr, network };
}

function createWritable() {
	let value = "";
	return {
		write(chunk: string) {
			value += chunk;
		},
		value() {
			return value;
		},
	};
}

describe("Shiplet CLI", () => {
	it("prepares a static folder payload in dry-run mode without making a network call", async () => {
		const artifactDir = await makeTempDir();
		await mkdir(path.join(artifactDir, "assets"));
		const html = "<h1>Review me</h1>";
		const script = "console.log('shiplet');";
		const analysis = "print('ready')";
		const geodata = "gpkg-bytes";
		await writeFile(path.join(artifactDir, "index.html"), html);
		await writeFile(path.join(artifactDir, "assets", "app.js"), script);
		await writeFile(path.join(artifactDir, "analysis.py"), analysis);
		await writeFile(path.join(artifactDir, "map.gpkg"), geodata);
		await writeFile(path.join(artifactDir, ".gitignore"), "dist/\n");

		const stdout = createWritable();
		const stderr = createWritable();
		const network = vi.fn(async () => {
			throw new Error("dry run must not call fetch");
		});

		const exitCode = await cli.runCli({
			argv: [
				"publish",
				artifactDir,
				"--name",
				"QA Bundle",
				"--subdomain",
				"qa-bundle",
				"--visibility",
				"unlisted",
				"--dry-run",
				"--json",
			],
			env: {},
			fetch: network as unknown as typeof fetch,
			stdout,
			stderr,
		});

		expect(exitCode, stderr.value()).toBe(0);
		expect(stderr.value()).toBe("");
		expect(network).not.toHaveBeenCalled();

		const body = JSON.parse(stdout.value()) as {
			ok: boolean;
			dryRun: boolean;
			action: string;
			endpoint: string;
			name: string;
			subdomain: string;
			visibility: string;
			assetCount: number;
			totalBytes: number;
			paths: string[];
			payload?: unknown;
		};

		expect(body.ok).toBe(true);
		expect(body.dryRun).toBe(true);
		expect(body.action).toBe("prepare_review_artifact");
		expect(body.endpoint).toBe("https://shiplet.cc/api/shiplets");
		expect(body.name).toBe("QA Bundle");
		expect(body.subdomain).toBe("qa-bundle");
		expect(body.visibility).toBe("unlisted");
		expect(body.assetCount).toBe(5);
		expect(body.totalBytes).toBe(
			Buffer.byteLength(html) +
				Buffer.byteLength(script) +
				Buffer.byteLength(analysis) +
				Buffer.byteLength(geodata) +
				Buffer.byteLength("dist/\n"),
		);
		expect(body.paths).toEqual([
			".gitignore",
			"analysis.py",
			"assets/app.js",
			"index.html",
			"map.gpkg",
		]);
		expect(body.payload).toBeUndefined();
		expect(stdout.value()).not.toContain(Buffer.from(html).toString("base64"));
		expect(stdout.value()).not.toContain(
			Buffer.from(script).toString("base64"),
		);
		expect(stdout.value()).not.toMatch(/production app/i);
	});

	it("treats prepare as a publish synonym and lets CLI API flags override environment config", async () => {
		const artifactDir = await makeTempDir();
		const filePath = path.join(artifactDir, "packet.pdf");
		await writeFile(filePath, "pdf-bytes");

		const stdout = createWritable();
		const stderr = createWritable();
		const network = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					ok: true,
					reviewUrl: "https://review.example.com",
					previewUrl: "/shiplets/project_123/preview",
					project: { id: "project_123", name: "Review Packet" },
				}),
				{ status: 201, headers: { "content-type": "application/json" } },
			);
		});

		const exitCode = await cli.runCli({
			argv: [
				"prepare",
				filePath,
				"--name",
				"Review Packet",
				"--subdomain",
				"review-packet",
				"--api-url",
				"https://cli.shiplet.test/",
				"--token",
				"shiplet_cli_test",
			],
			env: {
				SHIPLET_API_KEY: "shiplet_env_test",
				SHIPLET_API_URL: "https://env.shiplet.test/",
			},
			fetch: network as unknown as typeof fetch,
			stdout,
			stderr,
		});

		expect(exitCode).toBe(0);
		expect(stderr.value()).toBe("");
		expect(network).toHaveBeenCalledOnce();

		const [url, init] = network.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://cli.shiplet.test/api/shiplets");
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({
			authorization: "Bearer shiplet_cli_test",
			"content-type": "application/json",
		});
		expect(JSON.parse(String(init.body))).toEqual({
			name: "Review Packet",
			subdomain: "review-packet",
			visibility: "organization",
			assets: [
				{
					path: "packet.pdf",
					content: Buffer.from("pdf-bytes").toString("base64"),
					size: 9,
				},
			],
		});
		expect(stdout.value()).toContain("Prepared Review Packet for review");
		expect(stdout.value()).toContain("https://review.example.com");
		expect(stdout.value()).not.toContain("Preview URL");
		expect(stdout.value()).not.toMatch(/production app/i);
	});

	it("fails before upload when a live run has no API key", async () => {
		const artifactDir = await makeTempDir();
		await writeFile(path.join(artifactDir, "index.html"), "<h1>Review me</h1>");

		const stdout = createWritable();
		const stderr = createWritable();
		const network = vi.fn();

		const exitCode = await cli.runCli({
			argv: [
				"publish",
				artifactDir,
				"--name",
				"Missing Key",
				"--subdomain",
				"missing-key",
			],
			env: {},
			fetch: network as unknown as typeof fetch,
			stdout,
			stderr,
		});

		expect(exitCode).toBe(1);
		expect(stdout.value()).toBe("");
		expect(stderr.value()).toMatch(/OAuth|session/i);
		expect(stderr.value()).not.toMatch(/SHIPLET_API_KEY|--token/);
		expect(network).not.toHaveBeenCalled();
	});

	it("fails before upload for unsupported artifact file types", async () => {
		const artifactDir = await makeTempDir();
		await writeFile(path.join(artifactDir, "payload.exe"), "MZ");

		const stdout = createWritable();
		const stderr = createWritable();
		const network = vi.fn();

		const exitCode = await cli.runCli({
			argv: [
				"publish",
				artifactDir,
				"--name",
				"Unsupported",
				"--subdomain",
				"unsupported",
			],
			env: { SHIPLET_API_KEY: "shiplet_org_test" },
			fetch: network as unknown as typeof fetch,
			stdout,
			stderr,
		});

		expect(exitCode).toBe(1);
		expect(stdout.value()).toBe("");
		expect(stderr.value()).toContain("Unsupported artifact file type: .exe");
		expect(network).not.toHaveBeenCalled();
	});

	it("fails before upload for invalid requested subdomains", async () => {
		const artifactDir = await makeTempDir();
		await writeFile(path.join(artifactDir, "index.html"), "<h1>Review me</h1>");

		const stdout = createWritable();
		const stderr = createWritable();
		const network = vi.fn();

		const exitCode = await cli.runCli({
			argv: [
				"publish",
				artifactDir,
				"--name",
				"Invalid Subdomain",
				"--subdomain",
				"Invalid_Subdomain",
			],
			env: { SHIPLET_API_KEY: "shiplet_org_test" },
			fetch: network as unknown as typeof fetch,
			stdout,
			stderr,
		});

		expect(exitCode).toBe(1);
		expect(stdout.value()).toBe("");
		expect(stderr.value()).toContain("Subdomain must be DNS-safe");
		expect(network).not.toHaveBeenCalled();
	});

	it("describes review artifact preparation in help text", async () => {
		const stdout = createWritable();
		const stderr = createWritable();

		const exitCode = await cli.runCli({
			argv: ["--help"],
			env: {},
			stdout,
			stderr,
		});

		expect(exitCode).toBe(0);
		expect(stderr.value()).toBe("");
		expect(stdout.value()).toContain("prepares review artifacts");
		expect(stdout.value()).toContain("shiplet prepare <path>");
		expect(stdout.value()).toContain("--api-url <url>");
		expect(stdout.value()).toMatch(/OAuth|session/i);
		expect(stdout.value()).toContain("--token <token>");
		expect(stdout.value()).toContain("SHIPLET_API_KEY");
		expect(stdout.value()).toMatch(/secret store/i);
		expect(stdout.value()).toContain("kernel-authority-free portable package");
		expect(stdout.value()).not.toContain("credential-free portable package");
		expect(stdout.value()).not.toMatch(/production app/i);
	});

	it("exposes the complete revision command surface in help", async () => {
		const stdout = createWritable();
		const exitCode = await cli.runCli({
			argv: ["--help"],
			env: {},
			stdout,
			stderr: createWritable(),
		});
		expect(exitCode).toBe(0);
		for (const command of [
			"fork",
			"pull",
			"validate",
			"push",
			"diff",
			"deploy",
			"promote",
			"rollback",
			"eject",
		]) {
			expect(stdout.value()).toContain(`shiplet ${command}`);
		}
	});

	it.each([
		{
			argv: ["fork", "project_A"],
			url: "/api/shiplets/project_A/drafts",
			method: "POST",
			body: { fromRevisionId: null },
			response: {
				draft: {
					id: "draft_A",
					projectId: "project_A",
					baseRevisionId: "revision_A",
					version: 1,
				},
			},
		},
		{
			argv: ["deploy", "revision_A", "--target", "target_A", "--approve"],
			url: "/api/revisions/revision_A/deployments",
			method: "POST",
			body: { targetId: "target_A", approval: true },
			response: {
				deployment: {
					id: "deployment_A",
					revisionId: "revision_A",
					targetId: "target_A",
				},
			},
		},
		{
			argv: [
				"promote",
				"draft_A",
				"--expected-active",
				"revision_A",
				"--approve",
			],
			url: "/api/drafts/draft_A/promote",
			method: "POST",
			body: { expectedActiveRevisionId: "revision_A", approval: true },
			response: {
				draftId: "draft_A",
				revision: { id: "revision_B", parentRevisionId: "revision_A" },
			},
		},
		{
			argv: [
				"rollback",
				"project_A",
				"--revision",
				"revision_A",
				"--expected-active",
				"revision_B",
				"--approve",
			],
			url: "/api/shiplets/project_A/rollback",
			method: "POST",
			body: {
				revisionId: "revision_A",
				expectedActiveRevisionId: "revision_B",
				approval: true,
			},
			response: {
				shipletId: "project_A",
				revision: { id: "revision_A" },
				previousRevisionId: "revision_B",
			},
		},
	])(
		"maps $argv.0 through stable kernel endpoints without leaking its credential",
		async ({ argv, url, method, body, response }) => {
			const stdout = createWritable();
			const stderr = createWritable();
			const humanEffect = ["deploy", "promote", "rollback"].includes(argv[0]);
			const network = humanEffect
				? committedEffectNetwork(
						argv[0] as "deploy" | "promote" | "rollback",
						response,
					)
				: vi.fn(
						async () =>
							new Response(JSON.stringify(response), {
								status: 200,
								headers: { "content-type": "application/json" },
							}),
					);
			const exitCode = await cli.runCli({
				argv: [
					...argv,
					...(humanEffect ? [] : ["--token", "shiplet_cli_fixture"]),
					"--json",
				],
				env: {},
				fetch: (humanEffect ? vi.fn() : network) as unknown as typeof fetch,
				sessionFetch: humanEffect
					? (network as unknown as typeof fetch)
					: undefined,
				stdout,
				stderr,
			});
			expect(exitCode).toBe(0);
			expect(stderr.value()).toBe("");
			expect(network).toHaveBeenCalledOnce();
			const [requestUrl, init] = network.mock.calls[0] as unknown as [
				string,
				RequestInit,
			];
			expect(requestUrl).toBe(`https://shiplet.cc${url}`);
			expect(init.method).toBe(method);
			expect(init.headers).toMatchObject({
				"content-type": "application/json",
				...(humanEffect ? {} : { authorization: "Bearer shiplet_cli_fixture" }),
			});
			if (humanEffect) {
				expect(init.headers).not.toHaveProperty("authorization");
				expect(init.credentials).toBe("include");
			}
			expect(JSON.parse(String(init.body))).toEqual(body);
			expect(stdout.value()).not.toContain("shiplet_cli_fixture");
		},
	);

	it.each([
		["deploy", ["revision_A", "--target", "target_A"]],
		["promote", ["draft_A", "--expected-active", "revision_A"]],
		[
			"rollback",
			[
				"project_A",
				"--revision",
				"revision_A",
				"--expected-active",
				"revision_B",
			],
		],
	])(
		"requires explicit approval before %s side effects",
		async (command, args) => {
			const network = vi.fn();
			const stderr = createWritable();
			const exitCode = await cli.runCli({
				argv: [command, ...args, "--token", "shiplet_cli_fixture"],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout: createWritable(),
				stderr,
			});
			expect(exitCode).toBe(1);
			expect(stderr.value()).toContain("--approve");
			expect(network).not.toHaveBeenCalled();
		},
	);

	it("validates a portable envelope locally without network access or file contents in output", async () => {
		const directory = await makeTempDir();
		const packagePath = path.join(directory, "complete-v1.json");
		await writeFile(packagePath, JSON.stringify(completePackageFixture));
		const stdout = createWritable();
		const stderr = createWritable();
		const network = vi.fn();
		const exitCode = await cli.runCli({
			argv: ["validate", packagePath, "--json"],
			env: {},
			fetch: network as unknown as typeof fetch,
			stdout,
			stderr,
		});
		expect(exitCode, stderr.value()).toBe(0);
		expect(network).not.toHaveBeenCalled();
		const result = JSON.parse(stdout.value()) as {
			ok: boolean;
			schemaVersion: string;
			fileCount: number;
			paths: string[];
		};
		expect(result.ok).toBe(true);
		expect(result.schemaVersion).toBe("shiplet.package/v1");
		expect(result.fileCount).toBeGreaterThan(0);
		expect(result.paths).toEqual([...result.paths].sort());
		for (const entry of completePackageFixture.files) {
			expect(stdout.value()).not.toContain(entry.content);
		}
	});

	it.each(["push", "diff"])(
		"sends %s through the package contract with an optimistic draft version",
		async (command) => {
			const directory = await makeTempDir();
			const packagePath = path.join(directory, "package.json");
			await writeFile(packagePath, JSON.stringify(completePackageFixture));
			const packageDigest = canonicalPackageDigest(completePackageFixture);
			const network = vi.fn(
				async () =>
					new Response(
						JSON.stringify(
							command === "push"
								? {
										draft: { id: "draft_A", version: 8 },
										packageDigest,
									}
								: {
										draftId: "draft_A",
										draftVersion: 7,
										currentDigest: "a".repeat(64),
										proposedDigest: packageDigest,
										changed: true,
									},
						),
						{ headers: { "content-type": "application/json" } },
					),
			);
			const stdout = createWritable();
			const exitCode = await cli.runCli({
				argv: [
					command,
					"draft_A",
					packagePath,
					"--version",
					"7",
					"--token",
					"shiplet_cli_fixture",
					"--json",
				],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout,
				stderr: createWritable(),
			});
			expect(exitCode).toBe(0);
			const [url, init] = network.mock.calls[0] as unknown as [
				string,
				RequestInit,
			];
			expect(url).toBe(
				`https://shiplet.cc/api/drafts/draft_A/${command === "push" ? "package" : "diff"}`,
			);
			expect(init.method).toBe(command === "push" ? "PUT" : "POST");
			expect(init.headers).toMatchObject({ "if-match": "7" });
			const body = JSON.parse(String(init.body)) as {
				package: { mediaType: string };
				expectedVersion: string;
			};
			expect(body.package.mediaType).toBe(
				"application/vnd.shiplet.package+json;version=1",
			);
			expect(body.expectedVersion).toBe("7");
			expect(stdout.value()).not.toContain("shiplet_cli_fixture");
		},
	);

	it.each(["pull", "eject"])(
		"materializes a credential-free package for %s without inventing archive semantics",
		async (command) => {
			const root = await makeTempDir();
			const destination = path.join(root, command);
			const network = vi.fn(
				async () =>
					new Response(JSON.stringify(activePackagePayload()), {
						headers: { "content-type": "application/json" },
					}),
			);
			const stdout = createWritable();
			const exitCode = await cli.runCli({
				argv: [
					command,
					"project_A",
					destination,
					"--token",
					"shiplet_cli_fixture",
					"--json",
				],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout,
				stderr: createWritable(),
			});
			expect(exitCode).toBe(0);
			const [url, init] = network.mock.calls[0] as unknown as [
				string,
				RequestInit,
			];
			expect(url).toBe(
				`https://shiplet.cc/api/shiplets/project_A/package${command === "eject" ? "?disposition=eject" : ""}`,
			);
			expect(init.method).toBe("GET");
			expect(
				await readFileText(path.join(destination, "shiplet.json")),
			).toContain('"schemaVersion": "shiplet.package/v1"');
			expect(
				await readFileText(path.join(destination, "artifact", "index.html")),
			).toContain("Portable Shiplet");
			const result = JSON.parse(stdout.value()) as { paths: string[] };
			expect(result.paths).toContain("AGENTS.md");
			expect(stdout.value()).not.toContain("Portable Shiplet</main>");
		},
	);

	it("rejects hostile exported paths and identifier injection before writing or fetching", async () => {
		const root = await makeTempDir();
		const destination = path.join(root, "hostile");
		const hostile = structuredClone(
			completePackageFixture,
		) as typeof completePackageFixture;
		hostile.files = [
			{
				path: "../outside.txt",
				mediaType: "text/plain",
				encoding: "utf8",
				content: "outside",
				sha256: "",
				size: 7,
			} as (typeof hostile.files)[number],
		];
		const hostileNetwork = vi.fn(
			async () =>
				new Response(JSON.stringify({ package: hostile }), {
					headers: { "content-type": "application/json" },
				}),
		);
		const hostileError = createWritable();
		const hostileExit = await cli.runCli({
			argv: [
				"pull",
				"project_A",
				destination,
				"--token",
				"shiplet_cli_fixture",
			],
			env: {},
			fetch: hostileNetwork as unknown as typeof fetch,
			stdout: createWritable(),
			stderr: hostileError,
		});
		expect(hostileExit).toBe(1);
		expect(hostileError.value()).toContain("Unsafe package file path");
		expect(await fileExists(path.join(root, "outside.txt"))).toBe(false);

		const injectionNetwork = vi.fn();
		const injectionExit = await cli.runCli({
			argv: ["fork", "../project_B", "--token", "shiplet_cli_fixture"],
			env: {},
			fetch: injectionNetwork as unknown as typeof fetch,
			stdout: createWritable(),
			stderr: createWritable(),
		});
		expect(injectionExit).toBe(1);
		expect(injectionNetwork).not.toHaveBeenCalled();
	});

	it("redacts credential-shaped fields from API failures", async () => {
		const stderr = createWritable();
		const network = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						message: "denied",
						accessToken: "fixture-access-value",
						claimUrl: "https://claim.example/fixture",
					}),
					{ status: 403, headers: { "content-type": "application/json" } },
				),
		);
		const exitCode = await cli.runCli({
			argv: ["fork", "project_A", "--token", "shiplet_cli_fixture"],
			env: {},
			fetch: network as unknown as typeof fetch,
			stdout: createWritable(),
			stderr,
		});
		expect(exitCode).toBe(1);
		expect(stderr.value()).toContain("denied");
		expect(stderr.value()).not.toContain("fixture-access-value");
		expect(stderr.value()).not.toContain("claim.example");
		expect(stderr.value()).not.toContain("shiplet_cli_fixture");
	});

	describe("canonical portable package parity", () => {
		it("Given a required entrypoint is absent, when validate runs, then the package is rejected", async () => {
			const packageFixture = cloneCompletePackage();
			delete packageFixture.manifest.entrypoints.validation;

			const result = await validateEnvelope(packageFixture);

			expect(result.exitCode).toBe(1);
			expect(result.stderr.value()).toMatch(/entrypoint|manifest/i);
			expect(result.network).not.toHaveBeenCalled();
		});

		it.each([
			'<script type="module" src="./widget.js"></script>',
			'<img srcset="./small.png 1x, ./large.png 2x" alt="">',
			'<img src="./missing.png" alt="">',
			'<img src=./missing.png alt="">',
			'<iframe src="./widget.js"></iframe>',
			'<button onclick="import(\'data:text/javascript,export default true\')">Run</button>',
			'<script src="data:text/javascript,import(\'data:text/javascript,export default true\')"></script>',
			'<svg><script href="./widget.js"></script></svg>',
			'<svg><script xlink:href="./widget.js"></script></svg>',
		])(
			"Given runtime-v1 widget HTML has an unsupported dependency graph, when CLI validate runs, then it fails locally",
			async (widgetHtml) => {
				const packageFixture = cloneCompletePackage();
				replaceUtf8File(packageFixture, "widget/index.html", widgetHtml);

				const result = await validateEnvelope(packageFixture);

				expect(result.exitCode).toBe(1);
				expect(result.stderr.value()).toMatch(/unsupported widget dependency/i);
				expect(result.network).not.toHaveBeenCalled();
			},
		);

		it("Given a runtime-v1 widget authors a data script source, when CLI validate runs, then it rejects the uninspectable executable source", async () => {
			const packageFixture = cloneCompletePackage();
			replaceUtf8File(
				packageFixture,
				"widget/index.html",
				'<script src="data:text/javascript,document.body.dataset.ready=String(true)"></script>',
			);
			const widgetEntry = packageFixture.files.find(
				(file) => file.path === "widget/index.html",
			);
			if (!widgetEntry) throw new Error("Missing widget entrypoint fixture");
			widgetEntry.mediaType = "text/html; charset=utf-8";

			const result = await validateEnvelope(packageFixture);

			expect(result.exitCode).toBe(1);
			expect(result.stderr.value()).toMatch(/unsupported widget dependency/i);
			expect(result.network).not.toHaveBeenCalled();
		});

		it.each([
			'const Background = Worker; new Background("data:text/javascript,postMessage(true)");',
			'new globalThis.Worker("data:text/javascript,postMessage(true)");',
		])(
			"Given widget source aliases a Worker constructor, when CLI validate runs, then it fails locally",
			async (source) => {
				const packageFixture = cloneCompletePackage();
				replaceUtf8File(packageFixture, "widget/widget.js", source);

				const result = await validateEnvelope(packageFixture);

				expect(result.exitCode).toBe(1);
				expect(result.stderr.value()).toMatch(/unsupported widget dependency/i);
				expect(result.network).not.toHaveBeenCalled();
			},
		);

		it("Given malformed widget JavaScript, when CLI validate runs, then it fails locally before any network request", async () => {
			const packageFixture = cloneCompletePackage();
			replaceUtf8File(packageFixture, "widget/widget.js", "const broken = ;");

			const result = await validateEnvelope(packageFixture);

			expect(result.exitCode).toBe(1);
			expect(result.stderr.value()).toMatch(/unsupported widget dependency/i);
			expect(result.network).not.toHaveBeenCalled();
		});

		it("Given classic widget source only mentions import syntax inside inert strings and comments, when CLI validate runs, then it remains valid", async () => {
			const packageFixture = cloneCompletePackage();
			replaceUtf8File(
				packageFixture,
				"widget/widget.js",
				'const example = "import(\\"./not-code.js\\")"; // new Worker("./also-not-code.js")\ndocument.body.dataset.example = example;',
			);
			const widgetScript = packageFixture.files.find(
				(file) => file.path === "widget/widget.js",
			);
			if (!widgetScript) throw new Error("Missing widget script fixture");
			widgetScript.mediaType = "text/javascript; charset=utf-8";

			const result = await validateEnvelope(packageFixture);

			expect(result.exitCode, result.stderr.value()).toBe(0);
			expect(result.network).not.toHaveBeenCalled();
		});

		it.each([
			[
				"workflow/schema.json",
				JSON.stringify({
					schemaVersion: "shiplet.workflow/v1",
					statuses: "open",
					fields: [],
				}),
			],
			[
				"mcp/manifest.json",
				JSON.stringify({
					schemaVersion: "shiplet.mcp/v1",
					tools: [{ name: "missing-handler" }],
				}),
			],
			[
				"validation/manifest.json",
				JSON.stringify({
					schemaVersion: "shiplet.validation/v1",
					checks: [{ kind: "shell", path: "artifact/index.html" }],
				}),
			],
		])(
			"Given %s violates its declared schema, when validate runs, then the package is rejected",
			async (filePath, content) => {
				const packageFixture = cloneCompletePackage();
				replaceUtf8File(packageFixture, filePath, content);

				const result = await validateEnvelope(packageFixture);

				expect(result.exitCode).toBe(1);
				expect(result.stderr.value()).toMatch(/schema|invalid/i);
				expect(result.network).not.toHaveBeenCalled();
			},
		);

		it.each([
			["fileCount", 1],
			["fileBytes", 1],
			["packageBytes", 1],
		])(
			"Given manifest.limits.%s is exceeded, when validate runs, then the declared bound is enforced",
			async (limitName, limit) => {
				const packageFixture = cloneCompletePackage();
				packageFixture.manifest.limits[limitName] = limit;

				const result = await validateEnvelope(packageFixture);

				expect(result.exitCode).toBe(1);
				expect(result.stderr.value()).toMatch(/limit|large/i);
			},
		);

		it.each([
			"notes/readme.txt",
			"deployment/provider.json",
			"deployments/provider.json",
			"claim/provider.json",
		])(
			"Given the envelope contains non-contract or authority path %s, when validate runs, then export is rejected",
			async (filePath) => {
				const packageFixture = cloneCompletePackage();
				packageFixture.files.push(utf8File(filePath, "fixture-only\n"));
				sortPackageFiles(packageFixture);

				const result = await validateEnvelope(packageFixture);

				expect(result.exitCode).toBe(1);
				expect(result.stderr.value()).toMatch(/authority|path|forbidden/i);
			},
		);

		it("Given a file record contains credential-shaped metadata, when validate runs, then it is rejected", async () => {
			const packageFixture = cloneCompletePackage();
			packageFixture.files[0].authorization = "fixture-metadata-marker";

			const result = await validateEnvelope(packageFixture);

			expect(result.exitCode).toBe(1);
			expect(result.stderr.value()).toMatch(/credential|authority|file/i);
		});

		it.each([
			["envelope", "archiveFormat"],
			["manifest", "deploymentPolicy"],
		] as const)(
			"Given the %s contains unknown field %s, when validate runs, then the exact contract rejects it",
			async (location, field) => {
				const packageFixture = cloneCompletePackage();
				if (location === "envelope") packageFixture[field] = "fixture";
				else packageFixture.manifest[field] = "fixture";

				const result = await validateEnvelope(packageFixture);

				expect(result.exitCode).toBe(1);
				expect(result.stderr.value()).toMatch(/package|manifest|invalid/i);
			},
		);

		it.each([
			"artifact/CON.txt",
			"artifact/bad?.txt",
			"artifact\\windows.html",
			"artifact/control\u0001.txt",
			"artifact/trailing.",
			"artifact/trailing ",
		])(
			"Given package path %s is not portable to Windows, when validate runs, then it is rejected like the kernel",
			async (filePath) => {
				const packageFixture = cloneCompletePackage();
				const candidate = packageFixture.files.find(
					(file) => file.path === "artifact/icon.bin",
				);
				if (!candidate) throw new Error("Missing portable path fixture");
				candidate.path = filePath;
				sortPackageFiles(packageFixture);

				const result = await validateEnvelope(packageFixture);

				expect(result.exitCode).toBe(1);
				expect(result.stderr.value()).toMatch(/path|portable|unsafe/i);
			},
		);

		it("Given a valid envelope, when validate emits JSON, then it includes the canonical package digest", async () => {
			const packageFixture = cloneCompletePackage();
			const result = await validateEnvelope(packageFixture);

			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout.value())).toMatchObject({
				packageDigest: canonicalPackageDigest(packageFixture),
			});
		});
	});

	describe("safe package materialization", () => {
		it("Given an output ancestor is a symlink, when pull runs, then no package content is written outside the selected tree", async () => {
			const root = await makeTempDir();
			const outside = await makeTempDir();
			const linkedParent = path.join(root, "linked-parent");
			await symlink(outside, linkedParent, "dir");
			const destination = path.join(linkedParent, "exported");
			const network = vi.fn(
				async () =>
					new Response(JSON.stringify(activePackagePayload()), {
						headers: { "content-type": "application/json" },
					}),
			);
			const stderr = createWritable();

			const exitCode = await cli.runCli({
				argv: [
					"pull",
					"project_A",
					destination,
					"--token",
					"shiplet_cli_fixture",
				],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout: createWritable(),
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(stderr.value()).toMatch(/symbolic link|symlink/i);
			expect(
				await fileExists(path.join(outside, "exported", "AGENTS.md")),
			).toBe(false);
		});

		it("Given a nested package file is a symlink, when forced pull runs, then the linked target is untouched", async () => {
			const root = await makeTempDir();
			const destination = path.join(root, "exported");
			const outside = await makeTempDir();
			await mkdir(path.join(destination, "artifact"), { recursive: true });
			await writeFile(path.join(outside, "index.html"), "outside sentinel");
			await symlink(
				path.join(outside, "index.html"),
				path.join(destination, "artifact", "index.html"),
				"file",
			);
			const network = vi.fn(
				async () =>
					new Response(JSON.stringify(activePackagePayload()), {
						headers: { "content-type": "application/json" },
					}),
			);

			const exitCode = await cli.runCli({
				argv: [
					"pull",
					"project_A",
					destination,
					"--force",
					"--token",
					"shiplet_cli_fixture",
				],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout: createWritable(),
				stderr: createWritable(),
			});

			expect(exitCode).toBe(1);
			expect(await readFile(path.join(outside, "index.html"), "utf8")).toBe(
				"outside sentinel",
			);
		});

		it("Given a forced destination contains stale forbidden files, when pull succeeds, then replacement removes the stale files", async () => {
			const root = await makeTempDir();
			const destination = path.join(root, "exported");
			await mkdir(path.join(destination, "credentials"), { recursive: true });
			await writeFile(
				path.join(destination, "credentials", "old.json"),
				"stale fixture",
			);
			const network = vi.fn(
				async () =>
					new Response(JSON.stringify(activePackagePayload()), {
						headers: { "content-type": "application/json" },
					}),
			);

			const exitCode = await cli.runCli({
				argv: [
					"pull",
					"project_A",
					destination,
					"--force",
					"--token",
					"shiplet_cli_fixture",
				],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout: createWritable(),
				stderr: createWritable(),
			});

			expect(exitCode).toBe(0);
			expect(
				await fileExists(path.join(destination, "credentials", "old.json")),
			).toBe(false);
		});

		it("Given stale destination paths conflict with package file types, when forced pull runs, then one complete replacement is installed", async () => {
			const root = await makeTempDir();
			const destination = path.join(root, "exported");
			await mkdir(path.join(destination, "artifact", "app.js"), {
				recursive: true,
			});
			await writeFile(
				path.join(destination, "AGENTS.md"),
				"prior package sentinel\n",
			);
			const network = vi.fn(
				async () =>
					new Response(JSON.stringify(activePackagePayload()), {
						headers: { "content-type": "application/json" },
					}),
			);

			const exitCode = await cli.runCli({
				argv: [
					"pull",
					"project_A",
					destination,
					"--force",
					"--token",
					"shiplet_cli_fixture",
				],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout: createWritable(),
				stderr: createWritable(),
			});

			expect(exitCode).toBe(0);
			expect(
				await readFile(path.join(destination, "AGENTS.md"), "utf8"),
			).toContain("# Reviewer agent");
			expect(
				await readFile(path.join(destination, "artifact", "app.js"), "utf8"),
			).toContain("dataset.ready");
		});
	});

	describe("constrained API transport", () => {
		it.each([
			"http://api.example.invalid",
			"https://userinfo.invalid@api.example.invalid",
			"https://api.example.invalid/base?trace=1",
			"https://api.example.invalid/base#fragment",
		])(
			"Given API URL %s is not an origin-only HTTPS endpoint, when a command runs, then it fails before fetch",
			async (apiUrl) => {
				const network = vi.fn(
					async () =>
						new Response(JSON.stringify({ ok: true }), {
							headers: { "content-type": "application/json" },
						}),
				);
				const stderr = createWritable();

				const exitCode = await cli.runCli({
					argv: [
						"fork",
						"project_A",
						"--api-url",
						apiUrl,
						"--token",
						"shiplet_cli_fixture",
					],
					env: {},
					fetch: network as unknown as typeof fetch,
					stdout: createWritable(),
					stderr,
				});

				expect(exitCode).toBe(1);
				expect(stderr.value()).toMatch(/https|origin|API URL/i);
				expect(network).not.toHaveBeenCalled();
			},
		);

		it("Given an explicit loopback HTTP URL, when a command runs, then local development remains supported", async () => {
			const network = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							draft: {
								id: "draft_A",
								baseRevisionId: "revision_A",
								version: 1,
							},
						}),
						{
							headers: { "content-type": "application/json" },
						},
					),
			);
			const exitCode = await cli.runCli({
				argv: [
					"fork",
					"project_A",
					"--api-url",
					"http://127.0.0.1:8787",
					"--token",
					"shiplet_cli_fixture",
				],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout: createWritable(),
				stderr: createWritable(),
			});

			expect(exitCode).toBe(0);
			const [requestUrl] = network.mock.calls[0] as unknown as [
				string,
				RequestInit,
			];
			expect(requestUrl).toBe(
				"http://127.0.0.1:8787/api/shiplets/project_A/drafts",
			);
		});

		it("Given a kernel request, when fetch starts, then redirects are disabled and a timeout signal is attached", async () => {
			let init: RequestInit | undefined;
			const network = vi.fn(
				async (_url: string | URL | Request, requestInit?: RequestInit) => {
					init = requestInit;
					return new Response(
						JSON.stringify({
							draft: {
								id: "draft_A",
								baseRevisionId: "revision_A",
								version: 1,
							},
						}),
						{
							headers: { "content-type": "application/json" },
						},
					);
				},
			);

			const exitCode = await cli.runCli({
				argv: ["fork", "project_A", "--token", "shiplet_cli_fixture"],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout: createWritable(),
				stderr: createWritable(),
			});

			expect(exitCode).toBe(0);
			expect(init?.redirect).toBe("error");
			expect(init?.signal).toBeInstanceOf(AbortSignal);
		});

		it("Given fetch aborts, when the timeout boundary fires, then the CLI reports a bounded timeout error", async () => {
			let capturedSignal: AbortSignal | null | undefined;
			const network = vi.fn(
				async (_url: string | URL | Request, init?: RequestInit) => {
					capturedSignal = init?.signal;
					throw new DOMException("fixture abort", "AbortError");
				},
			);
			const stderr = createWritable();

			const exitCode = await cli.runCli({
				argv: ["fork", "project_A", "--token", "shiplet_cli_fixture"],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout: createWritable(),
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(capturedSignal).toBeInstanceOf(AbortSignal);
			expect(stderr.value()).toMatch(/timed out|timeout/i);
		});

		it("Given an oversized API response, when it is read, then the CLI stops at a fixed byte bound without calling unbounded text()", async () => {
			const chunk = new Uint8Array(700_000);
			const text = vi.fn(async () => "unbounded text reader was used");
			const response = {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers({ "content-type": "application/json" }),
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(chunk);
						controller.enqueue(chunk);
						controller.close();
					},
				}),
				text,
			};
			const stderr = createWritable();
			const exitCode = await cli.runCli({
				argv: ["fork", "project_A", "--token", "shiplet_cli_fixture"],
				env: {},
				fetch: vi.fn(async () => response) as unknown as typeof fetch,
				stdout: createWritable(),
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(stderr.value()).toMatch(/response.*large|byte limit/i);
			expect(text).not.toHaveBeenCalled();
		});
	});

	describe("content-aware output redaction", () => {
		const sensitiveMarker = "fixture-sensitive-marker";
		const claimLikeUrl = `https://claim.invalid/continue?code=${sensitiveMarker}`;

		it.each([
			["success", 200],
			["failure", 403],
		] as const)(
			"Given a JSON %s embeds authority in ordinary text, when output is rendered, then values and claim-like URLs are redacted",
			async (_outcome, status) => {
				const stdout = createWritable();
				const stderr = createWritable();
				const network = vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								draft: {
									id: "draft_A",
									baseRevisionId: "revision_A",
									version: 1,
								},
								message: `request result; Authorization: Bearer ${sensitiveMarker}; continue at ${claimLikeUrl}`,
							}),
							{ status, headers: { "content-type": "application/json" } },
						),
				);

				const exitCode = await cli.runCli({
					argv: [
						"fork",
						"project_A",
						"--token",
						"shiplet_cli_fixture",
						"--json",
					],
					env: {},
					fetch: network as unknown as typeof fetch,
					stdout,
					stderr,
				});
				const output = `${stdout.value()}${stderr.value()}`;

				expect(exitCode).toBe(status < 400 ? 0 : 1);
				expect(output).not.toContain(sensitiveMarker);
				expect(output).not.toContain("claim.invalid");
				expect(output).toContain("request result");
			},
		);

		it("Given a plain-text API failure embeds authority, when it is rendered, then the error is redacted", async () => {
			const stderr = createWritable();
			const network = vi.fn(
				async () =>
					new Response(
						`denied; Authorization: Bearer ${sensitiveMarker}; ${claimLikeUrl}`,
						{ status: 403, headers: { "content-type": "text/plain" } },
					),
			);

			const exitCode = await cli.runCli({
				argv: ["fork", "project_A", "--token", "shiplet_cli_fixture"],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout: createWritable(),
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(stderr.value()).toContain("denied");
			expect(stderr.value()).not.toContain(sensitiveMarker);
			expect(stderr.value()).not.toContain("claim.invalid");
		});

		it("Given a plain-text API success has no required result ID and embeds authority, when the command completes, then it fails closed without echoing authority", async () => {
			const stdout = createWritable();
			const stderr = createWritable();
			const network = vi.fn(
				async () =>
					new Response(
						`created; Authorization: Bearer ${sensitiveMarker}; ${claimLikeUrl}`,
						{ status: 200, headers: { "content-type": "text/plain" } },
					),
			);

			const exitCode = await cli.runCli({
				argv: ["fork", "project_A", "--token", "shiplet_cli_fixture", "--json"],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout,
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(stdout.value()).not.toContain(sensitiveMarker);
			expect(stdout.value()).not.toContain("claim.invalid");
			expect(stderr.value()).not.toContain(sensitiveMarker);
			expect(stderr.value()).not.toContain("claim.invalid");
		});

		it("Given legacy publish succeeds with a claim-like review URL, when output is rendered, then authority is not printed", async () => {
			const artifactDir = await makeTempDir();
			await writeFile(
				path.join(artifactDir, "index.html"),
				"<h1>Safe fixture</h1>",
			);
			const stdout = createWritable();
			const network = vi.fn(
				async () =>
					new Response(JSON.stringify({ ok: true, reviewUrl: claimLikeUrl }), {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
			);

			const exitCode = await cli.runCli({
				argv: ["publish", artifactDir, "--token", "shiplet_cli_fixture"],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout,
				stderr: createWritable(),
			});

			expect(exitCode).toBe(0);
			expect(stdout.value()).toContain("Prepared");
			expect(stdout.value()).not.toContain(sensitiveMarker);
			expect(stdout.value()).not.toContain("claim.invalid");
		});

		it("Given legacy publish fails with plain-text authority, when output is rendered, then the error is redacted", async () => {
			const artifactDir = await makeTempDir();
			await writeFile(
				path.join(artifactDir, "index.html"),
				"<h1>Safe fixture</h1>",
			);
			const stderr = createWritable();
			const network = vi.fn(
				async () =>
					new Response(
						`denied; Authorization: Bearer ${sensitiveMarker}; ${claimLikeUrl}`,
						{ status: 403, headers: { "content-type": "text/plain" } },
					),
			);

			const exitCode = await cli.runCli({
				argv: ["publish", artifactDir, "--token", "shiplet_cli_fixture"],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout: createWritable(),
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(stderr.value()).toContain("denied");
			expect(stderr.value()).not.toContain(sensitiveMarker);
			expect(stderr.value()).not.toContain("claim.invalid");
		});
	});

	describe("editable directory and stable selection workflow", () => {
		it("Given pull materializes a package directory, when validate consumes that directory, then it produces the same canonical digest", async () => {
			const root = await makeTempDir();
			const destination = path.join(root, "editable");
			const network = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							package: completePackageFixture,
							shipletId: "project_A",
							revision: {
								id: "revision_A",
								digest: canonicalPackageDigest(completePackageFixture),
							},
						}),
						{ headers: { "content-type": "application/json" } },
					),
			);
			const pullExit = await cli.runCli({
				argv: [
					"pull",
					"project_A",
					destination,
					"--token",
					"shiplet_cli_fixture",
				],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout: createWritable(),
				stderr: createWritable(),
			});
			const stdout = createWritable();
			const validateExit = await cli.runCli({
				argv: ["validate", destination, "--json"],
				env: {},
				fetch: vi.fn() as unknown as typeof fetch,
				stdout,
				stderr: createWritable(),
			});

			expect(pullExit).toBe(0);
			expect(validateExit).toBe(0);
			expect(JSON.parse(stdout.value())).toMatchObject({
				packageDigest: canonicalPackageDigest(completePackageFixture),
			});
		});

		it.each(["push", "diff"])(
			"Given an editable materialized directory, when %s runs, then it deterministically packs the package before the exact draft request",
			async (command) => {
				const root = await makeTempDir();
				const directory = path.join(root, "editable");
				await writeMaterializedPackage(directory);
				const packageDigest = canonicalPackageDigest(completePackageFixture);
				const network = vi.fn(
					async () =>
						new Response(
							JSON.stringify(
								command === "push"
									? {
											draft: { id: "draft_A", version: 8 },
											packageDigest,
										}
									: {
											draftId: "draft_A",
											draftVersion: 7,
											currentDigest: "a".repeat(64),
											proposedDigest: packageDigest,
											changed: true,
										},
							),
							{ headers: { "content-type": "application/json" } },
						),
				);

				const exitCode = await cli.runCli({
					argv: [
						command,
						"draft_A",
						directory,
						"--version",
						"7",
						"--token",
						"shiplet_cli_fixture",
					],
					env: {},
					fetch: network as unknown as typeof fetch,
					stdout: createWritable(),
					stderr: createWritable(),
				});

				expect(exitCode).toBe(0);
				expect(network).toHaveBeenCalledOnce();
				const [requestUrl, init] = network.mock.calls[0] as unknown as [
					string,
					RequestInit,
				];
				expect(requestUrl).toBe(
					`https://shiplet.cc/api/drafts/draft_A/${command === "push" ? "package" : "diff"}`,
				);
				expect(init.headers).toMatchObject({ "if-match": "7" });
				const body = JSON.parse(String(init.body)) as {
					package: PortablePackageFixture;
				};
				expect(canonicalPackageDigest(body.package)).toBe(
					canonicalPackageDigest(completePackageFixture),
				);
			},
		);

		it("Given pull returns the active revision, when JSON output is requested, then the exact selected revision and package digest are reported", async () => {
			const root = await makeTempDir();
			const destination = path.join(root, "selected");
			const stdout = createWritable();
			const network = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							package: completePackageFixture,
							shipletId: "project_A",
							revision: {
								id: "revision_A",
								digest: canonicalPackageDigest(completePackageFixture),
							},
						}),
						{ headers: { "content-type": "application/json" } },
					),
			);

			const exitCode = await cli.runCli({
				argv: [
					"pull",
					"project_A",
					destination,
					"--token",
					"shiplet_cli_fixture",
					"--json",
				],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout,
				stderr: createWritable(),
			});

			expect(exitCode).toBe(0);
			const [requestUrl] = network.mock.calls[0] as unknown as [
				string,
				RequestInit,
			];
			expect(requestUrl).toBe(
				"https://shiplet.cc/api/shiplets/project_A/package",
			);
			expect(JSON.parse(stdout.value())).toMatchObject({
				shipletId: "project_A",
				revisionId: "revision_A",
				packageDigest: canonicalPackageDigest(completePackageFixture),
			});
		});

		it("Given fork returns the kernel draft envelope, when JSON output is requested, then stable IDs are normalized at the top level", async () => {
			const stdout = createWritable();
			const network = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							draft: {
								id: "draft_A",
								projectId: "project_A",
								baseRevisionId: "revision_A",
								version: 1,
							},
						}),
						{ status: 201, headers: { "content-type": "application/json" } },
					),
			);

			const exitCode = await cli.runCli({
				argv: [
					"fork",
					"project_A",
					"--from-revision",
					"revision_A",
					"--token",
					"shiplet_cli_fixture",
					"--json",
				],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout,
				stderr: createWritable(),
			});

			expect(exitCode).toBe(0);
			const [, init] = network.mock.calls[0] as unknown as [
				string,
				RequestInit,
			];
			expect(JSON.parse(String(init.body))).toEqual({
				fromRevisionId: "revision_A",
			});
			expect(JSON.parse(stdout.value())).toMatchObject({
				action: "fork",
				shipletId: "project_A",
				draftId: "draft_A",
				baseRevisionId: "revision_A",
				draftVersion: 1,
			});
		});

		it("Given draft and revision selectors are both passed to pull, when selection is ambiguous, then the CLI rejects before fetching", async () => {
			const network = vi.fn();
			const stderr = createWritable();

			const exitCode = await cli.runCli({
				argv: [
					"pull",
					"project_A",
					"output",
					"--revision",
					"revision_A",
					"--draft",
					"draft_A",
					"--token",
					"shiplet_cli_fixture",
				],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout: createWritable(),
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(stderr.value()).toMatch(/either.*--draft.*--revision|not both/i);
			expect(network).not.toHaveBeenCalled();
		});
	});

	describe("kernel-backed revision workflow contract", () => {
		it("Given a locally valid package and draft, when validate runs, then the exact immutable revision and authenticated preview URL are first-class output", async () => {
			const directory = await makeTempDir();
			const packagePath = await writePackageEnvelope(directory);
			const stdout = createWritable();
			const stderr = createWritable();
			const packageDigest = canonicalPackageDigest(completePackageFixture);
			const network = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							validation: {
								ok: true,
								draftId: "draft_A",
								draftVersion: 7,
								revisionId: "revision_validated_A",
								previewUrl:
									"https://shiplet.cc/shiplets/project_A/drafts/draft_A/revisions/revision_validated_A/versions/7/preview",
								packageDigest,
								errors: [],
							},
						}),
						{ headers: { "content-type": "application/json" } },
					),
			);

			const exitCode = await cli.runCli({
				argv: [
					"validate",
					"draft_A",
					packagePath,
					"--version",
					"7",
					"--token",
					"shiplet_cli_fixture",
					"--json",
				],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout,
				stderr,
			});

			expect(exitCode).toBe(0);
			expect(stderr.value()).toBe("");
			expect(network).toHaveBeenCalledOnce();
			const [requestUrl, init] = network.mock.calls[0] as unknown as [
				string,
				RequestInit,
			];
			expect(requestUrl).toBe("https://shiplet.cc/api/drafts/draft_A/validate");
			expect(init.method).toBe("POST");
			expect(init.headers).toMatchObject({ "if-match": "7" });
			expect(JSON.parse(String(init.body))).toEqual({
				expectedVersion: 7,
				packageDigest,
				package: completePackageFixture,
			});
			expect(JSON.parse(stdout.value())).toEqual({
				ok: true,
				action: "validate",
				draftId: "draft_A",
				draftVersion: 7,
				revisionId: "revision_validated_A",
				previewUrl:
					"https://shiplet.cc/shiplets/project_A/drafts/draft_A/revisions/revision_validated_A/versions/7/preview",
				packageDigest,
			});
		});

		it.each([
			["missing", undefined],
			[
				"credential-bearing",
				"https://shiplet.cc/shiplets/project_A/preview?token=secret",
			],
			["foreign-origin", "https://example.com/shiplets/project_A/preview"],
		])(
			"Given a %s validation preview URL, when validate normalizes server output, then it fails closed",
			async (_label, previewUrl) => {
				const directory = await makeTempDir();
				const packagePath = await writePackageEnvelope(directory);
				const stderr = createWritable();
				const packageDigest = canonicalPackageDigest(completePackageFixture);
				const network = vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								validation: {
									ok: true,
									draftId: "draft_A",
									draftVersion: 7,
									revisionId: "revision_validated_A",
									...(previewUrl === undefined ? {} : { previewUrl }),
									packageDigest,
									errors: [],
								},
							}),
							{ headers: { "content-type": "application/json" } },
						),
				);

				const exitCode = await cli.runCli({
					argv: [
						"validate",
						"draft_A",
						packagePath,
						"--version",
						"7",
						"--token",
						"shiplet_cli_fixture",
						"--json",
					],
					env: {},
					fetch: network as unknown as typeof fetch,
					stdout: createWritable(),
					stderr,
				});

				expect(exitCode).toBe(1);
				expect(stderr.value()).toMatch(/preview URL/i);
			},
		);

		it.each([
			{
				label: "draft",
				selector: ["--draft", "draft_A"],
				requestUrl: "https://shiplet.cc/api/drafts/draft_A/package",
				response: {
					package: completePackageFixture,
					draft: {
						id: "draft_A",
						projectId: "project_A",
						baseRevisionId: "revision_A",
						version: 3,
						validationState: "pending",
					},
				},
				expected: {
					shipletId: "project_A",
					draftId: "draft_A",
					baseRevisionId: "revision_A",
					draftVersion: 3,
					validationState: "pending",
				},
			},
			{
				label: "revision",
				selector: ["--revision", "revision_A"],
				requestUrl:
					"https://shiplet.cc/api/shiplets/project_A/revisions/revision_A/package",
				response: {
					package: completePackageFixture,
					shipletId: "project_A",
					revision: {
						id: "revision_A",
						parentRevisionId: "revision_parent",
						digest: canonicalPackageDigest(completePackageFixture),
						contentDigest: "b".repeat(64),
					},
				},
				expected: {
					shipletId: "project_A",
					revisionId: "revision_A",
					parentRevisionId: "revision_parent",
					revisionDigest: canonicalPackageDigest(completePackageFixture),
					contentDigest: "b".repeat(64),
				},
			},
		])(
			"Given an exact $label selector, when pull runs, then it materializes that immutable selection instead of silently falling back to active",
			async ({ selector, requestUrl, response, expected }) => {
				const root = await makeTempDir();
				const destination = path.join(root, "selected");
				const stdout = createWritable();
				const network = vi.fn(
					async () =>
						new Response(JSON.stringify(response), {
							headers: { "content-type": "application/json" },
						}),
				);

				const exitCode = await cli.runCli({
					argv: [
						"pull",
						"project_A",
						destination,
						...selector,
						"--token",
						"shiplet_cli_fixture",
						"--json",
					],
					env: {},
					fetch: network as unknown as typeof fetch,
					stdout,
					stderr: createWritable(),
				});

				expect(exitCode).toBe(0);
				expect(network).toHaveBeenCalledOnce();
				const [selectedRequestUrl] = network.mock.calls[0] as unknown as [
					string,
					RequestInit,
				];
				expect(selectedRequestUrl).toBe(requestUrl);
				expect(JSON.parse(stdout.value())).toMatchObject({
					...expected,
					packageDigest: canonicalPackageDigest(completePackageFixture),
				});
			},
		);

		it.each([
			{
				label: "fork",
				argv: ["fork", "project_A"],
				response: {
					draft: {
						id: "draft_A",
						projectId: "project_A",
						baseRevisionId: "revision_A",
						version: 2,
					},
				},
				expectedText: [
					"draft_A",
					"revision_A",
					"version 2",
					"shiplet pull project_A",
					"--draft draft_A",
				],
			},
			{
				label: "diff",
				argv: ["diff", "draft_A", "PACKAGE", "--version", "4"],
				response: {
					draft: { id: "draft_A", version: 4 },
					currentDigest: "c".repeat(64),
					proposedDigest: canonicalPackageDigest(completePackageFixture),
					changed: true,
				},
				expectedText: [
					"draft_A",
					"version 4",
					"changed",
					"c".repeat(64),
					canonicalPackageDigest(completePackageFixture),
					"shiplet push draft_A",
				],
			},
			{
				label: "deploy",
				argv: ["deploy", "revision_A", "--target", "target_A", "--approve"],
				response: {
					deployment: {
						id: "deployment_A",
						revisionId: "revision_A",
						targetId: "target_A",
						status: "healthy",
					},
				},
				expectedText: [
					"deployment_A",
					"revision_A",
					"target_A",
					"healthy",
					"shiplet rollback",
				],
			},
		])(
			"Given a successful $label, when human output is used, then workflow-critical identifiers and the next command remain visible",
			async ({ argv, response, expectedText }) => {
				const directory = await makeTempDir();
				const packagePath = await writePackageEnvelope(directory);
				const stdout = createWritable();
				const effectiveArgv = argv.map((value) =>
					value === "PACKAGE" ? packagePath : value,
				);
				const humanEffect = argv[0] === "deploy";
				const network = humanEffect
					? committedEffectNetwork("deploy", response)
					: vi.fn(
							async () =>
								new Response(JSON.stringify(response), {
									headers: { "content-type": "application/json" },
								}),
						);
				const exitCode = await cli.runCli({
					argv: [
						...effectiveArgv,
						...(humanEffect ? [] : ["--token", "shiplet_cli_fixture"]),
					],
					env: {},
					fetch: (humanEffect ? vi.fn() : network) as unknown as typeof fetch,
					sessionFetch: humanEffect
						? (network as unknown as typeof fetch)
						: undefined,
					stdout,
					stderr: createWritable(),
				});

				expect(exitCode).toBe(0);
				for (const text of expectedText) expect(stdout.value()).toContain(text);
			},
		);

		it.each([
			{
				label: "fork draft",
				argv: ["fork", "project_A"],
				response: { draft: { baseRevisionId: "revision_A", version: 1 } },
			},
			{
				label: "validated revision",
				argv: ["validate", "draft_A", "PACKAGE", "--version", "1"],
				response: { validation: { ok: true, draftVersion: 1, errors: [] } },
			},
			{
				label: "promotion revision",
				argv: [
					"promote",
					"draft_A",
					"--expected-active",
					"revision_A",
					"--approve",
				],
				response: { revision: {} },
			},
			{
				label: "deployment",
				argv: ["deploy", "revision_A", "--target", "target_A", "--approve"],
				response: { deployment: {} },
			},
		])(
			"Given a success response without its required $label ID, when the CLI normalizes it, then it fails closed",
			async ({ argv, response }) => {
				const directory = await makeTempDir();
				const packagePath = await writePackageEnvelope(directory);
				const stderr = createWritable();
				const humanEffect = ["promote", "deploy"].includes(argv[0]);
				const network = humanEffect
					? committedEffectNetwork(argv[0] as "deploy" | "promote", response)
					: vi.fn(
							async () =>
								new Response(JSON.stringify(response), {
									headers: { "content-type": "application/json" },
								}),
						);
				const exitCode = await cli.runCli({
					argv: [
						...argv.map((value) => (value === "PACKAGE" ? packagePath : value)),
						...(humanEffect ? [] : ["--token", "shiplet_cli_fixture"]),
						"--json",
					],
					env: {},
					fetch: (humanEffect ? vi.fn() : network) as unknown as typeof fetch,
					sessionFetch: humanEffect
						? (network as unknown as typeof fetch)
						: undefined,
					stdout: createWritable(),
					stderr,
				});

				expect(exitCode).toBe(1);
				expect(stderr.value()).toMatch(/required|missing|invalid/i);
			},
		);

		it("Given a kernel response contains undeclared fields, when JSON output is requested, then only the command's strict public projection is emitted", async () => {
			const stdout = createWritable();
			const network = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							draft: {
								id: "draft_A",
								projectId: "project_A",
								baseRevisionId: "revision_A",
								version: 1,
								serverInternal: "must-not-cross",
							},
							unknownSafeField: "must-not-cross",
							metadata: { trace: "must-not-cross" },
						}),
						{ headers: { "content-type": "application/json" } },
					),
			);

			const exitCode = await cli.runCli({
				argv: ["fork", "project_A", "--token", "shiplet_cli_fixture", "--json"],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout,
				stderr: createWritable(),
			});

			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout.value())).toEqual({
				ok: true,
				action: "fork",
				shipletId: "project_A",
				draftId: "draft_A",
				baseRevisionId: "revision_A",
				draftVersion: 1,
			});
		});

		it.each([
			`artifact/${"é".repeat(128)}.html`,
			`artifact/${["a".repeat(252), "b".repeat(250), "c".repeat(250), "d".repeat(250)].join("/")}/index.html`,
		])(
			"Given a package path outside the kernel's UTF-8 portability bounds, when local validation runs, then it is rejected: %s",
			async (oversizedPath) => {
				const packageFixture = moveArtifactEntrypoint(
					cloneCompletePackage(),
					oversizedPath,
				);

				const result = await validateEnvelope(packageFixture);

				expect(result.exitCode).toBe(1);
				expect(result.stderr.value()).toMatch(/path|portable|unsafe/i);
				expect(result.network).not.toHaveBeenCalled();
			},
		);

		it("Given a 1024-byte portable path whose segments are each at most 255 bytes, when local validation runs, then it matches the kernel and accepts it", async () => {
			const boundaryPath = `artifact/${[
				"a".repeat(251),
				"b".repeat(250),
				"c".repeat(250),
				"d".repeat(250),
			].join("/")}/index.html`;
			expect(Buffer.byteLength(boundaryPath, "utf8")).toBe(1024);
			const packageFixture = moveArtifactEntrypoint(
				cloneCompletePackage(),
				boundaryPath,
			);

			const result = await validateEnvelope(packageFixture);

			expect(result.exitCode).toBe(0);
			expect(result.stderr.value()).toBe("");
			expect(result.network).not.toHaveBeenCalled();
		});

		it("Given a package pathname is swapped to a symlink after inspection, when validation reads it, then the swapped target is never accepted", async () => {
			const directory = await makeTempDir();
			const packagePath = await writePackageEnvelope(directory);
			const originalPath = path.join(directory, "original-package.json");
			const outsidePath = path.join(directory, "outside-package.json");
			const outsidePackage = cloneCompletePackage();
			replaceUtf8File(
				outsidePackage,
				outsidePackage.manifest.entrypoints.artifact,
				"<main>swapped package</main>",
			);
			sortPackageFiles(outsidePackage);
			await writeFile(outsidePath, JSON.stringify(outsidePackage));
			const outsideDigest = canonicalPackageDigest(outsidePackage);
			const realFs =
				require("node:fs/promises") as typeof import("node:fs/promises");
			let swapped = false;
			const swap = async () => {
				if (swapped) return;
				swapped = true;
				await realFs.rename(packagePath, originalPath);
				await symlink(outsidePath, packagePath);
			};
			const instrumentedFs = {
				...realFs,
				async readFile(
					file: Parameters<typeof realFs.readFile>[0],
					...args: unknown[]
				) {
					if (path.resolve(String(file)) === packagePath) await swap();
					return (
						realFs.readFile as (...values: unknown[]) => Promise<unknown>
					)(file, ...args);
				},
				async open(
					file: Parameters<typeof realFs.open>[0],
					...args: unknown[]
				) {
					if (path.resolve(String(file)) === packagePath) await swap();
					return (realFs.open as (...values: unknown[]) => Promise<unknown>)(
						file,
						...args,
					);
				},
			};
			const cliSourcePath = "/candidate/src/cli/shiplet.cjs";
			const isolatedModule = { exports: {} as Record<string, unknown> };
			const isolatedRequire = Object.assign(
				(specifier: string) =>
					specifier === "node:fs/promises"
						? instrumentedFs
						: require(specifier),
				{ main: null },
			);
			new Function(
				"require",
				"module",
				"exports",
				"__filename",
				"__dirname",
				cliCandidateSource,
			)(
				isolatedRequire,
				isolatedModule,
				isolatedModule.exports,
				cliSourcePath,
				path.dirname(cliSourcePath),
			);
			const isolatedCli = isolatedModule.exports as typeof cli;
			const stdout = createWritable();
			const stderr = createWritable();
			const exitCode = await isolatedCli.runCli({
				argv: ["validate", packagePath, "--json"],
				env: {},
				fetch: vi.fn() as unknown as typeof fetch,
				stdout,
				stderr,
			});
			expect([0, 1]).toContain(exitCode);
			if (exitCode === 0) {
				expect(JSON.parse(stdout.value()).packageDigest).not.toBe(
					outsideDigest,
				);
			} else {
				expect(stderr.value()).toMatch(/changed|symbolic|regular|package/i);
			}
		});

		it("Given promotion includes attached deployment targets, when approved, then every exact target ID is bound to the atomic promotion request", async () => {
			const network = committedEffectNetwork("promote", {
				draftId: "draft_A",
				revision: { id: "revision_B", parentRevisionId: "revision_A" },
				targetIds: ["target_managed", "target_customer"],
			});
			const exitCode = await cli.runCli({
				argv: [
					"promote",
					"draft_A",
					"--expected-active",
					"revision_A",
					"--target",
					"target_managed",
					"--target",
					"target_customer",
					"--approve",
				],
				env: {},
				fetch: vi.fn() as unknown as typeof fetch,
				sessionFetch: network as unknown as typeof fetch,
				stdout: createWritable(),
				stderr: createWritable(),
			});

			expect(exitCode).toBe(0);
			const [, init] = network.mock.calls[0] as unknown as [
				string,
				RequestInit,
			];
			expect(JSON.parse(String(init.body))).toEqual({
				expectedActiveRevisionId: "revision_A",
				targetIds: ["target_managed", "target_customer"],
				approval: true,
			});
		});
	});

	describe("adversarial operation binding and idempotency", () => {
		it.each([
			{
				command: "pull",
				selector: ["--draft", "draft_A"],
				response: {
					package: completePackageFixture,
					draft: {
						id: "draft_B",
						projectId: "project_A",
						baseRevisionId: "revision_A",
						version: 2,
					},
				},
			},
			{
				command: "eject",
				selector: ["--revision", "revision_A"],
				response: {
					package: completePackageFixture,
					shipletId: "project_B",
					revision: {
						id: "revision_A",
						parentRevisionId: "revision_parent",
						digest: "a".repeat(64),
						contentDigest: "b".repeat(64),
					},
				},
			},
		])(
			"Given $command receives a cross-bound exact selection, when --force is used, then response proof is rejected before any destination mutation",
			async ({ command, selector, response }) => {
				const root = await makeTempDir();
				const destination = path.join(root, "existing");
				await mkdir(destination);
				await writeFile(path.join(destination, "sentinel.txt"), "keep me");
				const stderr = createWritable();

				const exitCode = await cli.runCli({
					argv: [
						command,
						"project_A",
						destination,
						...selector,
						"--force",
						"--token",
						"shiplet_cli_fixture",
					],
					env: {},
					fetch: vi.fn(
						async () =>
							new Response(JSON.stringify(response), {
								headers: { "content-type": "application/json" },
							}),
					) as unknown as typeof fetch,
					stdout: createWritable(),
					stderr,
				});

				expect(exitCode).toBe(1);
				expect(stderr.value()).toMatch(/mismatch|different|selected|binding/i);
				expect(
					await readFile(path.join(destination, "sentinel.txt"), "utf8"),
				).toBe("keep me");
				expect(await fileExists(path.join(destination, "shiplet.json"))).toBe(
					false,
				);
			},
		);

		it("Given fork returns a draft bound to another Shiplet and base revision, when normalized, then it fails closed", async () => {
			const stderr = createWritable();
			const exitCode = await cli.runCli({
				argv: [
					"fork",
					"project_A",
					"--from-revision",
					"revision_A",
					"--token",
					"shiplet_cli_fixture",
				],
				env: {},
				fetch: vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								draft: {
									id: "draft_A",
									projectId: "project_B",
									baseRevisionId: "revision_B",
									version: 1,
								},
							}),
							{ headers: { "content-type": "application/json" } },
						),
				) as unknown as typeof fetch,
				stdout: createWritable(),
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(stderr.value()).toMatch(/mismatch|different|binding/i);
		});

		it.each([
			{
				label: "draft ID",
				draft: { id: "draft_B", version: 8 },
				digest: canonicalPackageDigest(completePackageFixture),
			},
			{
				label: "draft version",
				draft: { id: "draft_A", version: 99 },
				digest: canonicalPackageDigest(completePackageFixture),
			},
			{
				label: "package digest",
				draft: { id: "draft_A", version: 8 },
				digest: "e".repeat(64),
			},
		])(
			"Given push returns a mismatched $label, when normalized, then it fails closed",
			async ({ draft, digest }) => {
				const directory = await makeTempDir();
				const packagePath = await writePackageEnvelope(directory);
				const stderr = createWritable();
				const exitCode = await cli.runCli({
					argv: [
						"push",
						"draft_A",
						packagePath,
						"--version",
						"7",
						"--token",
						"shiplet_cli_fixture",
					],
					env: {},
					fetch: vi.fn(
						async () =>
							new Response(JSON.stringify({ draft, packageDigest: digest }), {
								headers: { "content-type": "application/json" },
							}),
					) as unknown as typeof fetch,
					stdout: createWritable(),
					stderr,
				});

				expect(exitCode).toBe(1);
				expect(stderr.value()).toMatch(/mismatch|different|binding/i);
			},
		);

		it.each([
			{
				label: "revision",
				deployment: {
					id: "deployment_A",
					revisionId: "revision_B",
					targetId: "target_A",
				},
			},
			{
				label: "target",
				deployment: {
					id: "deployment_A",
					revisionId: "revision_A",
					targetId: "target_B",
				},
			},
		])(
			"Given deploy returns a cross-bound $label, when normalized, then it fails closed",
			async ({ deployment }) => {
				const stderr = createWritable();
				const network = committedEffectNetwork("deploy", { deployment });
				const exitCode = await cli.runCli({
					argv: ["deploy", "revision_A", "--target", "target_A", "--approve"],
					env: {},
					fetch: vi.fn() as unknown as typeof fetch,
					sessionFetch: network as unknown as typeof fetch,
					stdout: createWritable(),
					stderr,
				});

				expect(exitCode).toBe(1);
				expect(stderr.value()).toMatch(/mismatch|different|binding/i);
			},
		);

		it("Given promote returns another draft, parent, or target binding, when normalized, then it fails closed", async () => {
			const stderr = createWritable();
			const network = committedEffectNetwork("promote", {
				draftId: "draft_B",
				revision: { id: "revision_B", parentRevisionId: "revision_X" },
				targetIds: ["target_B"],
			});
			const exitCode = await cli.runCli({
				argv: [
					"promote",
					"draft_A",
					"--expected-active",
					"revision_A",
					"--target",
					"target_A",
					"--approve",
				],
				env: {},
				fetch: vi.fn() as unknown as typeof fetch,
				sessionFetch: network as unknown as typeof fetch,
				stdout: createWritable(),
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(stderr.value()).toMatch(/mismatch|different|binding/i);
		});

		it.each([
			{},
			{
				shipletId: "project_B",
				revision: { id: "revision_B" },
				previousRevisionId: "revision_X",
			},
		])(
			"Given rollback returns missing or cross-bound proof %#, when normalized, then it fails closed",
			async (response) => {
				const stderr = createWritable();
				const network = committedEffectNetwork("rollback", response);
				const exitCode = await cli.runCli({
					argv: [
						"rollback",
						"project_A",
						"--revision",
						"revision_A",
						"--expected-active",
						"revision_B",
						"--approve",
					],
					env: {},
					fetch: vi.fn() as unknown as typeof fetch,
					sessionFetch: network as unknown as typeof fetch,
					stdout: createWritable(),
					stderr,
				});

				expect(exitCode).toBe(1);
				expect(stderr.value()).toMatch(/missing|mismatch|different|binding/i);
			},
		);

		it("Given diff returns a proposed digest that is not the exact local package, when normalized, then it fails closed", async () => {
			const directory = await makeTempDir();
			const packagePath = await writePackageEnvelope(directory);
			const stderr = createWritable();
			const exitCode = await cli.runCli({
				argv: [
					"diff",
					"draft_A",
					packagePath,
					"--version",
					"7",
					"--token",
					"shiplet_cli_fixture",
				],
				env: {},
				fetch: vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								draft: { id: "draft_A", version: 7 },
								currentDigest: "a".repeat(64),
								proposedDigest: "f".repeat(64),
								changed: true,
							}),
							{ headers: { "content-type": "application/json" } },
						),
				) as unknown as typeof fetch,
				stdout: createWritable(),
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(stderr.value()).toMatch(/digest|mismatch|binding/i);
		});

		it("Given local validation succeeds, when server validation runs, then the exact package and digest are bound in both directions", async () => {
			const directory = await makeTempDir();
			const packagePath = await writePackageEnvelope(directory);
			const localDigest = canonicalPackageDigest(completePackageFixture);
			const stdout = createWritable();
			const network = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							validation: {
								ok: true,
								draftId: "draft_A",
								draftVersion: 7,
								revisionId: "revision_validated_A",
								previewUrl:
									"https://shiplet.cc/shiplets/project_A/drafts/draft_A/revisions/revision_validated_A/versions/7/preview",
								packageDigest: localDigest,
							},
						}),
						{ headers: { "content-type": "application/json" } },
					),
			);

			const exitCode = await cli.runCli({
				argv: [
					"validate",
					"draft_A",
					packagePath,
					"--version",
					"7",
					"--token",
					"shiplet_cli_fixture",
					"--json",
				],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout,
				stderr: createWritable(),
			});

			expect(exitCode).toBe(0);
			const [, init] = network.mock.calls[0] as unknown as [
				string,
				RequestInit,
			];
			expect(JSON.parse(String(init.body))).toEqual({
				expectedVersion: 7,
				packageDigest: localDigest,
				package: completePackageFixture,
			});
			expect(JSON.parse(stdout.value())).toMatchObject({
				draftId: "draft_A",
				packageDigest: localDigest,
			});
		});

		it("Given server validation reports a different package digest, when the result is normalized, then it fails closed", async () => {
			const directory = await makeTempDir();
			const packagePath = await writePackageEnvelope(directory);
			const stderr = createWritable();
			const exitCode = await cli.runCli({
				argv: [
					"validate",
					"draft_A",
					packagePath,
					"--version",
					"7",
					"--token",
					"shiplet_cli_fixture",
				],
				env: {},
				fetch: vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								validation: {
									ok: true,
									draftId: "draft_A",
									draftVersion: 7,
									revisionId: "revision_validated_A",
									packageDigest: "f".repeat(64),
								},
							}),
							{ headers: { "content-type": "application/json" } },
						),
				) as unknown as typeof fetch,
				stdout: createWritable(),
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(stderr.value()).toMatch(/digest|mismatch|binding/i);
		});

		it.each([
			{
				command: "deploy",
				argv: ["deploy", "revision_A", "--target", "target_A", "--approve"],
				response: {
					deployment: {
						id: "deployment_A",
						revisionId: "revision_A",
						targetId: "target_A",
						status: "healthy",
					},
					operation: { id: "operation_A", status: "succeeded" },
				},
			},
			{
				command: "promote",
				argv: [
					"promote",
					"draft_A",
					"--expected-active",
					"revision_A",
					"--approve",
				],
				response: {
					draftId: "draft_A",
					revision: { id: "revision_B", parentRevisionId: "revision_A" },
					operation: { id: "operation_A", status: "succeeded" },
				},
			},
			{
				command: "rollback",
				argv: [
					"rollback",
					"project_A",
					"--revision",
					"revision_A",
					"--expected-active",
					"revision_B",
					"--approve",
				],
				response: {
					shipletId: "project_A",
					revision: { id: "revision_A" },
					previousRevisionId: "revision_B",
					operation: { id: "operation_A", status: "succeeded" },
				},
			},
		])(
			"Given an approved $command, when the request is sent, then a per-operation idempotency key and returned reconciliation ID are exposed",
			async ({ command, argv, response }) => {
				const stdout = createWritable();
				const network = committedEffectNetwork(
					command as "deploy" | "promote" | "rollback",
					response,
				);
				const exitCode = await cli.runCli({
					argv: [...argv, "--json"],
					env: {},
					fetch: vi.fn() as unknown as typeof fetch,
					sessionFetch: network as unknown as typeof fetch,
					stdout,
					stderr: createWritable(),
				});

				expect(exitCode).toBe(0);
				const [, init] = network.mock.calls[0] as unknown as [
					string,
					RequestInit,
				];
				const headers = init.headers as Record<string, string>;
				expect(headers["idempotency-key"]).toMatch(
					new RegExp(`^${command}_[A-Za-z0-9-]+$`),
				);
				expect(JSON.parse(stdout.value())).toMatchObject({
					operationId: "operation_A",
					operationStatus: "committed",
					idempotencyKey: headers["idempotency-key"],
				});
			},
		);

		it("Given an approved operation loses its response, when transport fails, then the idempotency key exists but no success is invented", async () => {
			let capturedKey = "";
			const stdout = createWritable();
			const stderr = createWritable();
			const exitCode = await cli.runCli({
				argv: ["deploy", "revision_A", "--target", "target_A", "--approve"],
				env: {},
				fetch: vi.fn() as unknown as typeof fetch,
				sessionFetch: vi.fn(async (_url, init) => {
					capturedKey = String(
						(init?.headers as Record<string, string>)["idempotency-key"] || "",
					);
					throw new TypeError("fixture connection lost");
				}) as unknown as typeof fetch,
				stdout,
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(capturedKey).toMatch(/^deploy_[A-Za-z0-9-]+$/);
			expect(stdout.value()).toBe("");
			expect(stderr.value()).toMatch(/connection lost|request failed/i);
		});
	});

	describe("legacy static publishing filesystem boundary", () => {
		it("Given the selected artifact root is a symlink, when publish prepares it, then it is rejected before any file read or network request", async () => {
			const root = await makeTempDir();
			const realArtifact = path.join(root, "real-artifact");
			const selectedArtifact = path.join(root, "selected-artifact");
			await mkdir(realArtifact);
			await writeFile(
				path.join(realArtifact, "index.html"),
				"<main>real</main>",
			);
			await symlink(realArtifact, selectedArtifact);
			const network = vi.fn();
			const stderr = createWritable();

			const exitCode = await cli.runCli({
				argv: ["publish", selectedArtifact, "--dry-run", "--json"],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout: createWritable(),
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(stderr.value()).toMatch(/symbolic|symlink|regular/i);
			expect(network).not.toHaveBeenCalled();
		});

		it("Given a selected static file is swapped to a symlink after inspection, when publish reads it, then the swapped target is never accepted", async () => {
			const directory = await makeTempDir();
			const selectedPath = path.join(directory, "index.html");
			const originalPath = path.join(directory, "original-index.html");
			const outsidePath = path.join(directory, "outside.html");
			const originalContent = "original";
			const outsideContent = "swapped content";
			await writeFile(selectedPath, originalContent);
			await writeFile(outsidePath, outsideContent);
			const realFs =
				require("node:fs/promises") as typeof import("node:fs/promises");
			let swapped = false;
			const swap = async () => {
				if (swapped) return;
				swapped = true;
				await realFs.rename(selectedPath, originalPath);
				await symlink(outsidePath, selectedPath);
			};
			const instrumentedFs = {
				...realFs,
				async readFile(
					file: Parameters<typeof realFs.readFile>[0],
					...args: unknown[]
				) {
					if (path.resolve(String(file)) === selectedPath) await swap();
					return (
						realFs.readFile as (...values: unknown[]) => Promise<unknown>
					)(file, ...args);
				},
				async open(
					file: Parameters<typeof realFs.open>[0],
					...args: unknown[]
				) {
					if (path.resolve(String(file)) === selectedPath) await swap();
					return (realFs.open as (...values: unknown[]) => Promise<unknown>)(
						file,
						...args,
					);
				},
			};
			const isolatedModule = { exports: {} as Record<string, unknown> };
			const isolatedRequire = Object.assign(
				(specifier: string) =>
					specifier === "node:fs/promises"
						? instrumentedFs
						: require(specifier),
				{ main: null },
			);
			new Function(
				"require",
				"module",
				"exports",
				"__filename",
				"__dirname",
				cliCandidateSource,
			)(
				isolatedRequire,
				isolatedModule,
				isolatedModule.exports,
				"/candidate/src/cli/shiplet.cjs",
				"/candidate/src/cli",
			);
			const isolatedCli = isolatedModule.exports as typeof cli;
			const stdout = createWritable();
			const stderr = createWritable();
			const exitCode = await isolatedCli.runCli({
				argv: ["publish", selectedPath, "--dry-run", "--json"],
				env: {},
				fetch: vi.fn() as unknown as typeof fetch,
				stdout,
				stderr,
			});

			expect([0, 1]).toContain(exitCode);
			if (exitCode === 0) {
				expect(JSON.parse(stdout.value()).totalBytes).toBe(
					Buffer.byteLength(originalContent),
				);
			} else {
				expect(stderr.value()).toMatch(/changed|symbolic|regular|artifact/i);
			}
		});
	});

	describe("critical CLI boundary closure", () => {
		it("Given an inspected parent directory is replaced by a symlink to the same file inode, when static publish opens the child, then intermediate traversal is rejected", async () => {
			const root = await makeTempDir();
			const selectedDirectory = path.join(root, "selected");
			const movedDirectory = path.join(root, "moved");
			const selectedPath = path.join(selectedDirectory, "index.html");
			await mkdir(selectedDirectory);
			await writeFile(selectedPath, "same inode");
			const realFs =
				require("node:fs/promises") as typeof import("node:fs/promises");
			const inspectedFileStat = await realFs.lstat(selectedPath);
			let swapped = false;
			const instrumentedFs = {
				...realFs,
				async lstat(
					file: Parameters<typeof realFs.lstat>[0],
					...args: unknown[]
				) {
					if (swapped && path.resolve(String(file)) === selectedPath) {
						return inspectedFileStat;
					}
					return (realFs.lstat as (...values: unknown[]) => Promise<unknown>)(
						file,
						...args,
					);
				},
				async open(
					file: Parameters<typeof realFs.open>[0],
					...args: unknown[]
				) {
					if (!swapped && path.resolve(String(file)) === selectedPath) {
						swapped = true;
						await realFs.rename(selectedDirectory, movedDirectory);
						await symlink(movedDirectory, selectedDirectory);
					}
					const handle = await (
						realFs.open as unknown as (
							...values: unknown[]
						) => Promise<Record<string, unknown>>
					)(
						swapped && path.resolve(String(file)) === selectedPath
							? path.join(movedDirectory, "index.html")
							: file,
						...args,
					);
					return new Proxy(handle, {
						get(target, property) {
							if (property === "stat") return async () => inspectedFileStat;
							if (property === "readFile") {
								return async () => Buffer.alloc(inspectedFileStat.size, "x");
							}
							const value = Reflect.get(target, property);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
				},
			};
			const isolatedModule = { exports: {} as Record<string, unknown> };
			const isolatedRequire = Object.assign(
				(specifier: string) =>
					specifier === "node:fs/promises"
						? instrumentedFs
						: require(specifier),
				{ main: null },
			);
			new Function(
				"require",
				"module",
				"exports",
				"__filename",
				"__dirname",
				cliCandidateSource,
			)(
				isolatedRequire,
				isolatedModule,
				isolatedModule.exports,
				"/candidate/src/cli/shiplet.cjs",
				"/candidate/src/cli",
			);
			const isolatedCli = isolatedModule.exports as typeof cli;
			const stderr = createWritable();
			const exitCode = await isolatedCli.runCli({
				argv: ["publish", selectedDirectory, "--dry-run", "--json"],
				env: {},
				fetch: vi.fn() as unknown as typeof fetch,
				stdout: createWritable(),
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(stderr.value()).toMatch(
				/intermediate|component|symbolic|changed/i,
			);
		});

		it.each([
			["deploy", "revision_A", "--target", "target_A"],
			["promote", "draft_A", "--expected-active", "revision_A"],
			[
				"rollback",
				"project_A",
				"--revision",
				"revision_A",
				"--expected-active",
				"revision_B",
			],
		])(
			"Given a human-only effect is invoked with a raw legacy token, when %s starts, then it fails honestly before network",
			async (...effectArgv) => {
				const network = vi.fn();
				const stderr = createWritable();
				const exitCode = await cli.runCli({
					argv: [...effectArgv, "--approve", "--token", "shiplet_cli_fixture"],
					env: {},
					fetch: network as unknown as typeof fetch,
					stdout: createWritable(),
					stderr,
				});

				expect(exitCode).toBe(1);
				expect(stderr.value()).toMatch(/OAuth|browser session|human session/i);
				expect(network).not.toHaveBeenCalled();
			},
		);

		it("Given active pull omits identity and revision digest proof, when --force is used, then it fails before destination mutation", async () => {
			const root = await makeTempDir();
			const destination = path.join(root, "existing");
			await mkdir(destination);
			await writeFile(path.join(destination, "sentinel.txt"), "keep me");
			const stderr = createWritable();
			const exitCode = await cli.runCli({
				argv: [
					"pull",
					"project_A",
					destination,
					"--force",
					"--token",
					"shiplet_cli_fixture",
				],
				env: {},
				fetch: vi.fn(
					async () =>
						new Response(JSON.stringify({ package: completePackageFixture }), {
							headers: { "content-type": "application/json" },
						}),
				) as unknown as typeof fetch,
				stdout: createWritable(),
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(stderr.value()).toMatch(/Shiplet|revision|digest|proof/i);
			expect(
				await readFile(path.join(destination, "sentinel.txt"), "utf8"),
			).toBe("keep me");
		});

		it.each([
			{
				command: "deploy",
				argv: ["deploy", "revision_A", "--target", "target_A", "--approve"],
				response: {
					deployment: {
						id: "deployment_A",
						revisionId: "revision_A",
						targetId: "target_A",
					},
				},
			},
			{
				command: "promote",
				argv: [
					"promote",
					"draft_A",
					"--expected-active",
					"revision_A",
					"--approve",
				],
				response: {
					draftId: "draft_A",
					revision: { id: "revision_B", parentRevisionId: "revision_A" },
				},
			},
			{
				command: "rollback",
				argv: [
					"rollback",
					"project_A",
					"--revision",
					"revision_A",
					"--expected-active",
					"revision_B",
					"--approve",
				],
				response: {
					shipletId: "project_A",
					revision: { id: "revision_A" },
					previousRevisionId: "revision_B",
				},
			},
		])(
			"Given $command returns no committed operation proof, when a session-authenticated request completes, then it fails closed",
			async ({ argv, response }) => {
				const sessionNetwork = vi.fn(
					async () =>
						new Response(JSON.stringify(response), {
							headers: { "content-type": "application/json" },
						}),
				);
				const stderr = createWritable();
				const exitCode = await cli.runCli({
					argv,
					env: {},
					fetch: vi.fn() as unknown as typeof fetch,
					sessionFetch: sessionNetwork as unknown as typeof fetch,
					stdout: createWritable(),
					stderr,
				});

				expect(exitCode).toBe(1);
				expect(sessionNetwork).toHaveBeenCalledOnce();
				expect(stderr.value()).toMatch(/operation|committed|proof/i);
			},
		);

		it.each([
			["deploy", "revision_A", "--target", "target_A"],
			["promote", "draft_A", "--expected-active", "revision_A"],
			[
				"rollback",
				"project_A",
				"--revision",
				"revision_A",
				"--expected-active",
				"revision_B",
			],
		])(
			"Given %s is dry-run, when planned, then it performs no effect or authentication network call",
			async (...effectArgv) => {
				const network = vi.fn();
				const sessionNetwork = vi.fn();
				const stdout = createWritable();
				const exitCode = await cli.runCli({
					argv: [...effectArgv, "--approve", "--dry-run", "--json"],
					env: {},
					fetch: network as unknown as typeof fetch,
					sessionFetch: sessionNetwork as unknown as typeof fetch,
					stdout,
					stderr: createWritable(),
				});

				expect(exitCode).toBe(0);
				expect(network).not.toHaveBeenCalled();
				expect(sessionNetwork).not.toHaveBeenCalled();
				expect(JSON.parse(stdout.value())).toMatchObject({
					ok: true,
					dryRun: true,
					action: effectArgv[0],
				});
			},
		);

		it("Given an explicit reusable idempotency key, when deploy succeeds through an established session, then the exact key is used and exposed", async () => {
			const stdout = createWritable();
			const sessionNetwork = vi.fn(async (_url, init) => {
				const key = String(
					(init?.headers as Record<string, string>)["idempotency-key"],
				);
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
							idempotencyKey: key,
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			});
			const exitCode = await cli.runCli({
				argv: [
					"deploy",
					"revision_A",
					"--target",
					"target_A",
					"--approve",
					"--idempotency-key",
					"retry_A",
					"--json",
				],
				env: {},
				fetch: vi.fn() as unknown as typeof fetch,
				sessionFetch: sessionNetwork as unknown as typeof fetch,
				stdout,
				stderr: createWritable(),
			});

			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout.value())).toMatchObject({
				idempotencyKey: "retry_A",
				operationId: "operation_A",
				operationStatus: "committed",
			});
		});

		it("Given a generated operation key and an ambiguous lost response, when deploy fails, then the exact retry key is visible", async () => {
			const stderr = createWritable();
			let requestKey = "";
			const exitCode = await cli.runCli({
				argv: ["deploy", "revision_A", "--target", "target_A", "--approve"],
				env: {},
				fetch: vi.fn() as unknown as typeof fetch,
				sessionFetch: vi.fn(async (_url, init) => {
					requestKey = String(
						(init?.headers as Record<string, string>)["idempotency-key"],
					);
					throw new TypeError("fixture connection lost");
				}) as unknown as typeof fetch,
				stdout: createWritable(),
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(requestKey).toMatch(/^deploy_[A-Za-z0-9-]+$/);
			expect(stderr.value()).toContain(requestKey);
			expect(stderr.value()).toContain("--idempotency-key");
		});

		it("Given a portable package response exceeds the generic 1 MiB cap but remains within the package limit, when pulled, then only the package route receives the larger bounded budget", async () => {
			const root = await makeTempDir();
			const destination = path.join(root, "large");
			const largePackage = cloneCompletePackage();
			const largeContent = "x".repeat(1_100_000);
			replaceUtf8File(
				largePackage,
				largePackage.manifest.entrypoints.artifact,
				largeContent,
			);
			largePackage.manifest.limits.fileBytes = 2_000_000;
			largePackage.manifest.limits.packageBytes = 3_000_000;
			const packageDigest = canonicalPackageDigest(largePackage);
			const network = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							package: largePackage,
							shipletId: "project_A",
							revision: { id: "revision_A", digest: packageDigest },
						}),
						{ headers: { "content-type": "application/json" } },
					),
			);
			const exitCode = await cli.runCli({
				argv: [
					"pull",
					"project_A",
					destination,
					"--token",
					"shiplet_cli_fixture",
				],
				env: {},
				fetch: network as unknown as typeof fetch,
				stdout: createWritable(),
				stderr: createWritable(),
			});

			expect(exitCode).toBe(0);
			expect(
				await readFile(
					path.join(destination, "artifact", "index.html"),
					"utf8",
				),
			).toHaveLength(largeContent.length);
		});

		it("Given rollback has exact targets, when session-authenticated, then target IDs are sent and bound to committed proof", async () => {
			const sessionNetwork = vi.fn(async (_url, init) => {
				const key = String(
					(init?.headers as Record<string, string>)["idempotency-key"],
				);
				return new Response(
					JSON.stringify({
						shipletId: "project_A",
						revision: { id: "revision_A" },
						previousRevisionId: "revision_B",
						targetIds: ["target_A", "target_B"],
						operation: {
							id: "operation_A",
							kind: "rollback",
							status: "committed",
							idempotencyKey: key,
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			});
			const exitCode = await cli.runCli({
				argv: [
					"rollback",
					"project_A",
					"--revision",
					"revision_A",
					"--expected-active",
					"revision_B",
					"--target",
					"target_A",
					"--target",
					"target_B",
					"--approve",
				],
				env: {},
				fetch: vi.fn() as unknown as typeof fetch,
				sessionFetch: sessionNetwork as unknown as typeof fetch,
				stdout: createWritable(),
				stderr: createWritable(),
			});

			expect(exitCode).toBe(0);
			const [, init] = sessionNetwork.mock.calls[0] as unknown as [
				string,
				RequestInit,
			];
			expect(JSON.parse(String(init.body)).targetIds).toEqual([
				"target_A",
				"target_B",
			]);
		});

		it("Given deploy names multiple targets, when parsed, then no target is silently selected", async () => {
			const sessionNetwork = vi.fn();
			const stderr = createWritable();
			const exitCode = await cli.runCli({
				argv: [
					"deploy",
					"revision_A",
					"--target",
					"target_A",
					"--target",
					"target_B",
					"--approve",
				],
				env: {},
				fetch: vi.fn() as unknown as typeof fetch,
				sessionFetch: sessionNetwork as unknown as typeof fetch,
				stdout: createWritable(),
				stderr,
			});

			expect(exitCode).toBe(1);
			expect(stderr.value()).toMatch(/exactly one|single target/i);
			expect(sessionNetwork).not.toHaveBeenCalled();
		});

		it.each([
			[
				"kind",
				(key: string) => ({
					id: "operation_A",
					kind: "promote",
					status: "committed",
					idempotencyKey: key,
				}),
			],
			[
				"status",
				(key: string) => ({
					id: "operation_A",
					kind: "deploy",
					status: "succeeded",
					idempotencyKey: key,
				}),
			],
			[
				"idempotency key",
				() => ({
					id: "operation_A",
					kind: "deploy",
					status: "committed",
					idempotencyKey: "different_retry_key",
				}),
			],
		] as const)(
			"Given committed operation proof has a mismatched %s, when deploy normalizes it, then it fails closed",
			async (_label, operationForKey) => {
				const stderr = createWritable();
				const sessionNetwork = vi.fn(async (_url, init) => {
					const key = String(
						(init?.headers as Record<string, string>)["idempotency-key"],
					);
					return new Response(
						JSON.stringify({
							deployment: {
								id: "deployment_A",
								revisionId: "revision_A",
								targetId: "target_A",
							},
							operation: operationForKey(key),
						}),
						{ headers: { "content-type": "application/json" } },
					);
				});
				const exitCode = await cli.runCli({
					argv: ["deploy", "revision_A", "--target", "target_A", "--approve"],
					env: {},
					fetch: vi.fn() as unknown as typeof fetch,
					sessionFetch: sessionNetwork as unknown as typeof fetch,
					stdout: createWritable(),
					stderr,
				});

				expect(exitCode).toBe(1);
				expect(stderr.value()).toMatch(/operation|committed|mismatch|binding/i);
			},
		);

		it.each([
			["fork", "project_A", "--target", "target_A"],
			[
				"deploy",
				"revision_A",
				"--target",
				"target_A",
				"--revision",
				"revision_B",
				"--approve",
			],
			["pull", "project_A", "output", "--approve"],
		])(
			"Given command-inapplicable flags for %s, when parsed, then they are rejected before network",
			async (...argv) => {
				const network = vi.fn();
				const stderr = createWritable();
				const exitCode = await cli.runCli({
					argv: [...argv, "--token", "shiplet_cli_fixture"],
					env: {},
					fetch: network as unknown as typeof fetch,
					stdout: createWritable(),
					stderr,
				});

				expect(exitCode).toBe(1);
				expect(stderr.value()).toMatch(/not valid|inapplicable|only valid/i);
				expect(network).not.toHaveBeenCalled();
			},
		);

		it("Given help is requested, when targets are described, then managed and customer-owned Cloudflare prerequisites and reusable operation keys are explicit", async () => {
			const stdout = createWritable();
			const exitCode = await cli.runCli({
				argv: ["--help"],
				env: {},
				stdout,
				stderr: createWritable(),
			});

			expect(exitCode).toBe(0);
			expect(stdout.value()).toMatch(/managed.*default/i);
			expect(stdout.value()).toMatch(/customer-owned.*Cloudflare.*OAuth/i);
			expect(stdout.value()).toContain("--idempotency-key");
		});
	});
});

async function readFileText(filePath: string) {
	return (await import("node:fs/promises")).readFile(filePath, "utf8");
}

async function fileExists(filePath: string) {
	try {
		await (await import("node:fs/promises")).access(filePath);
		return true;
	} catch {
		return false;
	}
}
