// Worktree lifecycle with node_modules junctions.
//   node scripts/harness/worktree.mjs new <name> <branch> [--base origin/main] [--deps upstream|local]
//   node scripts/harness/worktree.mjs remove <name> [--force]
//   node scripts/harness/worktree.mjs list
//   node scripts/harness/worktree.mjs install-hooks
// --deps upstream links gev-upstream-deps (default for an origin/* base); local links the main checkout's.
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  git,
  linkDir,
  mainCheckout,
  parseWorktrees,
  projectsDir,
  resolveWorktree,
  run,
  unlinkDir,
} from './lib.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, fallback) =>
  rest.includes(name) ? rest[rest.indexOf(name) + 1] : fallback;
const positional = rest.filter(
  (a, i) =>
    !a.startsWith('--') &&
    !rest[i - 1]?.startsWith('--base') &&
    !rest[i - 1]?.startsWith('--deps'),
);
const root = mainCheckout();
const lines = (s) => s.split(/\r?\n/).filter(Boolean);
const fail = (msg) => {
  console.error(`STOP: ${msg}`);
  process.exit(1);
};

if (cmd === 'new') {
  const [name, branch] = positional;
  if (!name || !branch)
    fail(
      'usage: new <name> <branch> [--base origin/main] [--deps upstream|local]',
    );
  const base = opt('--base', 'origin/main');
  const deps = opt('--deps', base.startsWith('origin/') ? 'upstream' : 'local');
  const depsDir = path.join(
    deps === 'upstream'
      ? path.join(projectsDir(root), 'gev-upstream-deps')
      : root,
    'node_modules',
  );
  const wt = resolveWorktree(name, root);
  if (existsSync(wt)) fail(`${wt} exists`);
  const [remote, ...ref] = base.split('/');
  if (ref.length)
    run('git', ['-C', root, 'fetch', '-q', remote, ref.join('/')]);
  const hasRef = (ref) =>
    run('git', ['-C', root, 'rev-parse', '--verify', '-q', ref]).status === 0;
  const exists = hasRef(`refs/heads/${branch}`);
  // A PR branch that is only on the fork is checked out from there, not recreated from the base.
  run('git', ['-C', root, 'fetch', '-q', 'fork', branch]);
  const onFork = !exists && hasRef(`refs/remotes/fork/${branch}`);
  git(
    root,
    'worktree',
    'add',
    ...(exists
      ? [wt, branch]
      : onFork
        ? ['--track', '-b', branch, wt, `fork/${branch}`]
        : ['--no-track', '-b', branch, wt, base]),
  );
  linkDir(depsDir, path.join(wt, 'node_modules'));
  console.log(
    `${wt} on ${branch} (${exists ? 'existing branch' : onFork ? `from fork/${branch}` : `from ${base}`}), node_modules -> ${depsDir}`,
  );
  if (deps === 'upstream') {
    const lock = readFileSync(
      path.join(depsDir, '..', 'package-lock.json'),
      'utf8',
    ).trim();
    if (lock !== git(wt, 'show', 'HEAD:package-lock.json'))
      console.log(
        'WARN: gev-upstream-deps lockfile differs from this base; run npm ci there.',
      );
  }
} else if (cmd === 'remove') {
  const [name] = positional;
  if (!name) fail('usage: remove <name> [--force]');
  const wt = resolveWorktree(name, root);
  const known = parseWorktrees(
    git(root, 'worktree', 'list', '--porcelain'),
  ).map((w) => path.resolve(w.path));
  if (!existsSync(wt)) fail(`${wt} does not exist`);
  if (path.resolve(wt) === path.resolve(root))
    fail('refusing to remove the main checkout');
  if (!known.includes(path.resolve(wt)))
    fail(`${wt} is not a worktree of this repo`);
  // Never remove a folder that other worktrees' junctions or the installed hooks point into.
  const inside = (p) => {
    const rel = path.relative(path.resolve(wt), path.resolve(p));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  for (const other of known.filter((k) => k !== path.resolve(wt))) {
    const link = path.join(other, 'node_modules');
    if (
      lstatSafe(link)?.isSymbolicLink() &&
      inside(path.resolve(other, readlinkSync(link)))
    )
      fail(`${other}'s node_modules links into ${wt}`);
  }
  const hooksPath = run('git', [
    '-C',
    root,
    'config',
    '--get',
    'core.hooksPath',
  ]).stdout.trim();
  if (hooksPath && inside(hooksPath))
    fail(
      `core.hooksPath (${hooksPath}) is inside ${wt}; run install-hooks from the main checkout first`,
    );
  const force = rest.includes('--force');
  if (git(wt, 'status', '--porcelain') && !force)
    fail('uncommitted changes (use --force to discard)');
  const unpushed = git(wt, 'rev-list', '--count', 'HEAD', '--not', '--remotes');
  if (unpushed !== '0' && !force)
    fail(`${unpushed} commits are on no remote (use --force to drop them)`);
  const ignored = lines(
    git(
      wt,
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
    ),
  ).filter((f) => !/^node_modules\/?$/.test(f));
  if (ignored.length)
    console.log(`ignored files go too: ${ignored.join(', ')}`);
  const nm = path.join(wt, 'node_modules');
  const st = lstatSafe(nm);
  let target = null;
  if (st?.isSymbolicLink()) {
    target = path.resolve(wt, readlinkSync(nm));
    const count = unlinkDir(nm, target);
    console.log(
      `unlinked node_modules -> ${target} (target keeps ${count} entries)`,
    );
  } else if (st)
    console.log('node_modules is a real folder; it goes with the worktree');
  const removed = run('git', [
    '-C',
    root,
    'worktree',
    'remove',
    ...(force ? ['--force'] : []),
    wt,
  ]);
  if (removed.status !== 0) {
    if (target) linkDir(target, nm);
    fail(
      `git worktree remove failed${target ? ' (node_modules relinked)' : ''}: ${removed.stderr.trim()}`,
    );
  }
  console.log(`removed ${wt}`);
} else if (cmd === 'list') {
  for (const w of parseWorktrees(
    git(root, 'worktree', 'list', '--porcelain'),
  )) {
    const ahead = run('git', [
      '-C',
      root,
      'rev-list',
      '--count',
      `origin/main..${w.head}`,
    ]).stdout.trim();
    const nm = path.join(w.path, 'node_modules');
    const link = lstatSafe(nm)?.isSymbolicLink()
      ? `-> ${readlinkSync(nm)}`
      : existsSync(nm)
        ? 'real'
        : 'none';
    console.log(
      `${w.path}  ${w.branch ?? '(detached)'}  ahead-of-main=${ahead}  node_modules ${link}`,
    );
  }
} else if (cmd === 'install-hooks') {
  const hooks = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'hooks',
  );
  // A hooks path inside a removable worktree goes dark silently when that worktree goes.
  if (!path.resolve(hooks).startsWith(path.resolve(root) + path.sep))
    fail(`run install-hooks from the main checkout (${root}), not ${hooks}`);
  git(root, 'config', 'core.hooksPath', hooks.split(path.sep).join('/'));
  console.log(
    `core.hooksPath = ${hooks} (applies to every worktree of this repo)`,
  );
} else fail('commands: new | remove | list | install-hooks');

function lstatSafe(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}
