# No Historical Narration

- Docs, comments and messages describe **what SOAT is now** — never what it
  was, what changed, or when. SOAT is pre-v1; readers have no old behaviour to
  unlearn.
- History belongs in git, commit messages and pull requests; keep the working
  tree in the present tense.

## Delete on sight

| Pattern | Example |
|---|---|
| What it used to do | `used to`, `no longer`, `previously`, `formerly`, `is now`, `was renamed`, `the old <thing>` |
| The story of a change | "which made the baseline move", "this replaces the Z approach", "measured false", "the first draft" |
| An issue or PR as the reason | `(#1234)`, `Refs #1234`, "the defect #1234 measured" |
| A dated or versioned aside | "as it stood at v3", "before the ledger existed", "since the rewrite" |
| Work narration | "added in this PR", "kept for now", "TODO", "left as is" |

## Keep the fact, drop the narrative

| Instead of | Write |
|---|---|
| The corpus used to read module docs, which made the baseline move | The corpus is self-contained, so a docs edit does not move the baseline |
| Never a third ranked list: a per-store list is the defect #1272 measured | Never a third ranked list: a per-store list lets a store claim slots by position rather than by what its rows are worth |
| This used to be `403`; #1029 changed it to `404` | A refusal is `404` when the caller's policies name no project |
| It used to hold the twins apart — measured false | The twins share one store, which makes the kind a test of ranking, not of scope |

## A present-tense reason is not history

- Keep a why that **still holds** (constraint, invariant, consequence); state
  it directly, never as the ticket where it was found:

```ts
// Raw SQL because the column is managed: Sequelize stamps the current time
// over an explicit `updatedAt` on every write path.        ← keep
// Raw SQL because #1102 broke the model path.              ← delete
```

- A conditional ("a pointer here _would_ make the baseline move") is present
  tense.

## Where it applies

| Surface | Rule |
|---|---|
| `packages/website/docs/**` | No history at all |
| `ERROR_CODES` descriptions, `ERROR_RESOLUTIONS` hints, OpenAPI descriptions | User-facing; no issue numbers |
| `src/**` and `tests/**` comments and JSDoc | Present-tense reason only, no issue number |
| `.claude/rules/**`, `CLAUDE.md` | A direct instruction only: no provenance, decision ids, task links, PR numbers, history, measurements or narrative. The Flow graph holds the record |
| Commit messages, PR descriptions | History belongs here, and only here |

Naming an existing file, test or constant (`pinned by
`moduleCeiling.test.mjs``) is not history; naming a ticket is.
