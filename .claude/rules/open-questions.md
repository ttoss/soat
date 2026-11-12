# Open Questions

An open choice (design, option A vs B, ambiguity) follows the workflow's
[Decisions default](https://raw.githubusercontent.com/ttoss/ttoss/main/docs/website/docs/engineering/workflow/parameters.md#the-decisions-default):
what it reserves to a person, dominance and long-term tests, trade format, the
`Q`/`A` record in the PR description. A choice the task, a standing decision or
a rule already makes is not open: implement it.

This project adds:

- **Reserved to a person**, beyond the default: permissions and privacy.
  Product intent covers language, theme, scope, stack and business rules.
- **Consolidation is decided.** Consolidate duplicated knowledge
  (`duplicated-knowledge.md`); leaving it is not an option.
- **Breaking and large changes do not weigh** in a trade while the product is
  v0: never list a public contract change or a change's size under what an
  option worsens. The breaking-change mechanics stay (`!` in the title, the
  changelog entry).
- **A proposal names the closed decisions it touches.** Before recommending,
  `list-tasks` with `kind=decision` and the subject's words; the proposal says
  which closed decision each option keeps, refines or reverses.
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
