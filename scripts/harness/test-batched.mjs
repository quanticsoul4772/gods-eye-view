// Runs the repo's unit-test plan in batches of 150 files, because one `node --test`
// call with every file exceeds the Windows command-line limit. Run from the checkout to test.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const runner = await import(
  pathToFileURL(path.resolve('scripts/run-unit-tests.mjs')).href
);
const plan = runner.buildUnitTestPlan(runner.discoverUnitTestFiles());
const node = (args) =>
  spawnSync(process.execPath, [...runner.UNIT_TEST_NODE_FLAGS, ...args], {
    stdio: 'inherit',
  }).status;
let failed = 0;
for (let i = 0; i < plan.parallel.length; i += 150) {
  if (node(['--test', ...plan.parallel.slice(i, i + 150)]) !== 0) failed++;
}
for (const file of plan.serializedAllocations) {
  if (node(runner.allocationTestArgs(file)) !== 0) failed++;
}
console.log(`BATCHES_FAILED=${failed} files=${plan.parallel.length}`);
process.exitCode = failed ? 1 : 0;
