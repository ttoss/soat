# SOAT High-Level Feature Roadmap

Features that elevate SOAT from infrastructure primitives to a complete platform for building AI applications.

---

## 1. Agent Sessions

**1 user ↔ 1 agent in 2 API calls.**

Nested under `/agents/:agentId/sessions`. Hides the conversation/actor plumbing and gives developers the simplest possible "send message, get reply" experience. Sessions manage history, actors, and generation automatically.

Status: PRD complete (`docs/prd-sessions.md`).

---

## 2. Built-in RAG

**Agents that answer from your documents automatically.**

Connect a document collection to an agent so it retrieves relevant context before generating. No custom tool wiring — just point the agent at a set of documents and it uses the existing pgvector semantic search under the hood.

---

## 3. Multi-Agent Workflows

**Agents that delegate to other agents.**

Allow an agent to call another agent as a tool. Enables supervisor/worker patterns, routing agents, and multi-step pipelines where each agent has its own tools, instructions, and model. Traces show the full call graph.

---

## 4. Agent Handoff

**Seamless transfer of a session from one agent to another.**

Within a session, an agent can hand off the conversation to a different agent (e.g., triage → specialist). The session stays the same for the user — only the responding agent changes. The handoff is visible in the trace.

---

## 5. Guardrails & Boundary Policies

**Input/output validation for agents.**

Define rules that run before the LLM call (input guardrails) and after (output guardrails). Block or transform messages that violate content policies, leak PII, or go off-topic. Configurable per agent.

---

## 6. Structured Outputs

**Force agents to respond in a specific JSON schema.**

Provide a response schema when creating a generation or sending a session message. The agent constrains its output to match. Useful for data extraction, form filling, and tool-driven workflows.

---

## 7. Long-Running / Background Agents

**Agents that run asynchronously beyond a request lifecycle.**

Kick off an agent generation that runs in the background. Poll or receive a webhook when it completes. Supports multi-step tasks that take minutes, not seconds.

---

## 8. Agent Memory (Persistent Context)

**Agents that remember across sessions.**

Give agents a persistent memory store (key-value or summarized context) that carries over between sessions. The agent can read and write to its own memory. Backed by the existing documents + embedding infrastructure.

---

## 9. Evaluation & Testing Framework

**Automated quality checks for agents.**

Define test cases (input → expected output criteria) and run evaluations against an agent. Track scores over time. Integrates with traces for debugging regressions. Useful for CI/CD pipelines.

---

## 10. Observability Dashboard

**Traces, costs, latency, and usage at a glance.**

Extend the existing trace infrastructure into a queryable analytics layer. Track token usage, cost per agent, latency percentiles, error rates, and tool call frequency. Expose via API and optional UI.

---

## 11. Scheduled / Triggered Runs

**Agents that run on a cron schedule or in response to events.**

Configure an agent to run automatically — on a time schedule (e.g., daily summary) or triggered by a webhook/event (e.g., new file uploaded). Results are stored as session messages or sent to a webhook.

---

## Priority Order (suggested)

| Priority | Feature                        | Reason                                      |
| -------- | ------------------------------ | ------------------------------------------- |
| P0       | Agent Sessions                 | Foundation for everything else              |
| P0       | Built-in RAG                   | Most requested agent capability             |
| P1       | Multi-Agent Workflows          | Unlocks complex use cases                   |
| P1       | Structured Outputs             | Essential for production apps               |
| P1       | Guardrails & Boundary Policies | Required for production safety              |
| P2       | Agent Handoff                  | Natural extension of sessions + multi-agent |
| P2       | Long-Running Agents            | Unlocks async/batch workloads               |
| P2       | Agent Memory                   | Differentiator for stateful assistants      |
| P3       | Evaluation & Testing           | Quality at scale                            |
| P3       | Observability Dashboard        | Operational visibility                      |
| P3       | Scheduled / Triggered Runs     | Automation layer                            |
