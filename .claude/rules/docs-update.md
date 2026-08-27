---
paths:
  - "packages/server/**"
  - "packages/website/**"
---

# Documentation Update Rule

Every implementation that adds or changes a module's behavior **must** update the corresponding module documentation page before the work is considered done.

## Checklist

When changing any module:

- [ ] Update `packages/website/docs/modules/<module>.md` to reflect any changes to:
  - Data model fields (add/remove/rename columns in the Data Model table)
  - Key concepts (new behaviors, configuration options, lifecycle changes)
  - Examples (update code samples to match the new API surface)

## What triggers a docs update

| Change type | Docs action required |
|---|---|
| New field on a resource | Add a row to the Data Model table |
| New behavior / feature | Add or update the relevant Key Concepts section |
| New error code exposed to callers | Document when and why it is returned |
| Removed or renamed field | Update or remove the relevant table row |
| New env var required at runtime | Add a `## Configuration` section |

## Endpoint mentions link to the reference

Every `` `METHOD /path` `` written in the docs must link to the operation's
generated reference page:

```md
[`POST /api/v1/documents/ingest`](/docs/api/documents/ingest-document)
```

The address is `/docs/api/<spec-file>/<kebab-cased-operationId>` — the spec file
is the `packages/server/src/rest/openapi/v1/*.yaml` the operation lives in, and
the slug is lodash `kebabCase` of its `operationId` (note `downloadFileBase64`
→ `download-file-base-64`).

Every mention, not just the first on a page: readers arrive by deep link, so a
link at the top of the page is invisible to someone who landed mid-page. A
mention that resolves to no operation (`POST /chat/completions` on a provider,
or a class of routes like "every mutating `POST` under `/api/v1`") is left as
plain code.

`scripts/docs-lint.mjs` (check 6) enforces both directions — an unlinked mention
that resolves to an operation, and a `/docs/api/` link addressing a page no
operation generates. Do not hand-write the slug: run `pnpm run docs-lint`, which
prints the correct target for every mention it flags.

## How to verify

Before committing, open the module doc and confirm every field in the API response appears in the Data Model table and every non-obvious behavior has a Key Concepts entry.
