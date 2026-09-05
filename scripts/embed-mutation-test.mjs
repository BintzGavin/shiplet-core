import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mutations = [
	{
		name: "production HTTP origins are accepted",
		file: "src/embed.ts",
		from:
			'if (url.protocol === "http:" && !isLocalHostname(url.hostname)) return null;',
		to:
			'if (false && url.protocol === "http:" && !isLocalHostname(url.hostname)) return null;',
	},
	{
		name: "embedded feedback accepts the wrong browser origin",
		file: "src/index.ts",
		from: '    if (c.req.header("origin") !== requestOrigin) {',
		to: '    if (false && c.req.header("origin") !== requestOrigin) {',
	},
	{
		name: "embedded review start skips project access",
		file: "src/index.ts",
		from:
			'      project.archived_on ||\n      !(await canViewProject(c.env.DB, project, user.id))\n    ) {\n      return embedReviewStateResponse(c, "permission_denied", {',
		to:
			'      project.archived_on ||\n      (false && !(await canViewProject(c.env.DB, project, user.id)))\n    ) {\n      return embedReviewStateResponse(c, "permission_denied", {',
	},
	{
		name: "review sessions are not bound to the requested page",
		file: "src/embed.ts",
		from: "  if (!sessionPage || !requestPage || sessionPage !== requestPage) {",
		to: "  if (false && (!sessionPage || !requestPage || sessionPage !== requestPage)) {",
	},
	{
		name: "installation secrets are stored in plaintext",
		file: "src/embed.ts",
		from: "secret_hash: secretHash,",
		to: "secret_hash: secret,",
	},
	{
		name: "expired exchange codes use a past clock",
		file: "src/embed.ts",
		from:
			"const codeHash = await hashToken(code);\n  const now = timestamps.now();",
		to:
			'const codeHash = await hashToken(code);\n  const now = "1900-01-01T00:00:00.000Z";',
	},
	{
		name: "used exchange codes remain reusable",
		file: "src/embed.ts",
		from: "AND used_on IS NULL",
		to: "AND (used_on IS NULL OR used_on IS NOT NULL)",
		expectedOccurrences: 2,
	},
	{
		name: "review CORS grants arbitrary browser origins",
		file: "src/index.ts",
		from: "    if (originUrl.origin === requestOrigin || originUrl.origin === appOrigin) {",
		to: "    if (true) {",
	},
];

function copyHarness(destination) {
	for (const entry of [
		"package.json",
		"package-lock.json",
		"tsconfig.json",
		"openapi.json",
		"wrangler.test.jsonc",
		"vitest.config.mts",
		"wrangler.jsonc",
		"worker-configuration.d.ts",
	]) {
		cpSync(path.join(repoRoot, entry), path.join(destination, entry));
	}
	cpSync(path.join(repoRoot, "src"), path.join(destination, "src"), {
		recursive: true,
	});
	cpSync(path.join(repoRoot, "public"), path.join(destination, "public"), {
		recursive: true,
	});
	mkdirSync(path.join(destination, "test"), { recursive: true });
	cpSync(
		path.join(repoRoot, "test/wordpress-embed.spec.ts"),
		path.join(destination, "test/wordpress-embed.spec.ts"),
	);
	symlinkSync(
		path.join(repoRoot, "node_modules"),
		path.join(destination, "node_modules"),
		"dir",
	);
}

function applyMutation(workdir, mutation) {
	const filePath = path.join(workdir, mutation.file);
	const source = readFileSync(filePath, "utf8");
	const occurrences = source.split(mutation.from).length - 1;
	const expectedOccurrences = mutation.expectedOccurrences || 1;
	if (occurrences !== expectedOccurrences) {
		throw new Error(
			`${mutation.name}: expected ${expectedOccurrences} matches in ${mutation.file}, found ${occurrences}`,
		);
	}
	writeFileSync(filePath, source.split(mutation.from).join(mutation.to));
}

function runEmbedTests(workdir) {
	const reportPath = path.join(workdir, "mutation-results.json");
	const result = spawnSync("npx", ["vitest", "run", "test/wordpress-embed.spec.ts", "--reporter=json", "--outputFile", reportPath], {
		cwd: workdir, encoding: "utf8", timeout: 90_000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0 && result.status !== 1) throw new Error(`Embed tests did not complete: ${result.signal ?? result.status}`);
	const report = JSON.parse(readFileSync(reportPath, "utf8"));
	if (report.numTotalTests === 0 || (result.status !== 0 && report.numFailedTests === 0)) {
		throw new Error(`Embed tests failed to execute; this is not a killed mutant\n${report.testResults.map((suite) => suite.message).filter(Boolean).join("\n")}`);
	}
	return report.numFailedTests === 0;
}

const baselineWorkdir = path.join(tmpdir(), `shiplet-embed-baseline-${process.pid}`);
mkdirSync(baselineWorkdir, { recursive: true });
try {
	copyHarness(baselineWorkdir);
	if (!runEmbedTests(baselineWorkdir)) throw new Error("Embed mutation baseline must pass before applying mutants");
	console.log("Embed mutation baseline passed.");
} finally {
	rmSync(baselineWorkdir, { recursive: true, force: true });
}

const survivors = [];
for (let index = 0; index < mutations.length; index += 1) {
	const mutation = mutations[index];
	const workdir = path.join(
		tmpdir(),
		`shiplet-embed-mutant-${process.pid}-${index}`,
	);
	rmSync(workdir, { recursive: true, force: true });
	mkdirSync(workdir, { recursive: true });
	try {
		copyHarness(workdir);
		applyMutation(workdir, mutation);
		if (runEmbedTests(workdir)) {
			survivors.push(mutation.name);
			process.stdout.write(`SURVIVED ${mutation.name}\n`);
		} else {
			process.stdout.write(`KILLED   ${mutation.name}\n`);
		}
	} finally {
		rmSync(workdir, { recursive: true, force: true });
	}
}

if (survivors.length) {
	process.stderr.write(
		`\nSurviving embed mutants:\n- ${survivors.join("\n- ")}\n`,
	);
	process.exitCode = 1;
} else {
	process.stdout.write(
		`\nEmbed mutation smoke passed: ${mutations.length} killed, 0 survived.\n`,
	);
}
