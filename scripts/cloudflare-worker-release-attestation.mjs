import { readFile, stat } from "node:fs/promises";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_EVIDENCE_BYTES = 1024 * 1024;

function fail(message) {
  process.stderr.write(`Worker release attestation failed: ${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) return null;
    values.set(key, value);
  }
  const allowed = new Set([
    "--deployment",
    "--versions",
    "--worker",
    "--expected-tag",
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key))) return null;
  if (
    !values.has("--deployment") ||
    !values.has("--versions") ||
    !values.has("--worker")
  ) {
    return null;
  }
  return values;
}

async function readBoundedJson(pathname, label) {
  const metadata = await stat(pathname);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_EVIDENCE_BYTES) {
    throw new Error(`${label} evidence has an invalid size`);
  }
  try {
    return JSON.parse(await readFile(pathname, "utf8"));
  } catch {
    throw new Error(`${label} evidence is not valid JSON`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    fail(
      "usage: --deployment <json> --versions <json> --worker <name> [--expected-tag <tag>]",
    );
    return;
  }
  const worker = args.get("--worker");
  const expectedTag = args.get("--expected-tag");
  if (!WORKER.test(worker) || (expectedTag && !TAG.test(expectedTag))) {
    fail("worker name or expected tag is invalid");
    return;
  }

  let deployment;
  let versions;
  try {
    [deployment, versions] = await Promise.all([
      readBoundedJson(args.get("--deployment"), "deployment"),
      readBoundedJson(args.get("--versions"), "version-list"),
    ]);
  } catch (error) {
    fail(error instanceof Error ? error.message : "evidence could not be read");
    return;
  }
  if (
    !deployment ||
    typeof deployment !== "object" ||
    Array.isArray(deployment) ||
    !Array.isArray(deployment.versions) ||
    deployment.versions.length !== 1 ||
    deployment.versions[0]?.percentage !== 100 ||
    !UUID.test(deployment.versions[0]?.version_id ?? "")
  ) {
    fail("production must have exactly one version at 100% traffic");
    return;
  }
  if (!Array.isArray(versions)) {
    fail("version-list evidence is not an array");
    return;
  }
  const versionId = deployment.versions[0].version_id;
  const exact = versions.filter((candidate) => candidate?.id === versionId);
  if (exact.length !== 1 || !UUID.test(exact[0]?.id ?? "")) {
    fail("the production version is absent or ambiguous in the version list");
    return;
  }
  if (
    expectedTag &&
    exact[0]?.annotations?.["workers/tag"] !== expectedTag
  ) {
    fail("the production version tag mismatch prevents release attestation");
    return;
  }
  process.stdout.write(`${versionId}\n`);
}

await main();
