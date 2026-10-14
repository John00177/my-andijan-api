---
name: session-handoff
description: Start and end every My Andijan work session. Use at the start of any task in myandijan-frontend or my-andijan-api, and before finishing a session that opened or merged a PR, changed a phase, made a decision, touched production, or found a blocker.
---

# Session handoff — My Andijan

The owner (John) is not an engineer and may switch between AI tools. This skill makes every session start from the same truth and end with that truth updated. The full rules are in `docs/my-andijan/intelligence/MEMORY_CONTRACT.md` (frontend repo); this skill is the short procedure. Link to it, don't restate it.

Canonical memory lives only in the frontend repo:
`D:\My-Andijan-Work\myandijan-frontend\docs\my-andijan\` (GitHub `John00177/myandijan-frontend`).

## A. Start of session (keep it cheap)

1. For each repo the task touches: `git fetch`, `git status -sb`, `git log --oneline -5 origin/main`. GitHub beats any document.
2. Read **only the top section** of `CURRENT_STATE.md`. Then read **one** domain document if the task needs it (routing: `intelligence/PROJECT_MEMORY.md` §3). Do not read history, `SESSION_CONTEXT.md` or old sections unless you need a specific "why".
3. If the task touches a locked rule, the schema or architecture: read the relevant `DECISIONS.md` entries first.
4. Give the owner a 3-line orientation before working:
   - **Phase now:** …
   - **Blockers / owner decisions open:** …
   - **This session will:** …
5. If `CURRENT_STATE.md` and Git disagree, say so and trust Git.

## B. During the session

- Do not reread files you already read unless they changed.
- If the task creates or edits a migration → use the `migration-safety` skill.
- If the task touches deploy, Railway, or merging to API `main` → use the `api-release` skill.

## C. End of session

1. **Is this a major session?** (MEMORY_CONTRACT §4.1: a PR opened or merged, phase status changed, a decision, production changed or verified, a blocker or material bug found.) If no → skip to step 4.
2. Update canonical memory in a **docs PR in `myandijan-frontend`** (a frontend-only change may carry it in its own PR), following MEMORY_CONTRACT §4.2–4.3:
   - `CURRENT_STATE.md` top section: **replace** it with *now*; move the old block below, labelled `(historical — superseded YYYY-MM-DD)`.
   - New decision → new `D-NN` in `DECISIONS.md` (append only).
   - Blockers and who unblocks them; the single **Next action**.
   - Every claim dated, with evidence (SHA, PR, CI run, deployment id). Prefer `UNKNOWN` to a guess.
   - Never "deployed/live" without a deployment record for that exact SHA (MEMORY_CONTRACT §5).
3. No secrets anywhere: name variables, never values.
4. Finish with an **owner summary** in plain English, at most 8 lines, in this shape (the owner's dashboard is refreshed from it and from `CURRENT_STATE.md`):

```
DONE:      what changed (PR numbers)
STATE:     phase + one line
BLOCKERS:  open blockers, each with who unblocks it
OWNER:     decisions John must make (or "none")
NEXT:      the single next action
PROD:      "no production change" or exactly what changed, with evidence
```
