---
description: "At-most-once requests: an idempotency_key body field or Idempotency-Key header makes a retry replay the original instead of running again."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Idempotency

The operations that start paid or visible work accept a **deduplication key**:

**A request carrying a key that already names a resource runs nothing and answers with that resource, in whatever state it has reached.**

This page is the canonical definition. Module pages describe what their own replay returns and link here.

## Operations that accept a key

| Operation | Scope | First request | Retry under the key | Same key, different request |
| --- | --- | --- | --- | --- |
| [`POST /api/v1/agents/{agent_id}/generate`](/docs/api/agents/create-agent-generation) | project | runs as usual | `202` with the generation handle | `409 IDEMPOTENCY_KEY_REUSED` |
| [`POST /api/v1/orchestration-runs`](/docs/api/orchestrations/start-orchestration-run) | project | `201` | `200` with the run | `409 IDEMPOTENCY_KEY_REUSED` |
| [`POST /api/v1/sessions/{session_id}/messages`](/docs/api/sessions/add-session-message) | session | `201` | `200` with the original message | `409 IDEMPOTENCY_KEY_REUSED` |
| [`POST /api/v1/tasks`](/docs/api/tasks/create-task) | project | `201` | `200` with the task as it is now | `409 IDEMPOTENCY_KEY_REUSED` |
| [`POST /api/v1/tasks/{task_id}/transitions`](/docs/api/tasks/transition-task) | task | `200` | `200` with the task as it is now | `409 IDEMPOTENCY_KEY_REUSED` |

A retry that arrives while the original is still running replays it too. What each operation compares to decide "same request" is on its module page: [agents](../modules/agents.md#running-a-generation-at-most-once), [orchestrations](../modules/orchestrations.md#starting-a-run-at-most-once), [sessions](../modules/sessions.md#idempotency), [task creates](../modules/workflows.md#retrying-a-create), [task transitions](../modules/workflows.md#retrying-a-transition).

## Sending a key

The key travels in the `idempotency_key` body field or the `Idempotency-Key` header:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat start-orchestration-run \
  --orchestration-id "$ORCH_ID" \
  --idempotency-key "dispatch-2026-09-18-activation-42"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.orchestrations.startOrchestrationRun({
  body: {
    orchestration_id: ORCH_ID,
    idempotency_key: 'dispatch-2026-09-18-activation-42',
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/orchestration-runs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: dispatch-2026-09-18-activation-42" \
  -d '{ "orchestration_id": "'"$ORCH_ID"'" }'
```

</TabItem>
</Tabs>

| Rule | Refusal |
| --- | --- |
| A non-empty string of at most 255 characters, stored verbatim | `400 VALIDATION_FAILED` |
| Header and body field together must name the same key | `400 VALIDATION_FAILED` |
| The header is sent once | `400 VALIDATION_FAILED` |

[MCP](../mcp/introduction.md) tool calls send the body field: tool schemas carry no headers.

## How long a key lasts

A key is claimed by the record its first request wrote, for as long as that record exists. There is no expiry window, so a retry never finds the key released and runs a second time.

## Keys the server sets

| Where | Key | Purpose |
| --- | --- | --- |
| [Orchestration node executions](../modules/orchestrations.md#idempotency-of-node-execution) | `{orchestration_run_id}:{node_id}:{attempt}` | A redelivered node reuses its stored output; an `http` tool node forwards the key as its `Idempotency-Key` request header |
| [Event trigger firings](../modules/triggers.md) | `<event_id>:<trigger_id>` | One firing per event and trigger |
