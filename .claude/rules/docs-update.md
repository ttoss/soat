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

## How to verify

Before committing, open the module doc and confirm every field in the API response appears in the Data Model table and every non-obvious behavior has a Key Concepts entry.
