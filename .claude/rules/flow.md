# Flow

Work in this repo lives in the Flow project `proj_vx1h3xshaq`, with
`naturali-ai/naturali.ai`; add that repo to read the project's parameters
(`.claude/flow.md`) and the pinned `flow` skills (`skills-lock.json`). A
maintainer's session follows
[Get Things Flowing](https://flow.ttoss.dev/docs/agents/protocol.md), the
[delivery process](https://raw.githubusercontent.com/ttoss/ttoss/main/docs/website/docs/engineering/workflow/process.md)
and those parameters, started by `/flow` or not:

- Work through a task: the one you were given, or one you find (`list-tasks`
  with `query`) or propose before changing anything. Your run holds the task
  (GTF-S8).
- Apply the parameters on the way: `Before proposing` before the change;
  `Merge rule`; `Intake` for what you notice; `Decisions` for open choices.
- The change carries the task's URL and the tasks it settles; before you stop,
  the task carries the change as an `implements` reference,
  `after_integration` (what integrating leaves), and its wait on the gates.
  After the verdict, the tick writes the task.
- A soat task closes on the validation its brief names from naturali's
  `.claude/flow-validation.md`, usually `merged`. Every soat code change is
  also validated on the real naturali API: at handoff the child writes an
  API-validation task behind naturali's bump (`.claude/flow-release.md`).
- Friction with a skill, GTF or a Flow tool → `flow-friction`, then continue.
