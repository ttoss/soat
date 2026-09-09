# Open Questions Gate

Run every open question (design choice, option A vs B, ambiguity) through two
tests before forwarding it to the user. Criteria come from
`.claude/skills/guardian/` (`SKILL.md` **Fix classification**,
`reference/methodology.md`); running `/guardian` itself is not required.

## Test 1 — Pareto optimum

An option is dominant when it improves at least one of the 8 methodology
dimensions and you checked in this session that it worsens nothing (name what
was checked; an unverified premise is a cost). Exactly one dominant option →
choose it. Uncertain → Test 2.

## Test 2 — Long-term health

Prefer: deterministic enforcement (types, schemas, tests, CI) > path-scoped
context > procedure > prose; debt that is modular, visible, observable, cheap to
repay; no replication of an existing antipattern; intact package/layer/ownership
boundaries. A clear winner → choose it.

## Forward only

| Class | Why |
|---|---|
| Genuine trade | Every option worsens something another improves |
| Unverifiable premise | Hinges on a fact not checkable this session |
| Product intent | Language, theme, scope, stack, business rules |
| High-risk | Security, auth, permissions, privacy, billing, data loss, migrations, public API contracts — always forwarded |

Forward in trade format: each option, what it worsens, the open premise, a
recommendation with its activation condition (`worth doing when <pain>`).

## Record

Every self-answered question goes in the final response and/or PR description:

```txt
Q: <question>
A: <chosen option> — resolved by <pareto|long-term>; checked: <what was verified>
```
