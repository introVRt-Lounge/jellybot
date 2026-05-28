# Issue to deployment

End-to-end path from a GitHub issue to code running in production on the operator host. This is the **label-gated Cursor agent** flow plus the **Watchtower** delivery layer that follows every merge to `main`.

For day-to-day contributor rules, see [CONTRIBUTING.md](../CONTRIBUTING.md). For repo settings and secrets, see [REPO_SETTINGS.md](../REPO_SETTINGS.md).

## At a glance

```mermaid
flowchart TB
  subgraph intake["1 · Intake"]
    A["Open GitHub issue<br/>(Agent task template optional)"]
    B["@radgey-cmd reviews"]
    C{"Label?"}
    A --> B --> C
  end

  subgraph agent["2 · Cursor cloud agent"]
    D["GitHub Action:<br/>cursor-issue-triage.yml"]
    E["Cursor API starts agent<br/>branch ai-triage/fix-issue-N"]
    F["Agent implements + opens PR<br/>Fixes #N in body"]
    G["Issue gets ai-triage-enqueued"]
    C -->|ai-triage or ai-safe| D --> E --> F --> G
    C -->|human-needed| H["Human implements<br/>normal PR flow"]
  end

  subgraph ci["3 · CI & merge"]
    I["Required check: ci<br/>(test, gitleaks, semgrep, audit)"]
    J{"no-automerge or<br/>human-needed?"}
    K["pr-automerge.yml<br/>mark ready + squash auto-merge"]
    L["Wait / manual merge"]
    F --> I
    H --> I
    I --> J
    J -->|no| K
    J -->|yes| L
  end

  subgraph ship["4 · Ship (release + image)"]
    M["PR merged to main<br/>(auto or human)"]
    N["ship-main.yml<br/>pull_request closed + push"]
    O["create-release-if-needed.sh<br/>feat → minor tag, fix → patch"]
    P["Build + push GHCR :latest"]
    M --> N --> O --> P
  end

  subgraph deploy["5 · Production deploy"]
    Q["watchtower-minutely<br/>scope=minutely, label-enable"]
    R["Recreate jellybot container<br/>~/docker/jellybot"]
    P --> Q --> R
  end

  subgraph announce["6 · Discord announce"]
    S["Bot on_ready one-shot"]
    T{"Major/minor<br/>release?"}
    U["Embed to NOTIFICATION_CHANNEL_ID<br/>+ Feature credits from GitHub"]
    V["Patch: silent DB bump only"]
    R --> S --> T
    T -->|yes| U
    T -->|patch| V
  end

  K --> M
  L --> M

  style intake fill:#1e293b,stroke:#64748b,color:#f8fafc
  style agent fill:#312e81,stroke:#818cf8,color:#f8fafc
  style ci fill:#14532d,stroke:#4ade80,color:#f8fafc
  style ship fill:#7c2d12,stroke:#fb923c,color:#f8fafc
  style deploy fill:#713f12,stroke:#fbbf24,color:#f8fafc
  style announce fill:#581c87,stroke:#c084fc,color:#f8fafc
```

## Roles

| Role | Who / what | Responsibility |
| --- | --- | --- |
| **Operator** | You | File issues, set acceptance criteria, merge non-automated PRs, prod `.env` |
| **Triage** | `@radgey-cmd` | Adds `ai-triage` or `ai-safe` when an issue is ready for Cursor |
| **Cursor cloud agent** | [cursor.com/agents](https://cursor.com/agents) | Implements on `ai-triage/fix-issue-N`, opens PR with `Fixes #N` |
| **GitHub Actions** | Workflows under `.github/workflows/` | Enqueue agent, run CI, optional auto-merge |
| **Watchtower** | `watchtower-minutely` on operator host | Pulls new `:latest` and recreates labeled containers ~every 60s |

## Phase 1 — Intake

1. Open an issue describing the goal, constraints, and acceptance criteria. The **Agent task** template (`.github/ISSUE_TEMPLATE/agent_task.yml`) is a good starting point.
2. **Do not** add `ai-triage` yourself. Triage is intentional: `@radgey-cmd` reviews scope and risk first.
3. Guard labels (manual): `ai-investigate-only`, `ai-no-db`, `ai-no-auth`, `human-needed`, `no-automerge`. `human-needed` and `no-automerge` block auto-merge.

## Phase 2 — Agent enqueue

When `@radgey-cmd` adds **`ai-triage`** or **`ai-safe`**:

1. **Workflow:** [`.github/workflows/cursor-issue-triage.yml`](../.github/workflows/cursor-issue-triage.yml)
2. **Trigger:** `issues.labeled` — only from sender `radgey-cmd`, only those two labels.
3. **Action:** POST to Cursor Cloud Agents API (`CURSOR_API_KEY` repo secret).
4. **Branch contract:** `ai-triage/fix-issue-{number}`.
5. **Marker:** label **`ai-triage-enqueued`** on the issue (prevents duplicate starts).
6. **Discord ops:** pipeline stuck/failed posts to **`DISCORD_BOTSPAM_CHANNEL_ID`** (#botspam) from the running bot — never to the feature suggestions / movies channel.

Monitor the run at [cursor.com/agents](https://cursor.com/agents) (Cloud Agents — not Cursor Dashboard **Automations**, which are PR-scoped).

**One-time setup:** Cursor GitHub integration for this repo + `CURSOR_API_KEY` in repo secrets. See [REPO_SETTINGS.md](../REPO_SETTINGS.md#cursor-cloud-agent-label-gated).

## Phase 3 — Pull request & CI

The agent (or a human) opens a PR to `main`. Substantive PRs need:

- Non-empty **Summary** and **Test plan**
- **`Fixes #N`** or **`Closes #N`** when the issue should close on merge

**Required check:** aggregate job **`ci`** (Docker test suite, `bun audit`, gitleaks, Semgrep).

### Auto-merge (all PRs when CI + scope review are green)

[`.github/workflows/pr-automerge.yml`](../.github/workflows/pr-automerge.yml) enables squash **auto-merge** when **all** of:

| Condition | |
| --- | --- |
| Base branch | `main` |
| Head repo | same repository (not a fork) |
| Blockers | PR and linked issues must **not** have `human-needed` or `no-automerge` |
| CI | required checks **`ci`** + **`scope-review`** = success |
| Merge state | mergeable |

Draft PRs are marked ready for review automatically when eligible.

Draft agent PRs are marked **ready for review** automatically. Issues labeled **`ai-triage`** without **`ai-safe`** still need a human squash merge after green CI.

## Phase 4 — Ship (release + container image)

> **Important:** Merges performed by GitHub Actions (`GITHUB_TOKEN`, including auto-merge) **do not emit `push` events**. [`.github/workflows/ship-main.yml`](../.github/workflows/ship-main.yml) therefore triggers on **`pull_request` closed** (merged) as well as human **`push`** to `main`.

When a PR merges to `main`, **Ship main**:

1. Runs [`scripts/create-release-if-needed.sh`](../scripts/create-release-if-needed.sh) — if conventional **`feat:`** commits landed since the last tag, cuts a new **minor** GitHub Release; **`fix:`** only → patch release (Discord-silent on boot).
2. Builds and pushes **`ghcr.io/introvrt-lounge/jellybot`** with tags `:latest`, `:main`, `:sha-<commit>`, and the semver tag when a release was created.

Manual semver tag pushes still build via [`.github/workflows/docker-image.yml`](../.github/workflows/docker-image.yml).

Package: [github.com/introVRt-Lounge/jellybot/pkgs/container/jellybot](https://github.com/introVRt-Lounge/jellybot/pkgs/container/jellybot)

## Phase 5 — Production deploy (automatic)

Production compose lives on the operator host at **`~/docker/jellybot/`** (not the dev checkout). The running service:

```yaml
# ~/docker/jellybot/docker-compose.yml (excerpt)
image: ghcr.io/introvrt-lounge/jellybot:latest
labels:
  - com.centurylinklabs.watchtower.enable=true
  - com.centurylinklabs.watchtower.scope=minutely
```

**`watchtower-minutely`** (server core stack) runs with `--interval 60 --scope minutely --label-enable`. When `:latest` digest changes, Watchtower recreates **`jellybot`** — no manual `docker compose pull` in normal ops.

| Event | Prod container updates? |
| --- | --- |
| Merge to `main` (Ship main runs) | Yes — `:latest` within ~60s after image push |
| Patch GitHub Release only | Deploy yes; Discord announce silent |
| `.env` change only | No — until next recreate (or manual `compose up -d --force-recreate`) |

Dev tree **`~/coding/jellybot-dev`**: use `make dev-refresh` for local container `jellybot-dev`. See [DEVELOPMENT.md](DEVELOPMENT.md).

## Phase 6 — Release announce

On **`ClientReady`** (once per container start), the bot checks GitHub Releases:

1. Compare latest tag to `last_announced_release` in `bot-state.db`
2. **Patch** releases: update DB silently — no Discord post
3. **Major/minor**: optional grace period, summarize notes (OpenAI if configured), post embed to **`NOTIFICATION_CHANNEL_ID`**
4. **Feature credits:** embed field listing `feat:` commits in the release range with GitHub display names (PR author when `(#NNN)` present)

Details: [architecture.md — Production release announce](architecture.md#production-release-announce).

## Human vs agent quick reference

| Step | Agent path | Human path |
| --- | --- | --- |
| Issue filed | Yes | Yes |
| Radgey labels | `ai-safe` or `ai-triage` | Optional |
| Implementation | Cursor cloud agent | Human or agent |
| Merge | Auto after green **`ci`** (unless `no-automerge`) | Same |
| Deploy | Watchtower on `:latest` | Same |
| Announce | On next major/minor boot | Same |

## Troubleshooting

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Label added, no agent | Wrong labeler, workflow error, missing `CURSOR_API_KEY` | Actions → **Cursor Issue Triage**; issue labels |
| Agent runs, no PR | Still working or failed in Cursor UI; **issue closed before bless** | [cursor.com/agents](https://cursor.com/agents); `/feature status`; issue pipeline comment |
| PR green, not merging | `no-automerge` / `human-needed`, fork PR, or CI still pending | Actions → **PR auto-merge** |
| Merged, prod unchanged | Ship main did not run (pre-fix) or Watchtower | Actions → **Ship main**; `docker logs watchtower-minutely` |
| Merged, no Discord post | Patch-only release or announce already recorded | Check latest GitHub Release semver; `bot-state.db` |
| **Stuck at `building` in Discord** | No pipeline telemetry before #85 | `/feature status`; GitHub issue **Jellybot pipeline status** comment; Actions → **Feature pipeline watchdog** |

## Pipeline observability (#85)

Every blessed suggestion should be traceable end-to-end:

| Layer | What it records |
| --- | --- |
| **SQLite** `feature_pipeline_events` | Stage transitions from bot reconcile loop |
| **Discord** `/feature status` | Live checklist + blocker for maintainers |
| **GitHub issue comment** | Auto-updated `jellybot-pipeline-status` table (watchdog workflow) |
| **GitHub issue comment** | `jellybot-pipeline-agent-id:` when Cursor agent starts |
| **GitHub issue comment** | `jellybot-agent-conversation` when agent finishes (**Cursor agent conversation archive** workflow) |
| **Actions** | **Feature pipeline watchdog** updates GitHub issue comments only (no Discord webhook) |

**#82 class failure:** branch pushed, no PR, issue already closed — stage `awaiting_pr`, blocker explains manual PR or reopen issue.

## Related files

| File | Purpose |
| --- | --- |
| `.github/workflows/cursor-issue-triage.yml` | Start Cursor agent from issue labels |
| `.github/workflows/cursor-agent-conversation.yml` | Poll agent; post `/conversation` transcript to issue |
| `scripts/archive-cursor-agent-conversation.sh` | Archive script (also `workflow_dispatch` with `skip_poll=true` for backfill) |
| `.github/workflows/pr-scope-review.yml` | LLM scope + quality gate (`scope-review`) |
| `.github/workflows/pr-automerge.yml` | Auto-merge when **`ci`** + **`scope-review`** green |
| `.github/workflows/ci.yml` | Required `ci` gate |
| `.github/workflows/ship-main.yml` | Release tag + GHCR image after merge to `main` |
| `.github/workflows/docker-image.yml` | Manual semver tag image builds |
| `scripts/create-release-if-needed.sh` | Conventional-commit semver release helper |
| `deploy/prod/docker-compose.yml` | Production compose template |
| `src/release/release-announcer.ts` | Discord release embeds |
| `docs/DEVELOPMENT.md` | Dev vs prod trees |
| `docs/architecture.md` | Data paths, announce config |
