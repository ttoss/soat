import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Exceptions

Make failures, anomalies, and guardrail breaches **first-class items** with a
severity and a resolution lifecycle — not log lines that scroll away.

## Overview

An `ExceptionItem` is a persistent, project-scoped failure record. It is filed
**automatically** by the platform when something goes wrong, or **explicitly**
by an agent or orchestration node. Each item carries a `severity`
(`info` \| `warning` \| `critical`) so receivers can fan `critical` items into an
operator escalation channel while routine items flow to the product queue — all
without polling.

Exceptions are listed and filtered via `GET /api/v1/exceptions` (by `status`,
`severity`) and moved through their lifecycle via
`POST /api/v1/exceptions/{exception_id}/resolve`.

> See the [Permissions Reference](../permissions.md) for the IAM action strings
> for this module.

## Data Model

### ExceptionItem

| Field                              | Type           | Description                                          |
| ---------------------------------- | -------------- | ---------------------------------------------------- |
| `id`                               | string         | Public identifier (`exc_…`)                          |
| `project_id`                       | string         | ID of the owning project (hard security boundary)    |
| `status`                           | `open` \| `acknowledged` \| `resolved` | Resolution lifecycle status         |
| `severity`                         | `info` \| `warning` \| `critical` | Routing severity                          |
| `kind`                             | `run_failed` \| `guardrail_tripwire` \| `approval_expired` \| `manual` | How it was filed |
| `title`                            | string         | Human-readable one-line description                  |
| `detail`                           | object         | Structured detail payload                            |
| `run_id` / `node_id` / `agent_id`  | string \| null | Provenance                                           |
| `resolved_by`                      | string \| null | Public ID of the user who resolved                   |
| `resolution_note`                  | string \| null | Note captured at resolution                          |
| `created_at`                       | string         | ISO 8601 creation timestamp                          |
| `updated_at`                       | string         | ISO 8601 last-updated timestamp                      |

## Key Concepts

### How Exceptions Are Filed

| `kind`               | Filed by                                                                 |
| -------------------- | ------------------------------------------------------------------------ |
| `run_failed`         | A run that exhausts its node retries                                     |
| `guardrail_tripwire` | A guardrail tripwire firing                                              |
| `approval_expired`   | The [approvals](./approvals.md) sweeper, when an item expires unresolved |
| `manual`             | An explicit `file-exception` operation from an agent or orchestration node |

### Severity Drives Routing

`severity` is included in the `exceptions.created` webhook payload so receivers
can route by importance:

- `critical` — page an operator / escalation channel
- `warning` — surface in the operator dashboard
- `info` — record for audit; no active alert

### Resolution Lifecycle

An exception moves `open → acknowledged → resolved`. Acknowledging signals that
someone is looking at it; resolving closes it with a `resolution_note` for the
audit trail. Both transitions go through
`POST /api/v1/exceptions/{exception_id}/resolve` and require
`exceptions:ResolveException`.

## Webhook Events

| Event                | When                          |
| -------------------- | ----------------------------- |
| `exceptions.created` | A new exception item is filed |

The payload includes `severity` so downstream systems can split critical
escalations from routine items.

## MCP Tools

`list-exceptions` and `resolve-exception` are derived automatically from the
OpenAPI spec.

## Related

- [Approvals](./approvals.md) — an expired approval files an `approval_expired` exception
- [Orchestrations](./orchestrations.md) — a run that exhausts retries files a `run_failed` exception
- [Activity](./activity.md) — every exception created appears in the feed
