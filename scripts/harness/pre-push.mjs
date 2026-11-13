// Git pre-push hook body (installed by `worktree.mjs install-hooks` for every worktree of this repo).
// Blocks pushes upstream and commits that break the contribution rules. Bypass: git push --no-verify.
import { readFileSync } from 'node:fs';
import { UPSTREAM, changelogStatus, checkCommit, out, run } from './lib.mjs';

const [remoteName = '', remoteUrl = ''] = process.argv.slice(2);
const problems = [];
const notes = [];
if (remoteName === 'origin' || remoteUrl.toLowerCase().includes(UPSTREAM))
  problems.push(
    `push to ${remoteName} (${remoteUrl}) is upstream; push to fork`,
  );

const ZERO = /^0+$/;
const stdin = readFileSync(0, 'utf8');
for (const line of stdin.split(/\r?\n/).filter(Boolean)) {
  const [localRef, localSha] = line.split(' ');
  if (ZERO.test(localSha)) continue; // branch deletion
  // out() throws on a git error, so the push is blocked rather than waved through unchecked.
  const log = out('git', [
    'log',
    '--format=%H%x00%ae%x00%ce%x00%P%x00%B%x1e',
    localSha,
    '--not',
    '--remotes',
  ]);
  for (const rec of log
    .split('\x1e')
    .map((r) => r.replace(/^\s+/, ''))
    .filter(Boolean)) {
    const [sha, authorEmail, committerEmail, parents, message] =
      rec.split('\x00');
    problems.push(
      ...checkCommit({
        sha,
        authorEmail,
        committerEmail,
        parents: parents.split(' ').filter(Boolean),
        message: message.trim(),
      }),
    );
  }
  if (/^refs\/heads\/upstream\//.test(localRef)) {
    const changed = run('git', [
      'diff',
      '--name-only',
      `origin/main...${localSha}`,
    ])
      .stdout.split(/\r?\n/)
      .filter(Boolean);
    if (changelogStatus(changed).warn)
      notes.push(
        `${localRef}: runtime files changed with no changelog.d fragment (needed only for behavior changes)`,
      );
  }
}
for (const n of notes) console.error(`pre-push note: ${n}`);
if (problems.length) {
  console.error(`pre-push blocked:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
