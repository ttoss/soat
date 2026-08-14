/**
 * Benchmark solutions dataset.
 *
 * One JSON file per solution. Adding a solution:
 *   1. Create `<slug>.json` following the shape validated by
 *      `scripts/solutionsData.test.ts` (run `pnpm test` in this package).
 *   2. Import it below and add it to `solutions`.
 * The test suite fails if a file exists that is not imported here.
 */
import deepseekHarness from './deepseek-harness.json';
import hermesAgent from './hermes-agent.json';
import langchain from './langchain.json';
import openclaw from './openclaw.json';
import soat from './soat.json';
import vertexAiAgentBuilder from './vertex-ai-agent-builder.json';

export type Archetype = 'managed-platform' | 'framework' | 'infrastructure';

export type Rating = 'native' | 'partial' | 'plugin' | 'absent';

export type Deployment = 'self-hosted' | 'managed';

export interface Capability {
  rating: Rating;
  note: string;
  evidence?: string;
}

export interface Solution {
  name: string;
  slug: string;
  archetype: Archetype;
  summary: string;
  website: string;
  repository?: string;
  license: string;
  deployment: Deployment[];
  last_verified: string;
  capabilities: Record<string, Capability>;
}

export interface Cluster {
  id: string;
  label: string;
  description: string;
}

export const CLUSTERS: Cluster[] = [
  {
    id: 'agent-runtime',
    label: 'Agent runtime',
    description: 'Agent loop, sessions, and generation lifecycle.',
  },
  {
    id: 'orchestration',
    label: 'Orchestration',
    description: 'Multi-step pipelines, workflows, and triggers.',
  },
  {
    id: 'knowledge-memory',
    label: 'Knowledge & memory',
    description: 'Documents, embeddings, semantic search, and recall.',
  },
  {
    id: 'tools-integration',
    label: 'Tools & integration',
    description: 'Tool calling, MCP, providers, and webhooks.',
  },
  {
    id: 'identity-governance',
    label: 'Identity & governance',
    description: 'IAM, guardrails, approvals, quotas, and audit.',
  },
  {
    id: 'observability',
    label: 'Observability',
    description: 'Traces, activity, usage, and failure queues.',
  },
  {
    id: 'data-secrets',
    label: 'Data & secrets',
    description: 'File storage and encrypted secrets.',
  },
  {
    id: 'evaluation',
    label: 'Evaluation',
    description: 'Datasets, scorers, and eval-gated improvement.',
  },
  {
    id: 'channels',
    label: 'Channels',
    description: 'Built-in gateways to messaging platforms and UIs.',
  },
  {
    id: 'code-execution',
    label: 'Code execution',
    description: 'Sandboxed code or terminal runtimes for agents.',
  },
];

export const ARCHETYPE_LABELS: Record<Archetype, string> = {
  'managed-platform': 'Managed platform',
  framework: 'Framework',
  infrastructure: 'Infrastructure',
};

export const RATING_LABELS: Record<Rating, string> = {
  native: 'Native',
  partial: 'Partial',
  plugin: 'Via plugin',
  absent: 'Absent',
};

const asSolution = (value: {
  archetype: string;
  deployment: string[];
  capabilities: Record<string, { rating: string; note: string }>;
}): Solution => {
  // JSON imports widen enum-like fields to `string`; the dataset test
  // (scripts/solutionsData.test.ts) enforces the actual value sets.
  return value as Solution;
};

export const solutions: Solution[] = [
  asSolution(soat),
  asSolution(vertexAiAgentBuilder),
  asSolution(langchain),
  asSolution(deepseekHarness),
  asSolution(hermesAgent),
  asSolution(openclaw),
];
