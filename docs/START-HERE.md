# Waypoint — Start Here

Personal backup tool for cold storage drives. Mac mini, 4TB SSD → two 8TB HDDs (one connected at a time, manually rotated). Custom build — no existing tool covers all requirements.

**Safety is the top priority.** Additive-only writes, no deletion code anywhere, all errors logged and surfaced. See `decisions.md` for the full constraint list.

---

## Doc map

| Doc | Purpose |
|---|---|
| `brief.md` | Full project brief: hardware context, requirements, existing-tools research, architecture sketch. Read this for deep context. |
| `decisions.md` | Locked design decisions. Don't re-open without new information. |
| `open-questions.md` | 4 unresolved questions that must be answered before implementation starts. Start here for next session. |
| `research-fit-gdu.md` | Findings from fit (C++ file integrity) and gdu (Go disk analyzer) |
| `research-spacedrive.md` | Findings from Spacedrive v2 (Rust file manager) |
| `research-correctness.md` | Findings from restic + borg: atomic writes, fsync, verification, macOS xattrs |

---

## Next session agenda

1. Resolve the 4 open questions in `open-questions.md` (in order — each affects what comes after)
2. Decide Go vs Rust
3. Final schema design (refine the sketch in `brief.md` section 4.5)
4. Then: start building

## Key things to keep in mind

- **No deletion code anywhere in the codebase, ever.** Not implicit, not automatic.
- **Orphaned temp files** from interrupted copies are surfaced in the UI for manual cleanup — never auto-deleted.
- **All errors are logged per-file in SQLite** — nothing silent, everything retryable.
- **iCloud dataless files** (`SF_DATALESS` on macOS): detect and skip, never hash a stub.
- The project is named **Waypoint**. GitHub: github.com/gaelollivier/waypoint.
