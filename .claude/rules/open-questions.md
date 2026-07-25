# Open Questions Gate

Every open question raised while implementing — a design choice, an "option A vs option B", an ambiguity in the task — must be run through the two Guardian tests below **before** being forwarded to the user. A question that either test resolves is answered on the spot and recorded; only questions that survive both tests are forwarded.

The criteria come from the Guardian skill installed at `.claude/skills/guardian/` (see its `SKILL.md` **Fix classification** section and `reference/methodology.md` for the 8 dimensions). This rule applies the criteria to open questions during any implementation; it does not require running `/guardian` itself.

## Test 1 — Pareto optimum (dominant option)

Apply Guardian's fix classification to the options:

- An option is **dominant** (a Pareto improvement) when it improves at least one of the 8 methodology dimensions and the **"worsens nothing"** claim was actually checked in this session — name what was checked. An unverified premise the option depends on is a cost, never neutral.
- If exactly one option is dominant over the alternatives → **choose it**. The question is answered; do not forward it.
- When uncertain whether an option worsens something, it is **not** dominant — fall through to Test 2.

## Test 2 — Best for the long term

If no option is dominant, judge the options against the project's long-term health using Guardian's structural criteria:

- **Durability ladder** — prefer the option whose guarantees live higher on the ladder: deterministic enforcement (types, schemas, tests, CI) > path-scoped context > procedure > prose.
- **Debt containment** — accept only debt that is modular, visible, observable, and cheap to repay. An option that introduces invisible or systemic debt loses.
- **Pattern hygiene** — an option that replicates or strengthens an existing antipattern loses; agents replicate whatever they see.
- **Boundary integrity** — an option that erodes package, layer, or ownership boundaries loses.

If one option clearly wins on these criteria → **choose it**. The question is answered; do not forward it.

## Forwarding — only what the two tests do not satisfy

Forward a question to the user only when it falls into one of these classes:

| Class | Why it forwards |
|---|---|
| Genuine trade | Every option worsens something another improves, and no clear long-term winner exists |
| Unverifiable premise | The decision hinges on a fact that cannot be checked in this session |
| Product intent | Language, theme, scope, stack, business rules — humans own these (Guardian's Authority section); never auto-resolve them |
| High-risk class | Security, auth, permissions, privacy, billing, data loss/deletion, migrations, public API contracts — always forwarded, even when a test appears to resolve it |

When forwarding, use the trade format: state each option, what it worsens, the open premise the choice depends on, and a recommendation with its activation condition (`worth doing when <pain observed>`).

## Recording

Every self-answered question must be recorded where the work is delivered (final response and/or PR description):

```txt
Q: <the question>
A: <chosen option> — resolved by <pareto|long-term>; checked: <what was verified this session>
```

A question resolved silently — without a recorded entry — does not count as resolved.
