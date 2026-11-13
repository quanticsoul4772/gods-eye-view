// Shared helpers for the contributor harness (fork only; never part of an upstream PR).
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';

export const UPSTREAM = 'bilawalsidhu/gods-eye-view';
export const OPEN_PR_CAP = 5;
export const NOREPLY = '71096528+quanticsoul4772@users.noreply.github.com';

/** Run a command; returns { status, stdout, stderr }. Never goes through a shell. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Run a command and return trimmed stdout, throwing with stderr on failure. */
export function out(cmd, args, opts = {}) {
  const r = run(cmd, args, opts);
  if (r.status !== 0)
    throw new Error(
      `${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr.trim()}`,
    );
  return r.stdout.trim();
}

export const git = (cwd, ...args) => out('git', ['-C', cwd, ...args]);

/** Absolute path of the main checkout, from any worktree. */
export function mainCheckout(cwd = process.cwd()) {
  return path.dirname(
    git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
  );
}

export const projectsDir = (cwd) => path.dirname(mainCheckout(cwd));

/** Resolve a worktree argument: a path, or a bare name under the projects folder. */
export function resolveWorktree(arg, cwd = process.cwd()) {
  if (!arg) return path.resolve(cwd);
  return /[\\/]/.test(arg)
    ? path.resolve(arg)
    : path.join(projectsDir(cwd), arg);
}

/** Parse `git worktree list --porcelain`. */
export function parseWorktrees(porcelain) {
  const list = [];
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    const entry = {};
    for (const line of block.split(/\r?\n/)) {
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'worktree') entry.path = value;
      else if (key === 'HEAD') entry.head = value;
      else if (key === 'branch')
        entry.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'detached') entry.branch = null;
    }
    if (entry.path) list.push(entry);
  }
  return list;
}

/** Count check outcomes in a `statusCheckRollup` array from `gh pr view --json`. */
export function summarizeChecks(rollup = []) {
  const counts = { pass: 0, fail: 0, pending: 0 };
  for (const c of rollup) {
    const result = String(
      c.conclusion || c.state || c.status || '',
    ).toUpperCase();
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(result)) counts.pass++;
    else if (
      [
        'FAILURE',
        'ERROR',
        'CANCELLED',
        'TIMED_OUT',
        'ACTION_REQUIRED',
        'STARTUP_FAILURE',
      ].includes(result)
    )
      counts.fail++;
    else counts.pending++;
  }
  return counts;
}

/** Where a local head stands against the PR head: same, behind (fast-forward), ahead, or diverged. */
export function headRelation(local, remote, isAncestor) {
  if (!local || !remote) return 'unknown';
  if (local === remote) return 'same';
  if (isAncestor(local, remote)) return 'behind';
  if (isAncestor(remote, local)) return 'ahead';
  return 'diverged';
}

const BANNED_WORDS = /\b(honest|honestly|honesty|understood)\b/i;
const CONVENTIONAL_SUBJECT = /^[a-z]+(\([^)\s]+\))?!?: \S/;
const CO_AUTHOR = /^Co-Authored-By: Claude [^<\n]+ <noreply@anthropic\.com>$/im;
// A noreply address: user@users.noreply.github.com, noreply@github.com, noreply@anthropic.com and the like.
const NOREPLY_EMAIL = /(^|[@.])noreply\.[^@]+$|^noreply@/i;

/**
 * Problems with one commit before it leaves the machine.
 * commit: { sha, authorEmail, committerEmail, parents: string[], message }
 */
export function checkCommit(commit) {
  const problems = [];
  const short = commit.sha.slice(0, 9);
  const subject = commit.message.split('\n')[0];
  // GitHub's "Update branch" merges are committed by noreply@github.com.
  if (!NOREPLY_EMAIL.test(commit.committerEmail))
    problems.push(`${short}: committer email is not a noreply address`);
  if (!NOREPLY_EMAIL.test(commit.authorEmail))
    problems.push(`${short}: author email is not a noreply address`);
  if (/Generated with/i.test(commit.message))
    problems.push(`${short}: message has a "Generated with" line`);
  if (BANNED_WORDS.test(commit.message))
    problems.push(`${short}: message uses a banned word`);
  const isMerge = commit.parents.length > 1;
  if (!isMerge && commit.authorEmail.toLowerCase() === NOREPLY) {
    // The scope is optional: upstream also takes "test: ..." and "changelog: ...".
    if (!CONVENTIONAL_SUBJECT.test(subject))
      problems.push(`${short}: subject is not "type(scope): change"`);
    if (!CO_AUTHOR.test(commit.message))
      problems.push(`${short}: no Co-Authored-By: Claude trailer`);
  }
  return problems;
}

const isTest = (f) => /\.test\.mjs$/.test(f);

/** Whether a branch's changed files suggest a runtime change, and whether a changelog fragment is present. */
export function changelogStatus(changedFiles) {
  const runtime = changedFiles.some(
    (f) => /^(src|server)\//.test(f) && !isTest(f) && !/\.md$/.test(f),
  );
  const fragment = changedFiles.some((f) => /^changelog\.d\/.+\.md$/.test(f));
  return { runtime, fragment, warn: runtime && !fragment };
}

/** Test files to run first for a set of changed files: changed tests plus same-directory tests named after changed sources. */
export function targetedTests(changedFiles, allTests) {
  const picked = new Set(
    changedFiles.filter((f) => isTest(f) && allTests.includes(f)),
  );
  for (const f of changedFiles) {
    if (isTest(f) || !/\.(m?js|vue)$/.test(f)) continue;
    const dir = path.posix.dirname(f);
    const base = path.posix.basename(f).replace(/\.(m?js|vue)$/, '');
    for (const t of allTests) {
      if (
        path.posix.dirname(t) === dir &&
        path.posix.basename(t).startsWith(base)
      )
        picked.add(t);
    }
  }
  return [...picked].sort();
}

/** Link `linkPath` to `target` as a directory junction (a symlink off Windows). */
export function linkDir(target, linkPath) {
  if (!existsSync(target)) throw new Error(`link target missing: ${target}`);
  if (existsSync(linkPath)) throw new Error(`already exists: ${linkPath}`);
  symlinkSync(target, linkPath, 'junction');
}

/**
 * Remove a junction without touching what it points to, and prove the target kept every entry.
 * Returns the target's entry count. Throws if `linkPath` is a real directory.
 */
export function unlinkDir(linkPath, target) {
  if (!lstatSync(linkPath).isSymbolicLink())
    throw new Error(`not a junction or symlink: ${linkPath}`);
  const before = readdirSync(target).length;
  unlinkSync(linkPath);
  if (existsSync(linkPath)) throw new Error(`link still present: ${linkPath}`);
  const after = readdirSync(target).length;
  if (after !== before)
    throw new Error(`target ${target} went from ${before} to ${after} entries`);
  return after;
}

/** Hours-ago ISO timestamp. */
export const hoursAgo = (h, now = Date.now()) =>
  new Date(now - h * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
