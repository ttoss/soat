---
description: 'The wait toggle: every long-running endpoint runs in the background by default and returns a handle to poll; wait=true blocks. One contract, one polarity, one default.'
---

# Synchronous & Asynchronous Execution

Operations that outlast a request — an LLM generation, a document ingestion, an orchestration run — are controlled by one toggle, **`wait`**:

**An operation runs in the background by default and answers immediately with a handle; `wait=true` blocks until it settles and answers with the result.**

This page is the canonical definition. Module pages describe their own handle and link here.

## The toggle

| | Value | Response | Use when |
| --- | --- | --- | --- |
| **Default** | `wait` omitted or `false` | `202 Accepted` — or `201 Created` when a run is created — plus a handle to poll (see [Status codes](#status-codes)) | The work may take a while and you have somewhere to put the result: a poll loop, a webhook, a UI that refreshes |
| **Blocking** | `wait=true` | `200`/`201` + the settled result | A script that needs the answer on the next line, or any flow that must observe `requires_action` |

`wait` is a **query parameter** on the generation and ingestion endpoints, and a **body field** on the run endpoints (`start-orchestration-run`, `start-eval-run`); same name, same meaning.

```bash
# Background (default): returns a handle immediately
soat create-agent-generation --agent-id agent_01 \
  --messages '[{"role":"user","content":"Summarize Q1"}]'

# Blocking: returns the finished generation
soat create-agent-generation --agent-id agent_01 --wait true \
  --messages '[{"role":"user","content":"Summarize Q1"}]'
```

## Where it applies

| Operation | Handle returned by default | Poll it with |
| --- | --- | --- |
| [`POST /agents/{agent_id}/generate`](../modules/agents.md#background-generation) | `generation_id`, `trace_id` | [`GET /generations/{generation_id}`](/docs/api/generations/get-generation) |
| [`POST /sessions/{session_id}/generate`](../modules/sessions.md#background-generation) | `session_id` | [`GET /conversations/{conversation_id}/messages`](/docs/api/conversations/list-conversation-messages) |
| [`POST /conversations/{conversation_id}/generate`](../modules/conversations.md#generating-the-next-message) | `conversation_id` | [`GET /conversations/{conversation_id}/messages`](/docs/api/conversations/list-conversation-messages) |
| [`POST /documents/ingest`](../modules/documents.md#async-file-ingestion) and [`POST /documents/{document_id}/ingest`](/docs/api/documents/reingest-document) | the document, in `status: pending` | [`GET /documents/{document_id}/status`](/docs/api/documents/get-document-status) |
| [`POST /orchestration-runs`](../modules/orchestrations.md#durable-background-execution) | the run, in `status: queued` | [`GET /orchestration-runs/{orchestration_run_id}`](/docs/api/orchestrations/get-orchestration-run) |
| [`POST /evals/{eval_id}/runs`](../modules/evaluations.md#synchronous-and-queued-runs) | the run, in `status: queued` | [`GET /evals/{eval_id}/runs/{eval_run_id}`](/docs/api/evaluations/get-eval-run) |

## What the default does **not** change

Backgrounding defers the slow part, never the checks. Everything that can reject a request still runs **before** the accepted response:

- **Authentication and permissions** — a caller without the IAM action gets `401`/`403`.
- **Input validation** — a malformed body is `400 VALIDATION_FAILED`.
- **Resource resolution** — an unknown agent, session, or conversation is `404`.
- **Admission control** — a breached [quota](../modules/quotas.md) is `429`, and the agent-to-agent [call-depth guard](../modules/agents.md#nested-agent-calls) still fires.
- **The record write** — the generation record exists before the response is written, so the `generation_id` is immediately readable. It reports `in_progress` until the run reaches `completed` or `failed`.

An accepted response means *admitted*; the only failures discovered by polling are those of the model call itself.

## Status codes

| Family | Background | Blocking | Why |
| --- | --- | --- | --- |
| Work on an existing resource — [agent](../modules/agents.md#background-generation), [session](../modules/sessions.md#background-generation) and [conversation](../modules/conversations.md#generating-the-next-message) generation, [document ingestion](../modules/documents.md#async-file-ingestion) | `202 Accepted` | `200` (`201` for ingestion) | The request is *accepting work*; no new resource's creation to report |
| Run creation — [orchestration runs](../modules/orchestrations.md#durable-background-execution), [eval runs](../modules/evaluations.md#synchronous-and-queued-runs) | `201 Created` | `201 Created` | A run row is created either way and is immediately readable; the mode shows in its `status` (`queued`), not the status code |

Branch on `wait` and on the run's own `status` field, never on `202` alone. The uniform rule: the response always carries something you can poll, and a caller that omitted `wait` never receives a settled result.

A [trigger](../modules/triggers.md) firing has no `wait`: it always starts an eval run in the background, and the firing record names the `evrun_…` to poll.

## Two combinations that are resolved for you

**Streaming implies waiting.** `stream: true` holds the response open, so it is a blocking call whether or not you pass `wait`. `stream: true` with `?wait=false` is contradictory and returns `400 VALIDATION_FAILED`.

**A `builtin` tool call always waits.** When an agent calls another agent through a `builtin` tool, the nested call blocks: a tool call is one request returning one result, with no channel to poll later. The field is not offered on the tool surface, like `stream`. See [Agent-to-Agent Calls](../modules/agents.md#nested-agent-calls).

## Choosing a mode

**`wait=true`** when the result is the next thing you need: a shell script, a smoke test, a tutorial step, or any [client-tool](../tutorials/client-tools.md) flow (`requires_action` is only observable in a blocking response).

The **default** when the work is detached: a UI that renders a pending state, a batch ingestion, a run inspected later.

- [**Webhooks**](../modules/webhooks.md) deliver generation lifecycle events, so you can react to completion instead of polling. [Chat with an LLM](../tutorials/chat-with-llm.md) wires this up.
- **Status endpoints are cheap.** [`GET /documents/{id}/status`](/docs/api/documents/get-document-status) returns only lifecycle fields and advances during processing — see [Polling Ingestion Status](../modules/documents.md#polling-ingestion-status).
