## PR babysit gate (mandatory)

**Never declare PR work "done", "ready to merge", or "shipped" while an open PR still has unresolved review feedback.**

`gh pr checks` is **necessary but not sufficient**. Required checks can be green while CodeQL, Code Quality, audit bots, and human reviewers have **unresolved inline threads** from earlier commits.

### Before saying done (any open PR)

1. Read and follow **`babysit`** + **`github-operations`** skills.
2. **Three-dimension clean** — all must pass unless the operator explicitly waives a specific thread in chat:
   - **Checks:** required status checks green (or documented waiver with reason).
   - **Threads:** **zero** unresolved review threads (`reviewThreads` where `isResolved == false` — query via GraphQL; `gh pr checks` does not show these).
   - **Latest bot verdict:** triage the bot review tied to **current `HEAD`** (not a stale SHA from a prior push).
3. **Triage every unresolved thread:** fix valid findings → push → wait for fresh bot run → re-run step 2. Push back with technical reasoning when wrong. Resolve threads on GitHub when addressed.
4. Report unresolved blockers explicitly — do not hand-wave "CI is green."

### Forbidden "done" states

- Celebrating one check (e.g. smoke) while CodeQL / Code Quality threads remain open.
- Reading only `gh pr checks` and skipping inline review comments.
- Pushing fixes without re-querying unresolved thread count.

### Quick probe (replace OWNER, REPO, PR)

```bash
gh api graphql -f query='
query { repository(owner:"OWNER", name:"REPO") {
  pullRequest(number:PR) {
    reviewThreads(first:100) {
      nodes { isResolved comments(first:1) { nodes { author { login } path body } } }
    }
  }
}}' --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | {author:.comments.nodes[0].author.login, path:.comments.nodes[0].path, snippet:.comments.nodes[0].body[0:80]}]'
```

Empty array `[]` = thread gate passed. Non-empty = **not done**.

**Canon:** merge this block into `AGENTS.md` on every repo using **perfect-github-setup-and-operation**. Source file in jellybot: `docs/agent-snippets/AGENTS.pr-babysit.snippet.md` — sync copy to `~/coding/skills/perfect-github-setup-and-operation/` on the operator host.
