---
paths:
  - "packages/website/**"
---

# Website

## Branding

Follow `.claude/skills/soat-design/` (`readme.md`, `guidelines/`, `tokens/`):
palette, typography, visual language, tone (technical, confident, concise).
The canonical descriptor is **"SOAT — open-source infrastructure for
production-ready AI agents."**, verbatim wherever the project describes itself
(site tagline, JSON-LD, `package.json` descriptions, MCP server description,
GitHub and Docker Hub). `tests/harness/packageMetadata.test.mjs` enforces the
package half.

## Structure

Read `packages/website/README.md` first. New module pages go in the matching
Platform category and new tutorials in the matching tutorial category in
`sidebars.ts`.

## Module pages (`packages/website/docs/modules/<module>.md`)

```
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Module Name
{one sentence}

## Overview             2–5 sentences, cross-links; ends with the Permissions Reference line
## Related Tutorials    only when tutorials exist: `- [Name - step N (Action)](path)`
## Data Model           always: one table per resource (Field, Type, Description)
## Key Concepts         optional: `###` per non-obvious behavior
## Configuration        only if the module reads env vars (Environment Variable, Required, Description)
## Examples             always: one <Tabs groupId="client"> per key operation, CLI/SDK/curl, at least create + one read
```

Overview ends with:

> See the [Permissions Reference](./permissions.md) for the IAM action strings for this module.

No `## Permissions` section. Define once, reference everywhere: never
reproduce another module's data model or rules (tool types → Tools, trace
ancestry → Traces, IAM policy format → IAM, user model → Users).

## Prose

Docs state facts; they do not argue for them. Before a page lands, cut:

- Rationale and motivation paragraphs. Keep the rule, drop the argument; one
  clause of "why" is enough when it is a hidden constraint.
- History and narration: "used to", "before X shipped", "this page explains",
  "as we saw", "in other words".
- Restatements of an adjacent table, or of another section (link instead).
- Another module's concepts. Link to its page; never re-define them.
- Hedging, marketing adjectives, rhetorical questions, italics for emphasis,
  em-dash asides that add no fact, admonitions that restate nearby text.
- Related Tutorials entries longer than the link plus a short clause.

Prefer a table or bullet list over a paragraph that enumerates cases. Plain
declarative sentences. A `### Key Concept` is one behavior: what it does, when
it applies, what it returns on refusal. If a section reads well as a blog post,
it is too long.

Never cut a fact: field, enum value, status or error code, env var, flag,
default, limit, unit, endpoint link, heading text (anchors) or code block.

## Permissions page is generated

Actions live in `packages/server/src/permissions/<module>.json`. Regenerate
`docs/modules/permissions.md` with
`pnpm --filter @soat/website generate-permissions-page`; never edit it by hand.
`iam.md` explains the format and links there without listing actions.

## Drift guardrails (CI)

- `pnpm docs-lint` (`scripts/docs-lint.mjs`): `as any` / `as unknown`,
  camelCase path params (use `{param_name}`), stale-term denylist. Reintroducing
  a term legitimately means removing its denylist entry, not working around it.
- `tests/unit/tests/lib/openapiExamplePrefixes.test.ts`: every id example in
  the specs uses a `PUBLIC_ID_PREFIXES` prefix
  (`packages/postgresdb/src/utils/publicId.ts`); so must docs (`agent_`,
  `actor_`, `trace_`, `mem_entry_`).

Never document an action, endpoint, field or behavior that does not exist in a
router, spec or permissions JSON. Keep the Docusaurus build clean.
