// Upstream status: open PRs against the cap, CI, new activity, and local worktree heads.
// Usage: node scripts/harness/status.mjs [--since-hours 24]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  OPEN_PR_CAP,
  UPSTREAM,
  git,
  headRelation,
  hoursAgo,
  mainCheckout,
  out,
  parseWorktrees,
  projectsDir,
  run,
  summarizeChecks,
} from './lib.mjs';

const argv = process.argv.slice(2);
const sinceHours = Number(argv[argv.indexOf('--since-hours') + 1]) || 24;
const since = hoursAgo(sinceHours);
const root = mainCheckout();
const ghJson = (args) => JSON.parse(out('gh', args) || 'null');
const me = out('gh', ['api', 'user', '--jq', '.login']);

run('git', ['-C', root, 'fetch', '-q', 'origin', 'main']);
run('git', ['-C', root, 'fetch', '-q', 'fork']);

const prs = ghJson([
  'pr',
  'list',
  '-R',
  UPSTREAM,
  '--author',
  me,
  '--state',
  'open',
  '--json',
  'number,title,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup',
]);
const worktrees = parseWorktrees(git(root, 'worktree', 'list', '--porcelain'));
const isAncestor = (a, b) =>
  run('git', ['-C', root, 'merge-base', '--is-ancestor', a, b]).status === 0;
const oneLine = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, 160);

console.log(
  `Open upstream PRs: ${prs.length}/${OPEN_PR_CAP}${prs.length < OPEN_PR_CAP ? '  -> a slot is free' : ''}`,
);
console.log(`Activity since ${since} (${sinceHours} h)\n`);

for (const pr of prs.sort((a, b) => a.number - b.number)) {
  const c = summarizeChecks(pr.statusCheckRollup);
  console.log(`#${pr.number} ${pr.title}`);
  console.log(
    `  ${pr.mergeable} ${pr.mergeStateStatus} review=${pr.reviewDecision || 'none'} ` +
      `CI pass=${c.pass} fail=${c.fail} pending=${c.pending}`,
  );
  const wt = worktrees.find((w) => w.branch === pr.headRefName);
  if (wt) {
    const rel = headRelation(wt.head, pr.headRefOid, isAncestor);
    const hint = {
      behind: ' (fast-forward before working)',
      ahead: ' (unpushed commits)',
      diverged: ' (STOP: diverged)',
    };
    console.log(`  local ${path.basename(wt.path)}: ${rel}${hint[rel] ?? ''}`);
  } else console.log(`  local: no worktree on ${pr.headRefName}`);
  const n = pr.number;
  const activity = [
    ...ghJson([
      'api',
      `repos/${UPSTREAM}/issues/${n}/comments?since=${since}&per_page=100`,
    ]).map((x) => ({
      at: x.created_at,
      who: x.user.login,
      kind: 'comment',
      body: x.body,
    })),
    ...ghJson(['api', `repos/${UPSTREAM}/pulls/${n}/reviews?per_page=100`])
      .filter((x) => x.submitted_at >= since)
      .map((x) => ({
        at: x.submitted_at,
        who: x.user.login,
        kind: `review ${x.state}`,
        body: x.body,
      })),
    ...ghJson([
      'api',
      `repos/${UPSTREAM}/pulls/${n}/comments?since=${since}&per_page=100`,
    ]).map((x) => ({
      at: x.created_at,
      who: x.user.login,
      kind: `line ${x.path}`,
      body: x.body,
    })),
    ...ghJson(['api', `repos/${UPSTREAM}/pulls/${n}/commits?per_page=100`])
      .filter((x) => x.commit.committer.date >= since && x.author?.login !== me)
      .map((x) => ({
        at: x.commit.committer.date,
        who: x.commit.author.name,
        kind: `commit ${x.sha.slice(0, 9)}`,
        body: x.commit.message.split('\n')[0],
      })),
  ].filter((a) => a.who !== me);
  for (const a of activity.sort((x, y) => x.at.localeCompare(y.at))) {
    console.log(`  ! ${a.at} ${a.who} ${a.kind}: ${oneLine(a.body)}`);
  }
  console.log('');
}

const closed = ghJson([
  'search',
  'prs',
  '--repo',
  UPSTREAM,
  '--author',
  me,
  '--closed',
  `>=${since.slice(0, 10)}`,
  '--json',
  'number,title,state,closedAt',
]);
for (const pr of closed)
  console.log(
    `Closed/merged: #${pr.number} ${pr.state} ${pr.closedAt} ${pr.title}`,
  );

// Upstream deps checkout: stale when upstream's lockfile changed since its last npm ci.
const depsLock = path.join(
  projectsDir(root),
  'gev-upstream-deps',
  'package-lock.json',
);
try {
  const same =
    readFileSync(depsLock, 'utf8').trim() ===
    out('git', ['-C', root, 'show', 'origin/main:package-lock.json']);
  console.log(
    `gev-upstream-deps lockfile: ${same ? 'matches origin/main' : 'DIFFERS from origin/main (re-run npm ci there)'}`,
  );
} catch (error) {
  console.log(`gev-upstream-deps lockfile: unreadable (${error.message})`);
}

// Duplicate watch: an Anthropic/Claude provider from #976's author would overlap feat/agent-anthropic-provider.
const watch = ghJson([
  'pr',
  'list',
  '-R',
  UPSTREAM,
  '--author',
  'darrendignam',
  '--state',
  'open',
  '--json',
  'number,title',
]);
const hits = watch.filter((p) => /anthropic|claude/i.test(p.title));
const pr976 = ghJson([
  'pr',
  'view',
  '976',
  '-R',
  UPSTREAM,
  '--json',
  'state',
]).state;
console.log(
  `#976: ${pr976}; darrendignam Anthropic/Claude PRs: ${hits.map((p) => `#${p.number}`).join(', ') || 'none'}`,
);
