---
description: 'End-to-end SOAT tutorials that walk through complete workflows from scratch — agents, tools, RAG, orchestration, guardrails, and cost controls.'
keywords:
  - SOAT tutorials
  - AI agent tutorials
  - self-hosted AI agents
  - AI agent infrastructure
sidebar_position: 0
title: Tutorials
slug: /tutorials
---

End-to-end workflows with CLI, SDK, and curl examples at every step, each validated against a live server in CI.

## Before you begin

- A running SOAT instance ([Quick Start](/docs/getting-started)).
- [Key Concepts](/docs/getting-started/concepts).
- The CLI installed, or the SDK in a TypeScript project.

## Pick a path

- **New to SOAT?** [Permissions in Practice](/docs/tutorials/permissions), [Chat with an LLM](/docs/tutorials/chat-with-llm), then [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).
- **Building an agent?** [Agent SOAT Tools](/docs/tutorials/agent-soat-tools), [client tools](/docs/tutorials/client-tools), [persistent memory](/docs/tutorials/memories-agent), and [debug sessions, generations, and traces](/docs/tutorials/debug-session-generation-trace-history).
- **Locking an agent down?** [Bound an Agent with a Boundary Policy](/docs/tutorials/agent-boundary-policy), then [Guardrails](/docs/tutorials/gate-a-tool-with-guardrails) for the tool types a boundary cannot reach.
- **Retrieval and RAG?** [Embeddings](/docs/tutorials/embeddings), an [agent over a library of PDFs](/docs/tutorials/agent-with-pdfs), and [ingest images and audio](/docs/tutorials/ingest-images-and-audio).
- **Coordinating multiple agents?** An [orchestration pipeline](/docs/tutorials/orchestrate-a-sonnet), a [workflow state machine](/docs/tutorials/orchestrate-a-sonnet-with-workflows), or [nested agent calls](/docs/tutorials/multi-agent-orchestration); then [branching](/docs/tutorials/conditional-orchestration), [control flow](/docs/tutorials/orchestration-control-flow), or [human approval gates](/docs/tutorials/approval-gate).
- **One governed process end to end?** [Close the Monthly Books](/docs/tutorials/close-the-monthly-books): an orchestration, a workflow, a trigger, and a human approval.
- **Shipping to production?** [Formations](/docs/tutorials/formations) and an [agent squad](/docs/tutorials/create-an-agent-squad), [Triggers](/docs/tutorials/automate-a-flow-with-triggers), [Guardrails](/docs/tutorials/gate-a-tool-with-guardrails), [per-user credentials with tool context](/docs/tutorials/per-user-credentials-with-tool-context), [metering and budgets](/docs/tutorials/metering-and-budgets), and [per-end-user spend caps](/docs/tutorials/cap-spend-per-end-user).
- **Shipping a change safely?** [Evaluate an Agent](/docs/tutorials/evaluate-an-agent), an [LLM judge](/docs/tutorials/judge-open-ended-answers) for open-ended output, then [Gate a Canary Promotion on an Eval](/docs/tutorials/gate-a-canary-promotion-on-an-eval).
- **Chasing one bad answer?** [Replay a Bad Turn](/docs/tutorials/replay-a-bad-turn): read the turn back, freeze it as a fixture, fork the session.
- **Under compliance pressure?** [Data retention and zero-retention](/docs/tutorials/data-retention-and-zero-retention), and [agent versioning and canary rollout](/docs/tutorials/agent-versioning-and-canary-rollout).
- **Calling a cloud API?** [Call AWS and GCP APIs from an Agent](/docs/tutorials/call-aws-and-gcp-apis-from-an-agent) (SigV4 or a GCP service account).

---

import DocCardList from '@theme/DocCardList';

<DocCardList />
