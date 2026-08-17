# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/ttoss/soat/security/advisories/new)
— the "Report a vulnerability" button on the repository's Security tab. The
report stays confidential until a fix ships.

Include as much of this as you can:

- the affected version or commit, and how SOAT was deployed (Docker image,
  source, behind a proxy)
- what an attacker gains — data read, privilege gained, availability lost
- reproduction steps or a proof of concept
- any configuration required to trigger it

## What to expect

| Stage                                                 | Target           |
| ----------------------------------------------------- | ---------------- |
| Acknowledgement                                       | 3 business days  |
| Initial assessment and severity                       | 10 business days |
| Fix or mitigation for a confirmed high-severity issue | 30 days          |

SOAT is maintained by a small team. These are targets we aim for, not
contractual commitments. If you have not heard back within the acknowledgement
window, please ping the advisory thread.

## Disclosure

We prefer coordinated disclosure. When a fix is released we publish a GitHub
Security Advisory crediting the reporter, unless they ask us not to. Please give
us a reasonable window to ship a fix before disclosing publicly.

## Supported versions

Fixes land on `main` and ship in the next release. There are no long-term
support branches — run a recent version.

## Scope

In scope: the SOAT server, SDK, CLI, web app, and the published Docker image.

Areas that matter most, given what SOAT holds:

- authentication, and the IAM policy engine — privilege escalation or policy
  bypass
- project isolation — reaching another project's resources with a scoped key
- secrets storage and encryption at rest
- API key, JWT, and OAuth token handling
- SSRF through agent HTTP tools, and prompt-injection paths that reach a real
  side effect through a tool call
- webhook signature verification, and guardrail or approval bypass

Out of scope: misconfiguration of your own deployment, missing hardening in the
development compose files, resource-exhaustion denial of service against an
unauthenticated self-hosted instance, and vulnerabilities in third-party model
providers.
