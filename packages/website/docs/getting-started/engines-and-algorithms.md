---
description: "The two-layer pattern behind SOAT's intelligence modules: a mechanical engine you can rely on, an algorithm layer you can swap, and tools as the seam for bringing your own algorithm."
sidebar_position: 4
sidebar_label: Engines & Algorithms
title: Engines & Algorithms
---

# Engines & Algorithms

Every intelligence module in SOAT — [Evaluations](/docs/modules/evaluations),
[Memories](/docs/modules/memories), [Knowledge](/docs/modules/knowledge) — splits into the
same two layers. Knowing the split tells you what you can rely on, what you are allowed to
disagree with, and where your own code plugs in.

## The pattern

### The engine — mechanics you cannot opt out of

The engine is the mechanical half: it calls the agent, calls the model, persists the
output, freezes the inputs, links the trace, settles the run. It is the physics of the
module — prompt in, output out, rows written, exactly once. Nothing in it takes a
judgment call about your application, which is precisely why it can be shared by every
application: permissions, metering, retention, and observability all ride on it, and its
guarantees (a run settles, a write is never lost, an error is never a score) hold no
matter what runs on top.

You cannot replace the engine, and you should not need to — there is no opinion in it to
disagree with.

### Algorithms — opinions that run on the engine

Algorithms are the layer that decides things: what "good output" means (a
[scorer](/docs/modules/evaluations#scorers)), what is worth remembering (the
[extraction algorithm](/docs/modules/memories#automatic-extraction)), whether two facts
are the same fact (the [write algorithm](/docs/modules/memories#write-algorithm)), where
a document splits
([chunking](/docs/advanced/memory-and-knowledge-engine#chunking-algorithms)), which
result ranks first
([retrieval](/docs/advanced/memory-and-knowledge-engine#the-retrieval-algorithm)). Each
one is named, has a default, and usually has a knob.

Algorithms are opinionated by nature, so disagreeing with one is expected — that is why
they are configurable, and why the third piece of the pattern exists.

### Custom algorithms — bring your own as a tool

When no built-in algorithm fits, the extension mechanism is a
[Tool](/docs/modules/tools). At a documented seam, the engine invokes your tool with a
fixed input contract; your code — any language, any model, any vendor, running wherever
you run it — answers in the documented output shape; the engine records the result under
the same invariants as a built-in algorithm. The tool *is* the algorithm; the engine
stays the engine.

Tools are the seam, rather than plugins or callbacks, because they already carry
everything a production algorithm needs:

- **Project-scoped and reusable** — one tool, shared across agents, evals, and rules,
  fixed in one place.
- **Credentialed safely** — API keys live in [Secrets](/docs/modules/secrets) references,
  never in configs.
- **Server-callable** — `http`, `mcp`, `soat`, and `pipeline` tools all work; the engine
  calls them through the same invocation path agents use. (`client` tools are refused at
  these seams: they pause for a calling client, and an engine runs server-side.)
- **Governed** — the call is project-scoped, traceable, and subject to the same platform
  controls as any other tool call.

## The three engines

| Module | The engine (mechanics) | Built-in algorithms | Bring your own |
| --- | --- | --- | --- |
| [Evaluations](/docs/modules/evaluations) | Datasets, runs, frozen inputs, version pinning, aggregation, baselines, queueing, lifecycle webhooks | The [scorers](/docs/modules/evaluations#scorers): `exact_match`, `contains`, `json_logic`, `output_schema`, `llm_judge` | A [custom scorer](/docs/modules/evaluations#custom-scorers-tool) — a `tool` scorer graded by your own algorithm |
| [Memories](/docs/modules/memories) (write side) | One write funnel, embedding, provenance, temporal invalidation | The [write (dedup/merge) algorithm](/docs/modules/memories#write-algorithm) and [fact extraction](/docs/modules/memories#automatic-extraction) | A custom extraction `prompt`/model; per-write `duplicate_threshold` tuning — see the [engine deep dive](/docs/advanced/memory-and-knowledge-engine#extending-the-engine-today) |
| [Knowledge](/docs/modules/knowledge) (read side) | Two stores, one search function, injection into generations | [Chunking strategies](/docs/advanced/memory-and-knowledge-engine#chunking-algorithms), [retrieval ranking](/docs/advanced/memory-and-knowledge-engine#the-retrieval-algorithm) | A [converter tool](/docs/modules/ingestion-rules#converter-tool-contract) via ingestion rules — your OCR, transcription, or parser; pre-chunking and re-ranking [composition](/docs/advanced/memory-and-knowledge-engine#extending-the-engine-today) |

The boundary is marked in each module's documentation: engine behavior and algorithm
behavior are separate sections, and every bring-your-own seam documents its exact input
and output contract.

## What holds no matter which algorithm runs

The point of the split is that the engine's guarantees are unconditional — they hold for
a built-in algorithm, a reconfigured one, and yours alike:

- **Your algorithm failing never corrupts a verdict.** A scorer tool that errors or
  answers garbage marks the *item* errored — never a score of 0, never a failed run
  ([errors are not zeros](/docs/modules/evaluations#errors-are-not-zeros)). A converter
  that fails marks the *document* failed with a named
  [`failure_reason`](/docs/modules/ingestion-rules#failure-reasons). An extraction that
  fails is skipped, and the turn it came from is unaffected.
- **Contracts are wire contracts.** Every seam speaks snake_case JSON in and out — the
  same convention as the REST API — so the tool you write for SOAT is an ordinary
  endpoint, testable with `curl`.
- **Authorization does not widen.** The engine invokes your tool scoped to the owning
  project; a scorer or converter can never borrow another project's tools or secrets.
- **Observability is uniform.** Runs, documents, and generations record what the
  algorithm decided (scores and reasoning, extraction summaries, failure reasons), so a
  custom algorithm is as debuggable as a built-in one.

## Where to go next

- Grade agents with your own metric: [Custom scorers](/docs/modules/evaluations#custom-scorers-tool).
- Teach ingestion a new file type: [Ingestion Rules](/docs/modules/ingestion-rules).
- See one engine end to end, with every algorithm and seam:
  [Memory & Knowledge Engine](/docs/advanced/memory-and-knowledge-engine).
