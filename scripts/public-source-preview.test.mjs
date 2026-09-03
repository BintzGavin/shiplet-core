import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("public guidance keeps source preview, participation, and security routes distinct", () => {
	const readme = readFileSync("README.md", "utf8");
	const contributing = readFileSync("CONTRIBUTING.md", "utf8");
	const security = readFileSync("SECURITY.md", "utf8");
	assert.match(readme, /source-preview/i);
	assert.match(contributing, /pull requests are not an accepted/i);
	assert.match(contributing, /GitHub Issues are\s+not an accepted/i);
	assert.match(contributing, /GitHub Discussions are\s+not an accepted/i);
	assert.match(security, /report a vulnerability privately/i);
	assert.match(security, /security advisories/i);
});

test("every page in the public docs navigation exists", () => {
	const config = JSON.parse(readFileSync("docs.json", "utf8"));
	const pages = (config.navigation?.groups ?? []).flatMap((group) =>
		(group.pages ?? []).filter((page) => typeof page === "string"),
	);
	for (const page of pages) {
		assert.equal(
			existsSync(`${page}.mdx`) || existsSync(`${page}.md`),
			true,
			`missing public documentation page: ${page}`,
		);
	}
});

test("the public configuration has no Shiplet production deployment authority", () => {
	for (const file of [
		"wrangler.jsonc",
		"wrangler.test.jsonc",
		"workers/cloudflare-control-plane/wrangler.jsonc",
		"workers/managed-runtime-gateway/wrangler.jsonc",
		"workers/deny-egress/wrangler.jsonc",
	]) {
		const config = readFileSync(file, "utf8");
		assert.doesNotMatch(config, /shiplet\.cc/i);
		assert.doesNotMatch(config, /"routes"/);
	}
	const workflow = readFileSync(".github/workflows/verify.yml", "utf8");
	assert.doesNotMatch(workflow, /wrangler\s+deploy|api[_-]?token|secret put/i);
});
