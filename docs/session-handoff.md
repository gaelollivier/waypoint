# Session Handoff

Pick this up cold. Read this doc first, then `decisions.md`, then `open-questions.md`. The research docs (`research-*.md`) have deeper context if needed.

---

## What this project is

A personal backup tool for one specific hardware setup: Mac mini, 4TB SSD source, two 8TB HDDs as cold-storage destinations. Only one HDD connected at a time (manually rotated). Custom build — no existing tool covers all requirements. See `HANDOFF.md` for the full original design brief.

## What was done this session

1. **Research phase completed.** Three research docs written from source code of: `fit` (C++ file integrity tool), `gdu` (Go disk analyzer), `Spacedrive v2` (Rust file manager), `restic` and `borg` (backup tools). Findings in `docs/research-*.md`.

2. **Decisions locked.** Core safety constraints, storage format, hashing, architecture shape, job model — all documented in `docs/decisions.md`. Do not re-open without new information.

3. **Open questions documented.** Four unresolved design questions in `docs/open-questions.md`. These need discussion before implementation starts. Do not skip them.

## The single most important constraint

**Safety over everything.** This tool reads/writes to the user's most important personal data. The codebase must contain zero deletion logic. All writes are either to the SQLite metadata DB or additive-only file copies. Any design choice that could result in unexpected overwrites or deletions is rejected regardless of other benefits.

## Where to start next session

Work through `open-questions.md` one item at a time with the user. Do not start implementing until all four are resolved. The order matters:

1. **fsync strategy** (item 1) — affects copy job design fundamentally.
2. **Walk queue / resumable scan** (item 2) — affects schema design fundamentally.
3. **Hashing strategy** (item 3) — affects scan job performance design.
4. **Orphaned temp files** (item 4) — smaller, but must be resolved before any file copy code is written.

After all four are resolved, the next step is the schema design (refine the sketch in `HANDOFF.md` section 4.5 into a final schema with migration plan).

## Language decision still open

Go vs Rust. Recommendation is Go for v1. User has not decided. Resolve this before writing any code.

## Key research findings to keep in mind

- **Restic's atomic write pattern** (write-to-temp → rename) is the model for all file copies. The fsync question is separate from this.
- **gdu's `synchronous=OFF` is a trap** — never use it. WAL + `synchronous=NORMAL` is our baseline.
- **No existing tool truly resumes mid-walk** — our walk queue idea is novel and needs careful design.
- **Sampled hashing** (Spacedrive) is an option for fast re-scans but is deferred to open-questions.
- **iCloud dataless files** (`SF_DATALESS` flag on macOS): detect and skip stubs that haven't downloaded yet.
- **xattr/resource forks**: restic handles these; we should too. Low complexity, high correctness value for macOS.
