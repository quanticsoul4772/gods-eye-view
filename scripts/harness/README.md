# Contributor harness (fork only)

Scripts for the upstream-contribution workflow. They live on the fork's `local`
branch and never go into an upstream PR. Run them from any checkout that has
them; they find the main checkout and the projects folder through git.

- `node scripts/harness/status.mjs [--since-hours 24]`: open upstream PRs
  against the cap of 5, merge state, CI, and other people's comments, reviews and
  commits in the window. It also shows whether each local `wt-up-*` worktree
  matches its PR head, whether `gev-upstream-deps` still matches upstream's
  lockfile, and the #976 duplicate watch.
- `node scripts/harness/merge-main.mjs <worktree>`: refuses a dirty tree,
  fast-forwards to `fork/<branch>` (stops if they diverged), and starts
  `git merge --no-commit --no-ff origin/main`. It lists the conflicts and the
  files both sides changed.
- `node scripts/harness/merge-main.mjs <worktree> --verify [--no-suite] [--no-build]`:
  checks for unmerged paths and leftover conflict markers. Then it runs the
  targeted tests (only when some match), the batched full suite,
  `format:check`, `check:boundaries`, `i18n` and `build`. It never commits.
- `node scripts/harness/test-batched.mjs`: the full unit suite in batches of
  150 files, for the Windows command-line limit. It prints
  `BATCHES_FAILED=n files=N`.
- `node scripts/harness/worktree.mjs new <name> <branch> [--base origin/main] [--deps upstream|local]`:
  adds the worktree and links its `node_modules`. An `origin/*` base defaults
  to `gev-upstream-deps`; a stale lockfile is flagged.
- `node scripts/harness/worktree.mjs remove <name> [--force]`: refuses
  uncommitted or unpushed work, and any folder that another worktree's
  `node_modules` or `core.hooksPath` points into (so `gev-upstream-deps` is
  safe). It lists the ignored files that go with it, unlinks the junction,
  checks the target kept every entry, then runs `git worktree remove`. It
  relinks the junction if that fails.
- `node scripts/harness/worktree.mjs list`: worktrees, commits ahead of main,
  and where each `node_modules` points.
- `node scripts/harness/worktree.mjs install-hooks`: points `core.hooksPath`
  (repo-wide, so every worktree) at `scripts/harness/hooks`. It runs only
  from the main checkout. A path inside a worktree would stop running hooks,
  without any warning, once that worktree is removed.
- `new` checks out a PR branch that exists only on the fork from
  `fork/<branch>`, rather than recreating it from the base.

The pre-push hook blocks a push to `origin`. It also blocks a commit that is
not yet on any remote if:

- its author or committer email is not a noreply address;
- it contains a "Generated with" line or a banned word;
- our own non-merge commit lacks a `type(scope): change` subject (the scope is
  optional, as in `test: ...`) or the
  `Co-Authored-By: Claude` trailer.

For `upstream/*` branches it notes runtime changes that have no
`changelog.d` fragment. Bypass with `git push --no-verify`.

Tests: `src/tooling/harness.test.mjs`.
