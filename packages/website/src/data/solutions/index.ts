/**
 * Benchmark solutions dataset.
 *
 * One JSON file per solution. Adding a solution:
 *   1. Create `<slug>.json` following the shape validated by
 *      `scripts/solutionsData.test.ts` (run `pnpm test` in this package).
 *   2. Import it below and add it to `solutions`.
 * The test suite fails if a file exists that is not imported here.
 */
import awsBedrockAgentcore from './aws-bedrock-agentcore.json';
import azureAiFoundryAgentService from './azure-ai-foundry-agent-service.json';
import claudeDeveloperPlatform from './claude-developer-platform.json';
import crewai from './crewai.json';
import deepseekHarness from './deepseek-harness.json';
import dify from './dify.json';
import hermesAgent from './hermes-agent.json';
import langchain from './langchain.json';
import langgraph from './langgraph.json';
import letta from './letta.json';
import microsoftAgentFramework from './microsoft-agent-framework.json';
import openaiAgentsPlatform from './openai-agents-platform.json';
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
  {
    id: 'human-in-loop',
    label: 'Human-in-the-loop',
    description: 'Pausing a run for human approval, then resuming it.',
  },
  {
    id: 'multi-tenancy',
    label: 'Multi-tenancy',
    description: 'Projects or workspaces scoping resources and permissions.',
  },
  {
    id: 'declarative-deployment',
    label: 'Declarative deployment',
    description: 'Templates that provision agent resources as one stack.',
  },
  {
    id: 'agent-versioning',
    label: 'Versioning & rollout',
    description: 'Agent versions, canary rollout, gated promotion.',
  },
  {
    id: 'skill-learning',
    label: 'Skill learning',
    description: 'Agents authoring reusable skills from their own experience.',
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
  asSolution(awsBedrockAgentcore),
  asSolution(azureAiFoundryAgentService),
  asSolution(claudeDeveloperPlatform),
  asSolution(crewai),
  asSolution(deepseekHarness),
  asSolution(dify),
  asSolution(hermesAgent),
  asSolution(langchain),
  asSolution(langgraph),
  asSolution(letta),
  asSolution(microsoftAgentFramework),
  asSolution(openaiAgentsPlatform),
  asSolution(openclaw),
  asSolution(vertexAiAgentBuilder),
];

/**
 * SOAT is the baseline every other solution is read against, so it leads
 * the directory and the comparator regardless of the dataset's file order.
 */
export const PINNED_SLUG = 'soat';

export const orderSolutions = (entries: Solution[]): Solution[] => {
  return [...entries].sort((a, b) => {
    if (a.slug === PINNED_SLUG) {
      return -1;
    }
    if (b.slug === PINNED_SLUG) {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });
};
