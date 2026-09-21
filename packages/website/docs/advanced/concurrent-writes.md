---
description: 'Optimistic concurrency on versioned resources: expected_version or If-Match refuses a write whose author read a version that has since moved, and concurrent writes to one resource are serialized whether or not anybody opted in.'
---

# Concurrent Writes

Every resource that carries a `version` counter — [agents](../modules/agents.md), [guardrails](../modules/guardrails.md), [orchestrations](../modules/orchestrations.md), [workflows](../modules/workflows.md) — accepts a **write precondition**:

**A write may name the version it believes the resource holds. If the resource is at any other version the write is refused whole, and nothing is written.**

This page is the canonical definition. Module pages describe their own version counter and link here.

## Why a counter is not enough

Two writers read version 3. One sets `instructions`, the other sets `model`. Both write. Both are told they succeeded, and the resource holds one of the two changes.

The change that vanished leaves no trace. The archived version records the winner's config, the loser's `200` records only that its request was accepted, and the record that would show what it wrote is the one that was replaced. That is what makes a lost update different from an ordinary conflict: nothing downstream can detect it, so nothing downstream can repair it.

## Stating a precondition

Send the version in the request body:

```bash
soat update-agent --agent-id agent_01 --expected_version 3 --model claude-sonnet-5
```

Or as an HTTP entity tag, which is the same precondition:

```bash
curl -X PATCH "$SOAT_URL/api/v1/agents/agent_01" \
  -H "Authorization: Bearer $SOAT_API_KEY" \
  -H 'If-Match: 3' \
  -H 'Content-Type: application/json' \
  -d '{"model": "claude-sonnet-5"}'
```

| Form | Where | Notes |
| --- | --- | --- |
| `expected_version` | request body | An integer ≥ 1. Declared in the spec, so the SDK and CLI carry it. |
| `If-Match` | request header | `3` or `"3"`. `*` states no precondition beyond the resource existing. |

Sending both with different versions is `400 VALIDATION_FAILED`: they are one precondition, so a disagreement is a contradiction rather than a precedence question.

## The refusal

A mismatch is `409 VERSION_CONFLICT`, carrying the version in force:

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Agent 'agent_01' is at version 5, not the expected version 3.",
    "meta": { "current_version": 5, "expected_version": 3 }
  }
}
```

Re-read the resource, re-apply the change on top of version 5, and retry against 5. Retrying the same body against 3 conflicts again.

## What happens without one

Omitting the precondition does not make a write unordered. The version bump is a conditional update inside the same transaction as the field write, so two writes that reach the server together are still separated: one takes the version, and the other is refused with the same `409` — with `expected_version` absent from `meta`, because the caller named none.

So a write that states nothing is still never lost silently. What stating a version adds is refusing a write whose author read the resource some time ago and has not seen what happened since — the case a request-scoped race cannot catch, because by the time the second write arrives the first is long committed.

## What "refused whole" means

A conflict rolls back the field write along with the version bump. The resource keeps every value it had, and the archive gains nothing. This is what lets a caller retry without first checking which half of its change landed, and it is what keeps the version chain a chain: no gap, no repeat, and no archived config that was never the live one.

A **write that changes nothing takes no version**. Re-sending the config a resource already holds, or restoring the version already live, is a no-op — so it cannot conflict with a concurrent write either. It is still refused if it states a stale version, because the caller's claim about what it was editing is wrong regardless of what it was going to write.

## Scope

The precondition covers one resource's config. It is not a transaction across resources: two writes to two agents are two writes, and there is no way to make them succeed or fail together. Where several records must move as one, model the step as an [orchestration](../modules/orchestrations.md) and make it idempotent.
