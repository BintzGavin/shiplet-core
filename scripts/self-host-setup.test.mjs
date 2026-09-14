import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	createStaticSelfHostConfig,
	detectSelfHostCapabilities,
	parseD1CreateOutput,
	parseJsonConfig,
	writeStaticSelfHostArtifacts,
} from "./self-host-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const example = Object.freeze({
	deploymentName: "acme-shiplet",
	databaseId: "11111111-2222-4333-8444-555555555555",
	appUrl: "https://acme-shiplet.example.workers.dev",
	authkitIssuer: "https://acme.authkit.app",
});

test("Given static-only inputs, when config is generated, then Shiplet keeps advanced Cloudflare infrastructure absent", () => {
	const config = createStaticSelfHostConfig({
		...example,
		main: "../../src/index.ts",
	});

	assert.equal(config.name, "acme-shiplet");
	assert.equal(config.main, "../../src/index.ts");
	assert.deepEqual(
		config.d1_databases.map((database) => database.binding),
		["DB"],
	);
	assert.deepEqual(
		config.r2_buckets.map((bucket) => bucket.binding).sort(),
		["REVIEW_ASSETS", "SHIPLET_ASSETS"],
	);
	assert.deepEqual(
		config.durable_objects.bindings.map((binding) => binding.name).sort(),
		["SANDBOX_SESSION", "SHIPLET_ROOT"],
	);
	assert.equal(config.vars.SHIPLET_AUTH_MODE, "workos");
	assert.equal(config.vars.CLOUDFLARE_OAUTH_READINESS, "disabled");
	assert.equal(config.vars.CLOUDFLARE_MANAGED_RUNTIME_READINESS, "disabled");
	assert.equal(config.vars.CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS, "disabled");
	assert.ok(!("worker_loaders" in config));
	assert.ok(!("dispatch_namespaces" in config));
	assert.ok(!("services" in config));

	const serialized = JSON.stringify(config);
	for (const secretName of [
		"WORKOS_CLIENT_ID",
		"WORKOS_API_KEY",
		"SHIPLET_REVIEW_TOKEN_SECRET",
	]) {
		assert.ok(!serialized.includes(secretName));
	}
});

test("Given a static config, when capabilities are inspected, then core review is available and every advanced path is an optional upgrade", () => {
	const report = detectSelfHostCapabilities({
		mainConfig: createStaticSelfHostConfig({
			...example,
			main: "../../src/index.ts",
		}),
	});

	assert.equal(report.schemaVersion, "shiplet.self-host-capabilities/v1");
	assert.equal(report.profile, "static-first");
	assert.equal(report.capabilities.staticReview.state, "available");
	assert.equal(report.capabilities.codeModeMcp.state, "optional_unavailable");
	assert.deepEqual(report.capabilities.codeModeMcp.missing, [
		"main Worker Loader binding CODE_MODE_LOADER",
	]);
	assert.equal(
		report.capabilities.managedWorkersForPlatforms.state,
		"optional_unavailable",
	);
	assert.ok(
		report.capabilities.managedWorkersForPlatforms.missing.includes(
			"managed runtime support Worker config",
		),
	);
	assert.equal(
		report.capabilities.customerOwnedCloudflare.state,
		"optional_unavailable",
	);
	assert.equal(
		report.capabilities.temporaryAccounts.state,
		"optional_unavailable",
	);
});

test("Given complete advanced config shapes and enabled readiness, when inspected, then Workers for Platforms is reported as configured", () => {
	const mainConfig = createStaticSelfHostConfig({
		...example,
		main: "../../src/index.ts",
	});
	mainConfig.worker_loaders = [{ binding: "CODE_MODE_LOADER" }];
	mainConfig.services = [
		{ binding: "CLOUDFLARE_OAUTH_CONTROL_PLANE", service: "control" },
		{ binding: "CLOUDFLARE_GRANT_VAULT_RPC", service: "control" },
		{ binding: "CLOUDFLARE_TEMPORARY_ACCOUNT_RPC", service: "control" },
		{ binding: "CLOUDFLARE_VERSION_HEALTH_RPC", service: "runtime" },
		{ binding: "CLOUDFLARE_CUSTOM_MCP_RUNTIME_RPC", service: "runtime" },
		{ binding: "CLOUDFLARE_MANAGED_RUNTIME_RPC", service: "runtime" },
	];
	mainConfig.vars.CLOUDFLARE_OAUTH_READINESS = "enabled";
	mainConfig.vars.CLOUDFLARE_MANAGED_RUNTIME_READINESS = "enabled";
	mainConfig.vars.CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS = "enabled";

	const report = detectSelfHostCapabilities({
		mainConfig,
		controlConfig: {
			d1_databases: [{ binding: "CONTROL_DB", database_id: example.databaseId }],
		},
		runtimeConfig: {
			worker_loaders: [{ binding: "CUSTOM_MCP_LOADER" }],
			d1_databases: [{ binding: "RUNTIME_DB", database_id: example.databaseId }],
			dispatch_namespaces: [
				{ binding: "STAGING_DISPATCH", namespace: "acme-staging" },
				{ binding: "PRODUCTION_DISPATCH", namespace: "acme-production" },
			],
			services: [
				{ binding: "MANAGED_DEPLOYMENT_BROKER", service: "control" },
				{ binding: "DENY_EGRESS_CONTRACT", service: "deny" },
				{ binding: "DENY_EGRESS", service: "deny" },
			],
		},
		denyConfig: { main: "index.ts" },
	});

	assert.equal(report.capabilities.codeModeMcp.state, "configured");
	assert.equal(
		report.capabilities.managedWorkersForPlatforms.state,
		"configured",
	);
	assert.equal(
		report.capabilities.customerOwnedCloudflare.state,
		"configured",
	);
	assert.equal(report.capabilities.temporaryAccounts.state, "configured");
});

test("Given an enabled readiness string but only one support binding, when inspected, then advanced capabilities remain unavailable", () => {
	const mainConfig = createStaticSelfHostConfig({
		...example,
		main: "../../src/index.ts",
	});
	mainConfig.services = [
		{ binding: "CLOUDFLARE_OAUTH_CONTROL_PLANE", service: "control" },
	];
	mainConfig.vars.CLOUDFLARE_OAUTH_READINESS = "enabled";
	mainConfig.vars.CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS = "enabled";

	const report = detectSelfHostCapabilities({
		mainConfig,
		controlConfig: {
			d1_databases: [{ binding: "CONTROL_DB", database_id: example.databaseId }],
		},
	});

	assert.equal(
		report.capabilities.customerOwnedCloudflare.state,
		"optional_unavailable",
	);
	assert.ok(
		report.capabilities.customerOwnedCloudflare.missing.includes(
			"main service binding CLOUDFLARE_VERSION_HEALTH_RPC",
		),
	);
	assert.equal(
		report.capabilities.temporaryAccounts.state,
		"optional_unavailable",
	);
});

test("Given unsafe or incomplete public inputs, when config is generated, then it fails before provisioning", () => {
	for (const invalid of [
		{ ...example, deploymentName: "Shiplet With Spaces" },
		{ ...example, databaseId: "not-a-database-id" },
		{ ...example, appUrl: "http://shiplet.example.com" },
		{ ...example, authkitIssuer: "acme.authkit.app" },
	]) {
		assert.throws(() =>
			createStaticSelfHostConfig({ ...invalid, main: "../../src/index.ts" }),
		);
	}
});

test("Given Wrangler D1 creation output, when parsed, then only the database identifier is returned", () => {
	assert.equal(
		parseD1CreateOutput(`Created your new D1 database.\n{\n  "d1_databases": [{\n    "binding": "DB",\n    "database_name": "acme-shiplet",\n    "database_id": "${example.databaseId}"\n  }]\n}`),
		example.databaseId,
	);
	assert.throws(() => parseD1CreateOutput("database created without an id"));
});

test("Given an operator-owned Wrangler JSONC file, when read, then comments and trailing commas are accepted without changing string values", () => {
	assert.deepEqual(
		parseJsonConfig(`{
			// This URL contains comment-like characters that must remain intact.
			"url": "https://example.com/path//segment",
			"bindings": [
				{ "binding": "DB" },
			],
			/* Advanced configs often explain why readiness stays disabled. */
			"readiness": "disabled",
		}`),
		{
			url: "https://example.com/path//segment",
			bindings: [{ binding: "DB" }],
			readiness: "disabled",
		},
	);
});

test("Given malformed JSONC or JavaScript expressions, when parsed, then invalid configuration is rejected", () => {
	for (const source of [
		"[,]",
		'{"binding":,}',
		'{,"binding":"DB"}',
		'{"binding":"DB",,}',
		'{"binding":"DB" /* unfinished',
		'{"binding": undefined}',
		'{binding: "DB"}',
		'{"binding": "D" + "B"}',
	]) {
		assert.throws(() => parseJsonConfig(source));
	}
	assert.deepEqual(parseJsonConfig('{"offset": -1, "label": "/* literal */",}'), {
		offset: -1,
		label: "/* literal */",
	});
});

test("Given a JSONC config on disk, when the CLI reads or inspects it, then both commands accept the operator comments", async () => {
	const outputDir = await mkdtemp(path.join(tmpdir(), "shiplet-jsonc-config-"));
	try {
		const written = await writeStaticSelfHostArtifacts({
			...example,
			outputDir,
			repoRoot: root,
		});
		await writeFile(
			written.configPath,
			`// Operator-owned config\n${JSON.stringify(written.config).replace(/}$/, ",}")}`,
		);
		const helper = path.join(root, "scripts", "self-host-config.mjs");
		assert.equal(
			execFileSync(process.execPath, [
				helper, "field", "--config", written.configPath, "--name", "deployment-name",
			], { encoding: "utf8" }).trim(),
			example.deploymentName,
		);
		assert.match(
			execFileSync(process.execPath, [
				helper, "inspect", "--main-config", written.configPath,
			], { encoding: "utf8" }),
			/staticReview: available/,
		);
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
});

test("Given approved public inputs, when artifacts are written, then the real Worker dry-run accepts the static topology", async () => {
	const outputDir = await mkdtemp(path.join(tmpdir(), "shiplet-static-config-"));
	try {
		const written = await writeStaticSelfHostArtifacts({
			...example,
			outputDir,
			repoRoot: root,
		});
		const config = JSON.parse(await readFile(written.configPath, "utf8"));
		const report = JSON.parse(await readFile(written.capabilitiesPath, "utf8"));
		assert.equal(report.capabilities.staticReview.state, "available");
		assert.ok(!JSON.stringify(config).includes("CODE_MODE_LOADER"));

		const wrangler = path.join(root, "node_modules", ".bin", "wrangler");
		execFileSync(
			wrangler,
			["deploy", "--dry-run", "--config", written.configPath],
			{ cwd: root, encoding: "utf8", stdio: "pipe" },
		);
	} finally {
		await rm(outputDir, { recursive: true, force: true });
	}
});

test("The repeatable wizard is executable, keeps generated state ignored, and documents static-first setup", async () => {
	const wizardPath = path.join(root, "scripts", "self-host-setup.sh");
	const wizard = await readFile(wizardPath, "utf8");
	const mode = (await stat(wizardPath)).mode;
	assert.ok(mode & 0o100);
	assert.match(wizard, /ask_secret WORKOS_API_KEY/);
	assert.match(
		wizard,
		/printf '%s' "\$value" \| "\$WRANGLER" secret put "\$name" --config "\$CONFIG_PATH"/,
	);
	assert.doesNotMatch(
		wizard,
		/write_env (WORKOS_API_KEY|SHIPLET_REVIEW_TOKEN_SECRET)/,
	);
	assert.match(await readFile(path.join(root, ".gitignore"), "utf8"), /^\.shiplet-self-host\/$/m);
	assert.match(
		await readFile(path.join(root, "README.md"), "utf8"),
		/npm run setup:self-host/,
	);
	assert.match(
		await readFile(path.join(root, "docs", "self-hosting.mdx"), "utf8"),
		/Static-first is the supported default/,
	);
	const packageJson = JSON.parse(
		await readFile(path.join(root, "package.json"), "utf8"),
	);
	assert.equal(
		packageJson.scripts["setup:self-host"],
		"bash scripts/self-host-setup.sh",
	);
	assert.match(packageJson.scripts.test, /self-host-setup\.test\.mjs/);
});
