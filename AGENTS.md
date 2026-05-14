# Agent Instructions

Before making changes in this repository, read:

- `AGENTS.md`
- `CLAUDE.md`
- `.claude/commands/`
- `docs/START-HERE.md`

## Default workflow

- For code or docs changes, work on a branch and open a pull request into
  `main` unless the user explicitly asks not to.
- Keep PRs narrowly scoped to the requested change. Inspect `git status -sb`
  and the staged diff before committing.
- Prefer creating the PR with `gh pr create` after pushing the branch.
- If GitHub shows an unexpected added/deleted file, compare against tracked
  state (`git ls-tree`, `git status -sb`) before assuming the file is actually
  present on `main`; untracked files in another worktree are not pushed.
