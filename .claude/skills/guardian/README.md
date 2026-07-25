# Guardian — an Agent Skill

Guardian keeps a repository in **basis-form**: its structure, code, scripts, and instructions written as a *basis* (the axes of the decision space), not as enumerated *cases*. It reviews and improves a repo's AI-readiness and migrates quality rules from prose into deterministic enforcement (lint, types, tests, CI, hooks).

Cross-agent — built on the [Agent Skills](https://agentskills.io) standard. `reference/bindings.md` isolates the Claude Code platform mechanics — the primary file to swap when porting.

## Install

```bash
npx skills add ttoss/skills --skill guardian
```

Scope the agent to avoid duplication. Without `--agent`, the CLI mirrors the skill into every supported agent's directory (e.g. both `.claude/skills/` and `.agents/skills/`). For Claude Code only:

```bash
npx skills add ttoss/skills --skill guardian --agent claude-code
```

Only install unscoped if the target repo also runs another agent (Copilot/Cursor/etc.) that should read the skill from its own directory.

## Use (Claude Code)

Manual only (`disable-model-invocation`). The first token selects the mode:

```
/guardian <mode> [task | path | finding | surface]
```

| Mode      | Does                                                                  | Argument                          | Writes              |
| --------- | --------------------------------------------------------------------- | --------------------------------- | ------------------- |
| `plan`    | task → bounded, verifiable plan (axes, scope, risk, tests)            | task                              | no                  |
| `review`  | review the current diff before commit (findings + correction prompt; a PASS-class verdict ends with a PR package) | optional path narrows the diff | no |
| `audit`   | bounded repo-health audit of a scope                                  | path/package/domain (required)    | no                  |
| `improve` | fix one approved finding; promote case→basis and prose→enforcement    | one finding: `G-NNN` or durable key (required) | yes         |
| `docs`    | review/improve instruction surfaces                                   | submode [+ surface file]          | submode-dependent   |

`docs` submode (second token, default `review`):

| Submode   | Does                                                                            | Writes |
| --------- | ------------------------------------------------------------------------------- | ------ |
| `review`  | with a surface: diagnose that file; without: full review of all surfaces (Deep) | no     |
| `improve` | edit one approved surface (incl. JSDoc/TSDoc blocks)                            | yes    |

The contracts — routing, action axis (read-only vs write), severity, verdicts, finding format — are defined once in [`SKILL.md`](SKILL.md), the runtime source of truth; this README only mirrors the tables above, and CI validates they stay in sync. What the tables don't show: every finding is a scannable headline (severity · fix-class · id · dimension · rung) over an indented detail tier, carries a durable key that survives sessions (`improve` accepts a `G-NNN` or the key), and writes always target one approved unit at a time.

Typical loop — the ratchet that makes it pay off:

```
/guardian plan <task>      # plan before code
/guardian review           # findings on the diff (a PASS ends with a PR package)
/guardian improve <id>     # fix one finding → durable enforcement
```

## Layout

- [`CONCEPT.md`](https://github.com/ttoss/skills/blob/main/docs/guardian/CONCEPT.md) — what Guardian is and why, independent of any host agent or file format; read this to understand the thesis or to port Guardian to a new platform (lives in the source repo under `docs/guardian/`, not shipped with the skill)
- `SKILL.md` — router: identity, rules, severity, mode routing
- `reference/` — `basis-form` (the standard), `methodology` (dimensions + instruction-artifact syndromes), `baseline` (discovery + reconciliation), `enforcement` (promotion + checks), `bindings` (Claude Code specifics)
- `modes/` — `plan`, `review`, `audit`, `improve`, `docs` (each with a worked example)

## License

MIT
