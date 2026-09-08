import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(join(tmpdir(), 'shiplet-kody-mutations-'));
for (const path of ['src', 'test', 'integrations', 'workers', 'docs', 'public', 'openapi.json', 'package.json', 'tsconfig.json', 'vitest.config.mts', 'wrangler.test.jsonc', 'worker-configuration.d.ts']) {
  cpSync(join(source, path), join(directory, path), { recursive: true });
}
symlinkSync(join(source, 'node_modules'), join(directory, 'node_modules'), 'dir');
const mutations = [
  ['stale revision accepted', 'integrations/kody/shiplet/src/client.ts', 'current.revision.id !== ref.revisionId', 'false'],
  ['wrong-version feedback accepted', 'integrations/kody/shiplet/src/client.ts', 'feedback.source_revision_id !== ref.revisionId', 'false'],
  ['foreign feedback accepted', 'integrations/kody/shiplet/src/client.ts', 'ticket.project_id !== ref.projectId', 'false'],
  ['failed evidence accepted', 'integrations/kody/shiplet/src/client.ts', '!passes(target, check)', 'false'],
  ['Kody tool errors treated as success', 'integrations/kody/shiplet/src/client.ts', 'value.isError || value.__mcpIsError', 'false'],
  ['cursor ignored', 'src/review.ts', 'if (before !== undefined)', 'if (false)'],
  ['canonical source lost', 'src/review.ts', 'revisionsByFeedback.get(row.id) ?? null', 'null'],
];
function run(label) {
  const result = spawnSync(process.execPath, [join(source, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=2', 'test/kody-workflow.spec.ts', 'test/kody-feedback-contract.spec.ts', 'test/kody-package-boundaries.spec.ts'], { cwd: directory, encoding: 'utf8', timeout: 180_000 });
  writeFileSync(join(directory, `${label}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return { status: result.status, timedOut: !!result.error, assertionFailure: /AssertionError|expected .*to|promise resolved.*rejects|Received promise rejected/.test(`${result.stdout}${result.stderr}`) };
}
if (run('baseline').status !== 0) throw new Error(`Mutation baseline failed; inspect ${directory}/baseline.log`);
let killed = 0;
for (const [name, path, before, after] of mutations) {
  const filename = join(directory, path), original = readFileSync(filename, 'utf8');
  if (!original.includes(before)) throw new Error(`Mutation anchor missing: ${name}`);
  writeFileSync(filename, original.replace(before, after));
  const result = run(`mutation-${killed + 1}`);
  writeFileSync(filename, original);
  if (result.status === 0 || result.timedOut || !result.assertionFailure) throw new Error(`Mutation survived or infrastructure failed: ${name}; inspect ${directory}`);
  killed++;
  console.log(`Killed: ${name}`);
}
console.log(`${killed}/${mutations.length} targeted mutations killed. Logs: ${directory}`);
