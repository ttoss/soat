---
description: 'End-to-end SOAT tutorials that walk through complete workflows from scratch — agents, tools, RAG, orchestration, guardrails, and cost controls.'
keywords:
  - SOAT tutorials
  - AI agent tutorials
  - self-hosted AI agents
  - AI agent infrastructure
sidebar_position: 0
title: Tutorials
---

Tutorials walk you through complete, end-to-end workflows using SOAT. Each one starts from scratch and demonstrates how the platform's building blocks fit together in a real scenario — every step comes with CLI, SDK, and curl examples, and every tutorial is validated against a live server in CI.

## Before you begin

All tutorials assume:

- A running SOAT instance. Follow the [Quick Start](/docs/getting-started) to bring the stack up.
- Familiarity with SOAT's core concepts. Read [Key Concepts](/docs/getting-started/concepts) if you are new.
- The CLI installed, or the SDK set up in a TypeScript project.

## Pick a path

- **New to SOAT?** Start with [Permissions in Practice](/docs/tutorials/permissions) and [Chat with an LLM](/docs/tutorials/chat-with-llm), then connect a hosted model with [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).
- **Building an agent?** Wire platform tools in [Agent SOAT Tools](/docs/tutorials/agent-soat-tools), run your own functions with [client tools](/docs/tutorials/client-tools), add [persistent memory](/docs/tutorials/memories-agent), and learn to [debug sessions, generations, and traces](/docs/tutorials/debug-session-generation-trace-history).
- **Locking an agent down?** Cap what a single agent may do — independently of who calls it — with [Bound an Agent with a Boundary Policy](/docs/tutorials/agent-boundary-policy), then gate the tool types a boundary cannot reach using [Guardrails](/docs/tutorials/gate-a-tool-with-guardrails).
- **Retrieval and RAG?** Generate [embeddings](/docs/tutorials/embeddings), build an [agent over a library of PDFs](/docs/tutorials/agent-with-pdfs), and [ingest images and audio](/docs/tutorials/ingest-images-and-audio).
- **Coordinating multiple agents?** Compare a direct [orchestration pipeline](/docs/tutorials/orchestrate-a-sonnet), a [workflow state machine](/docs/tutorials/orchestrate-a-sonnet-with-workflows), and [nested agent calls](/docs/tutorials/multi-agent-orchestration) — then add [branching](/docs/tutorials/conditional-orchestration), [control flow](/docs/tutorials/orchestration-control-flow), or [human approval gates](/docs/tutorials/approval-gate).
- **Building one governed process end to end?** [Close the Monthly Books](/docs/tutorials/close-the-monthly-books) composes an orchestration, a workflow, a trigger, and a human approval into a single month-end close — the capstone that puts the pieces above together.
- **Shipping to production?** Deploy a whole stack declaratively with [Formations](/docs/tutorials/formations) and an [agent squad](/docs/tutorials/create-an-agent-squad), automate it with [Triggers](/docs/tutorials/automate-a-flow-with-triggers), gate risky calls with [Guardrails](/docs/tutorials/gate-a-tool-with-guardrails), hand [per-user credentials to tools with tool context](/docs/tutorials/per-user-credentials-with-tool-context), and control cost with [metering and budgets](/docs/tutorials/metering-and-budgets) and [per-end-user spend caps](/docs/tutorials/cap-spend-per-end-user).
- **Shipping a change safely?** Measure it first with [Evaluate an Agent](/docs/tutorials/evaluate-an-agent), grade open-ended output with an [LLM judge](/docs/tutorials/judge-open-ended-answers), then make the rollout itself wait for a green suite with [Gate a Canary Promotion on an Eval](/docs/tutorials/gate-a-canary-promotion-on-an-eval).
- **Chasing one bad answer?** [Replay a Bad Turn](/docs/tutorials/replay-a-bad-turn) reads the turn back step by step, freezes it as a fixture so it cannot regress quietly, and forks the session at that message to try a different agent against the same context.
- **Under compliance pressure?** Erase, expire, or never store prompt content with [data retention and zero-retention](/docs/tutorials/data-retention-and-zero-retention), and ship prompt changes safely with [agent versioning and canary rollout](/docs/tutorials/agent-versioning-and-canary-rollout).
- **Calling a cloud API?** Sign requests as AWS or authenticate as a GCP service account with [Call AWS and GCP APIs from an Agent](/docs/tutorials/call-aws-and-gcp-apis-from-an-agent).

---

import DocCardList from '@theme/DocCardList';

<DocCardList />
