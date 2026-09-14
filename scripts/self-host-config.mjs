#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tokenizer } from "acorn";

const COMPATIBILITY_DATE = "2026-08-07";
const CONFIG_FILE = "wrangler.jsonc";
const CAPABILITIES_FILE = "capabilities.json";
const DATABASE_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEPLOYMENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u;

const MAIN_ADVANCED_SERVICES = Object.freeze([
	"CLOUDFLARE_OAUTH_CONTROL_PLANE",
	"CLOUDFLARE_GRANT_VAULT_RPC",
	"CLOUDFLARE_TEMPORARY_ACCOUNT_RPC",
	"CLOUDFLARE_VERSION_HEALTH_RPC",
	"CLOUDFLARE_CUSTOM_MCP_RUNTIME_RPC",
	"CLOUDFLARE_MANAGED_RUNTIME_RPC",
]);

const RUNTIME_SERVICES = Object.freeze([
	"MANAGED_DEPLOYMENT_BROKER",
	"DENY_EGRESS_CONTRACT",
	"DENY_EGRESS",
]);

function requireDeploymentName(value) {
	if (typeof value !== "string" || !DEPLOYMENT_NAME_PATTERN.test(value)) {
		throw new TypeError(
			"Deployment name must be 1-48 lowercase letters, numbers, or interior hyphens.",
		);
	}
	return value;
}

function requireDatabaseId(value) {
	if (typeof value !== "string" || !DATABASE_ID_PATTERN.test(value)) {
		throw new TypeError("D1 database ID must be a UUID.");
	}
	return value;
}

function requireHttpsOrigin(value, label) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new TypeError(`${label} must be a valid HTTPS origin.`);
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash
	) {
		throw new TypeError(`${label} must be a valid HTTPS origin.`);
	}
	return parsed.origin;
}

function hasBinding(entries, binding) {
	return Array.isArray(entries) && entries.some((entry) => entry?.binding === binding);
}

function hasDurableObjectBinding(entries, name) {
	return Array.isArray(entries) && entries.some((entry) => entry?.name === name);
}

function missingBindings(entries, bindings, label) {
	return bindings
		.filter((binding) => !hasBinding(entries, binding))
		.map((binding) => `${label} ${binding}`);
}

function capability(missing) {
	return Object.freeze({
		state: missing.length === 0 ? "configured" : "optional_unavailable",
		missing: Object.freeze(missing),
	});
}

export function createStaticSelfHostConfig(input) {
	const deploymentName = requireDeploymentName(input.deploymentName);
	const databaseId = requireDatabaseId(input.databaseId);
	const appUrl = requireHttpsOrigin(input.appUrl, "Application URL");
	const authkitIssuer = requireHttpsOrigin(
		input.authkitIssuer,
		"AuthKit issuer",
	);
	if (typeof input.main !== "string" || !input.main.trim()) {
		throw new TypeError("Worker entry point is required.");
	}

	return {
		name: deploymentName,
		main: input.main,
		compatibility_date: COMPATIBILITY_DATE,
		compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
		rules: [
			{
				type: "Text",
				globs: ["**/*.svg"],
				fallthrough: true,
			},
		],
		workers_dev: true,
		observability: { enabled: true },
		triggers: { crons: ["*/5 * * * *"] },
		version_metadata: { binding: "CF_VERSION_METADATA" },
		d1_databases: [
			{
				binding: "DB",
				database_name: deploymentName,
				database_id: databaseId,
			},
		],
		r2_buckets: [
			{
				binding: "SHIPLET_ASSETS",
				bucket_name: `${deploymentName}-assets`,
			},
			{
				binding: "REVIEW_ASSETS",
				bucket_name: `${deploymentName}-review-assets`,
			},
		],
		durable_objects: {
			bindings: [
				{ name: "SANDBOX_SESSION", class_name: "SandboxSession" },
				{ name: "SHIPLET_ROOT", class_name: "ShipletRoot" },
			],
		},
		migrations: [
			{
				tag: "v1_sandbox_session",
				new_sqlite_classes: ["SandboxSession"],
			},
			{
				tag: "v2_review_presence",
				new_sqlite_classes: ["ReviewPresenceRoom"],
			},
			{
				tag: "v3_shiplet_root",
				new_sqlite_classes: ["ShipletRoot"],
			},
			{
				tag: "v4_delete_review_presence",
				deleted_classes: ["ReviewPresenceRoom"],
			},
		],
		vars: {
			SHIPLET_AUTH_MODE: "workos",
			SHIPLET_APP_URL: appUrl,
			WORKOS_AUTHKIT_ISSUER: authkitIssuer,
			WORKOS_REDIRECT_URI: `${appUrl}/auth/callback`,
			SHIPLET_ENABLED_FEATURE_FLAGS: "",
			CLOUDFLARE_OAUTH_READINESS: "disabled",
			CLOUDFLARE_OAUTH_SMOKE_USER_ID: "",
			CLOUDFLARE_CONTROL_PLANE_VERSION_ID: "",
			CLOUDFLARE_RUNTIME_GATEWAY_VERSION_ID: "",
			CLOUDFLARE_DENY_EGRESS_VERSION_ID: "",
			CLOUDFLARE_SUPPORT_RELEASE_TAG: "",
			CLOUDFLARE_MANAGED_RUNTIME_READINESS: "disabled",
			CLOUDFLARE_MANAGED_RUNTIME_SMOKE_USER_ID: "",
			CLOUDFLARE_MANAGED_RUNTIME_OPERATOR_USER_ID: "",
			CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS: "disabled",
			CLOUDFLARE_TEMPORARY_ACCOUNTS_SMOKE_USER_ID: "",
			CUSTOM_DOMAIN: "",
		},
		upload_source_maps: false,
	};
}

export function detectSelfHostCapabilities(input) {
	const main = input.mainConfig ?? {};
	const mainVars = main.vars ?? {};
	const staticMissing = [
		...(hasBinding(main.d1_databases, "DB") ? [] : ["main D1 binding DB"]),
		...(hasBinding(main.r2_buckets, "SHIPLET_ASSETS")
			? []
			: ["main R2 binding SHIPLET_ASSETS"]),
		...(hasBinding(main.r2_buckets, "REVIEW_ASSETS")
			? []
			: ["main R2 binding REVIEW_ASSETS"]),
		...(hasDurableObjectBinding(
			main.durable_objects?.bindings,
			"SANDBOX_SESSION",
		)
			? []
			: ["Durable Object binding SANDBOX_SESSION"]),
		...(hasDurableObjectBinding(main.durable_objects?.bindings, "SHIPLET_ROOT")
			? []
			: ["Durable Object binding SHIPLET_ROOT"]),
	];
	const codeModeMissing = hasBinding(main.worker_loaders, "CODE_MODE_LOADER")
		? []
		: ["main Worker Loader binding CODE_MODE_LOADER"];

	const controlMissing = input.controlConfig
		? hasBinding(input.controlConfig.d1_databases, "CONTROL_DB")
			? []
			: ["control plane D1 binding CONTROL_DB"]
		: ["Cloudflare control-plane support Worker config"];
	const denyMissing = input.denyConfig
		? []
		: ["deny-egress support Worker config"];
	const runtimeMissing = input.runtimeConfig
		? [
				...(hasBinding(input.runtimeConfig.d1_databases, "RUNTIME_DB")
					? []
					: ["managed runtime D1 binding RUNTIME_DB"]),
				...(hasBinding(
					input.runtimeConfig.worker_loaders,
					"CUSTOM_MCP_LOADER",
				)
					? []
					: ["managed runtime Worker Loader binding CUSTOM_MCP_LOADER"]),
				...missingBindings(
					input.runtimeConfig.dispatch_namespaces,
					["STAGING_DISPATCH", "PRODUCTION_DISPATCH"],
					"managed runtime dispatch binding",
				),
				...missingBindings(
					input.runtimeConfig.services,
					RUNTIME_SERVICES,
					"managed runtime service binding",
				),
			]
		: ["managed runtime support Worker config"];
	const runtimeContractMissing = input.runtimeConfig
		? []
		: ["managed runtime support Worker config"];

	const mainServiceMissing = missingBindings(
		main.services,
		MAIN_ADVANCED_SERVICES,
		"main service binding",
	);
	const customerOwnedMissing = [
		...controlMissing,
		...runtimeContractMissing,
		...mainServiceMissing,
		...(mainVars.CLOUDFLARE_OAUTH_READINESS === "enabled"
			? []
			: ["CLOUDFLARE_OAUTH_READINESS=enabled after operator smoke"]),
	];
	const temporaryMissing = [
		...controlMissing,
		...runtimeContractMissing,
		...mainServiceMissing,
		...(mainVars.CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS === "enabled"
			? []
			: [
					"CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS=enabled after operator smoke",
				]),
	];
	const managedMissing = [
		...controlMissing,
		...denyMissing,
		...runtimeMissing,
		...mainServiceMissing,
		...(mainVars.CLOUDFLARE_MANAGED_RUNTIME_READINESS === "enabled"
			? []
			: ["CLOUDFLARE_MANAGED_RUNTIME_READINESS=enabled after operator smoke"]),
	];

	const capabilities = Object.freeze({
		staticReview: Object.freeze({
			state: staticMissing.length === 0 ? "available" : "misconfigured",
			missing: Object.freeze(staticMissing),
		}),
		codeModeMcp: capability(codeModeMissing),
		managedWorkersForPlatforms: capability(managedMissing),
		customerOwnedCloudflare: capability(customerOwnedMissing),
		temporaryAccounts: capability(temporaryMissing),
	});
	return Object.freeze({
		schemaVersion: "shiplet.self-host-capabilities/v1",
		profile:
			capabilities.managedWorkersForPlatforms.state === "configured"
				? "static-first+advanced"
				: "static-first",
		capabilities,
		docs: Object.freeze({
			selfHosting: "https://shiplet.cc/docs/self-hosting",
			workersForPlatforms:
				"https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/",
		}),
	});
}

export function parseD1CreateOutput(output) {
	if (typeof output !== "string") throw new TypeError("D1 output is required.");
	const match = output.match(
		/"database_id"\s*:\s*"([0-9a-f-]{36})"/iu,
	);
	if (!match) throw new TypeError("Wrangler output did not include a D1 database ID.");
	return requireDatabaseId(match[1]);
}

export async function writeStaticSelfHostArtifacts(input) {
	const outputDir = path.resolve(input.outputDir);
	const repoRoot = path.resolve(input.repoRoot);
	const configPath = path.join(outputDir, CONFIG_FILE);
	const capabilitiesPath = path.join(outputDir, CAPABILITIES_FILE);
	const main = path
		.relative(outputDir, path.join(repoRoot, "src", "index.ts"))
		.split(path.sep)
		.join("/");
	const config = createStaticSelfHostConfig({ ...input, main });
	const report = detectSelfHostCapabilities({ mainConfig: config });
	await mkdir(outputDir, { recursive: true });
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
		mode: 0o600,
	});
	await writeFile(capabilitiesPath, `${JSON.stringify(report, null, 2)}\n`, {
		mode: 0o600,
	});
	return Object.freeze({ configPath, capabilitiesPath, config, report });
}

function parseArguments(argv) {
	const [command, ...rest] = argv;
	const values = new Map();
	for (let index = 0; index < rest.length; index += 2) {
		const key = rest[index];
		const value = rest[index + 1];
		if (!key?.startsWith("--") || value === undefined) {
			throw new TypeError(`Expected --name value arguments; received ${key ?? "nothing"}.`);
		}
		values.set(key.slice(2), value);
	}
	return { command, values };
}

function requiredArgument(values, name) {
	const value = values.get(name);
	if (!value) throw new TypeError(`Missing --${name}.`);
	return value;
}

export function parseJsonConfig(source) {
	const ignored = [];
	const tokens = [...tokenizer(source, {
		ecmaVersion: "latest",
		allowHashBang: false,
		onComment: (_block, _text, start, end) => ignored.push({ start, end }),
	})];
	const valueEndings = new Set(["string", "num", "true", "false", "null", "]", "}"]);
	for (let index = 1; index < tokens.length - 1; index += 1) {
		const token = tokens[index];
		if (
			token.type.label === "," &&
			["}", "]"].includes(tokens[index + 1].type.label) &&
			valueEndings.has(tokens[index - 1].type.label)
		) {
			ignored.push(token);
		}
	}
	// Only comments and trailing commas are removed. JSON.parse still rejects
	// JavaScript syntax, missing values, and all other malformed JSON.
	let json = source;
	for (const { start, end } of ignored.sort((left, right) => right.start - left.start)) {
		json = `${json.slice(0, start)}${" ".repeat(end - start)}${json.slice(end)}`;
	}
	return JSON.parse(json);
}

async function readJson(filePath) {
	return parseJsonConfig(await readFile(path.resolve(filePath), "utf8"));
}

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

function fieldValue(config, name) {
	switch (name) {
		case "deployment-name":
			return config.name;
		case "database-id":
			return config.d1_databases?.find((entry) => entry.binding === "DB")
				?.database_id;
		case "assets-bucket":
			return config.r2_buckets?.find((entry) => entry.binding === "SHIPLET_ASSETS")
				?.bucket_name;
		case "review-assets-bucket":
			return config.r2_buckets?.find((entry) => entry.binding === "REVIEW_ASSETS")
				?.bucket_name;
		case "app-url":
			return config.vars?.SHIPLET_APP_URL;
		case "authkit-issuer":
			return config.vars?.WORKOS_AUTHKIT_ISSUER;
		default:
			throw new TypeError(`Unsupported public config field: ${name}.`);
	}
}

async function runCli() {
	const { command, values } = parseArguments(process.argv.slice(2));
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	if (command === "generate") {
		const written = await writeStaticSelfHostArtifacts({
			repoRoot,
			outputDir: requiredArgument(values, "output-dir"),
			deploymentName: requiredArgument(values, "deployment-name"),
			databaseId: requiredArgument(values, "database-id"),
			appUrl: requiredArgument(values, "app-url"),
			authkitIssuer: requiredArgument(values, "authkit-issuer"),
		});
		process.stdout.write(`${written.configPath}\n`);
		return;
	}
	if (command === "parse-d1") {
		process.stdout.write(`${parseD1CreateOutput(await readStdin())}\n`);
		return;
	}
	if (command === "field") {
		const config = await readJson(requiredArgument(values, "config"));
		const value = fieldValue(config, requiredArgument(values, "name"));
		if (typeof value !== "string" || !value) {
			throw new TypeError("Requested field is absent from the config.");
		}
		process.stdout.write(`${value}\n`);
		return;
	}
	if (command === "inspect") {
		const report = detectSelfHostCapabilities({
			mainConfig: await readJson(requiredArgument(values, "main-config")),
			controlConfig: values.has("control-config")
				? await readJson(values.get("control-config"))
				: undefined,
			runtimeConfig: values.has("runtime-config")
				? await readJson(values.get("runtime-config"))
				: undefined,
			denyConfig: values.has("deny-config")
				? await readJson(values.get("deny-config"))
				: undefined,
		});
		if (values.has("write")) {
			await writeFile(
				path.resolve(values.get("write")),
				`${JSON.stringify(report, null, 2)}\n`,
				{ mode: 0o600 },
			);
		}
		for (const [name, value] of Object.entries(report.capabilities)) {
			process.stdout.write(`${name}: ${value.state}\n`);
			for (const missing of value.missing) {
				process.stdout.write(`  - ${missing}\n`);
			}
		}
		return;
	}
	throw new TypeError(
		"Usage: self-host-config.mjs <generate|parse-d1|field|inspect> [options]",
	);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runCli().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
