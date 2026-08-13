---
description: 'The wait toggle: every long-running endpoint runs in the background by default and returns a handle to poll; wait=true blocks. One contract, one polarity, one default.'
---

# Synchronous & Asynchronous Execution

Some SOAT operations take longer than a request should be held open: an LLM generation, a document ingestion, an orchestration run. Every one of them is controlled by a single toggle, **`wait`**.

The contract is one sentence: **an operation runs in the background by default and answers immediately with a handle; `wait=true` blocks until it settles and answers with the result.**

This page is the canonical definition. Module pages describe what their own handle contains and link here for the rule.

## The toggle

| | Value | Response | Use when |
| --- | --- | --- | --- |
| **Default** | `wait` omitted or `false` | `202 Accepted` — or `201 Created` when a run is created — plus a handle to poll (see [Status codes](#status-codes)) | The work may take a while and you have somewhere to put the result: a poll loop, a webhook, a UI that refreshes |
| **Blocking** | `wait=true` | `200`/`201` + the settled result | A script that needs the answer on the next line, or any flow that must observe `requires_action` |

`wait` is a **query parameter** on the generation and ingestion endpoints, and a **body field** on the run endpoints (`start-orchestration-run`, `start-eval-run`) — the same name and the same meaning either way.

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
| [`POST /agents/{agent_id}/generate`](../modules/agents.md#background-generation) | `generation_id`, `trace_id` | `GET /generations/{generation_id}` |
| [`POST /sessions/{session_id}/generate`](../modules/sessions.md#background-generation) | `session_id` | `GET /conversations/{conversation_id}/messages` |
| [`POST /conversations/{conversation_id}/generate`](../modules/conversations.md#generating-the-next-message) | `conversation_id` | `GET /conversations/{conversation_id}/messages` |
| [`POST /documents/ingest`](../modules/documents.md#async-file-ingestion) and `POST /documents/{document_id}/ingest` | the document, in `status: pending` | `GET /documents/{document_id}/status` |
| [`POST /orchestration-runs`](../modules/orchestrations.md#durable-background-execution) | the run, in `status: queued` | `GET /orchestration-runs/{orchestration_run_id}` |
| [`POST /evals/{eval_id}/runs`](../modules/evaluations.md#synchronous-and-queued-runs) | the run, in `status: queued` | `GET /evals/{eval_id}/runs/{eval_run_id}` |

## What the default does **not** change

Backgrounding defers the slow part, never the checks. Everything that can reject a request still runs **before** the accepted response:

- **Authentication and permissions** — a caller without the IAM action gets `401`/`403`, not an accepted job that fails later.
- **Input validation** — a malformed body is `400 VALIDATION_FAILED`.
- **Resource resolution** — an unknown agent, session, or conversation is `404`.
- **Admission control** — a breached [quota](../modules/quotas.md) is `429`, and the agent-to-agent [call-depth guard](../modules/agents.md#nested-agent-calls) still fires.
- **The record write** — the generation record exists before the response is written, so the `generation_id` you receive is immediately readable. It reports `in_progress` until the run reaches `completed` or `failed`.

The practical consequence: an accepted response means *admitted*, and the only failures you have to discover by polling are the ones that happen during the model call itself.

## Status codes

The accepted response is **not** the same status everywhere, because the two families of
endpoint are doing different things:

| Family | Background | Blocking | Why |
| --- | --- | --- | --- |
| Work on an existing resource — [agent](../modules/agents.md#background-generation), [session](../modules/sessions.md#background-generation) and [conversation](../modules/conversations.md#generating-the-next-message) generation, [document ingestion](../modules/documents.md#async-file-ingestion) | `202 Accepted` | `200` (`201` for ingestion) | The request is *accepting work*; there is no new resource whose creation the status could report |
| Run creation — [orchestration runs](../modules/orchestrations.md#durable-background-execution), [eval runs](../modules/evaluations.md#synchronous-and-queued-runs) | `201 Created` | `201 Created` | A run row is created either way and is immediately readable; the mode shows up in its `status` (`queued`), not in the status code |

So branch on `wait` and on the run's own `status` field, never on `202` alone — a queued
orchestration or eval run answers `201`.

The rule that *is* uniform: the response always carries something you can poll, and a caller
that omitted `wait` never receives a settled result.

A [trigger](../modules/triggers.md) firing has no `wait` of its own: it always starts an
eval run in the background, because a cron tick cannot hold a request open for a whole
dataset. The firing record names the `evrun_…` to poll.

## Two combinations that are resolved for you

**Streaming implies waiting.** `stream: true` holds the response open by definition, so it is a blocking call whether or not you pass `wait`. Asking for both a stream and a background run (`stream: true` with `?wait=false`) is contradictory and returns `400 VALIDATION_FAILED` rather than silently dropping one of the two.

**A `soat` tool call always waits.** When an agent calls another agent through a `soat` tool, the nested call blocks regardless of the default: a tool call is one request returning one result, with no channel to poll a background run later. The field is not offered on the tool surface at all — the same treatment as `stream`, and for the same reason. See [Agent-to-Agent Calls](../modules/agents.md#nested-agent-calls).

## Choosing a mode

Reach for **`wait=true`** when the result is the next thing you need: a shell script, a smoke test, a tutorial step, or any [client-tool](../tutorials/client-tools.md) flow — `requires_action` is only observable in a blocking response.

Stay on the **default** when the work is genuinely detached: a UI that can render a pending state, a batch ingestion, a run you will inspect later. Two things make this comfortable rather than a polling chore:

- [**Webhooks**](../modules/webhooks.md) deliver generation lifecycle events, so you can react to completion instead of asking for it. [Chat with an LLM](../tutorials/chat-with-llm.md) wires this up end to end.
- **Status endpoints are cheap.** `GET /documents/{id}/status` returns only lifecycle fields rather than the assembled document, and it advances during processing — see [Polling Ingestion Status](../modules/documents.md#polling-ingestion-status).

## Why `wait` and not `async`

Earlier versions spelled this two ways: an `async` query parameter on ingestion and session generation, `wait` on the run endpoints — with **opposite polarity**, so `async=true` and `wait=true` meant opposite things. Unifying on `wait` keeps one positive verb (`wait=true` blocks, everywhere), avoids the `async` keyword collision in generated SDKs, and names what the caller wants rather than how the server executes it.
