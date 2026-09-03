#!/usr/bin/env node

const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");
const crypto = require("node:crypto");
const acorn =
	require("acorn") || require("node:module").createRequire(__filename)("acorn");

const DEFAULT_API_URL = "https://shiplet.cc";
const SHIPLET_ENDPOINT_PATH = "/api/shiplets";
const DEFAULT_VISIBILITY = "organization";
const VALID_COMMANDS = new Set([
	"publish",
	"prepare",
	"fork",
	"pull",
	"validate",
	"push",
	"diff",
	"deploy",
	"promote",
	"rollback",
	"eject",
]);
const VALID_VISIBILITIES = new Set([
	"private",
	"organization",
	"unlisted",
	"public",
]);
const SUBDOMAIN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_STATIC_ASSET_FILES = 200;
const MAX_STATIC_ASSET_FILE_BYTES = 10_000_000;
const MAX_STATIC_ASSET_TOTAL_BYTES = 50_000_000;
const MAX_STATIC_ASSET_PATH_LENGTH = 512;
const MAX_PACKAGE_FILES = 1_024;
const MAX_PACKAGE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGE_TREE_DEPTH = 32;
const MAX_PORTABLE_PATH_BYTES = 1_024;
const MAX_PORTABLE_PATH_SEGMENT_BYTES = 255;
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const MAX_PACKAGE_API_RESPONSE_BYTES = MAX_PACKAGE_BYTES + 1024 * 1024;
const API_REQUEST_TIMEOUT_MS = 30_000;
const PACKAGE_MEDIA_TYPE = "application/vnd.shiplet.package+json;version=1";
const PACKAGE_SCHEMA_VERSION = "shiplet.package/v1";
const RUNTIME_COMPATIBILITY = "shiplet.runtime/v1";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REQUIRED_PACKAGE_ENTRYPOINTS = [
	"artifact",
	"widget",
	"workflow",
	"mcp",
	"agentInstructions",
	"validation",
	"provenance",
];
const PACKAGE_KEYS = new Set(["mediaType", "manifest", "files"]);
const MANIFEST_KEYS = new Set([
	"schemaVersion",
	"runtimeCompatibility",
	"entrypoints",
	"requestedCapabilities",
	"limits",
	"staticFirst",
]);
const PACKAGE_FILE_KEYS = new Set([
	"path",
	"mediaType",
	"encoding",
	"content",
	"sha256",
	"size",
]);
const FORBIDDEN_AUTHORITY_KEYS = new Set([
	"accessgrant",
	"accessgrants",
	"audithistory",
	"auditevents",
	"authorizationcode",
	"authorization",
	"authorizationheader",
	"authheader",
	"apikey",
	"apicredential",
	"apicredentials",
	"accesstoken",
	"bearer",
	"bearertoken",
	"claimcode",
	"claimcredential",
	"claimcredentials",
	"claimurl",
	"clientsecret",
	"cloudflareconnection",
	"cloudflareconnections",
	"cloudflareapitoken",
	"credential",
	"credentials",
	"customerstate",
	"deployment",
	"deployments",
	"grant",
	"grants",
	"oauth",
	"oauthdata",
	"oauthgrant",
	"oauthgrants",
	"password",
	"passwords",
	"privatekey",
	"session",
	"sessions",
	"state",
	"token",
	"tokens",
]);
const FORBIDDEN_PACKAGE_ROOTS = new Set([
	"audit",
	"audits",
	"claim",
	"claims",
	"credential",
	"credentials",
	"deployment",
	"deployments",
	"grant",
	"grants",
	"oauth",
	"session",
	"sessions",
	"state",
]);
const APPROVAL_COMMANDS = new Set(["deploy", "promote", "rollback"]);
const ALLOWED_STATIC_ASSET_EXTENSIONS = new Set([
	"3gp",
	"7z",
	"avif",
	"aac",
	"aif",
	"aiff",
	"arrow",
	"asc",
	"astro",
	"avi",
	"bash",
	"bat",
	"bib",
	"bmp",
	"bz2",
	"c",
	"cc",
	"cfg",
	"cgi",
	"cjs",
	"clj",
	"cljs",
	"cljc",
	"cmd",
	"conf",
	"cpp",
	"cpg",
	"cs",
	"css",
	"csv",
	"cxx",
	"dart",
	"dbf",
	"dbml",
	"doc",
	"docx",
	"dockerignore",
	"e57",
	"edn",
	"epub",
	"erl",
	"ex",
	"exs",
	"feather",
	"fgb",
	"fish",
	"flac",
	"fs",
	"fsx",
	"geojson",
	"gitattributes",
	"gitignore",
	"gif",
	"gml",
	"go",
	"gpkg",
	"gpx",
	"gql",
	"gradle",
	"graphql",
	"grb",
	"grib",
	"grib2",
	"groovy",
	"gz",
	"h",
	"h5",
	"hdf",
	"hdf5",
	"heic",
	"heif",
	"hpp",
	"hrl",
	"htm",
	"html",
	"ico",
	"ini",
	"ipynb",
	"java",
	"jfif",
	"jgw",
	"jpeg",
	"jpg",
	"js",
	"json",
	"jsonc",
	"jsonl",
	"jsx",
	"kml",
	"kmz",
	"kt",
	"kts",
	"las",
	"laz",
	"log",
	"lua",
	"m4a",
	"m4v",
	"map",
	"mbtiles",
	"md",
	"mdx",
	"mid",
	"midi",
	"mjs",
	"mkv",
	"ml",
	"mli",
	"mov",
	"mp3",
	"mp4",
	"mpeg",
	"mpg",
	"nc",
	"ndjson",
	"nim",
	"ods",
	"odt",
	"oga",
	"ogg",
	"ogv",
	"opus",
	"osm",
	"otf",
	"parquet",
	"pcd",
	"pdf",
	"pgw",
	"php",
	"pl",
	"pm",
	"pmtiles",
	"png",
	"ppt",
	"pptx",
	"prj",
	"properties",
	"proto",
	"ps1",
	"py",
	"pyi",
	"qgs",
	"qgz",
	"qix",
	"qmd",
	"qpj",
	"r",
	"rb",
	"rs",
	"rtf",
	"sbn",
	"sbx",
	"scala",
	"scss",
	"sh",
	"shp",
	"shx",
	"sld",
	"sol",
	"sql",
	"sqlite",
	"svg",
	"svelte",
	"swift",
	"tar",
	"tex",
	"tfw",
	"tgz",
	"tif",
	"tiff",
	"toml",
	"topojson",
	"ts",
	"tsv",
	"tsx",
	"txt",
	"ttf",
	"vb",
	"vbs",
	"vue",
	"vrt",
	"webmanifest",
	"webp",
	"webm",
	"weba",
	"wav",
	"wkt",
	"wld",
	"woff",
	"woff2",
	"xls",
	"xlsx",
	"xlsm",
	"xml",
	"yaml",
	"yml",
	"zig",
	"zsh",
	"zip",
]);
const ALLOWED_STATIC_ASSET_FILENAMES = new Set([
	".dockerignore",
	".eslintignore",
	".gitattributes",
	".gitignore",
	".prettierignore",
	"changelog",
	"dockerfile",
	"gemfile",
	"license",
	"makefile",
	"procfile",
	"rakefile",
	"readme",
]);
const ALLOWED_STATIC_ASSET_DOTFILES = new Set(
	[...ALLOWED_STATIC_ASSET_FILENAMES].filter((name) => name.startsWith(".")),
);
const BLOCKED_STATIC_ASSET_EXTENSIONS = new Set([
	"apk",
	"app",
	"bin",
	"class",
	"com",
	"deb",
	"dll",
	"dmg",
	"exe",
	"ipa",
	"jar",
	"msi",
	"pkg",
	"rar",
	"rpm",
	"wasm",
]);

class CliError extends Error {
	constructor(message, exitCode = 1) {
		super(message);
		this.name = "CliError";
		this.exitCode = exitCode;
	}
}

function helpText() {
	return `Shiplet CLI prepares review artifacts for team feedback.

Usage:
  shiplet publish <path> [options]
  shiplet prepare <path> [options]
  shiplet fork <shiplet-id> [--from-revision <revision-id>]
  shiplet pull <shiplet-id> <path> [--draft <draft-id> | --revision <revision-id>]
  shiplet validate <package-path>
  shiplet validate <draft-id> <package-path> --version <draft-version>
  shiplet push <draft-id> <package-path> --version <draft-version>
  shiplet diff <draft-id> <package-path> --version <draft-version>
  shiplet deploy <revision-id> --target <target-id> --approve
  shiplet promote <draft-id> --expected-active <revision-id> [--target <target-id> ...] --approve
  shiplet rollback <shiplet-id> --revision <revision-id> --expected-active <revision-id> --approve
  shiplet eject <shiplet-id> <path>

Commands:
  publish   Prepare and upload a file or static folder to Shiplet for review.
  prepare   Synonym for publish, using review-artifact language.
  fork      Create an isolated draft from a Shiplet revision.
  pull      Materialize a portable package without state or access grants.
  validate  Validate a portable package locally without activation.
  push      Replace a draft package using optimistic version matching.
  diff      Compare a local package with an isolated draft.
  deploy    Deploy one immutable revision to one explicit target.
  promote   Atomically activate a validated draft.
  rollback  Atomically reactivate a prior known-good revision.
  eject     Export and materialize a kernel-authority-free portable package.

Configuration:
  SHIPLET_API_URL   Optional API base URL. Can be replaced by --api-url.
  SHIPLET_API_KEY   Optional least-privilege organization key injected by a secret store.
  Authentication    Interactive commands use Shiplet's established OAuth/session path.
                    Never place key material in source, package content, shell history, or logs.

Flags:
  --name <name>          Artifact display name. Defaults to the file or folder name.
  --subdomain <slug>    DNS-safe review link slug. Defaults to a slug from the name.
  --visibility <mode>   private, organization, unlisted, or public. Defaults to organization.
  --api-url <url>        API base URL. Defaults to SHIPLET_API_URL or https://shiplet.cc.
  --token <token>        Organization key supplied by an established secret-store workflow.
  --dry-run             Build and print artifact metadata without making a network request.
  --approve             Confirm a deploy, promote, or rollback side effect.
  --target <id>         Exact deployment target ID.
  --idempotency-key <id> Reusable deploy/promote/rollback retry key.
  --draft <id>          Exact mutable draft selected for pull.
  --revision <id>       Exact revision selected for rollback.
  --from-revision <id>  Exact source revision selected for a fork.
  --expected-active <id> Optimistic active-revision precondition.
  --version <version>   Optimistic mutable-draft version precondition.
  --force               Permit pull/eject to write into a non-empty destination.
  --json                Print machine-readable JSON output.
  --help                Show this help.

Deployment targets:
  Shiplet-managed hosting is the zero-configuration default for static packages.
  Customer-owned Cloudflare targets require a separately established scoped OAuth connection.
  Human deployment effects use that browser session; raw tokens cannot authorize them.
`;
}

function parseArguments(argv) {
	const args = [...argv];
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		return { help: true };
	}

	const command = args.shift();
	if (!VALID_COMMANDS.has(command)) {
		throw new CliError(
			`Unknown command "${command}". Run shiplet --help for usage.`,
		);
	}

	const options = {
		command,
		artifactPath: "",
		positionals: [],
		name: "",
		subdomain: "",
		visibility: DEFAULT_VISIBILITY,
		apiUrl: "",
		token: "",
		dryRun: false,
		approve: false,
		force: false,
		json: false,
		help: false,
		target: "",
		targets: [],
		draft: "",
		revision: "",
		fromRevision: "",
		expectedActive: "",
		version: "",
		idempotencyKey: "",
		providedFlags: new Set(),
	};

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg === "--dry-run") {
			options.dryRun = true;
			options.providedFlags.add("--dry-run");
			continue;
		}
		if (arg === "--json") {
			options.json = true;
			options.providedFlags.add("--json");
			continue;
		}
		if (arg === "--approve") {
			options.approve = true;
			options.providedFlags.add("--approve");
			continue;
		}
		if (arg === "--force") {
			options.force = true;
			options.providedFlags.add("--force");
			continue;
		}
		if (arg.startsWith("--")) {
			const equalsIndex = arg.indexOf("=");
			const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
			const inlineValue =
				equalsIndex === -1 ? null : arg.slice(equalsIndex + 1);
			const value = inlineValue ?? readFlagValue(args, (index += 1), flag);
			options.providedFlags.add(flag);

			if (flag === "--name") options.name = value;
			else if (flag === "--subdomain") options.subdomain = value;
			else if (flag === "--visibility") options.visibility = value;
			else if (flag === "--api-url") options.apiUrl = value;
			else if (flag === "--token") options.token = value;
			else if (flag === "--target") {
				options.target = value;
				options.targets.push(value);
			} else if (flag === "--draft") options.draft = value;
			else if (flag === "--revision") options.revision = value;
			else if (flag === "--from-revision") options.fromRevision = value;
			else if (flag === "--expected-active") options.expectedActive = value;
			else if (flag === "--version") options.version = value;
			else if (flag === "--idempotency-key") options.idempotencyKey = value;
			else throw new CliError(`Unknown flag "${flag}".`);
			continue;
		}
		options.positionals.push(arg);
	}

	if (options.help) return options;
	if (command === "publish" || command === "prepare") {
		if (options.positionals.length !== 1) {
			throw new CliError(
				`Missing artifact path. Run shiplet ${command} <path>.`,
			);
		}
		options.artifactPath = options.positionals[0];
	}
	if (
		(command === "publish" || command === "prepare") &&
		!VALID_VISIBILITIES.has(options.visibility)
	) {
		throw new CliError(
			`Invalid visibility "${options.visibility}". Use private, organization, unlisted, or public.`,
		);
	}
	assertApplicableFlags(options);
	if (APPROVAL_COMMANDS.has(command) && !options.approve) {
		throw new CliError(`${command} requires explicit --approve confirmation.`);
	}

	return options;
}

function assertApplicableFlags(options) {
	const allowedCommands = {
		"--name": new Set(["publish", "prepare"]),
		"--subdomain": new Set(["publish", "prepare"]),
		"--visibility": new Set(["publish", "prepare"]),
		"--dry-run": new Set(["publish", "prepare", ...APPROVAL_COMMANDS]),
		"--approve": APPROVAL_COMMANDS,
		"--force": new Set(["pull", "eject"]),
		"--target": APPROVAL_COMMANDS,
		"--draft": new Set(["pull", "eject"]),
		"--revision": new Set(["pull", "eject", "rollback"]),
		"--from-revision": new Set(["fork"]),
		"--expected-active": new Set(["promote", "rollback"]),
		"--version": new Set(["validate", "push", "diff"]),
		"--idempotency-key": APPROVAL_COMMANDS,
	};
	for (const flag of options.providedFlags) {
		const allowed = allowedCommands[flag];
		if (allowed && !allowed.has(options.command)) {
			throw new CliError(
				`${flag} is not valid for shiplet ${options.command}.`,
			);
		}
	}
}

function readFlagValue(args, index, flag) {
	const value = args[index];
	if (!value || value.startsWith("--")) {
		throw new CliError(`Missing value for ${flag}.`);
	}
	return value;
}

function normalizeApiUrl(value) {
	const raw = String(value || DEFAULT_API_URL).trim() || DEFAULT_API_URL;
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		throw new CliError(
			"API URL must be a valid HTTPS origin or an explicit loopback HTTP origin.",
		);
	}
	const loopback =
		parsed.hostname === "localhost" ||
		parsed.hostname === "127.0.0.1" ||
		parsed.hostname === "[::1]" ||
		parsed.hostname === "::1";
	if (
		(parsed.protocol !== "https:" &&
			!(parsed.protocol === "http:" && loopback)) ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		(parsed.pathname !== "/" && parsed.pathname !== "")
	) {
		throw new CliError(
			"API URL must be an origin-only HTTPS URL without userinfo, query, or fragment; explicit loopback HTTP origins are allowed.",
		);
	}
	return parsed.origin;
}

function endpointFromOptions(options, env) {
	return `${normalizeApiUrl(options.apiUrl || env.SHIPLET_API_URL)}${SHIPLET_ENDPOINT_PATH}`;
}

function apiKeyFromOptions(options, env) {
	return String(options.token || env.SHIPLET_API_KEY || "").trim();
}

function humanNameFromPath(artifactPath) {
	const name = path.basename(artifactPath).trim();
	return name || "Review Artifact";
}

function slugify(value) {
	const slug = String(value)
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 63)
		.replace(/-+$/g, "");
	return slug || "review-artifact";
}

async function collectArtifactFiles(inputPath) {
	const absolutePath = path.resolve(inputPath);
	let stat;
	try {
		await assertNoSymlinkComponents(absolutePath, false);
		stat = await fs.lstat(absolutePath);
	} catch (error) {
		if (error instanceof CliError) throw error;
		throw new CliError(`Artifact path does not exist: ${inputPath}`);
	}
	if (stat.isSymbolicLink()) {
		throw new CliError("Selected artifact root cannot be a symbolic link.");
	}

	const fileRecords = [];
	if (stat.isDirectory()) {
		await collectDirectory(absolutePath, absolutePath, stat, fileRecords);
	} else if (stat.isFile()) {
		fileRecords.push({
			absolutePath,
			assetPath: toPosixPath(path.basename(absolutePath)),
			stat,
		});
	} else {
		throw new CliError("Artifact path must be a file or directory.");
	}

	fileRecords.sort((a, b) => a.assetPath.localeCompare(b.assetPath));
	if (fileRecords.length > MAX_STATIC_ASSET_FILES) {
		throw new CliError(
			`Static uploads are limited to ${MAX_STATIC_ASSET_FILES} files.`,
		);
	}

	const assets = [];
	let totalBytes = 0;
	for (const file of fileRecords) {
		const assetPath = normalizeStaticAssetPath(file.assetPath);
		assertSupportedAssetType(assetPath);
		const content = await readStableRegularFile(
			file.absolutePath,
			file.stat,
			MAX_STATIC_ASSET_FILE_BYTES,
			`Artifact file ${assetPath}`,
		);
		if (content.byteLength === 0) continue;
		if (content.byteLength > MAX_STATIC_ASSET_FILE_BYTES) {
			throw new CliError(
				`Asset is too large. Each file is limited to ${formatBytes(MAX_STATIC_ASSET_FILE_BYTES)}.`,
			);
		}
		totalBytes += content.byteLength;
		if (totalBytes > MAX_STATIC_ASSET_TOTAL_BYTES) {
			throw new CliError(
				`Static upload is too large. Total files are limited to ${formatBytes(MAX_STATIC_ASSET_TOTAL_BYTES)}.`,
			);
		}
		assets.push({
			path: assetPath,
			content: content.toString("base64"),
			size: content.byteLength,
		});
	}

	if (assets.length === 0) {
		throw new CliError("No non-empty files found in artifact path.");
	}

	return assets;
}

async function collectDirectory(
	basePath,
	directory,
	inspectedStat,
	fileRecords,
) {
	const beforeRead = await fs.lstat(directory);
	if (
		beforeRead.isSymbolicLink() ||
		!beforeRead.isDirectory() ||
		!sameFileIdentity(inspectedStat, beforeRead)
	) {
		throw new CliError("Artifact directory changed while it was being read.");
	}
	const entries = await fs.readdir(directory, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));

	for (const entry of entries) {
		const absolutePath = path.join(directory, entry.name);
		const stat = await fs.lstat(absolutePath);
		if (stat.isSymbolicLink()) {
			throw new CliError(
				`Artifact directory contains a symbolic link: ${entry.name}.`,
			);
		}
		if (stat.isDirectory()) {
			await collectDirectory(basePath, absolutePath, stat, fileRecords);
			continue;
		}
		if (!stat.isFile()) continue;
		fileRecords.push({
			absolutePath,
			assetPath: toPosixPath(path.relative(basePath, absolutePath)),
			stat,
		});
	}
	const afterRead = await fs.lstat(directory);
	if (
		afterRead.isSymbolicLink() ||
		!afterRead.isDirectory() ||
		!sameFileIdentity(beforeRead, afterRead)
	) {
		throw new CliError("Artifact directory changed while it was being read.");
	}
}

function toPosixPath(value) {
	return value.split(path.sep).join("/");
}

function normalizeStaticAssetPath(value) {
	const assetPath = String(value || "")
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\.\/+/, "")
		.replace(/\/+/g, "/");
	if (
		!assetPath ||
		assetPath.length > MAX_STATIC_ASSET_PATH_LENGTH ||
		assetPath.startsWith("/") ||
		assetPath.includes("\0") ||
		/^[a-zA-Z]:/.test(assetPath)
	) {
		throw new CliError(`Unsafe artifact file path: ${assetPath}`);
	}

	const segments = assetPath.split("/");
	if (
		segments.some(
			(segment) =>
				!segment ||
				segment === "." ||
				segment === ".." ||
				(segment.startsWith(".") &&
					!ALLOWED_STATIC_ASSET_DOTFILES.has(segment.toLowerCase())),
		)
	) {
		throw new CliError(`Unsafe artifact file path: ${assetPath}`);
	}
	return assetPath;
}

function assertSupportedAssetType(assetPath) {
	const extension =
		assetPath.split("/").pop()?.split(".").pop()?.toLowerCase() || "";
	const fileName = assetPath.split("/").pop()?.toLowerCase() || "";
	if (
		(!extension && !ALLOWED_STATIC_ASSET_FILENAMES.has(fileName)) ||
		BLOCKED_STATIC_ASSET_EXTENSIONS.has(extension) ||
		(!ALLOWED_STATIC_ASSET_EXTENSIONS.has(extension) &&
			!ALLOWED_STATIC_ASSET_FILENAMES.has(fileName))
	) {
		throw new CliError(
			`Unsupported artifact file type: .${extension || "none"}`,
		);
	}
}

function assertDnsSafeSubdomain(subdomain) {
	if (!SUBDOMAIN_PATTERN.test(subdomain) || subdomain.length > 63) {
		throw new CliError(
			"Subdomain must be DNS-safe: lowercase letters, numbers, and single hyphens, up to 63 characters.",
		);
	}
}

function formatBytes(value) {
	if (value >= 1_000_000) return `${value / 1_000_000} MB`;
	if (value >= 1_000) return `${value / 1_000} KB`;
	return `${value} bytes`;
}

async function buildPublishPayload(options, cwd = process.cwd()) {
	const absoluteArtifactPath = path.resolve(cwd, options.artifactPath);
	const name = options.name.trim() || humanNameFromPath(absoluteArtifactPath);
	const subdomain = options.subdomain.trim() || slugify(name);
	assertDnsSafeSubdomain(subdomain);
	return {
		name,
		subdomain,
		visibility: options.visibility,
		assets: await collectArtifactFiles(absoluteArtifactPath),
	};
}

function payloadSummary(payload) {
	return {
		assetCount: payload.assets.length,
		totalBytes: payload.assets.reduce((total, asset) => total + asset.size, 0),
		paths: payload.assets.map((asset) => asset.path),
	};
}

async function readBoundedResponseText(
	response,
	maximumBytes = MAX_API_RESPONSE_BYTES,
) {
	const declaredLength = Number(response.headers?.get?.("content-length") || 0);
	if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
		throw new CliError("Shiplet API response exceeded the byte limit.");
	}
	if (response.body === null) return "";
	if (!response.body || typeof response.body.getReader !== "function") {
		throw new CliError(
			"Shiplet API response cannot be read through the bounded response reader.",
		);
	}
	const reader = response.body.getReader();
	const chunks = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!(value instanceof Uint8Array)) {
				throw new CliError("Shiplet API returned an invalid response body.");
			}
			totalBytes += value.byteLength;
			if (totalBytes > maximumBytes) {
				try {
					await reader.cancel();
				} catch {
					// The response is already rejected; cancellation is best effort.
				}
				throw new CliError("Shiplet API response exceeded the byte limit.");
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock?.();
	}
	return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function fetchApiResponse(
	fetchImpl,
	url,
	init,
	maximumBytes = MAX_API_RESPONSE_BYTES,
) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);
	try {
		const response = await fetchImpl(url, {
			...init,
			redirect: "error",
			signal: controller.signal,
		});
		return {
			response,
			responseText: await readBoundedResponseText(response, maximumBytes),
		};
	} catch (error) {
		if (error && typeof error === "object" && error.name === "AbortError") {
			throw new CliError("Shiplet API request timed out.");
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function publishReviewArtifact(options) {
	const { payload, endpoint, apiKey, fetch: fetchImpl, authenticatedSession } = options;

	if (!apiKey && !authenticatedSession) {
		throw new CliError(
			"Production publishing requires Shiplet's established OAuth/session path. Use --dry-run to inspect artifact metadata without uploading; this CLI will not ask you to paste a credential.",
		);
	}
	if (typeof fetchImpl !== "function") {
		throw new CliError("This Node runtime does not provide fetch.");
	}

	const { response, responseText } = await fetchApiResponse(
		fetchImpl,
		endpoint,
		{
			method: "POST",
			headers: {
				...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
				"content-type": "application/json",
				accept: "application/json",
				"user-agent": "shiplet-cli/0.1",
			},
			body: JSON.stringify(payload),
		},
	);
	const body = parseJsonResponse(responseText);
	if (!response.ok) {
		const safe = sanitizeApiValue(body);
		const detail =
			typeof safe === "string"
				? safe
				: safe && typeof safe === "object"
					? JSON.stringify(safe)
					: sanitizeOutputText(response.statusText || "Request failed");
		throw new CliError(`Shiplet API returned ${response.status}: ${detail}`);
	}

	return body ?? { ok: true };
}

function parseJsonResponse(value) {
	if (!value) return null;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function writeJson(stdout, value) {
	stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeDryRun(stdout, payload, endpoint, summary, json) {
	const result = {
		ok: true,
		dryRun: true,
		action: "prepare_review_artifact",
		endpoint,
		name: payload.name,
		subdomain: payload.subdomain,
		visibility: payload.visibility,
		assetCount: summary.assetCount,
		totalBytes: summary.totalBytes,
		paths: summary.paths,
	};
	if (json) {
		writeJson(stdout, result);
		return;
	}
	stdout.write(`Dry run prepared review artifact "${payload.name}".\n`);
	stdout.write(`Endpoint: ${endpoint}\n`);
	stdout.write(`Files: ${summary.assetCount} (${summary.totalBytes} bytes)\n`);
	stdout.write("No network request made.\n");
}

function writePublishResult(stdout, payload, result, json) {
	const normalized = normalizePublishResult(payload, result);
	if (json) {
		writeJson(stdout, normalized);
		return;
	}

	stdout.write(`Prepared ${payload.name} for review.\n`);
	if (normalized.reviewUrl)
		stdout.write(`Review URL: ${normalized.reviewUrl}\n`);
}

function normalizePublishResult(payload, result) {
	const body =
		result && typeof result === "object" && !Array.isArray(result)
			? result
			: {};
	const project =
		body.project &&
		typeof body.project === "object" &&
		!Array.isArray(body.project)
			? body.project
			: {};
	return {
		ok: body.ok !== false,
		name: payload.name,
		subdomain: payload.subdomain,
		reviewUrl: safePublicOutputUrl(
			body.reviewUrl || body.shipletUrl || body.artifactUrl || "",
		),
		projectId: project.id || body.projectId || "",
	};
}

function assertIdentifier(value, label) {
	if (!IDENTIFIER_PATTERN.test(String(value || ""))) {
		throw new CliError(`Invalid ${label}.`);
	}
	return String(value);
}

function requirePositionals(options, count, usage) {
	if (options.positionals.length !== count) {
		throw new CliError(`Usage: shiplet ${usage}`);
	}
	return options.positionals;
}

function assertPortablePath(value) {
	if (typeof value !== "string") {
		throw new CliError("Unsafe package file path: missing");
	}
	const portablePath = value;
	if (
		!portablePath ||
		Buffer.byteLength(portablePath, "utf8") > MAX_PORTABLE_PATH_BYTES ||
		portablePath.startsWith("/") ||
		portablePath.includes("\\") ||
		/[\u0000-\u001f\u007f]/u.test(portablePath)
	) {
		throw new CliError(`Unsafe package file path: ${portablePath}`);
	}
	const segments = portablePath.split("/");
	if (
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new CliError(`Unsafe package file path: ${portablePath}`);
	}
	for (const segment of segments) {
		if (
			Buffer.byteLength(segment, "utf8") > MAX_PORTABLE_PATH_SEGMENT_BYTES ||
			/[<>:"|?*]/u.test(segment) ||
			/[. ]$/u.test(segment)
		) {
			throw new CliError(`Unsafe package file path: ${portablePath}`);
		}
		const basename = segment.split(".", 1)[0].toUpperCase();
		if (
			basename === "CON" ||
			basename === "PRN" ||
			basename === "AUX" ||
			basename === "NUL" ||
			/^COM[1-9]$/u.test(basename) ||
			/^LPT[1-9]$/u.test(basename)
		) {
			throw new CliError(`Unsafe package file path: ${portablePath}`);
		}
	}
	return portablePath;
}

function normalizedAuthorityName(value) {
	return String(value)
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[-_\s]/g, "");
}

function assertNoForbiddenAuthority(value, location = "package", depth = 0) {
	if (depth > MAX_PACKAGE_TREE_DEPTH) {
		throw new CliError(`Package metadata is too deep at ${location}.`);
	}
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			assertNoForbiddenAuthority(
				value[index],
				`${location}[${index}]`,
				depth + 1,
			);
		}
		return;
	}
	for (const [key, child] of Object.entries(value)) {
		if (FORBIDDEN_AUTHORITY_KEYS.has(normalizedAuthorityName(key))) {
			throw new CliError(
				`Credentials or authority are forbidden in ${location}.${key}.`,
			);
		}
		assertNoForbiddenAuthority(child, `${location}.${key}`, depth + 1);
	}
}

function assertExactKeys(value, allowed, label) {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key))
			throw new CliError(`Invalid ${label} field: ${key}.`);
	}
}

function assertAllowedPackagePath(filePath) {
	const root = normalizedAuthorityName(filePath.split("/", 1)[0]);
	if (FORBIDDEN_PACKAGE_ROOTS.has(root)) {
		throw new CliError(`Authority or state path is forbidden: ${filePath}.`);
	}
	if (
		filePath === "AGENTS.md" ||
		filePath === "workflow/schema.json" ||
		filePath === "mcp/manifest.json" ||
		filePath === "validation/manifest.json" ||
		filePath === "provenance.json" ||
		filePath.startsWith("artifact/") ||
		filePath.startsWith("widget/") ||
		filePath.startsWith("mcp/handlers/")
	) {
		return;
	}
	throw new CliError(`Invalid package file path: ${filePath}.`);
}

function packageFileBytes(entry) {
	if (entry.encoding === "utf8") {
		if (typeof entry.content !== "string") {
			throw new CliError(`Invalid UTF-8 package content for ${entry.path}.`);
		}
		return Buffer.from(entry.content, "utf8");
	}
	if (entry.encoding === "base64") {
		if (
			typeof entry.content !== "string" ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
				entry.content,
			)
		) {
			throw new CliError(`Invalid base64 package content for ${entry.path}.`);
		}
		return Buffer.from(entry.content, "base64");
	}
	throw new CliError(`Unsupported package encoding for ${entry.path}.`);
}

function unsupportedWidgetDependency(filePath, reason = "runtime") {
	throw new CliError(`Unsupported widget dependency (${reason}) at ${filePath}.`);
}

function walkWidgetJavaScript(node, filePath, seen = new Set()) {
	if (!node || typeof node !== "object" || seen.has(node)) return;
	seen.add(node);
	if (Array.isArray(node)) {
		for (const child of node) walkWidgetJavaScript(child, filePath, seen);
		return;
	}
	if (
		node.type === "Identifier" &&
		(node.name === "Worker" ||
			node.name === "SharedWorker" ||
			node.name === "importScripts")
	) {
		unsupportedWidgetDependency(filePath);
	}
	if (node.type === "ImportExpression" || node.type === "MetaProperty") {
		unsupportedWidgetDependency(filePath);
	}
	if (
		node.type === "NewExpression" &&
		node.callee?.type === "Identifier" &&
		(node.callee.name === "Worker" || node.callee.name === "SharedWorker")
	) {
		unsupportedWidgetDependency(filePath);
	}
	if (
		node.type === "CallExpression" &&
		node.callee?.type === "Identifier" &&
		node.callee.name === "importScripts"
	) {
		unsupportedWidgetDependency(filePath);
	}
	for (const child of Object.values(node)) {
		walkWidgetJavaScript(child, filePath, seen);
	}
}

function validateClassicWidgetJavaScript(source, filePath) {
	let program;
	try {
		program = acorn.parse(source, {
			ecmaVersion: "latest",
			sourceType: "script",
			allowHashBang: true,
		});
	} catch {
		unsupportedWidgetDependency(filePath, "syntax");
	}
	walkWidgetJavaScript(program, filePath);
}

function validateTerminalWidgetCss(source, filePath) {
	if (/@import(?:\s|url|["'])/i.test(source))
		unsupportedWidgetDependency(filePath);
	for (const match of source.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
		const reference = String(match[2] || "").trim();
		if (!/^(?:data:|blob:|#)/i.test(reference))
			unsupportedWidgetDependency(filePath);
	}
}

function widgetPackageReference(reference, entryPath, ownerPath) {
	const value = String(reference || "").trim();
	if (!value || value.startsWith("#") || /^(?:data:|blob:)/i.test(value))
		return null;
	if (
		value.includes("&") ||
		/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value)
	) {
		unsupportedWidgetDependency(ownerPath);
	}
	let resolved;
	try {
		resolved = new URL(value, new URL(entryPath, "https://package.invalid/"));
	} catch {
		unsupportedWidgetDependency(ownerPath);
	}
	let resolvedPath;
	try {
		resolvedPath = decodeURIComponent(resolved.pathname).replace(/^\/+/, "");
	} catch {
		unsupportedWidgetDependency(ownerPath);
	}
	const entryDirectory = entryPath.slice(0, entryPath.lastIndexOf("/") + 1);
	if (
		!resolvedPath.startsWith(entryDirectory) ||
		!resolvedPath.startsWith("widget/")
	) {
		unsupportedWidgetDependency(ownerPath);
	}
	return resolvedPath;
}

function parseWidgetAttributes(source, filePath) {
	const attributes = new Map();
	let cursor = 0;
	while (cursor < source.length) {
		while (/\s/.test(source[cursor] || "")) cursor += 1;
		if (cursor >= source.length || source[cursor] === "/") break;
		const nameStart = cursor;
		while (cursor < source.length && !/[\s=/>]/.test(source[cursor])) {
			cursor += 1;
		}
		if (cursor === nameStart) unsupportedWidgetDependency(filePath);
		const name = source.slice(nameStart, cursor).toLowerCase();
		while (/\s/.test(source[cursor] || "")) cursor += 1;
		let value = "";
		if (source[cursor] === "=") {
			cursor += 1;
			while (/\s/.test(source[cursor] || "")) cursor += 1;
			const quote = source[cursor];
			if (quote === '"' || quote === "'") {
				cursor += 1;
				const valueStart = cursor;
				while (cursor < source.length && source[cursor] !== quote) cursor += 1;
				if (cursor >= source.length) unsupportedWidgetDependency(filePath);
				value = source.slice(valueStart, cursor);
				cursor += 1;
			} else {
				const valueStart = cursor;
				while (cursor < source.length && !/[\s>]/.test(source[cursor])) {
					cursor += 1;
				}
				value = source.slice(valueStart, cursor);
			}
		}
		if (attributes.has(name)) unsupportedWidgetDependency(filePath);
		attributes.set(name, value);
	}
	return attributes;
}

function scanWidgetHtml(source, filePath) {
	const elements = [];
	const lower = source.toLowerCase();
	let cursor = 0;
	while (cursor < source.length) {
		const open = source.indexOf("<", cursor);
		if (open < 0) break;
		if (source.startsWith("<!--", open)) {
			const close = source.indexOf("-->", open + 4);
			if (close < 0) unsupportedWidgetDependency(filePath);
			cursor = close + 3;
			continue;
		}
		const marker = source[open + 1] || "";
		if (marker === "/" || marker === "!" || marker === "?") {
			const close = source.indexOf(">", open + 2);
			if (close < 0) unsupportedWidgetDependency(filePath);
			cursor = close + 1;
			continue;
		}
		let nameEnd = open + 1;
		while (/[A-Za-z0-9:-]/.test(source[nameEnd] || "")) nameEnd += 1;
		if (nameEnd === open + 1) {
			cursor = open + 1;
			continue;
		}
		const name = source.slice(open + 1, nameEnd).toLowerCase();
		let tagEnd = nameEnd;
		let quote = "";
		for (; tagEnd < source.length; tagEnd += 1) {
			const character = source[tagEnd];
			if (quote) {
				if (character === quote) quote = "";
			} else if (character === '"' || character === "'") {
				quote = character;
			} else if (character === ">") {
				break;
			}
		}
		if (tagEnd >= source.length || quote) {
			unsupportedWidgetDependency(filePath);
		}
		const attributes = parseWidgetAttributes(
			source.slice(nameEnd, tagEnd),
			filePath,
		);
		let content = "";
		cursor = tagEnd + 1;
		if (name === "script" || name === "style") {
			const closeStart = lower.indexOf(`</${name}`, cursor);
			if (closeStart < 0) unsupportedWidgetDependency(filePath);
			const closeEnd = source.indexOf(">", closeStart + name.length + 2);
			if (closeEnd < 0) unsupportedWidgetDependency(filePath);
			content = source.slice(cursor, closeStart);
			cursor = closeEnd + 1;
		}
		elements.push({ name, attributes, content });
	}
	return elements;
}

function validateRuntimeV1WidgetPackage(files, entryPath) {
	const fileMap = new Map(files.map((file) => [file.path, file]));
	const entry = fileMap.get(entryPath);
	if (!entry || !String(entry.mediaType).toLowerCase().includes("text/html"))
		unsupportedWidgetDependency(entryPath);
	const checkedScripts = new Set();
	const checkedStyles = new Set();
	const fileText = (file) => {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(
				packageFileBytes(file),
			);
		} catch {
			unsupportedWidgetDependency(file.path);
		}
	};
	const requireFile = (reference, ownerPath) => {
		const filePath = widgetPackageReference(reference, entryPath, ownerPath);
		if (!filePath) return null;
		const file = fileMap.get(filePath);
		if (!file) unsupportedWidgetDependency(ownerPath);
		return file;
	};
	const checkScript = (file) => {
		if (checkedScripts.has(file.path)) return;
		checkedScripts.add(file.path);
		if (!/(?:javascript|ecmascript)/i.test(String(file.mediaType))) {
			unsupportedWidgetDependency(file.path, "media_type");
		}
		validateClassicWidgetJavaScript(fileText(file), file.path);
	};
	const checkStyle = (file) => {
		if (checkedStyles.has(file.path)) return;
		checkedStyles.add(file.path);
		if (!String(file.mediaType).toLowerCase().includes("text/css")) {
			unsupportedWidgetDependency(file.path, "media_type");
		}
		validateTerminalWidgetCss(fileText(file), file.path);
	};
	const html = fileText(entry);
	for (const element of scanWidgetHtml(html, entryPath)) {
		const type = String(element.attributes.get("type") || "")
			.trim()
			.toLowerCase();
		const rel = new Set(
			String(element.attributes.get("rel") || "")
				.trim()
				.toLowerCase()
				.split(/\s+/)
				.filter(Boolean),
		);
		if (
			Array.from(element.attributes).some(
				([name, value]) => name.startsWith("on") && value,
			)
		) {
			unsupportedWidgetDependency(entryPath);
		}
		if (element.attributes.has("srcset")) {
			unsupportedWidgetDependency(entryPath);
		}
		const inlineStyle = element.attributes.get("style");
		if (inlineStyle) validateTerminalWidgetCss(inlineStyle, entryPath);

		if (element.name === "script") {
			if (type === "module" || type === "importmap") {
				unsupportedWidgetDependency(entryPath);
			}
			const src = element.attributes.get("src");
			if (
				element.attributes.has("href") ||
				Array.from(element.attributes).some(([name]) => name.endsWith(":href"))
			) {
				unsupportedWidgetDependency(entryPath);
			}
			if (
				![
					"",
					"text/javascript",
					"application/javascript",
					"text/ecmascript",
					"application/ecmascript",
				].includes(type)
			) {
				if (src) unsupportedWidgetDependency(entryPath);
				continue;
			}
			if (src) {
				const file = requireFile(src, entryPath);
				if (!file) unsupportedWidgetDependency(entryPath);
				checkScript(file);
			} else if (element.content.trim()) {
				validateClassicWidgetJavaScript(element.content, entryPath);
			}
			continue;
		}
		if (element.name === "style") {
			validateTerminalWidgetCss(element.content, entryPath);
			continue;
		}
		if (element.name === "link") {
			if (rel.has("modulepreload")) unsupportedWidgetDependency(entryPath);
			const href = element.attributes.get("href");
			if (href) {
				const file = requireFile(href, entryPath);
				if (file && rel.has("stylesheet")) checkStyle(file);
			}
			continue;
		}
		const src = element.attributes.get("src");
		if (src) {
			if (element.name === "iframe" || element.name === "frame") {
				unsupportedWidgetDependency(entryPath);
			}
			requireFile(src, entryPath);
		}
		const poster = element.attributes.get("poster");
		if (poster) requireFile(poster, entryPath);
		const href = element.attributes.get("href");
		if (href && (element.name === "a" || element.name === "area")) {
			if (!href.trim().startsWith("#")) unsupportedWidgetDependency(entryPath);
		} else if (href) {
			requireFile(href, entryPath);
		}
	}
}

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, canonicalize(value[key])]),
	);
}

function validatePortablePackage(envelope) {
	if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
		throw new CliError("Portable package must be a JSON object.");
	}
	assertNoForbiddenAuthority(envelope);
	assertExactKeys(envelope, PACKAGE_KEYS, "portable package");
	if (envelope.mediaType !== PACKAGE_MEDIA_TYPE) {
		throw new CliError(
			`Portable package mediaType must be ${PACKAGE_MEDIA_TYPE}.`,
		);
	}
	const manifest = envelope.manifest;
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
		throw new CliError("Portable package manifest is required.");
	}
	assertExactKeys(manifest, MANIFEST_KEYS, "manifest");
	if (manifest.schemaVersion !== PACKAGE_SCHEMA_VERSION) {
		throw new CliError(
			`Unsupported package schema: ${manifest.schemaVersion || "missing"}.`,
		);
	}
	if (manifest.runtimeCompatibility !== RUNTIME_COMPATIBILITY) {
		throw new CliError(
			`Unsupported runtime compatibility: ${manifest.runtimeCompatibility || "missing"}.`,
		);
	}
	if (
		!manifest.entrypoints ||
		typeof manifest.entrypoints !== "object" ||
		Array.isArray(manifest.entrypoints)
	) {
		throw new CliError("Portable package manifest entrypoints are required.");
	}
	assertExactKeys(
		manifest.entrypoints,
		new Set(REQUIRED_PACKAGE_ENTRYPOINTS),
		"manifest entrypoints",
	);
	for (const entrypoint of REQUIRED_PACKAGE_ENTRYPOINTS) {
		const entryPath = manifest.entrypoints[entrypoint];
		if (typeof entryPath !== "string") {
			throw new CliError(`Missing manifest entrypoint: ${entrypoint}.`);
		}
		assertPortablePath(entryPath);
		if (!entrypointMatchesPath(entrypoint, entryPath)) {
			throw new CliError(`Invalid ${entrypoint} entrypoint: ${entryPath}.`);
		}
	}
	if (
		!Array.isArray(manifest.requestedCapabilities) ||
		manifest.requestedCapabilities.some(
			(capability) => typeof capability !== "string" || capability.length === 0,
		)
	) {
		throw new CliError("Invalid manifest requestedCapabilities.");
	}
	if (
		!manifest.limits ||
		typeof manifest.limits !== "object" ||
		Array.isArray(manifest.limits)
	) {
		throw new CliError("Portable package manifest limits are required.");
	}
	for (const [name, limit] of Object.entries(manifest.limits)) {
		if (!Number.isSafeInteger(limit) || limit <= 0) {
			throw new CliError(`Invalid manifest limit: ${name}.`);
		}
	}
	for (const name of ["fileCount", "fileBytes", "packageBytes"]) {
		if (!Number.isSafeInteger(manifest.limits[name])) {
			throw new CliError(`Missing manifest limit: ${name}.`);
		}
	}
	if (manifest.limits.packageBytes < manifest.limits.fileBytes) {
		throw new CliError(
			"Invalid manifest limit: packageBytes must cover fileBytes.",
		);
	}
	if (typeof manifest.staticFirst !== "boolean") {
		throw new CliError("Invalid manifest staticFirst value.");
	}
	if (!Array.isArray(envelope.files) || envelope.files.length === 0) {
		throw new CliError("Portable package files are required.");
	}
	if (envelope.files.length > MAX_PACKAGE_FILES) {
		throw new CliError(
			`Portable packages are limited to ${MAX_PACKAGE_FILES} files.`,
		);
	}
	if (envelope.files.length > manifest.limits.fileCount) {
		throw new CliError("Portable package exceeds manifest.limits.fileCount.");
	}
	const seen = new Map();
	let packageBytes = Buffer.byteLength(JSON.stringify(canonicalize(manifest)));
	const files = envelope.files.map((source) => {
		if (!source || typeof source !== "object" || Array.isArray(source)) {
			throw new CliError("Invalid portable package file entry.");
		}
		assertExactKeys(source, PACKAGE_FILE_KEYS, "portable package file");
		const filePath = assertPortablePath(source.path);
		assertAllowedPackagePath(filePath);
		const folded = filePath.normalize("NFC").toLowerCase();
		if (seen.has(folded))
			throw new CliError(`Duplicate package path: ${filePath}.`);
		seen.set(folded, filePath);
		if (typeof source.mediaType !== "string" || source.mediaType.length === 0) {
			throw new CliError(`Invalid media type for ${filePath}.`);
		}
		const bytes = packageFileBytes({ ...source, path: filePath });
		if (
			!Number.isSafeInteger(source.size) ||
			source.size < 0 ||
			source.size !== bytes.byteLength
		) {
			throw new CliError(`Package size mismatch for ${filePath}.`);
		}
		if (bytes.byteLength > MAX_PACKAGE_FILE_BYTES) {
			throw new CliError(`Package file is too large: ${filePath}.`);
		}
		if (bytes.byteLength > manifest.limits.fileBytes) {
			throw new CliError(
				`Portable package exceeds manifest.limits.fileBytes at ${filePath}.`,
			);
		}
		const digest = crypto.createHash("sha256").update(bytes).digest("hex");
		if (
			typeof source.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(source.sha256) ||
			source.sha256 !== digest
		) {
			throw new CliError(`Package digest mismatch for ${filePath}.`);
		}
		packageBytes += bytes.byteLength;
		if (packageBytes > MAX_PACKAGE_BYTES) {
			throw new CliError("Portable package is too large.");
		}
		if (packageBytes > manifest.limits.packageBytes) {
			throw new CliError(
				"Portable package exceeds manifest.limits.packageBytes.",
			);
		}
		return { ...source, path: filePath };
	});
	files.sort((left, right) => left.path.localeCompare(right.path));
	const packagePaths = new Set(files.map((file) => file.path));
	for (const file of files) validateStructuredPackageFile(file, packagePaths);
	for (const name of REQUIRED_PACKAGE_ENTRYPOINTS) {
		const entryPath = manifest.entrypoints[name];
		if (!seen.has(entryPath.normalize("NFC").toLowerCase())) {
			throw new CliError(`Missing ${name} entrypoint: ${entryPath}.`);
		}
	}
	validateRuntimeV1WidgetPackage(files, manifest.entrypoints.widget);
	const normalizedEnvelope = { mediaType: PACKAGE_MEDIA_TYPE, manifest, files };
	const serialized = JSON.stringify(canonicalize(normalizedEnvelope));
	if (Buffer.byteLength(serialized) > MAX_PACKAGE_BYTES) {
		throw new CliError("Portable package is too large.");
	}
	if (Buffer.byteLength(serialized) > manifest.limits.packageBytes) {
		throw new CliError(
			"Portable package exceeds manifest.limits.packageBytes.",
		);
	}
	const packageDigest = crypto
		.createHash("sha256")
		.update(serialized)
		.digest("hex");
	return {
		envelope: normalizedEnvelope,
		summary: {
			ok: true,
			schemaVersion: manifest.schemaVersion,
			runtimeCompatibility: manifest.runtimeCompatibility,
			fileCount: files.length,
			totalBytes: files.reduce((total, file) => total + file.size, 0),
			paths: files.map((file) => file.path),
			packageDigest,
		},
	};
}

function entrypointMatchesPath(entrypoint, filePath) {
	if (entrypoint === "artifact") return filePath.startsWith("artifact/");
	if (entrypoint === "widget") return filePath.startsWith("widget/");
	if (entrypoint === "workflow") return filePath === "workflow/schema.json";
	if (entrypoint === "mcp") return filePath === "mcp/manifest.json";
	if (entrypoint === "agentInstructions") return filePath === "AGENTS.md";
	if (entrypoint === "validation")
		return filePath === "validation/manifest.json";
	if (entrypoint === "provenance") return filePath === "provenance.json";
	return false;
}

function validNamedString(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function hasOnlyKeys(value, allowed) {
	return Object.keys(value).every((key) => allowed.has(key));
}

function parseStructuredPackageJson(file) {
	let parsed;
	try {
		const bytes = packageFileBytes(file);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		parsed = JSON.parse(text);
	} catch (error) {
		if (error instanceof CliError) throw error;
		throw new CliError(`Invalid JSON schema file: ${file.path}.`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new CliError(`Invalid schema file: ${file.path}.`);
	}
	assertNoForbiddenAuthority(parsed, file.path);
	return parsed;
}

function validateStructuredPackageFile(file, packagePaths) {
	if (
		file.path !== "workflow/schema.json" &&
		file.path !== "mcp/manifest.json" &&
		file.path !== "validation/manifest.json" &&
		file.path !== "provenance.json"
	) {
		return;
	}
	const value = parseStructuredPackageJson(file);
	if (file.path === "workflow/schema.json") {
		const allowedCategories = new Set([
			"open",
			"in_progress",
			"blocked",
			"resolved",
			"closed",
			"informational",
		]);
		if (
			!hasOnlyKeys(value, new Set(["schemaVersion", "statuses", "fields"])) ||
			value.schemaVersion !== "shiplet.workflow/v1" ||
			!Array.isArray(value.statuses) ||
			!Array.isArray(value.fields) ||
			value.statuses.some(
				(status) =>
					!status ||
					typeof status !== "object" ||
					Array.isArray(status) ||
					!hasOnlyKeys(status, new Set(["name", "category"])) ||
					!validNamedString(status.name) ||
					!allowedCategories.has(status.category),
			) ||
			value.fields.some(
				(field) =>
					!field ||
					typeof field !== "object" ||
					Array.isArray(field) ||
					!hasOnlyKeys(field, new Set(["name", "type"])) ||
					!validNamedString(field.name) ||
					!validNamedString(field.type),
			)
		) {
			throw new CliError(`Invalid workflow schema: ${file.path}.`);
		}
		return;
	}
	if (file.path === "mcp/manifest.json") {
		if (
			!hasOnlyKeys(value, new Set(["schemaVersion", "tools"])) ||
			value.schemaVersion !== "shiplet.mcp/v1" ||
			!Array.isArray(value.tools) ||
			value.tools.some(
				(tool) =>
					!tool ||
					typeof tool !== "object" ||
					Array.isArray(tool) ||
					!hasOnlyKeys(
						tool,
						new Set([
							"name",
							"description",
							"handler",
							"inputSchema",
							"requestedCapabilities",
							"approval",
						]),
					) ||
					!validNamedString(tool.name) ||
					!validNamedString(tool.description) ||
					typeof tool.handler !== "string" ||
					!tool.handler.startsWith("mcp/handlers/") ||
					!packagePaths.has(tool.handler) ||
					!tool.inputSchema ||
					typeof tool.inputSchema !== "object" ||
					Array.isArray(tool.inputSchema) ||
					!Array.isArray(tool.requestedCapabilities) ||
					tool.requestedCapabilities.some(
						(capability) => !validNamedString(capability),
					) ||
					!validNamedString(tool.approval),
			)
		) {
			throw new CliError(`Invalid MCP schema: ${file.path}.`);
		}
		return;
	}
	if (file.path === "validation/manifest.json") {
		if (
			!hasOnlyKeys(value, new Set(["schemaVersion", "checks"])) ||
			value.schemaVersion !== "shiplet.validation/v1" ||
			!Array.isArray(value.checks) ||
			value.checks.some(
				(check) =>
					!check ||
					typeof check !== "object" ||
					Array.isArray(check) ||
					!hasOnlyKeys(check, new Set(["id", "kind", "path"])) ||
					check.kind !== "file-exists" ||
					typeof check.path !== "string" ||
					check.path.length === 0 ||
					(check.id !== undefined && !validNamedString(check.id)),
			)
		) {
			throw new CliError(`Invalid validation schema: ${file.path}.`);
		}
		for (const check of value.checks) {
			assertPortablePath(check.path);
			if (!packagePaths.has(check.path)) {
				throw new CliError(`Validation file does not exist: ${check.path}.`);
			}
		}
		return;
	}
	if (
		!hasOnlyKeys(value, new Set(["schemaVersion", "source", "lineage"])) ||
		value.schemaVersion !== "shiplet.provenance/v1" ||
		!value.source ||
		typeof value.source !== "object" ||
		Array.isArray(value.source) ||
		!hasOnlyKeys(value.source, new Set(["kind"])) ||
		!validNamedString(value.source.kind) ||
		!value.lineage ||
		typeof value.lineage !== "object" ||
		Array.isArray(value.lineage) ||
		!hasOnlyKeys(value.lineage, new Set(["parentRevisionId"])) ||
		(value.lineage.parentRevisionId !== null &&
			!validNamedString(value.lineage.parentRevisionId))
	) {
		throw new CliError(`Invalid provenance schema: ${file.path}.`);
	}
}

function mediaTypeForPackagePath(filePath) {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".html" || extension === ".htm")
		return "text/html; charset=utf-8";
	if (extension === ".js" || extension === ".mjs")
		return "text/javascript; charset=utf-8";
	if (extension === ".css") return "text/css; charset=utf-8";
	if (extension === ".md") return "text/markdown; charset=utf-8";
	if (extension === ".json") return "application/json";
	if (extension === ".txt" || extension === ".csv")
		return "text/plain; charset=utf-8";
	return "application/octet-stream";
}

function isDeterministicTextPath(filePath, bytes) {
	if (
		!new Set([
			".html",
			".htm",
			".js",
			".mjs",
			".css",
			".md",
			".json",
			".txt",
			".csv",
		]).has(path.extname(filePath).toLowerCase())
	) {
		return false;
	}
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

function sameFileIdentity(left, right) {
	if (!left || !right) return false;
	if (left.dev !== right.dev || left.ino !== right.ino) return false;
	return left.size === right.size;
}

function samePathComponentIdentity(left, right) {
	if (!left || !right) return false;
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.isDirectory() === right.isDirectory() &&
		left.isFile() === right.isFile()
	);
}

async function snapshotSafePathComponents(targetPath) {
	const absolutePath = path.resolve(targetPath);
	const parsed = path.parse(absolutePath);
	const segments = path
		.relative(parsed.root, absolutePath)
		.split(path.sep)
		.filter(Boolean);
	const snapshot = [];
	let current = parsed.root;
	for (let index = 0; index < segments.length; index += 1) {
		current = path.join(current, segments[index]);
		const stat = await fs.lstat(current);
		if (stat.isSymbolicLink()) {
			if (await isTrustedSystemPathAlias(current)) continue;
			throw new CliError(
				`Artifact path component cannot be a symbolic link: ${current}.`,
			);
		}
		if (index < segments.length - 1 && !stat.isDirectory()) {
			throw new CliError(
				`Artifact path ancestor must be a directory: ${current}.`,
			);
		}
		snapshot.push({ componentPath: current, stat });
	}
	return snapshot;
}

async function verifySafePathComponents(snapshot) {
	for (const component of snapshot) {
		const currentStat = await fs.lstat(component.componentPath);
		if (
			currentStat.isSymbolicLink() ||
			!samePathComponentIdentity(component.stat, currentStat)
		) {
			throw new CliError(
				`Artifact path intermediate component changed while it was being read: ${component.componentPath}.`,
			);
		}
	}
}

async function readStableRegularFile(
	filePath,
	inspectedStat,
	maximumBytes,
	label,
) {
	let handle;
	try {
		const pathSnapshot = await snapshotSafePathComponents(filePath);
		const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW)
			? fsConstants.O_NOFOLLOW
			: 0;
		handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
		const openedStat = await handle.stat();
		const currentStat = await fs.lstat(filePath);
		if (
			!openedStat.isFile() ||
			currentStat.isSymbolicLink() ||
			!currentStat.isFile() ||
			!sameFileIdentity(inspectedStat, openedStat) ||
			!sameFileIdentity(openedStat, currentStat)
		) {
			throw new CliError(`${label} changed while it was being read.`);
		}
		if (openedStat.size > maximumBytes) {
			throw new CliError(`${label} is too large.`);
		}
		const bytes = await handle.readFile();
		if (bytes.byteLength !== openedStat.size) {
			throw new CliError(`${label} changed while it was being read.`);
		}
		await verifySafePathComponents(pathSnapshot);
		return bytes;
	} catch (error) {
		if (error instanceof CliError) throw error;
		if (error && (error.code === "ELOOP" || error.code === "EMLINK")) {
			throw new CliError(`${label} cannot be a symbolic link.`);
		}
		throw error;
	} finally {
		if (handle) await handle.close().catch(() => undefined);
	}
}

async function packMaterializedPackage(directory) {
	await assertNoSymlinkComponents(directory, false);
	const manifestPath = path.join(directory, "shiplet.json");
	const manifestStat = await fs.lstat(manifestPath).catch(() => null);
	if (
		!manifestStat ||
		!manifestStat.isFile() ||
		manifestStat.isSymbolicLink()
	) {
		throw new CliError(
			"Materialized package requires a regular shiplet.json manifest.",
		);
	}
	if (manifestStat.size > MAX_PACKAGE_BYTES) {
		throw new CliError("Materialized package manifest is too large.");
	}
	let manifest;
	try {
		const manifestBytes = await readStableRegularFile(
			manifestPath,
			manifestStat,
			MAX_PACKAGE_BYTES,
			"Materialized package manifest",
		);
		manifest = JSON.parse(manifestBytes.toString("utf8"));
	} catch {
		throw new CliError("Materialized shiplet.json must contain valid JSON.");
	}
	const records = [];
	await collectMaterializedPackageFiles(directory, directory, records);
	if (records.length > MAX_PACKAGE_FILES) {
		throw new CliError(
			`Portable packages are limited to ${MAX_PACKAGE_FILES} files.`,
		);
	}
	const files = [];
	let totalBytes = 0;
	for (const record of records) {
		if (record.filePath === "shiplet.json") continue;
		assertPortablePath(record.filePath);
		assertAllowedPackagePath(record.filePath);
		if (record.size > MAX_PACKAGE_FILE_BYTES) {
			throw new CliError(`Package file is too large: ${record.filePath}.`);
		}
		totalBytes += record.size;
		if (totalBytes > MAX_PACKAGE_BYTES)
			throw new CliError("Portable package is too large.");
		const bytes = await readStableRegularFile(
			record.absolutePath,
			record.stat,
			MAX_PACKAGE_FILE_BYTES,
			`Package file ${record.filePath}`,
		);
		const encoding = isDeterministicTextPath(record.filePath, bytes)
			? "utf8"
			: "base64";
		files.push({
			path: record.filePath,
			mediaType: mediaTypeForPackagePath(record.filePath),
			encoding,
			content:
				encoding === "utf8" ? bytes.toString("utf8") : bytes.toString("base64"),
			sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
			size: bytes.byteLength,
		});
	}
	files.sort((left, right) => left.path.localeCompare(right.path));
	return validatePortablePackage({
		mediaType: PACKAGE_MEDIA_TYPE,
		manifest,
		files,
	});
}

async function collectMaterializedPackageFiles(basePath, directory, records) {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		const absolutePath = path.join(directory, entry.name);
		const stat = await fs.lstat(absolutePath);
		if (stat.isSymbolicLink()) {
			throw new CliError(
				`Materialized package cannot contain a symbolic link: ${entry.name}.`,
			);
		}
		if (stat.isDirectory()) {
			await collectMaterializedPackageFiles(basePath, absolutePath, records);
			continue;
		}
		if (!stat.isFile()) {
			throw new CliError(
				`Materialized package contains a non-file entry: ${entry.name}.`,
			);
		}
		records.push({
			absolutePath,
			filePath: toPosixPath(path.relative(basePath, absolutePath)),
			size: stat.size,
			stat,
		});
	}
}

async function readPortablePackage(inputPath, cwd) {
	const absolutePath = path.resolve(cwd, inputPath);
	let stat;
	try {
		await assertNoSymlinkComponents(absolutePath, false);
		stat = await fs.lstat(absolutePath);
	} catch (error) {
		if (error instanceof CliError) throw error;
		if (error && error.code !== "ENOENT") throw error;
		throw new CliError(`Package path does not exist: ${inputPath}`);
	}
	if (stat.isDirectory()) return packMaterializedPackage(absolutePath);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new CliError(
			"Portable package input must be a regular JSON envelope or materialized directory.",
		);
	}
	if (stat.size > MAX_PACKAGE_BYTES)
		throw new CliError("Portable package envelope is too large.");
	let envelope;
	try {
		const bytes = await readStableRegularFile(
			absolutePath,
			stat,
			MAX_PACKAGE_BYTES,
			"Portable package envelope",
		);
		envelope = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new CliError("Portable package envelope must contain valid JSON.");
	}
	return validatePortablePackage(envelope);
}

function sensitiveOutputUrl(value) {
	try {
		const parsed = new URL(value);
		if (parsed.username || parsed.password) return true;
		if (
			/(?:claim|oauth|authorize|authorization)/i.test(
				`${parsed.hostname}${parsed.pathname}`,
			)
		) {
			return true;
		}
		for (const key of parsed.searchParams.keys()) {
			if (
				/(?:authorization|code|credential|secret|session|token|claim)/i.test(
					key,
				)
			) {
				return true;
			}
		}
		return false;
	} catch {
		return /claim/i.test(value);
	}
}

function sanitizeOutputText(value) {
	let output = String(value || "");
	if (output.length > 8_192) output = `${output.slice(0, 8_192)}…`;
	output = output.replace(/https?:\/\/[^\s"'<>]+/gi, (url) =>
		sensitiveOutputUrl(url) ? "[redacted authority URL]" : url,
	);
	output = output.replace(
		/\bauthorization\s*:\s*bearer\s+[^\s,;"'}]+/gi,
		"Authorization: [redacted]",
	);
	output = output.replace(/\bbearer\s+[^\s,;"'}]+/gi, "Bearer [redacted]");
	output = output.replace(
		/\b(?:access[_-]?token|api[_-]?key|authorization|claim[_-]?(?:code|credential|url)|client[_-]?secret|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
		"[redacted authority]",
	);
	return output;
}

function safePublicOutputUrl(value) {
	if (typeof value !== "string" || !value) return "";
	if (sensitiveOutputUrl(value)) return "";
	return sanitizeOutputText(value);
}

function requiredRevisionPreviewUrl(value, input) {
	if (typeof value !== "string" || !value) {
		throw new CliError(
			"Shiplet API response is missing required revision preview URL.",
		);
	}
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new CliError("Shiplet API response revision preview URL is invalid.");
	}
	const expectedOrigin = normalizeApiUrl(input.apiUrl);
	const match = parsed.pathname.match(
		/^\/shiplets\/([^/]+)\/drafts\/([^/]+)\/revisions\/([^/]+)\/versions\/([^/]+)\/preview$/,
	);
	let projectId = "";
	let draftId = "";
	let revisionId = "";
	let draftVersion = "";
	try {
		projectId = decodeURIComponent(match?.[1] || "");
		draftId = decodeURIComponent(match?.[2] || "");
		revisionId = decodeURIComponent(match?.[3] || "");
		draftVersion = decodeURIComponent(match?.[4] || "");
	} catch {
		throw new CliError("Shiplet API response revision preview URL is invalid.");
	}
	if (
		parsed.origin !== expectedOrigin ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		sensitiveOutputUrl(value) ||
		!apiIdentifier(projectId) ||
		draftId !== input.draftId ||
		revisionId !== input.revisionId ||
		draftVersion !== String(input.draftVersion)
	) {
		throw new CliError(
			"Shiplet API response revision preview URL binding mismatch.",
		);
	}
	return parsed.toString();
}

function sanitizeApiValue(value, depth = 0) {
	if (depth > 16) return "[bounded]";
	if (Array.isArray(value))
		return value.slice(0, 250).map((item) => sanitizeApiValue(item, depth + 1));
	if (!value || typeof value !== "object") {
		return typeof value === "string" ? sanitizeOutputText(value) : value;
	}
	const result = {};
	for (const [key, item] of Object.entries(value).slice(0, 250)) {
		const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
		if (
			/(?:accesstoken|authorization|claimcode|claimurl|cookie|credential|password|refreshtoken|secret|session|token)/.test(
				normalized,
			)
		) {
			continue;
		}
		result[key] = sanitizeApiValue(item, depth + 1);
	}
	return result;
}

function unconfirmedSessionRevocationError() {
	return new CliError(
		"Shiplet API request completed, but CLI session revocation was not confirmed. The operation result is partial/unconfirmed; verify current Shiplet state before retrying.",
	);
}

async function requestKernel(options, request) {
	const apiKey = apiKeyFromOptions(options, request.env);
	const humanSessionRequired = request.requireHumanSession === true;
	let sessionFetch = request.sessionFetch;
	let ownsSession = false;
	if (!apiKey && typeof sessionFetch !== "function" && typeof request.sessionBootstrap === "function") {
		sessionFetch = await request.sessionBootstrap({
			apiUrl: options.apiUrl || request.env.SHIPLET_API_URL || DEFAULT_API_URL,
			fetch: request.fetch,
			stdout: request.stdout,
		});
		ownsSession = true;
	}
	if (humanSessionRequired && apiKey) {
		throw new CliError(
			"Human deployment effects require Shiplet's established browser OAuth session; raw tokens and organization API keys cannot authorize deploy, promote, or rollback.",
		);
	}
	if (humanSessionRequired && typeof sessionFetch !== "function") {
		throw new CliError(
			"Human deployment effects require an established Shiplet browser OAuth session. Connect through the Shiplet dashboard, then retry through a session-capable CLI integration.",
		);
	}
	if (!humanSessionRequired && !apiKey && typeof sessionFetch !== "function") {
		throw new CliError(
			"Production commands require Shiplet's established OAuth/session path. This CLI will not ask you to paste a credential.",
		);
	}
	const fetchImpl = sessionFetch || request.fetch;
	if (typeof fetchImpl !== "function") {
		throw new CliError("This Node runtime does not provide fetch.");
	}
	const headers = {
		accept: "application/json",
		"user-agent": "shiplet-cli/0.2",
	};
	if (!sessionFetch && apiKey) headers.authorization = `Bearer ${apiKey}`;
	if (request.body !== undefined) headers["content-type"] = "application/json";
	if (request.version) headers["if-match"] = request.version;
	if (request.idempotencyKey) {
		headers["idempotency-key"] = request.idempotencyKey;
	}
	let requestCompleted = false;
	try {
		const { response, responseText } = await fetchApiResponse(
			fetchImpl,
			`${normalizeApiUrl(options.apiUrl || request.env.SHIPLET_API_URL)}${request.path}`,
			{
				method: request.method,
				headers,
				body:
					request.body === undefined ? undefined : JSON.stringify(request.body),
				...(humanSessionRequired ? { credentials: "include" } : {}),
			},
			request.maxResponseBytes,
		);
		const parsed = parseJsonResponse(responseText);
		if (!response.ok) {
			const safe = sanitizeApiValue(parsed);
			const detail =
				typeof safe === "string"
					? safe
					: safe
						? JSON.stringify(safe)
						: sanitizeOutputText(response.statusText || "Request failed");
			throw new CliError(`Shiplet API returned ${response.status}: ${detail}`);
		}
		requestCompleted = true;
		return parsed && typeof parsed === "object" ? parsed : { ok: true };
	} finally {
		if (ownsSession && typeof sessionFetch?.revoke === "function") {
			try {
				await sessionFetch.revoke();
			} catch {
				if (requestCompleted) {
					throw unconfirmedSessionRevocationError();
				}
			}
		}
	}
}

async function assertNoSymlinkComponents(targetPath, allowMissingTail) {
	const absolutePath = path.resolve(targetPath);
	const parsed = path.parse(absolutePath);
	const segments = path
		.relative(parsed.root, absolutePath)
		.split(path.sep)
		.filter(Boolean);
	let current = parsed.root;
	let missing = false;
	for (let index = 0; index < segments.length; index += 1) {
		current = path.join(current, segments[index]);
		if (missing) continue;
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink() && !(await isTrustedSystemPathAlias(current))) {
				throw new CliError(
					`Package path component cannot be a symbolic link: ${current}.`,
				);
			}
			if (
				index < segments.length - 1 &&
				!stat.isDirectory() &&
				!stat.isSymbolicLink()
			) {
				throw new CliError(
					`Package path ancestor must be a directory: ${current}.`,
				);
			}
		} catch (error) {
			if (error instanceof CliError) throw error;
			if (error && error.code === "ENOENT" && allowMissingTail) {
				missing = true;
				continue;
			}
			throw error;
		}
	}
}

async function isTrustedSystemPathAlias(candidate) {
	const expected =
		candidate === "/tmp"
			? "/private/tmp"
			: candidate === "/var"
				? "/private/var"
				: "";
	if (!expected) return false;
	try {
		return (await fs.realpath(candidate)) === expected;
	} catch {
		return false;
	}
}

async function nearestExistingDirectory(directory) {
	let current = path.resolve(directory);
	const missing = [];
	while (true) {
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink()) {
				throw new CliError(
					`Package path component cannot be a symbolic link: ${current}.`,
				);
			}
			if (!stat.isDirectory()) {
				throw new CliError(
					`Package path ancestor must be a directory: ${current}.`,
				);
			}
			return { current, missing: missing.reverse() };
		} catch (error) {
			if (error instanceof CliError) throw error;
			if (!error || error.code !== "ENOENT") throw error;
			const parent = path.dirname(current);
			if (parent === current) throw error;
			missing.push(path.basename(current));
			current = parent;
		}
	}
}

async function ensureSafeDirectory(directory) {
	const absolutePath = path.resolve(directory);
	await assertNoSymlinkComponents(absolutePath, true);
	const anchor = await nearestExistingDirectory(absolutePath);
	let current = anchor.current;
	for (const segment of anchor.missing) {
		current = path.join(current, segment);
		await fs.mkdir(current);
		const stat = await fs.lstat(current);
		if (stat.isSymbolicLink()) {
			throw new CliError(
				`Package path component cannot be a symbolic link: ${current}.`,
			);
		}
		if (!stat.isDirectory()) {
			throw new CliError(
				`Package path ancestor must be a directory: ${current}.`,
			);
		}
	}
	return absolutePath;
}

async function assertTreeHasNoSymlinks(directory, budget = { entries: 0 }) {
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		budget.entries += 1;
		if (budget.entries > 10_000) {
			throw new CliError(
				"Package destination contains too many existing entries.",
			);
		}
		const entryPath = path.join(directory, entry.name);
		const stat = await fs.lstat(entryPath);
		if (stat.isSymbolicLink()) {
			throw new CliError(
				`Package destination contains a symbolic link: ${entry.name}.`,
			);
		}
		if (stat.isDirectory()) await assertTreeHasNoSymlinks(entryPath, budget);
	}
}

async function assertSafeDestination(destination, force) {
	if (destination === path.parse(destination).root) {
		throw new CliError("Package destination cannot be a filesystem root.");
	}
	await ensureSafeDirectory(path.dirname(destination));
	try {
		const stat = await fs.lstat(destination);
		if (stat.isSymbolicLink())
			throw new CliError("Package destination cannot be a symbolic link.");
		if (!stat.isDirectory())
			throw new CliError("Package destination must be a directory.");
		await assertTreeHasNoSymlinks(destination);
		const entries = await fs.readdir(destination);
		if (entries.length > 0 && !force) {
			throw new CliError(
				"Package destination is not empty. Use --force to replace it.",
			);
		}
		return true;
	} catch (error) {
		if (error instanceof CliError) throw error;
		if (error && error.code !== "ENOENT") throw error;
		return false;
	}
}

async function supportsReliableDirectoryRename(parent, base) {
	const source = await fs.mkdtemp(
		path.join(parent, `.${base}.shiplet-rename-probe-`),
	);
	const destination = `${source}-destination`;
	try {
		await fs.writeFile(path.join(source, "sentinel"), "ok", { flag: "wx" });
		await fs.rename(source, destination);
		try {
			return (
				(await fs.readFile(path.join(destination, "sentinel"), "utf8")) === "ok"
			);
		} catch {
			return false;
		}
	} finally {
		await fs
			.rm(source, { recursive: true, force: true })
			.catch(() => undefined);
		await fs
			.rm(destination, { recursive: true, force: true })
			.catch(() => undefined);
	}
}

async function installWithCopyFallback(
	staging,
	destination,
	destinationExists,
	parent,
	base,
) {
	let backup = "";
	if (destinationExists) {
		backup = path.join(
			parent,
			`.${base}.shiplet-backup-${crypto.randomUUID()}`,
		);
		await fs.cp(destination, backup, {
			recursive: true,
			force: false,
			errorOnExist: true,
		});
		await fs.rm(destination, { recursive: true, force: true });
	}
	try {
		await fs.cp(staging, destination, {
			recursive: true,
			force: false,
			errorOnExist: true,
		});
	} catch (error) {
		await fs
			.rm(destination, { recursive: true, force: true })
			.catch(() => undefined);
		if (backup) {
			try {
				await fs.cp(backup, destination, {
					recursive: true,
					force: false,
					errorOnExist: true,
				});
				await fs.rm(backup, { recursive: true, force: true });
				backup = "";
			} catch {
				throw new CliError(
					"Package replacement failed and the prior destination could not be restored.",
				);
			}
		}
		throw error;
	}
	if (backup) await fs.rm(backup, { recursive: true, force: true });
}

async function materializePortablePackage(validated, outputPath, cwd, force) {
	const destination = path.resolve(cwd, outputPath);
	const destinationExists = await assertSafeDestination(destination, force);
	const parent = path.dirname(destination);
	const base = path.basename(destination);
	const staging = await fs.mkdtemp(
		path.join(parent, `.${base}.shiplet-stage-`),
	);
	let backup = "";
	let stagingExists = true;
	try {
		for (const file of validated.envelope.files) {
			const output = path.resolve(staging, file.path);
			if (output !== staging && !output.startsWith(`${staging}${path.sep}`)) {
				throw new CliError(`Unsafe package output path: ${file.path}`);
			}
			await fs.mkdir(path.dirname(output), { recursive: true });
			await fs.writeFile(output, packageFileBytes(file), { flag: "wx" });
		}
		await fs.writeFile(
			path.join(staging, "shiplet.json"),
			`${JSON.stringify(validated.envelope.manifest, null, 2)}\n`,
			{ flag: "wx" },
		);
		if (await supportsReliableDirectoryRename(parent, base)) {
			if (destinationExists) {
				backup = path.join(
					parent,
					`.${base}.shiplet-backup-${crypto.randomUUID()}`,
				);
				await fs.rename(destination, backup);
			}
			try {
				await fs.rename(staging, destination);
				stagingExists = false;
			} catch (error) {
				if (backup) {
					try {
						await fs.rename(backup, destination);
						backup = "";
					} catch {
						throw new CliError(
							"Package replacement failed and the prior destination could not be restored.",
						);
					}
				}
				throw error;
			}
			if (backup) {
				await fs.rm(backup, { recursive: true, force: true });
				backup = "";
			}
		} else {
			await installWithCopyFallback(
				staging,
				destination,
				destinationExists,
				parent,
				base,
			);
		}
		return destination;
	} finally {
		if (stagingExists) {
			await fs
				.rm(staging, { recursive: true, force: true })
				.catch(() => undefined);
		}
	}
}

function apiIdentifier(value) {
	return IDENTIFIER_PATTERN.test(String(value || "")) ? String(value) : "";
}

function requiredApiIdentifier(value, label) {
	const identifier = apiIdentifier(value);
	if (!identifier)
		throw new CliError(`Shiplet API response is missing required ${label}.`);
	return identifier;
}

function responseRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}

function responseInteger(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function requiredResponseInteger(value, label) {
	const integer = responseInteger(value);
	if (integer === null) {
		throw new CliError(`Shiplet API response is missing required ${label}.`);
	}
	return integer;
}

function assertIdentifierBinding(value, expected, label, required = true) {
	const actual = apiIdentifier(value);
	if (!actual) {
		if (required) {
			throw new CliError(`Shiplet API response is missing required ${label}.`);
		}
		return "";
	}
	if (actual !== expected) {
		throw new CliError(`Shiplet API response ${label} binding mismatch.`);
	}
	return actual;
}

function requiredPackageDigest(value, label = "package digest") {
	const digest = String(value || "");
	if (!/^[a-f0-9]{64}$/.test(digest)) {
		throw new CliError(`Shiplet API response is missing required ${label}.`);
	}
	return digest;
}

function assertDigestBinding(value, expected, label = "package digest") {
	const digest = requiredPackageDigest(value, label);
	if (digest !== expected) {
		throw new CliError(`Shiplet API response ${label} binding mismatch.`);
	}
	return digest;
}

function assertIntegerBinding(value, expected, label) {
	const integer = requiredResponseInteger(value, label);
	if (integer !== expected) {
		throw new CliError(`Shiplet API response ${label} binding mismatch.`);
	}
	return integer;
}

function exactIdentifierSet(value, label) {
	if (!Array.isArray(value)) {
		throw new CliError(`Shiplet API response is missing required ${label}.`);
	}
	const identifiers = value.map((entry) => requiredApiIdentifier(entry, label));
	if (new Set(identifiers).size !== identifiers.length) {
		throw new CliError(`Shiplet API response ${label} binding mismatch.`);
	}
	return [...identifiers].sort();
}

function assertIdentifierSetBinding(value, expected, label) {
	const actual = exactIdentifierSet(value, label);
	const normalizedExpected = [...expected].sort();
	if (
		actual.length !== normalizedExpected.length ||
		actual.some((entry, index) => entry !== normalizedExpected[index])
	) {
		throw new CliError(`Shiplet API response ${label} binding mismatch.`);
	}
	return actual;
}

function operationProjection(response, context) {
	const operation = responseRecord(response?.operation);
	const rawId = operation.id || response?.operationId;
	const rawStatus = operation.status || response?.operationStatus;
	const operationId = requiredApiIdentifier(rawId, "operation ID");
	const operationStatus = requiredApiIdentifier(rawStatus, "operation status");
	if (operationStatus !== "committed") {
		throw new CliError(
			"Shiplet API response is missing required committed operation proof.",
		);
	}
	assertIdentifierBinding(operation.kind, context.command, "operation kind");
	assertIdentifierBinding(
		operation.idempotencyKey,
		context.idempotencyKey,
		"operation idempotency key",
	);
	return {
		operationId,
		operationStatus,
		idempotencyKey: context.idempotencyKey,
	};
}

function positiveDraftVersion(value, label = "draft version") {
	const parsed = Number(value);
	if (
		!Number.isSafeInteger(parsed) ||
		parsed < 1 ||
		String(parsed) !== String(value)
	) {
		throw new CliError(`Invalid ${label}.`);
	}
	return parsed;
}

function normalizeRevisionCommandResult(command, response, context) {
	if (response?.ok === false)
		throw new CliError(`Shiplet API reported ${command} failure.`);
	const draft = responseRecord(response?.draft);
	const revision = responseRecord(response?.revision);
	const deployment = responseRecord(response?.deployment);
	const message =
		typeof response?.message === "string"
			? { message: sanitizeOutputText(response.message) }
			: {};
	if (command === "fork") {
		const draftId = requiredApiIdentifier(
			draft.id || response?.draftId || response?.resultId,
			"draft ID",
		);
		const returnedShipletId =
			draft.shipletId ||
			draft.projectId ||
			draft.project_id ||
			response?.shipletId;
		if (returnedShipletId !== undefined) {
			assertIdentifierBinding(
				returnedShipletId,
				context.shipletId,
				"Shiplet ID",
			);
		}
		const baseRevisionId = requiredApiIdentifier(
			draft.baseRevisionId ||
				draft.base_revision_id ||
				response?.baseRevisionId ||
				context.fromRevisionId,
			"base revision ID",
		);
		if (context.fromRevisionId) {
			assertIdentifierBinding(
				baseRevisionId,
				context.fromRevisionId,
				"base revision ID",
			);
		}
		return {
			ok: true,
			action: command,
			shipletId: context.shipletId,
			draftId,
			baseRevisionId,
			draftVersion: responseInteger(draft.version ?? response?.draftVersion),
			...message,
		};
	}
	if (command === "push" || command === "diff") {
		const returnedDraftId = draft.id || response?.draftId || response?.resultId;
		assertIdentifierBinding(returnedDraftId, context.draftId, "draft ID");
		const expectedVersion =
			command === "push"
				? context.expectedVersion + 1
				: context.expectedVersion;
		const draftVersion = assertIntegerBinding(
			draft.version ?? response?.draftVersion,
			expectedVersion,
			"draft version",
		);
		const returnedDigest =
			command === "diff"
				? response?.proposedDigest
				: response?.packageDigest ||
					draft.packageDigest ||
					draft.package_digest;
		const packageDigest = assertDigestBinding(
			returnedDigest,
			context.packageDigest,
		);
		const result = {
			ok: true,
			action: command,
			draftId: context.draftId,
			draftVersion,
			packageDigest,
			...message,
		};
		if (command === "diff") {
			return {
				...result,
				currentDigest: apiIdentifier(response?.currentDigest),
				proposedDigest: apiIdentifier(response?.proposedDigest),
				changed: response?.changed === true,
			};
		}
		return result;
	}
	if (command === "deploy") {
		const revisionId = assertIdentifierBinding(
			deployment.revisionId || deployment.revision_id || response?.revisionId,
			context.revisionId,
			"deployment revision ID",
		);
		const targetId = assertIdentifierBinding(
			deployment.targetId || deployment.target_id || response?.targetId,
			context.targetId,
			"deployment target ID",
		);
		return {
			ok: true,
			action: command,
			revisionId,
			targetId,
			deploymentId: requiredApiIdentifier(
				deployment.id || response?.deploymentId || response?.resultId,
				"deployment ID",
			),
			status: apiIdentifier(deployment.status || response?.status),
			...operationProjection(response, context),
			...message,
		};
	}
	if (command === "promote") {
		assertIdentifierBinding(
			response?.draftId || revision.draftId,
			context.draftId,
			"promoted draft ID",
		);
		assertIdentifierBinding(
			revision.parentRevisionId ||
				revision.parent_revision_id ||
				response?.previousRevisionId,
			context.expectedActiveRevisionId,
			"promotion parent revision ID",
		);
		if (context.targetIds.length > 0) {
			assertIdentifierSetBinding(
				response?.targetIds || revision.targetIds,
				context.targetIds,
				"promotion target IDs",
			);
		}
		return {
			ok: true,
			action: command,
			draftId: context.draftId,
			revisionId: requiredApiIdentifier(
				revision.id || response?.revisionId || response?.resultId,
				"promoted revision ID",
			),
			targetIds: context.targetIds,
			...operationProjection(response, context),
			...message,
		};
	}
	if (command === "rollback") {
		assertIdentifierBinding(
			response?.shipletId || revision.shipletId || revision.projectId,
			context.shipletId,
			"rollback Shiplet ID",
		);
		const revisionId = assertIdentifierBinding(
			revision.id || response?.revisionId,
			context.revisionId,
			"rollback revision ID",
		);
		assertIdentifierBinding(
			response?.previousRevisionId ||
				revision.previousRevisionId ||
				revision.previous_revision_id,
			context.expectedActiveRevisionId,
			"rollback previous revision ID",
		);
		if (context.targetIds.length > 0) {
			assertIdentifierSetBinding(
				response?.targetIds || revision.targetIds,
				context.targetIds,
				"rollback target IDs",
			);
		}
		return {
			ok: true,
			action: command,
			shipletId: context.shipletId,
			revisionId,
			targetIds: context.targetIds,
			...operationProjection(response, context),
			...message,
		};
	}
	return {};
}

function writeRevisionHumanResult(stdout, result) {
	const writeOperationProof = () => {
		if (result.idempotencyKey) {
			stdout.write(
				`Committed operation ${result.operationId}. Reusable retry key: ${result.idempotencyKey}\n`,
			);
		}
	};
	if (result.action === "fork") {
		stdout.write(
			`Forked draft ${result.draftId} from revision ${result.baseRevisionId || "active"}${result.draftVersion === null ? "" : ` (version ${result.draftVersion})`}.\n`,
		);
		stdout.write(
			`Next: shiplet pull ${result.shipletId} <path> --draft ${result.draftId}\n`,
		);
		return;
	}
	if (result.action === "diff") {
		stdout.write(
			`Draft ${result.draftId}${result.draftVersion === null ? "" : ` version ${result.draftVersion}`} is ${result.changed ? "changed" : "unchanged"}.\n`,
		);
		if (result.currentDigest)
			stdout.write(`Current digest: ${result.currentDigest}\n`);
		if (result.proposedDigest)
			stdout.write(`Proposed digest: ${result.proposedDigest}\n`);
		if (result.changed) {
			stdout.write(
				`Next: shiplet push ${result.draftId} <package-path> --version ${result.draftVersion ?? "<draft-version>"}\n`,
			);
		}
		return;
	}
	if (result.action === "deploy") {
		stdout.write(
			`Deployment ${result.deploymentId} installed revision ${result.revisionId} on target ${result.targetId}${result.status ? ` (${result.status})` : ""}.\n`,
		);
		stdout.write(
			`Next: shiplet rollback <shiplet-id> --revision <previous-revision-id> --expected-active ${result.revisionId} --approve\n`,
		);
		writeOperationProof();
		return;
	}
	if (result.action === "validate") {
		stdout.write(
			`Validated draft ${result.draftId} version ${result.draftVersion} as immutable revision ${result.revisionId}.\n`,
		);
		stdout.write(`Preview the sealed revision: ${result.previewUrl}\n`);
		stdout.write(
			`Next: shiplet promote ${result.draftId} --expected-active <active-revision-id> --approve\n`,
		);
		return;
	}
	if (result.action === "push") {
		stdout.write(
			`Pushed draft ${result.draftId}${result.draftVersion === null ? "" : ` version ${result.draftVersion}`}.\n`,
		);
		stdout.write(
			`Next: shiplet validate ${result.draftId} <package-path> --version ${result.draftVersion ?? "<draft-version>"}\n`,
		);
		return;
	}
	if (result.action === "promote") {
		stdout.write(
			`Promoted draft ${result.draftId} as revision ${result.revisionId}.\n`,
		);
		writeOperationProof();
		return;
	}
	if (result.action === "rollback") {
		stdout.write(
			`Rolled back ${result.shipletId} to revision ${result.revisionId}.\n`,
		);
		writeOperationProof();
		return;
	}
	stdout.write(`${result.action} completed.\n`);
}

async function runRevisionCommand(options, runtime) {
	const { command } = options;
	if (command === "validate") {
		if (options.positionals.length !== 1 && options.positionals.length !== 2) {
			throw new CliError(
				"Usage: shiplet validate <package-path> or shiplet validate <draft-id> <package-path> --version <draft-version>",
			);
		}
		const serverValidation = options.positionals.length === 2;
		const draftId = serverValidation
			? assertIdentifier(options.positionals[0], "draft ID")
			: "";
		const packagePath = options.positionals[serverValidation ? 1 : 0];
		const validated = await readPortablePackage(packagePath, runtime.cwd);
		if (!serverValidation) {
			if (options.json) writeJson(runtime.stdout, validated.summary);
			else
				runtime.stdout.write(
					`Valid ${validated.summary.schemaVersion} package with ${validated.summary.fileCount} files.\n`,
				);
			return;
		}
		if (!options.version) throw new CliError("validate requires --version.");
		const expectedVersion = positiveDraftVersion(options.version);
		const response = await requestKernel(options, {
			...runtime,
			method: "POST",
			path: `/api/drafts/${encodeURIComponent(draftId)}/validate`,
			body: {
				expectedVersion,
				packageDigest: validated.summary.packageDigest,
				package: validated.envelope,
			},
			version: String(expectedVersion),
		});
		const validation = responseRecord(response.validation);
		if (validation.ok !== true) {
			throw new CliError(
				"Shiplet API response reported draft validation failure.",
			);
		}
		assertIdentifierBinding(
			validation.draftId || response?.draftId,
			draftId,
			"validated draft ID",
		);
		const draftVersion = assertIntegerBinding(
			validation.draftVersion,
			expectedVersion,
			"validated draft version",
		);
		const packageDigest = assertDigestBinding(
			validation.packageDigest,
			validated.summary.packageDigest,
			"validated package digest",
		);
		const revisionId = requiredApiIdentifier(
			validation.revisionId,
			"validated revision ID",
		);
		const result = {
			ok: true,
			action: command,
			draftId,
			draftVersion,
			revisionId,
			previewUrl: requiredRevisionPreviewUrl(validation.previewUrl, {
				apiUrl:
					options.apiUrl || runtime.env.SHIPLET_API_URL || DEFAULT_API_URL,
				draftId,
				revisionId,
				draftVersion,
			}),
			packageDigest,
		};
		if (options.json) writeJson(runtime.stdout, result);
		else writeRevisionHumanResult(runtime.stdout, result);
		return;
	}

	if (command === "pull" || command === "eject") {
		if (options.draft && options.revision) {
			throw new CliError(
				`${command} accepts either --draft or --revision, not both.`,
			);
		}
		const [shipletIdValue, outputPath] = requirePositionals(
			options,
			2,
			`${command} <shiplet-id> <path>`,
		);
		const shipletId = assertIdentifier(shipletIdValue, "Shiplet ID");
		const draftId = options.draft
			? assertIdentifier(options.draft, "draft ID")
			: "";
		const revisionId = options.revision
			? assertIdentifier(options.revision, "revision ID")
			: "";
		const query = command === "eject" ? "?disposition=eject" : "";
		const requestPath = draftId
			? `/api/drafts/${encodeURIComponent(draftId)}/package`
			: revisionId
				? `/api/shiplets/${encodeURIComponent(shipletId)}/revisions/${encodeURIComponent(revisionId)}/package${query}`
				: `/api/shiplets/${encodeURIComponent(shipletId)}/package${query}`;
		const response = await requestKernel(options, {
			...runtime,
			method: "GET",
			path: requestPath,
			maxResponseBytes: MAX_PACKAGE_API_RESPONSE_BYTES,
		});
		const validated = validatePortablePackage(response.package || response);
		const revision = responseRecord(response?.revision);
		const draft = responseRecord(response?.draft);
		const selectedRevisionId = apiIdentifier(
			revision.id || response?.revisionId,
		);
		const selectedDraftId = apiIdentifier(draft.id || response?.draftId);
		const boundRevisionId = draftId
			? ""
			: revisionId
				? assertIdentifierBinding(
						selectedRevisionId,
						revisionId,
						"selected revision ID",
					)
				: requiredApiIdentifier(selectedRevisionId, "selected revision ID");
		if (draftId) {
			assertIdentifierBinding(selectedDraftId, draftId, "selected draft ID");
		}
		const responseShipletId =
			draft.shipletId ||
			draft.projectId ||
			draft.project_id ||
			revision.shipletId ||
			revision.projectId ||
			revision.project_id ||
			response?.shipletId;
		assertIdentifierBinding(
			responseShipletId,
			shipletId,
			"selected Shiplet ID",
		);
		const revisionDigest = revision.digest || response?.revisionDigest;
		if (!draftId) {
			assertDigestBinding(
				revisionDigest,
				validated.summary.packageDigest,
				"selected revision digest",
			);
		}
		const draftPackageDigest =
			draft.packageDigest || draft.package_digest || response?.packageDigest;
		if (draftPackageDigest !== undefined) {
			assertDigestBinding(
				draftPackageDigest,
				validated.summary.packageDigest,
				"selected draft package digest",
			);
		}
		const result = {
			...validated.summary,
			action: command,
			shipletId,
			...(draftId
				? {
						draftId: selectedDraftId,
						baseRevisionId: requiredApiIdentifier(
							draft.baseRevisionId || draft.base_revision_id,
							"base revision ID",
						),
						draftVersion:
							responseInteger(draft.version) ??
							(() => {
								throw new CliError(
									"Shiplet API response is missing required draft version.",
								);
							})(),
						validationState: apiIdentifier(
							draft.validationState || draft.validation_state,
						),
					}
				: {
						revisionId: boundRevisionId,
						parentRevisionId: apiIdentifier(
							revision.parentRevisionId || revision.parent_revision_id,
						),
						revisionDigest: apiIdentifier(revisionDigest),
						contentDigest: apiIdentifier(
							revision.contentDigest || revision.content_digest,
						),
					}),
		};
		await materializePortablePackage(
			validated,
			outputPath,
			runtime.cwd,
			options.force,
		);
		if (options.json) writeJson(runtime.stdout, result);
		else {
			runtime.stdout.write(
				`${command === "eject" ? "Ejected" : "Pulled"} ${draftId ? `draft ${result.draftId}` : `revision ${result.revisionId || "active"}`} for ${shipletId} to ${outputPath}.\n`,
			);
			runtime.stdout.write(`Package digest: ${result.packageDigest}\n`);
		}
		return;
	}

	let method = "POST";
	let requestPath = "";
	let body;
	let version = "";
	const resultContext = { command, targetIds: [] };
	if (command === "fork") {
		const [shipletIdValue] = requirePositionals(
			options,
			1,
			"fork <shiplet-id>",
		);
		const shipletId = assertIdentifier(shipletIdValue, "Shiplet ID");
		requestPath = `/api/shiplets/${encodeURIComponent(shipletId)}/drafts`;
		body = {
			fromRevisionId: options.fromRevision
				? assertIdentifier(options.fromRevision, "source revision ID")
				: null,
		};
		resultContext.shipletId = shipletId;
		resultContext.fromRevisionId = body.fromRevisionId || "";
	} else if (command === "push" || command === "diff") {
		const [draftIdValue, packagePath] = requirePositionals(
			options,
			2,
			`${command} <draft-id> <package-path> --version <draft-version>`,
		);
		const draftId = assertIdentifier(draftIdValue, "draft ID");
		if (!options.version) throw new CliError(`${command} requires --version.`);
		const expectedVersion = positiveDraftVersion(options.version);
		const validated = await readPortablePackage(packagePath, runtime.cwd);
		requestPath = `/api/drafts/${encodeURIComponent(draftId)}/${command === "push" ? "package" : "diff"}`;
		method = command === "push" ? "PUT" : "POST";
		version = String(expectedVersion);
		body = { package: validated.envelope, expectedVersion: options.version };
		resultContext.draftId = draftId;
		resultContext.expectedVersion = expectedVersion;
		resultContext.packageDigest = validated.summary.packageDigest;
	} else if (command === "deploy") {
		const [revisionIdValue] = requirePositionals(
			options,
			1,
			"deploy <revision-id> --target <target-id> --approve",
		);
		if (options.targets.length !== 1) {
			throw new CliError("deploy requires exactly one --target value.");
		}
		const revisionId = assertIdentifier(revisionIdValue, "revision ID");
		const targetId = assertIdentifier(options.target, "target ID");
		requestPath = `/api/revisions/${encodeURIComponent(revisionId)}/deployments`;
		body = { targetId, approval: true };
		resultContext.revisionId = revisionId;
		resultContext.targetId = targetId;
	} else if (command === "promote") {
		const [draftIdValue] = requirePositionals(
			options,
			1,
			"promote <draft-id> --expected-active <revision-id> --approve",
		);
		const draftId = assertIdentifier(draftIdValue, "draft ID");
		const expectedActiveRevisionId = assertIdentifier(
			options.expectedActive,
			"expected active revision ID",
		);
		requestPath = `/api/drafts/${encodeURIComponent(draftId)}/promote`;
		const targetIds = options.targets.map((targetId) =>
			assertIdentifier(targetId, "target ID"),
		);
		body = {
			expectedActiveRevisionId,
			...(targetIds.length > 0 ? { targetIds } : {}),
			approval: true,
		};
		resultContext.draftId = draftId;
		resultContext.targetIds = targetIds;
		resultContext.expectedActiveRevisionId = expectedActiveRevisionId;
	} else if (command === "rollback") {
		const [shipletIdValue] = requirePositionals(
			options,
			1,
			"rollback <shiplet-id> --revision <revision-id> --expected-active <revision-id> --approve",
		);
		const shipletId = assertIdentifier(shipletIdValue, "Shiplet ID");
		requestPath = `/api/shiplets/${encodeURIComponent(shipletId)}/rollback`;
		const targetIds = options.targets.map((targetId) =>
			assertIdentifier(targetId, "target ID"),
		);
		body = {
			revisionId: assertIdentifier(options.revision, "revision ID"),
			expectedActiveRevisionId: assertIdentifier(
				options.expectedActive,
				"expected active revision ID",
			),
			...(targetIds.length > 0 ? { targetIds } : {}),
			approval: true,
		};
		resultContext.shipletId = shipletId;
		resultContext.revisionId = body.revisionId;
		resultContext.expectedActiveRevisionId = body.expectedActiveRevisionId;
		resultContext.targetIds = targetIds;
	} else {
		throw new CliError(`Unsupported revision command: ${command}.`);
	}

	if (APPROVAL_COMMANDS.has(command)) {
		resultContext.idempotencyKey = options.idempotencyKey
			? assertIdentifier(options.idempotencyKey, "idempotency key")
			: `${command}_${crypto.randomUUID()}`;
		if (options.dryRun) {
			const plan = {
				ok: true,
				dryRun: true,
				action: command,
				idempotencyKey: resultContext.idempotencyKey,
				request: { method, path: requestPath, body },
			};
			if (options.json) writeJson(runtime.stdout, plan);
			else {
				runtime.stdout.write(
					`Planned ${command}; no network request was made.\nRetry key: ${resultContext.idempotencyKey}\n`,
				);
			}
			return;
		}
	}

	let response;
	try {
		response = await requestKernel(options, {
			...runtime,
			method,
			path: requestPath,
			body,
			version,
			idempotencyKey: resultContext.idempotencyKey,
			requireHumanSession: APPROVAL_COMMANDS.has(command),
		});
	} catch (error) {
		const ambiguousTransportFailure =
			APPROVAL_COMMANDS.has(command) &&
			(!(error instanceof CliError) || /timed out/i.test(error.message));
		if (ambiguousTransportFailure) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new CliError(
				`${detail} Operation outcome was not confirmed. Retry with --idempotency-key ${resultContext.idempotencyKey}.`,
			);
		}
		throw error;
	}
	const result = normalizeRevisionCommandResult(
		command,
		response,
		resultContext,
	);
	if (options.json) writeJson(runtime.stdout, result);
	else writeRevisionHumanResult(runtime.stdout, result);
}

async function runCli({
	argv = process.argv.slice(2),
	env = process.env,
	cwd = process.cwd(),
	fetch: fetchImpl = globalThis.fetch,
	sessionFetch,
	sessionBootstrap,
	stdout = process.stdout,
	stderr = process.stderr,
} = {}) {
	try {
		const options = parseArguments(argv);
		if (options.help) {
			stdout.write(helpText());
			return 0;
		}
		if (options.command !== "publish" && options.command !== "prepare") {
			await runRevisionCommand(options, {
				env,
				cwd,
				fetch: fetchImpl,
				sessionFetch,
				sessionBootstrap,
				stdout,
			});
			return 0;
		}

		const endpoint = endpointFromOptions(options, env);
		const payload = await buildPublishPayload(options, cwd);
		const summary = payloadSummary(payload);

		if (options.dryRun) {
			writeDryRun(stdout, payload, endpoint, summary, options.json);
			return 0;
		}

		const apiKey = apiKeyFromOptions(options, env);
		const authenticatedFetch =
			apiKey || typeof sessionFetch === "function"
				? sessionFetch || fetchImpl
				: typeof sessionBootstrap === "function"
					? await sessionBootstrap({
							apiUrl: options.apiUrl || env.SHIPLET_API_URL || DEFAULT_API_URL,
							fetch: fetchImpl,
							stdout,
						})
					: fetchImpl;
		let result;
		let requestCompleted = false;
		try {
			result = await publishReviewArtifact({
				payload,
				endpoint,
				apiKey,
				fetch: authenticatedFetch,
				authenticatedSession:
					!apiKey &&
					(typeof sessionFetch === "function" ||
						typeof sessionBootstrap === "function"),
			});
			requestCompleted = true;
		} finally {
			if (
				!apiKey &&
				typeof sessionBootstrap === "function" &&
				typeof authenticatedFetch?.revoke === "function"
			) {
				try {
					await authenticatedFetch.revoke();
				} catch {
					if (requestCompleted) {
						throw unconfirmedSessionRevocationError();
					}
				}
			}
		}
		writePublishResult(stdout, payload, result, options.json);
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		stderr.write(`${sanitizeOutputText(message)}\n`);
		return error && typeof error.exitCode === "number" ? error.exitCode : 1;
	}
}

module.exports = {
	runCli,
	parseArguments,
	collectArtifactFiles,
	buildPublishPayload,
	publishReviewArtifact,
	validatePortablePackage,
	runRevisionCommand,
};

if (require.main === module) {
	const { createBrowserSessionFetch } = require("./browser-session.cjs");
	runCli({ sessionBootstrap: createBrowserSessionFetch }).then((exitCode) => {
		process.exitCode = exitCode;
	});
}
