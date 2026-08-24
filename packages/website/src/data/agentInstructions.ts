/**
 * Instructions for an agent deciding whether — and how — to use SOAT.
 *
 * The audit that prompted this file read the site as having "no agent
 * instruction file with when-to-use guidance", and it was right: every page
 * explained *what* SOAT is, and none of them said *which jobs to reach for it
 * on*. Marketing prose does not read as guidance to a model choosing between
 * tools; a named list of jobs, with the call to make for each, does.
 *
 * Declared once here and rendered into three places, so they cannot drift:
 *
 *   static/agents.md  the standalone instruction file
 *   llms.txt          the same guidance as the `rootContent` preamble
 *   the homepage      the "When to use SOAT" and onboarding sections
 */

export type UseCase = {
  /** The job to be done, phrased as a job and not as a feature. */
  job: string;
  /** What SOAT does about it, and the concrete call that does it. */
  how: string;
  /**
   * `how`, minus the trailing endpoint clause — the prose the homepage card
   * shows above its CLI command. `agents.md` and llms.txt render `how` in
   * full, since REST/MCP is the call surface an agent uses; the homepage
   * pairs this with `cli` instead.
   */
  description: string;
  /**
   * The same call, as the `soat` CLI commands a human would actually type.
   * Rendered on the homepage only. Omitted for jobs that have no CLI-shaped
   * equivalent (e.g. a protocol endpoint an MCP client calls, not a human).
   */
  cli?: string[];
};

/**
 * The jobs SOAT is the right tool for. Each names an operation, because a
 * use case an agent cannot act on is a claim, not guidance.
 */
export const USE_CASES: UseCase[] = [
  {
    job: 'Give an agent memory that survives the process',
    how: 'Sessions and conversations persist message history in PostgreSQL. `POST /api/v1/agents/{agent_id}/sessions`, then `POST /api/v1/sessions/{session_id}/messages` and `POST /api/v1/sessions/{session_id}/generate`.',
    description:
      'Sessions and conversations persist message history in PostgreSQL.',
    cli: [
      'soat create-session --agent-id agent_01',
      'soat add-session-message --session-id sess_01 --message "Hello!"',
      'soat generate-session-response --session-id sess_01 --wait true',
    ],
  },
  {
    job: 'Ground an agent in your own documents',
    how: 'Ingest files into chunked, embedded documents and search them with pgvector. `POST /api/v1/documents/ingest`, then `POST /api/v1/knowledge/search`.',
    description:
      'Ingest files into chunked, embedded documents and search them with pgvector.',
    cli: [
      'soat ingest-document --project-id proj_ABC --file-id file_01',
      'soat search-knowledge --project-id proj_ABC --query "quarterly revenue"',
    ],
  },
  {
    job: 'Run multi-step work deterministically instead of hoping one prompt covers it',
    how: 'Orchestrations are DAGs of agent, tool, and human nodes; workflows are state machines for long-running work. `POST /api/v1/orchestrations/{orchestration_id}/runs`.',
    description:
      'Orchestrations are DAGs of agent, tool, and human nodes; workflows are state machines for long-running work.',
    cli: ['soat start-orchestration-run --orchestration-id orch_01'],
  },
  {
    job: 'Bound what an agent is allowed to do',
    how: 'IAM policies gate every action, API keys scope to one project, guardrails screen input and output, and quotas cap spend. `POST /api/v1/policies`, `POST /api/v1/api-keys`, `POST /api/v1/quotas`.',
    description:
      'IAM policies gate every action, API keys scope to one project, guardrails screen input and output, and quotas cap spend.',
    cli: [
      'soat create-policy --name "Read Only Documents"',
      'soat create-api-key --name "CI/CD Pipeline"',
      'soat create-quota --project-id proj_ABC --metric requests --limit 600',
    ],
  },
  {
    job: 'Put a human in the loop without stopping the run',
    how: 'Approval nodes and exceptions pause a run, record who decided what, and resume from the same point. `POST /api/v1/approvals/{approval_id}/approve`.',
    description:
      'Approval nodes and exceptions pause a run, record who decided what, and resume from the same point.',
    cli: [
      'soat approve-approval --approval-id apr_01 --arguments \'{"amount": 450}\'',
    ],
  },
  {
    job: 'Prove after the fact what an agent did and what it cost',
    how: 'Every generation writes a trace with each tool call, model response, and token count, alongside an append-only audit log. `GET /api/v1/traces/{trace_id}/tree`.',
    description:
      'Every generation writes a trace with each tool call, model response, and token count, alongside an append-only audit log.',
    cli: ['soat get-trace-tree --trace-id trace_abc123'],
  },
  {
    job: 'Change an agent in production without guessing whether it got worse',
    how: 'Agent versions are append-only; a canary release splits traffic, and promotion is gated on a passing eval run. `POST /api/v1/agents/{agent_id}/release`.',
    description:
      'Agent versions are append-only; a canary release splits traffic, and promotion is gated on a passing eval run.',
    cli: [
      'soat set-agent-release --agent-id agent_01 \\\n  --stable-version 1 --canary-version 2 --canary-percent 20',
    ],
  },
  {
    job: 'Expose your own backend to an MCP client (Claude, Cursor, VS Code)',
    how: 'Every REST operation is also an MCP tool at `POST /mcp`, behind the same permission engine, with OAuth 2.1 discovery and Dynamic Client Registration.',
    description:
      'Every REST operation is also an MCP tool, behind the same permission engine, with OAuth 2.1 discovery and Dynamic Client Registration.',
  },
  {
    job: 'Stand up a whole agent stack reproducibly',
    how: 'Agent Formations declare providers, tools, agents, orchestrations, and webhooks in one template, resolve the dependency graph, and apply it. `POST /api/v1/formations`.',
    description:
      'Agent Formations declare providers, tools, agents, orchestrations, and webhooks in one template, resolve the dependency graph, and apply it.',
    cli: [
      'soat create-formation --project-id proj_ABC \\\n  --name "my-stack" --template-file formation.json',
    ],
  },
];

/**
 * Where SOAT is the wrong answer. Stated because an instruction file that only
 * says yes is useless for choosing between tools — and because two of these
 * are the mistakes callers actually make.
 */
export const NOT_FOR: string[] = [
  'You need a model. SOAT ships none and hosts none: it calls the provider you configure (OpenAI, Anthropic, Google, Bedrock, Ollama, or any OpenAI-compatible endpoint).',
  'You need one stateless completion and nothing else. Call the provider directly; SOAT earns its place once state, permissions, retrieval, or evidence are involved.',
  'You want a hosted control plane with no infrastructure of your own. SOAT is self-hosted software, not a SaaS — you run the server and the database.',
];

export type CallingRule = {
  topic: string;
  rule: string;
};

/** How to call SOAT once you have decided to. */
export const CALLING_RULES: CallingRule[] = [
  {
    topic: 'Surfaces',
    rule: 'One API, four ways in: REST under `/api/v1`, the MCP endpoint at `POST /mcp`, the `@soat/sdk` TypeScript client, and the `soat` CLI. The last three are generated from the same OpenAPI documents, so an operation that exists in one exists in all of them.',
  },
  {
    topic: 'Contract',
    rule: 'Read <https://soat.ttoss.dev/openapi.json> — every operation, schema, and security scheme in one OpenAPI 3.0 document. MCP tool names are the kebab-cased `operationId`.',
  },
  {
    topic: 'Base URL',
    rule: 'Your own deployment (`http://localhost:5047` out of the box). `soat.ttoss.dev` serves documentation only — there is no API behind it, so do not send calls there.',
  },
  {
    topic: 'Authentication',
    rule: 'Send `Authorization: Bearer <credential>`: a project API key (`sk_…`), a user JWT from `POST /api/v1/users/login`, or an OAuth 2.1 access token. OAuth clients discover the server at `/.well-known/oauth-authorization-server` (RFC 8414) and `/.well-known/oauth-protected-resource` (RFC 9728), and can register themselves at `/register` (RFC 7591) with no operator step.',
  },
  {
    topic: 'Field casing',
    rule: 'snake_case on the wire, everywhere — REST, MCP, webhooks, and the audit export. Unknown fields are rejected rather than ignored, so a typo fails loudly.',
  },
  {
    topic: 'Errors',
    rule: 'Every failure answers `{ "error": { "code", "message", "hint", "docs_url", "meta"? } }`. Branch on `code`, act on `hint`. The full catalog is at <https://soat.ttoss.dev/errors.json>.',
  },
  {
    topic: 'Long operations',
    rule: 'Anything that can outlast a request takes one toggle, `wait`, defaulting to background: you get `202` (or `201`) plus a handle to poll. Pass `wait=true` to block for the result instead.',
  },
  {
    topic: 'Pagination',
    rule: 'Every list endpoint takes `limit` and `offset` and returns the same envelope, so one paging loop works for all of them.',
  },
];

export type OnboardingStep = {
  step: string;
  detail: string;
};

/**
 * Getting in, start to first call. Every step is self-serve on purpose: there
 * is no signup, no waitlist, and no sales contact anywhere in this list — which
 * is the property an agent needs, since it cannot fill in a contact form.
 */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    step: 'Nothing to sign up for',
    detail:
      'SOAT is Apache-2.0 licensed and self-hosted. There is no account to create, no key to request, no trial to start, and no quota you have to ask anyone to raise.',
  },
  {
    step: 'Run the stack',
    detail:
      'Copy the Compose file from the quick start and run `docker compose up -d`. It brings up PostgreSQL with pgvector, a local Ollama for models, and the SOAT server on port 5047 — so the whole platform runs offline, with no third-party credential.',
  },
  {
    step: 'Get the first credential',
    detail:
      '`POST /api/v1/users/bootstrap` creates the first admin. It is open only until that admin exists, then closed for good, so the same call cannot be replayed against a running deployment.',
  },
  {
    step: 'Issue your own API key',
    detail:
      '`POST /api/v1/api-keys` (or `soat create-api-key`) mints a project-scoped `sk_…` key with exactly the actions of the policy you attach. Keys are self-serve and rotatable — `POST /api/v1/api-keys/{api_key_id}/rotate`.',
  },
  {
    step: 'The sandbox is the same software',
    detail:
      'There is no separate sandbox tier to request: a local instance is the product, so throwaway projects, seeded data, and destructive tests all run against your own deployment. Delete the volumes to reset.',
  },
];

const bulleted = (lines: string[]): string => {
  return lines
    .map((line) => {
      return `- ${line}`;
    })
    .join('\n');
};

/** The "when to use" block, shared by `agents.md` and the llms.txt preamble. */
export const buildWhenToUseMarkdown = (): string => {
  return `## When to use SOAT

Reach for SOAT when the job is one of these. Each line names the operation that
does it, so the decision and the call are in the same place.

${bulleted(
  USE_CASES.map((useCase) => {
    return `**${useCase.job}.** ${useCase.how}`;
  })
)}

## When not to use SOAT

${bulleted(NOT_FOR)}`;
};

/** The "how to call it" block. */
export const buildHowToCallMarkdown = (): string => {
  return `## How an agent should call SOAT

${bulleted(
  CALLING_RULES.map((rule) => {
    return `**${rule.topic}.** ${rule.rule}`;
  })
)}`;
};

/** The onboarding block. */
export const buildOnboardingMarkdown = (): string => {
  return `## Getting access

${bulleted(
  ONBOARDING_STEPS.map((step) => {
    return `**${step.step}.** ${step.detail}`;
  })
)}`;
};

/**
 * `static/agents.md` — the standalone agent instruction file, linked from
 * llms.txt, the homepage, robots.txt and the 404 recovery map.
 */
export const buildAgentInstructionsMarkdown = (): string => {
  return `# SOAT — instructions for agents

SOAT is self-hosted infrastructure for production-ready AI agents: durable
sessions, multi-agent orchestration, knowledge retrieval, memory, guardrails,
IAM, quotas, and traces, in one Node.js server backed by PostgreSQL and
pgvector.

This file is written for a machine deciding whether to use SOAT and how to call
it. Everything below is true of any SOAT deployment; the documentation site at
<https://soat.ttoss.dev> is static and serves no API.

${buildWhenToUseMarkdown()}

${buildHowToCallMarkdown()}

${buildOnboardingMarkdown()}

## Machine-readable surfaces

- <https://soat.ttoss.dev/llms.txt> — every documentation page, one line each
- <https://soat.ttoss.dev/llms-full.txt> — the whole prose corpus, ready to embed
- <https://soat.ttoss.dev/openapi.json> — the entire REST surface in one document
- <https://soat.ttoss.dev/errors.json> — every error code, its status, and what to do about it
- <https://soat.ttoss.dev/sitemap.xml> — every canonical URL with its last-modified date

Append \`.md\` to any documentation URL for its Markdown source, e.g.
<https://soat.ttoss.dev/docs/introduction.md>. Each HTML page advertises its own
twin with \`<link rel="alternate" type="text/markdown">\`, and sending
\`Accept: text/markdown\` to the page URL itself returns that Markdown — no URL
rewriting on your side.

## Source

Apache-2.0, developed in the open at <https://github.com/ttoss/soat>. Every
developer entry point — reference, specs, SDK, CLI, MCP, and how to get a
credential — is collected at <https://soat.ttoss.dev/developers>.
`;
};

/**
 * The preamble injected into `llms.txt` and `llms-full.txt`. The link index that
 * follows it answers "what is documented"; this answers "should I be here at
 * all", which is the question an agent has first.
 */
export const buildLlmsRootContent = (): string => {
  return `${buildWhenToUseMarkdown()}

${buildHowToCallMarkdown()}

${buildOnboardingMarkdown()}

Full agent instructions: <https://soat.ttoss.dev/agents.md>`;
};
