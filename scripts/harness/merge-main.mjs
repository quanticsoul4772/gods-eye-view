// Bring upstream main into a PR worktree, then verify the result.
//   node scripts/harness/merge-main.mjs <worktree>            fetch, fast-forward to the fork, start the merge
//   node scripts/harness/merge-main.mjs <worktree> --verify   after resolving: markers, tests, checks
//   add --no-build to skip `npm run build`, --no-suite to skip the full suite.
// It never commits or pushes.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changelogStatus,
  git,
  headRelation,
  resolveWorktree,
  run,
  targetedTests,
} from './lib.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const wt = resolveWorktree(argv.find((a) => !a.startsWith('--')));
if (!existsSync(path.join(wt, '.git')))
  throw new Error(`not a worktree: ${wt}`);
const here = path.dirname(fileURLToPath(import.meta.url));
const fail = (msg) => {
  console.error(`STOP: ${msg}`);
  process.exit(1);
};
const lines = (s) => s.split(/\r?\n/).filter(Boolean);

if (!flags.has('--verify')) {
  const branch = git(wt, 'branch', '--show-current');
  if (!branch) fail('detached HEAD');
  if (git(wt, 'status', '--porcelain'))
    fail('worktree has uncommitted changes');
  git(wt, 'fetch', '-q', 'origin', 'main');
  const fetched = run('git', ['-C', wt, 'fetch', '-q', 'fork', branch]);
  const knownRef =
    run('git', [
      '-C',
      wt,
      'rev-parse',
      '-q',
      '--verify',
      `refs/remotes/fork/${branch}`,
    ]).status === 0;
  // A failed fetch of a branch the fork is known to have must not skip the divergence check.
  if (fetched.status !== 0 && knownRef)
    fail(`fetching fork/${branch} failed: ${fetched.stderr.trim()}`);
  const hasFork = fetched.status === 0;
  const head = git(wt, 'rev-parse', 'HEAD');
  if (hasFork) {
    const forkHead = git(wt, 'rev-parse', `fork/${branch}`);
    const isAncestor = (a, b) =>
      run('git', ['-C', wt, 'merge-base', '--is-ancestor', a, b]).status === 0;
    const rel = headRelation(head, forkHead, isAncestor);
    console.log(`fork/${branch}: local is ${rel}`);
    if (rel === 'diverged')
      fail(`local and fork/${branch} diverged; reconcile by hand`);
    if (rel === 'behind') git(wt, 'merge', '--ff-only', `fork/${branch}`);
  } else console.log(`fork/${branch}: not on the fork yet`);
  if (
    run('git', ['-C', wt, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD'])
      .status === 0
  ) {
    console.log('Already contains origin/main; nothing to merge.');
    process.exit(0);
  }
  const ours = new Set(
    lines(git(wt, 'diff', '--name-only', 'origin/main...HEAD')),
  );
  const theirs = lines(git(wt, 'diff', '--name-only', 'HEAD...origin/main'));
  const merge = run('git', [
    '-C',
    wt,
    'merge',
    '--no-commit',
    '--no-ff',
    'origin/main',
  ]);
  const conflicts = lines(git(wt, 'diff', '--name-only', '--diff-filter=U'));
  console.log(
    `\nMain changed ${theirs.length} files; ${theirs.filter((f) => ours.has(f)).length} also changed on this branch:`,
  );
  for (const f of theirs.filter((f) => ours.has(f))) console.log(`  ${f}`);
  console.log(
    conflicts.length ? `\nConflicts (${conflicts.length}):` : '\nNo conflicts.',
  );
  for (const f of conflicts) console.log(`  ${f}`);
  if (merge.status !== 0 && !conflicts.length) fail(merge.stderr.trim());
  console.log(
    "\nResolve, then re-run with --verify. Also grep main's new code for readers of anything this branch changes.",
  );
  process.exit(0);
}

// --verify
const unmerged = lines(git(wt, 'diff', '--name-only', '--diff-filter=U'));
if (unmerged.length) fail(`unmerged paths: ${unmerged.join(', ')}`);
const markers = lines(
  run('git', ['-C', wt, 'diff', '--check', 'HEAD']).stdout,
).filter((l) => /conflict marker/.test(l));
if (markers.length) fail(`conflict markers left:\n${markers.join('\n')}`);

const changed = lines(git(wt, 'diff', '--name-only', 'origin/main'));
const allTests = lines(git(wt, 'ls-files', '*.test.mjs'));
// Allocation probes need a process of their own; the batched suite runs them that way.
const targeted = targetedTests(changed, allTests).filter(
  (f) => !/Allocations?\.test\.mjs$/.test(f),
);
const results = [];
const step = (name, cmd, args, opts = {}) => {
  console.log(`\n== ${name}`);
  const status = spawnSync(cmd, args, {
    cwd: wt,
    stdio: 'inherit',
    ...opts,
  }).status;
  results.push(`${status === 0 ? 'ok  ' : 'FAIL'} ${name}`);
};
const npm = (script) =>
  step(`npm run ${script}`, `npm run ${script}`, [], { shell: true });

if (targeted.length) {
  step(`targeted tests (${targeted.length})`, process.execPath, [
    '--import=./build/registerVue.js',
    '--test',
    ...targeted,
  ]);
} else results.push('skip targeted tests (none match the changed files)');
if (!flags.has('--no-suite'))
  step('full suite (batched)', process.execPath, [
    path.join(here, 'test-batched.mjs'),
  ]);
npm('format:check');
npm('check:boundaries');
npm('i18n');
if (!flags.has('--no-build')) npm('build');

const cl = changelogStatus(changed);
if (cl.warn)
  results.push(
    'note runtime files changed and no changelog.d fragment (needed only for behavior changes)',
  );
console.log(`\n${results.join('\n')}`);
process.exitCode = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
