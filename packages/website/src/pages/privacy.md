---
title: Privacy
description: What this documentation site collects, and where your data lives when you run SOAT yourself.
---

# Privacy

There are two separate questions here, and they have different answers: what
this documentation site collects, and what happens to data when you run SOAT.

## This documentation site

[soat.ttoss.dev](https://soat.ttoss.dev) is a static site. It runs no analytics,
sets no cookies, embeds no trackers, and loads no third-party scripts or fonts.
Nothing on it asks for an email address, and there is no account to create.

Requests reach the site through a CDN, which — like any web server — processes
the IP address and request headers needed to deliver a response and to keep the
service available. That is the whole extent of it: there is no advertising
identifier, no cross-site profile, and no data sold or shared with anyone.

Some pages link out to GitHub, npm, and Docker Hub. Following such a link takes
you to a third party with its own privacy policy, which this page does not
cover.

## Your SOAT deployment

SOAT is self-hosted software. **You** run the server and the database, so every
piece of data SOAT stores — users, projects, API keys, documents, embeddings,
conversations, memories, traces, and audit records — lives in **your**
PostgreSQL instance, on infrastructure you control. The maintainers have no
access to it, receive no telemetry from it, and cannot see that your deployment
exists.

SOAT ships no model and hosts none. When an agent generates, your server calls
the provider you configured, and that provider's terms govern the prompt and
completion. If that matters for your data, the local Ollama setup in the quick
start keeps generation on your own hardware with no third-party call at all.

Two things worth knowing when you handle regulated data:

- Traces and generation records store prompts and completions by design, because
  they are the evidence of what an agent did. They can be purged per generation
  or per trace when you need the content gone.
- Secrets are encrypted at rest with a key you supply and hold. Losing that key
  means losing the secrets — the maintainers cannot recover them.

Because SOAT is Apache-2.0 licensed and self-hosted, you are the data controller
for anything it processes. See the
[self-hosting documentation](/docs/self-hosting/configuration) for the
configuration that governs retention and encryption.
