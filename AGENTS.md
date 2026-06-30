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

### Never stash

**Do not use `git stash` to manage work.** A stash means one of two things:

1. **In-progress work that is not finished** — finish it on a feature branch, or discard it explicitly.
2. **An accident** — wrong branch, messy tree — fix the tree (commit, move commits, or `git restore`), do not hide it in a stash.

If you need a clean checkout, the correct moves are: commit on the topic branch, open a draft PR, or ask the operator. Stashes left behind become orphan landmines for the next agent.

When switching branches mid-task, **commit or branch** the work — never stash-and-forget.

### Deploy

After merge to `main`, **prod** updates via **Ship main** → GHCR `:latest` → Watchtower recreates `~/docker/jellybot` (no manual pull in normal ops). Slash commands now **auto-register on startup** when the command body hash differs from the last applied hash (stored in `bot-state.db.command_sync_state`); empty bodies are refused defensively. The first restart after a command change emits `discord.commands.synced`; subsequent restarts log `discord.commands.already_synced` and make no Discord API calls.

`make register-commands` (and the `register` compose profile) remain as a **manual escape hatch** — run it (or `JELLYBOT_COMMAND_SYNC_FORCE=1` on the running container) only when Discord state has diverged from `bot-state.db` and you need a forced re-sync.

**Dev bot** (`jellybot-dev` / Bottitesto) is for **you** to confirm behavior (`bun run ci`, optional `make dev-refresh`) **before** merging to `main`. If a PR is merged, prod auto-registers on the next Watchtower recreate.

#### Manual prod recreate (env changes only)

Watchtower handles image upgrades. When you change `~/docker/jellybot/.env` and need the new vars loaded **right now** (e.g. enabling webhook secrets, rotating tokens), use:

```bash
bash ~/docker/jellybot/recreate.sh
```

This script does an atomic `docker compose up -d --force-recreate --remove-orphans` in a single invocation, then polls `docker inspect` for `Health.Status=healthy`.

**Do not** run `docker compose pull && docker compose up -d` as separate commands, and do not issue two consecutive `docker compose up -d` calls. The race between the first invocation's removal and the second's create makes Docker assign a transient `<short-id>_jellybot` name that compose never heals; `protect-containers.sh` then fires `CRITICAL: jellybot MISSING_FROM_DOCKER` even though the bot is fine. (The protection script auto-renames transient containers on its next monitor pass as of 2026-06, but the right answer is to never create the transient name in the first place.)

---

## Happy place (mandatory end state)

**Happy place** = `~/coding/jellybot-dev` ready for the next task:

| Check | Expected |
| --- | --- |
| Branch | `main` |
| `git pull --ff-only` | Up to date with `origin/main` |
| `git status` | Clean (no modified/untracked work) |
| Topic branches | Deleted locally after merge |
| Prod | Matches `main` (image + register when commands changed) |

Return here **every time** after shipping. Do not leave work only on a feature branch or only in a merged PR without confirming prod/register.

**If you cannot reach happy place** (merge blocked, dirty tree you did not create, register fails, prod not on latest image): treat as **CRITICAL** — tell the operator immediately with the exact blocker. Do not hand-wave "done."

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

**Cloud Agent VMs must never connect to the Discord gateway.** Only one process may hold `DISCORD_TOKEN` at a time. A second login (local dev, `make dev-refresh`, or an agent running `bun run start`) steals autocomplete acks and breaks `/quote` and `/clip` in production with `Interaction has already been acknowledged`.

On Cloud Agents: run **`bun run ci`** only. Do **not** run `bun run start`, `make dev-refresh`, or Docker compose profiles that start the bot. Do not load production `DISCORD_TOKEN` into the agent environment.

For humans on the dev machine: use a **separate Discord dev application** if you need a live gateway while prod is up. Never point dev at the production bot token while `~/docker/jellybot` is running.

The bot requires live Discord and Jellyfin credentials for a full gateway run (see `.env.example`). Without them, `bun run start` will crash at Jellyfin authentication - this is expected. The health server (`GET /healthz` on port 8080) starts before external auth, so you can verify the Bun + health layer independently.

Key env vars for a live run: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `JELLYFIN_USERNAME`, `JELLYFIN_PASSWORD`, `JELLYFIN_MOVIES_LIBRARY_ID`, `JELLYFIN_TV_LIBRARY_ID`.

### Docker parity

`make test` runs the test suite inside the Docker `test` target for CI parity. Docker is not installed by default on Cloud Agent VMs - install it if needed (see system instructions for Docker-in-Docker setup).

### Pre-commit hook

Husky runs `bun run secrets:staged` (gitleaks) on commit. If gitleaks is not installed locally, the script falls back to the `zricethezav/gitleaks:v8.30.1` Docker image. In Cloud Agent VMs without Docker, the hook may fail - this is non-blocking for development but worth noting.

### Git push from agents (GitHub PAT)

Fine-grained PATs can pass `GET /repos/...` permission checks while still lacking **Contents: Read and write** for `git push` over HTTPS. If `gh api` shows `push: true` but `git push` returns 403, the token is wrong for git operations — use a classic `ghp_` token (or equivalent) with full repo **Contents** scope. OpenACP-jelly uses the host push-capable token for in-container git; see `.env.example` if documented there.

## Cursor Cloud Agents (GitHub)

Label-gated automation only — **not** on every new issue. **`@radgey-cmd`** is triage: they review issues and add **`ai-triage`** or **`ai-safe`** when Cursor should attempt work. The GitHub Action (not Cursor Dashboard PR automations) runs when `radgey-cmd` applies either label.

| Label | Effect |
| --- | --- |
| `ai-triage` | GitHub Action starts Cursor (assess scope, implement if reasonable) |
| `ai-safe` | GitHub Action starts Cursor (low-risk: implement, test, PR) |
| `no-automerge` | Block auto-merge even when checks are green |
| `scope-review-skip` | Skip LLM scope gate (operator override) |

All open PRs targeting **`main`** squash auto-merge when **`ci`** and **`scope-review`** pass. Mission doc: `docs/PRODUCT_SCOPE.md`. Opt out with labels above on the PR or linked issue.
| `human-needed` | Do not use agent automation |

Requires **`CURSOR_API_KEY`** repo secret + Cursor GitHub integration. See `CONTRIBUTING.md`.
