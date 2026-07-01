# Perfect GitHub — PR babysit snippet sync

When bootstrapping or reconciling a repo with **perfect-github-setup-and-operation**, merge **both** AGENTS snippets into `AGENTS.md`:

| Snippet | Purpose |
|---------|---------|
| `AGENTS.issue-gate.snippet.md` | Issues-first / no ticket no workee |
| `AGENTS.pr-babysit.snippet.md` | PR comment triage before "done" |

**jellybot copy:** `docs/agent-snippets/AGENTS.pr-babysit.snippet.md`

**Operator host sync** (skills canon):

```bash
cp docs/agent-snippets/AGENTS.pr-babysit.snippet.md \
  ~/coding/skills/perfect-github-setup-and-operation/AGENTS.pr-babysit.snippet.md
# then run skills-sync if your host mirrors to ~/.cursor/skills
```

## perfect-github SKILL.md patches (manual until synced)

Add to **Issues-first agent workflow** section:

> 4. Merge [`AGENTS.pr-babysit.snippet.md`](./AGENTS.pr-babysit.snippet.md) into `AGENTS.md` (PR babysit gate — zero unresolved review threads before "done").

Add to **Tier H** (CodeQL + Code Quality):

> Agents must **babysit** inline findings — enabling CodeQL/Code Quality without the babysit gate in `AGENTS.md` produces green `ci` with unresolved security/quality threads (false "done").

Add to **Acceptance criteria (Both)**:

> - [ ] **`AGENTS.md`** includes PR babysit block (zero unresolved `reviewThreads` before declaring merge-ready)

Add to **Relationship to other skills**:

> | **babysit** | Mandatory before "done" on open PRs; pairs with github-operations three-dimension check |

Add to **Anti-goals**:

> - Declaring PR work done after `gh pr checks` only, without triaging unresolved CodeQL/Code Quality/audit inline threads

## feature-branch-workflow SKILL.md patch

Insert as **step 7.5** (after CI, before repo hygiene):

```markdown
7.5. **PR babysit (mandatory before "done")**  
   Follow **`babysit`** skill. Do **not** report merge-ready or task-complete while unresolved inline review threads exist (`reviewThreads` / `isResolved == false`).  
   `gh pr checks` does not surface CodeQL, Code Quality, or audit-bot threads.  
   After every push: wait for bot review on current `HEAD` → triage → fix valid → resolve threads → re-query until `[]`.
```

Add to **Friction mode / Contract violations**:

> - Declaring work complete while PR has unresolved CodeQL, Code Quality, or audit inline threads; reporting "smoke green" or "CI green" without thread gate

Copy `docs/agent-snippets/pr-babysit-gate.mdc` → `.cursor/rules/pr-babysit-gate.mdc` — `alwaysApply: true`. (`.cursor/` is gitignored in jellybot; tracked canon lives under `docs/agent-snippets/`.)
