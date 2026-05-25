# AGENTS.md

---

## Issues-first workflow (mandatory)

**No ticket, no workee.** Do not implement features or bugfixes requested in chat until a tracking GitHub Issue exists.

| Request in chat | Agent action |
|-----------------|--------------|
| New feature | Create issue (`[feat]: …`) via `gh issue create`, then branch |
| Bug / regression | Create issue (`[bug]: …`), then branch |
| Question / explanation only | Answer; no issue required |
| Docs typo (one line) | Fix directly; issue optional |

Before writing implementation code:

1. Confirm repo has a GitHub remote and `gh` auth for the owning identity.
2. Open or find the issue; note the number.
3. Branch name should include the issue number when practical (`feat/123-short-name`).
4. PR body must include `Fixes #N`.

**Exceptions** (no issue required):

- Operator explicitly says "skip issue" or "no ticket".
- One-line typos, comment-only edits, or doc fixes with no behavior change.
- Active production incident when the operator declares hotfix mode.

If the operator describes substantive work but no issue exists, **create the issue first**, paste the URL back, then proceed.

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

## Cursor Cloud specific instructions

### Runtime

Bun 1.3+ is required. The update script installs it if missing and runs `bun install`. ffmpeg is pre-installed on the VM.

### Lint / typecheck / test

```bash
bun run typecheck   # tsc --noEmit
bun test            # bun's built-in test runner (71 tests across 21 files)
bun run ci          # typecheck + test in one shot
```

All tests are self-contained with mocks - no external services needed.

### Running the bot locally

The bot requires live Discord and Jellyfin credentials (see `.env.example`). Without them, `bun run start` will crash at Jellyfin authentication - this is expected. The health server (`GET /healthz` on port 8080) starts before external auth, so you can verify the Bun + health layer independently.

Key env vars for a live run: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `JELLYFIN_USERNAME`, `JELLYFIN_PASSWORD`, `JELLYFIN_MOVIES_LIBRARY_ID`, `JELLYFIN_TV_LIBRARY_ID`.

### Docker parity

`make test` runs the test suite inside the Docker `test` target for CI parity. Docker is not installed by default on Cloud Agent VMs - install it if needed (see system instructions for Docker-in-Docker setup).

### Pre-commit hook

Husky runs `bun run secrets:staged` (gitleaks) on commit. If gitleaks is not installed locally, the script falls back to the `zricethezav/gitleaks:v8.30.1` Docker image. In Cloud Agent VMs without Docker, the hook may fail - this is non-blocking for development but worth noting.

## Cursor Cloud Agents (GitHub)

Label-gated automation only — **not** on every new issue. **`@radgey-cmd`** is triage: they review issues and add `ai-triage` when Cursor should attempt work. The workflow only runs when `radgey-cmd` applies that label.

| Label | Effect |
| --- | --- |
| `ai-triage` | Triggers `.github/workflows/cursor-issue-triage.yml` when applied by `radgey-cmd` |
| `human-needed` | Do not use agent automation |

Cloud Agents must follow the **Cursor agent rules** in `CONTRIBUTING.md`. Prefer `ai-safe`, `ai-no-db`, and `ai-no-auth` labels to narrow scope.
