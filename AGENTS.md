# Agent Instructions

Before making changes in this repository, read:

- `AGENTS.md`
- `CLAUDE.md`
- `.claude/commands/`
- `docs/START-HERE.md`

## Default workflow

- After every change, open a pull request into `main`
- Inspect `git status -sb` and the staged diff before committing
- Prefer creating the PR with `gh pr create` after pushing the branch

## Hard rules (full text in `CLAUDE.md`)

- **All filesystem I/O must go through `apps/api/src/fs/disk-reads.ts`
  (reads) or `disk-writes.ts` (writes).** No inline `fs` / `Bun.file` calls
  anywhere else in `apps/api/src/` (tests excepted).
- **Fail fast on internal invariants.** Don't paper over impossible
  states with `?? fallback`, `continue`, or warn-and-proceed. Throw.
- **Database queries need an explicit index story.** For non-trivial queries,
  verify the backing index and query shape; if a query intentionally scans or
  cannot use an index well, call that out explicitly and decide if it is acceptable.
- **File deletions must NEVER be initiated by an LLM or agent.** Deletions
  are gated on a browser User-Agent + an explicit `initiatedFromWebUI`
  flag in the body, both server-validated. Do not write code that bypasses
  these or trigger the endpoint yourself.
- **Never put the user's personal data in checked-in artifacts.** Commit
  messages, docs, comments — no real file names, paths, sizes, or disk
  labels. Use placeholders (`<disk>`, `<large video file>`). Numbers and
  ratios about the system are fine; specifics tied to identifiable user
  content are not.
