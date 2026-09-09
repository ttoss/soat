---
paths:
  - "packages/server/**"
  - "packages/website/**"
---

# Documentation Update

Any module behavior change updates `packages/website/docs/modules/<module>.md`
in the same change:

| Change | Docs |
|---|---|
| Field added / removed / renamed | Data Model table row |
| New behavior | Key Concepts section |
| New error code | When and why it is returned |
| New runtime env var | `## Configuration` section |

## Endpoint mentions link to the reference

Every `` `METHOD /path` `` in docs links to
`/docs/api/<spec-file>/<kebab-cased-operationId>` (lodash `kebabCase`:
`downloadFileBase64` → `download-file-base-64`), on every mention. A mention
that resolves to no operation stays plain code. `pnpm run docs-lint`
(`scripts/docs-lint.mjs`, check 6) enforces both directions and prints the
correct target; do not hand-write slugs.

```md
[`POST /api/v1/documents/ingest`](/docs/api/documents/ingest-document)
```
