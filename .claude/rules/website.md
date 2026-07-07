---
paths:
  - "packages/website/**"
---

# Website Instructions

Agents working on the website package must adhere to the following guidelines to maintain consistency, branding, and functionality.

## Branding Compliance

- **Always follow the `soat-design` skill**: All content, design, and visual elements must strictly adhere to the SOAT brand system defined in the `.claude/skills/soat-design/` skill (see its `readme.md`, `guidelines/`, and `tokens/`). This includes color palettes, typography, visual language, and tone of voice.
- **Brand Consistency**: Ensure all new content, pages, and components align with the infrastructure-for-AI-apps positioning and the Vector Galaxy logo concept.

## Documentation Structure

- **Read README.md for Website Details**: Before making any changes, thoroughly read the packages/website/README.md file to understand the current website structure, navbar organization, and sidebar conventions.
- **Maintain Structure**: When adding new documentation, follow the established structure outlined in the README.md, including the navbar sections (Platform, Resources, MCP, API, Blog) and sidebar organization for resources.

## Content Guidelines

- **Tone and Voice**: Write in a technical, confident, and concise manner as specified in the `soat-design` skill. Avoid unnecessary jargon while maintaining technical accuracy.
- **Navigation**: Ensure all new pages and sections are properly integrated into the navigation system and sidebars.

## Module Documentation

Module docs live at `packages/website/docs/modules/<module>.md`. Each page must describe:

- What the module does (overview)
- Key concepts and data model
- Any roles or access rules that apply

**Canonical section order:**

```
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Module Name
{one-sentence description}

## Overview

## Related Tutorials    [only when tutorials exist]

## Data Model           [always]

## Key Concepts         [optional — omit if trivial]

## Configuration        [only if the module requires env vars]

## Examples             [always]
```

### Section rules

**`# Module Name` line:** One sentence only — the resource name and its primary purpose. No verbs like "provides" or "manages" unless necessary.

**`## Overview`:** 2–5 sentences expanding the one-liner. State the main use cases and cross-link closely related modules. End with:
> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

**`## Related Tutorials`:** Bullet list of `- [Tutorial name - step N (Action)](path)` links. Include only when at least one tutorial covers this module.

**`## Data Model`:** One table per resource type exposed by the module. Columns: `Field`, `Type`, `Description`. Brief prose below the table only for non-obvious relationships (e.g. uniqueness constraints, nullable semantics). Never add a Data Model section for a resource defined in another module — reference it with a link instead.

**`## Key Concepts`:** Named `###` subsections for non-obvious behaviors (business rules, algorithms, invariants, lifecycle transitions). Omit entirely for simple CRUD modules. Never reproduce another module's data model or behavioral rules here — cross-reference with a link.

**`## Configuration`:** Table with columns `Environment Variable`, `Required`, `Description`. Include only when the module reads runtime environment variables.

**`## Examples`:** One `<Tabs groupId="client">` block per key operation. Always include CLI, SDK, and curl tabs (in that order). Show at minimum: the create/primary operation and one read operation.

### Cross-referencing rules

1. **Define once, reference everywhere.** If concept X is fully documented in module Y, write one sentence pointing there: `See [X](./y.md#anchor).` Do not summarise or repeat the definition.
2. **Tool types** (http, client, mcp, soat) are defined in [Tools](./tools.md). Agents references them but does not re-document them.
3. **Trace ancestry model** is defined in [Traces](./traces.md#trace-ancestry-model). Agents references it but does not re-document it.
4. **IAM policy format and evaluation rules** are defined in [IAM](./iam.md). Policies and API Keys reference them but do not re-document them.
5. **User data model** is defined in [Users](./users.md). IAM references it but does not re-document it.

Do **not** add a `## Permissions` section to module docs. Instead, add this line at the end of the overview or as a callout:

> See the [Permissions Reference](./permissions.md) for the IAM action strings for this module.

### Permission actions are now auto-generated

Permission action strings live in `packages/server/src/permissions/<module>.json`, one file per module. The Permissions Reference page (`packages/website/docs/modules/permissions.md`) is auto-generated from those JSON files by running:

```bash
pnpm --filter @soat/website generate-permissions-page
```

When a new permission action is added to the server:

1. Add an entry to `packages/server/src/permissions/<module>.json`.
2. Regenerate the page: `pnpm --filter @soat/website generate-permissions-page`.
3. Do **not** manually edit `permissions.md` — it will be overwritten.

`iam.md` explains the `resource:Action` format and wildcards but does **not** list individual actions — it links to the Permissions Reference page instead.

## Drift Guardrails

Two automated checks enforce doc/spec ↔ runtime consistency and run in CI. Keep docs passing both:

1. **`scripts/docs-lint.mjs`** (`pnpm docs-lint`, wired into `pr.yml`) scans `packages/website/docs` for: forbidden casts (`as any` / `as unknown`), camelCase path params (`:paramName` — use snake_case `{param_name}`), and a stale-term/wrong-prefix denylist. When a renamed term is legitimately reintroduced, remove its entry from the denylist in that script — do not work around the check.
2. **`packages/server/tests/unit/tests/lib/openapiExamplePrefixes.test.ts`** asserts every id-shaped `example:` value in `packages/server/src/rest/openapi/v1/*.yaml` starts with a prefix the runtime actually generates.

The single source of truth for public-ID prefixes is `PUBLIC_ID_PREFIXES` in `packages/postgresdb/src/utils/publicId.ts`. Every ID example in docs and OpenAPI specs must use those prefixes (e.g. `agent_`, `actor_`, `trace_`, `mem_entry_`, not `agt_`, `act_`, `trc_`, `me_`). Docs must never document an action, endpoint, field, or behavior that does not exist in a router, OpenAPI spec, or permissions JSON.

## Technical Requirements

- **API Documentation**: When generating or updating API documentation, ensure it is comprehensive and follows the standards outlined in the website package.
- **Build and Deployment**: Verify that changes do not break the build process and maintain compatibility with the Docusaurus framework used for the website.
