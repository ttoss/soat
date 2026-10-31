# Open Questions Gate

Open choices follow the workflow's
[Decisions default](https://raw.githubusercontent.com/ttoss/ttoss/main/docs/website/docs/engineering/workflow/parameters.md#the-decisions-default):
Test 1 (dominance), Test 2 (long term), the trade format, the `Q`/`A` record.
This repo sets:

- **A dominant option is taken, whatever the class**, high-risk included.
- **Test 1 checks these dimensions**, naming what was checked; an unverified
  premise is a cost.

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

- **High-risk** is the default's reserved classes plus permissions and privacy;
  forwarded even when Test 2 has a winner.
- **Product intent** includes language, theme, scope, stack and business rules.
- A choice the task, a standing decision or a rule already makes is not an open
  question: implement it.
- **Record** each self-answered choice in the final response and/or PR
  description:

  ```txt
  Q: <question>
  A: <chosen option> — resolved by <pareto|long-term>; checked: <what was verified>
  ```
