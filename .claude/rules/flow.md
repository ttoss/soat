# Flow

The maintainers' work in this repo lives in the Flow project
`proj_vx1h3xshaq`, with `naturali-ai/naturali.ai`, which holds the project's
parameters (`.claude/flow.md`) and pins the `flow` skills (`skills-lock.json`):
add that repo to read them. A maintainer's session follows
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
- A soat change reaches production through naturali's batched release, so its
  task's `after_integration` is `release`, never `close`, and its merge puts it
  behind the bump as naturali's `.claude/flow-release.md` says.
- Friction with a skill, GTF or a Flow tool → `flow-friction`, then continue.
