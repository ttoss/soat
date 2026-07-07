import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Activity

An append-only, project-scoped feed where **every autonomous execution is
visible after the fact** — so autonomy stays auditable.

## Overview

The activity feed is the "what did the agents do today" surface. Every
autonomously executed action, every approval resolution, every exception, and
every schedule fire lands as one `ActivityEntry`. Entries are immutable: there
is no update path once written.

Thin clients render the feed directly from `GET /api/v1/activity`, which is
cursor-paginated (newest first) and filterable by `kind`.

> See the [Permissions Reference](../permissions.md) for the IAM action strings
> for this module.

## Data Model

### ActivityEntry

| Field                              | Type           | Description                                                       |
| ---------------------------------- | -------------- | ----------------------------------------------------------------- |
| `id`                               | string         | Public identifier (`acte_…`)                                      |
| `project_id`                       | string         | ID of the owning project (hard security boundary)                 |
| `kind`                             | `action_executed` \| `approval_resolved` \| `exception_created` \| `schedule_fired` | Entry type |
| `summary`                          | string         | One-line human-readable description                               |
| `detail`                           | object \| null | Structured payload (tool, args digest, policy version, …)         |
| `run_id` / `agent_id`              | string \| null | Provenance                                                        |
| `ref_id`                           | string \| null | Points at the related approval / exception / schedule             |
| `created_at`                       | string         | ISO 8601 creation timestamp. **Append-only — no update path**     |

## Key Concepts

### One Entry per Auditable Event

| `kind`              | Written when                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `action_executed`   | An action executes autonomously (no human in the loop)              |
| `approval_resolved` | An [approval](./approvals.md) is approved, rejected, or expired     |
| `exception_created` | An [exception](./exceptions.md) is filed                            |
| `schedule_fired`    | A scheduled activation fires                                        |

### Entries Link Back to Their Origin

Every entry carries provenance — `run_id`, `agent_id`, and a `ref_id` that
points at the approval, exception, or schedule it describes. Where applicable,
`detail` also records the guardrail policy version that allowed an autonomous
action, so one query answers "what ran, on whose behalf, and under which
policy". The feed itself has no `severity` field — for an
`exception_created` entry, follow `ref_id` to the exception to read its
severity.

### Append-Only

The feed is immutable. Entries are never updated or deleted; corrections are new
entries. This keeps the feed a trustworthy audit record. It is also **unbounded
in v1** — a retention/rollup policy is deferred.

### Cursor Pagination

`GET /api/v1/activity` is cursor-paginated rather than using the `limit`/`offset`
the other list endpoints use. This is deliberate: an append-only feed takes
concurrent inserts at the head, and offset paging would skip or double-count
rows as the feed grows under the reader.

## Example

<Tabs groupId="client">
<TabItem value="curl" label="curl">

```bash
# First page of the feed, newest first
curl -s "$SOAT_BASE_URL/api/v1/activity?project_id=proj_ABC" \
  -H "Authorization: Bearer $SOAT_TOKEN"

# Filter to autonomously executed actions, then page with the returned cursor
curl -s "$SOAT_BASE_URL/api/v1/activity?project_id=proj_ABC&kind=action_executed&cursor=$NEXT" \
  -H "Authorization: Bearer $SOAT_TOKEN"
```

</TabItem>
</Tabs>

## MCP Tools

`list-activity` is derived automatically from the OpenAPI spec.

## Related

- [Approvals](./approvals.md) — resolutions appear as `approval_resolved` entries
- [Exceptions](./exceptions.md) — filed exceptions appear as `exception_created` entries
- [Orchestrations](./orchestrations.md) — autonomous node executions appear as `action_executed` entries
