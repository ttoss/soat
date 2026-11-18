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
  `.claude/flow-validation.md`, usually `merged`. Which soat changes also get
  an API-validation task at handoff, and how it is written, is that file's
  § Every task that changes the API is validated on the API.
- A change that leaves anything to remove later (a shim, fallback or dual read,
  deprecated route or field, column or table kept a release, feature flag,
  migration-only path, workaround awaiting an upstream fix) files one removal
  task at its handoff: tags the repo, `removal` and the area; the title names
  what goes; the body lists the files, symbols, columns and tests to delete;
  `blocks`-held by what must happen first, else `active`; `derived_from` the
  task that created it. The change's description names its URL. A removal task
  is never `incubated` and never closes before the code is gone.
- Friction with a skill, GTF or a Flow tool → `flow-friction`, then continue.
