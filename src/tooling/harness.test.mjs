import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  NOREPLY,
  changelogStatus,
  checkCommit,
  headRelation,
  linkDir,
  parseWorktrees,
  summarizeChecks,
  targetedTests,
  unlinkDir,
} from '../../scripts/harness/lib.mjs';

const ok =
  'fix(hud): show 1.0 km\n\nWhy.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const commit = (over = {}) => ({
  sha: 'a'.repeat(40),
  authorEmail: NOREPLY,
  committerEmail: NOREPLY,
  parents: ['b'],
  message: ok,
  ...over,
});

test('checkCommit accepts a conventional commit with the trailer', () => {
  assert.deepEqual(checkCommit(commit()), []);
});

test('checkCommit flags a personal committer email, a missing trailer and a vague subject', () => {
  const problems = checkCommit(
    commit({
      committerEmail: 'someone@gmail.com',
      message: 'say when it rounds',
    }),
  );
  assert.equal(problems.length, 3);
  assert.match(problems.join('\n'), /committer email/);
  assert.match(problems.join('\n'), /type\(scope\)/);
  assert.match(problems.join('\n'), /Co-Authored-By/);
});

test('checkCommit flags the attribution line and banned words in any commit', () => {
  const merge = commit({
    parents: ['b', 'c'],
    message: 'Merge main\n\nHonestly fine\n\nGenerated with Claude Code',
  });
  assert.equal(checkCommit(merge).length, 2);
});

test('checkCommit lets another noreply author keep their own message style', () => {
  const kevin = commit({
    authorEmail: '7121943+kvnloo@users.noreply.github.com',
    message: 'test(routes): cover 502',
  });
  assert.deepEqual(checkCommit(kevin), []);
  assert.equal(
    checkCommit(
      commit({ authorEmail: 'x@example.com', message: 'test(routes): x' }),
    ).length,
    1,
  );
});

test('parseWorktrees reads branches and detached heads', () => {
  const porcelain =
    'worktree D:/a\nHEAD 111\nbranch refs/heads/local\n\nworktree D:/b\nHEAD 222\ndetached\n';
  assert.deepEqual(parseWorktrees(porcelain), [
    { path: 'D:/a', head: '111', branch: 'local' },
    { path: 'D:/b', head: '222', branch: null },
  ]);
});

test('summarizeChecks counts check runs and status contexts', () => {
  const rollup = [
    { conclusion: 'SUCCESS' },
    { conclusion: 'FAILURE' },
    { status: 'IN_PROGRESS', conclusion: '' },
    { state: 'SUCCESS' },
  ];
  assert.deepEqual(summarizeChecks(rollup), { pass: 2, fail: 1, pending: 1 });
});

test('headRelation tells fast-forward from diverged', () => {
  const anc = (a, b) => a === 'old' && b === 'new';
  assert.equal(headRelation('x', 'x', anc), 'same');
  assert.equal(headRelation('old', 'new', anc), 'behind');
  assert.equal(headRelation('new', 'old', anc), 'ahead');
  assert.equal(headRelation('p', 'q', anc), 'diverged');
});

test('changelogStatus warns only for runtime changes without a fragment', () => {
  assert.equal(changelogStatus(['src/hud.js']).warn, true);
  assert.equal(
    changelogStatus(['src/hud.js', 'changelog.d/1676-x.md']).warn,
    false,
  );
  assert.equal(
    changelogStatus(['src/hud.test.mjs', '.github/workflows/ci.yml']).warn,
    false,
  );
});

test('targetedTests picks changed tests and same-folder tests named after changed sources', () => {
  const all = [
    'src/hud.test.mjs',
    'src/hudLocality.test.mjs',
    'src/other.test.mjs',
    'src/voice/speech.test.mjs',
  ];
  assert.deepEqual(
    targetedTests(['src/hudLocality.js', 'src/voice/speech.test.mjs'], all),
    ['src/hudLocality.test.mjs', 'src/voice/speech.test.mjs'],
  );
  assert.deepEqual(targetedTests(['docs/x.md'], all), []);
});

test('unlinkDir removes the link and leaves every target entry', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-'));
  try {
    const target = path.join(dir, 'deps');
    mkdirSync(target);
    writeFileSync(path.join(target, 'a.js'), '');
    mkdirSync(path.join(target, 'pkg'));
    const link = path.join(dir, 'wt', 'node_modules');
    mkdirSync(path.dirname(link));
    linkDir(target, link);
    assert.throws(() => linkDir(target, link), /already exists/);
    assert.equal(unlinkDir(link, target), 2);
    assert.equal(existsSync(link), false);
    assert.deepEqual(readdirSync(target).sort(), ['a.js', 'pkg']);
    assert.throws(() => unlinkDir(target, target), /not a junction/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkCommit accepts a GitHub "Update branch" merge', () => {
  const update = commit({
    committerEmail: 'noreply@github.com',
    parents: ['b', 'c'],
    message: "Merge branch 'main' into upstream/x",
  });
  assert.deepEqual(checkCommit(update), []);
});

test('checkCommit treats only real noreply domains as noreply', () => {
  assert.equal(
    checkCommit(
      commit({ authorEmail: 'noreplyfan@gmail.com', message: 'test(x): y' }),
    ).length,
    1,
  );
  assert.deepEqual(
    checkCommit(
      commit({
        authorEmail: 'noreply@github.com',
        parents: ['b', 'c'],
        message: 'Merge x',
      }),
    ),
    [],
  );
});

test('checkCommit reads the trailer key case-insensitively and our email in any case', () => {
  assert.deepEqual(
    checkCommit(
      commit({ message: ok.replace('Co-Authored-By', 'Co-authored-by') }),
    ),
    [],
  );
  assert.equal(
    checkCommit(commit({ authorEmail: NOREPLY.toUpperCase(), message: 'wip' }))
      .length,
    2,
  );
});
