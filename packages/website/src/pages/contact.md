---
title: Contact
description: How to reach the SOAT maintainers — support, bug reports, security disclosure, and commercial questions.
---

# Contact

SOAT is developed in the open by
[Terezinha Tech Operations (ttoss)](https://ttoss.dev). Every support channel is
public and self-serve: there is no contact form to fill in, no sales gate, and
no ticket portal. Pick the channel that matches what you need.

## Questions and help

Ask in
[GitHub Discussions](https://github.com/ttoss/soat/discussions). This is the
right place for "how do I…", architecture questions, and anything where you are
not yet sure whether the behavior you are seeing is a bug. Searching closed
discussions first is usually faster than waiting for a reply.

Before asking, check whether the answer is already written down — the
[documentation](/docs/introduction) covers every module, and
[llms.txt](https://soat.ttoss.dev/llms.txt) indexes every page in one file if you would rather grep
than browse.

## Bugs and feature requests

Open an issue at
[github.com/ttoss/soat/issues](https://github.com/ttoss/soat/issues). A useful
report names the SOAT version, how the server is deployed (Docker image, from
source, behind a proxy), the request you made, and the response you got. Error
responses carry a machine-readable `code` and a `docs_url` — include both, they
identify the failure precisely.

## Security vulnerabilities

**Do not open a public issue for a security vulnerability.** Report it privately
through
[GitHub's private vulnerability reporting](https://github.com/ttoss/soat/security/advisories/new).
The report stays confidential until a fix ships. The full policy — what is in
scope, and the acknowledgement and fix targets we aim for — is in
[SECURITY.md](https://github.com/ttoss/soat/blob/main/SECURITY.md).

## Contributing

Pull requests are welcome. Start with
[CONTRIBUTING.md](https://github.com/ttoss/soat/blob/main/CONTRIBUTING.md),
which covers the repository layout, the test suites, and what CI expects of a
change before it can merge.

## Commercial and trademark questions

For questions about the name or logo, see the
[trademark policy](https://github.com/ttoss/soat/blob/main/TRADEMARK.md). For
anything else that does not fit the channels above, open a
[discussion](https://github.com/ttoss/soat/discussions) — the maintainers read
them, and a public answer helps the next person with the same question.
