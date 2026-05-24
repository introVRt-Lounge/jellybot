# AGENTS.md

> If `SOUL.md` exists in this repo, read it before proceeding.

---

## Branch protocol (mandatory for features)

**All substantive work uses feature branches.** No long-lived uncommitted feature piles on `main`.

Follow **`feature-branch-workflow`** (issue → branch from `main` → tests → implement → push → PR → green CI → merge → cleanup).

### Bias: ship when green

When a feature is **complete and tests pass**, the default next action is **commit → push → open PR → merge** - not "leave it local for later."

- Do not end a feature session with only local changes unless the operator explicitly asked for local-only / WIP.
- PR body must be non-empty: Summary, Test plan, and `Fixes #N` when an issue exists.
- After merge: `git checkout main && git pull --ff-only`, delete the topic branch, confirm `git status` is clean.

### Exceptions

- One-line typos the operator wants directly on `main`.
- Operator explicitly says "don't commit yet" or "local only."

### Deploy

After merge to `main`, run **`make dev-refresh`** (or your documented prod deploy) so the running bot matches `main`.

---

## Progress reporting

One line per update:

```
<STATE> | <DELTA> | <NEXT> | <ASK>
```

---

## Project pointers

- Discord setup: `DISCORD_SETUP.md`
- Commands: `docs/COMMANDS.md`
- Tests: `bun run ci` or `make test` (Docker parity)
- Register slash commands: `make register-commands` (builds register image first)
