# Open Questions Gate

Run every open question (design choice, option A vs B, ambiguity) through two
tests before forwarding it to the user. **A Pareto optimum is decided by you,
never forwarded — whatever the class, high-risk included.**

## Test 1 — Pareto optimum

An option is dominant when it improves at least one of these dimensions and you
checked in this session that it worsens nothing (name what was checked; an
unverified premise is a cost). Exactly one dominant option → choose it and
record it; do not ask. Uncertain → Test 2.

| Dimension | Asks |
| --- | --- |
| Context compressibility | Can the change be explained through a small, bounded context? |
| Executable specification | Is the intent in tests, types, schemas or validators, not only prose? |
| Co-located specs | Where code cannot express intent, is it in a spec beside the artifact? |
| Verification loop | Can a future agent run a fast, faithful check of it? |
| Boundary integrity | Are package, layer, ownership and public-API boundaries kept and enforced? |
| Pattern hygiene | Does it avoid copying or strengthening a bad local pattern? |
| Debt containment | Is any debt modular, visible, observable and cheap to repay? |
| Instruction hygiene | Do instruction surfaces stay defined once, consistent and accurate? |

## Test 2 — Long-term health

Prefer: deterministic enforcement (types, schemas, tests, CI) > path-scoped
context > procedure > prose; debt that is modular, visible, observable, cheap to
repay; no replication of an existing antipattern; intact package/layer/ownership
boundaries. A clear winner → choose it.

## Forward only

Only a question Test 1 did not settle:

| Class | Why |
|---|---|
| Genuine trade | Every option worsens something another improves |
| Unverifiable premise | Hinges on a fact not checkable this session |
| Product intent | Language, theme, scope, stack, business rules |
| High-risk | Security, auth, permissions, privacy, billing, data loss, migrations, public API contracts — forwarded even when Test 2 has a winner |

Forward in trade format: each option, what it worsens, the open premise, a
recommendation with its activation condition (`worth doing when <pain>`).

A choice the task, a standing decision or a rule already makes is not an open
question: implement it. A forwarded question holds only the work it decides
(GTF-N6); other work continues.

## Record

Every self-answered question goes in the final response and/or PR description:

```txt
Q: <question>
A: <chosen option> — resolved by <pareto|long-term>; checked: <what was verified>
```
