# Open Questions

An open choice (design, option A vs B, ambiguity) follows the workflow's
[Decisions default](https://raw.githubusercontent.com/ttoss/ttoss/main/docs/website/docs/engineering/workflow/parameters.md#the-decisions-default):
what it reserves to a person, its dominance and long-term tests, the trade
format, the `Q`/`A` record in the PR description. A choice the task, a standing
decision or a rule already makes is not open: implement it.

This project adds:

- **Reserved to a person**, beyond the default: permissions and privacy.
  Product intent covers language, theme, scope, stack and business rules.
- **Dominance** is measured on these dimensions; "worsens nothing" names which
  were checked in the run.

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
