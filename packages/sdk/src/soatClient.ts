import type { Client } from './generated/client/index.js';
import { createClient, createConfig } from './generated/client/index.js';
import type * as GeneratedSdk from './generated/sdk.gen.js';
import {
  Activity as ActivitySdk,
  Actors as ActorsSdk,
  Agents as AgentsSdk,
  AgentVersions as AgentVersionsSdk,
  AiProviders as AiProvidersSdk,
  ApiKeys as ApiKeysSdk,
  Approvals as ApprovalsSdk,
  AuditLog as AuditLogSdk,
  Chats as ChatsSdk,
  Conversations as ConversationsSdk,
  Discussions as DiscussionsSdk,
  Documents as DocumentsSdk,
  Embeddings as EmbeddingsSdk,
  Evaluations as EvaluationsSdk,
  Exceptions as ExceptionsSdk,
  Files as FilesSdk,
  Formations as FormationsSdk,
  Generations as GenerationsSdk,
  Guardrails as GuardrailsSdk,
  IngestionRules as IngestionRulesSdk,
  Knowledge as KnowledgeSdk,
  Memories as MemoriesSdk,
  MemoryEntries as MemoryEntriesSdk,
  ModelRoutes as ModelRoutesSdk,
  Orchestrations as OrchestrationsSdk,
  Policies as PoliciesSdk,
  Projects as ProjectsSdk,
  Quotas as QuotasSdk,
  Secrets as SecretsSdk,
  Sessions as SessionsSdk,
  Tasks as TasksSdk,
  Tools as ToolsSdk,
  Traces as TracesSdk,
  Triggers as TriggersSdk,
  Usage as UsageSdk,
  Users as UsersSdk,
  Webhooks as WebhooksSdk,
  Workflows as WorkflowsSdk,
} from './generated/sdk.gen.js';

/**
 * Wraps a static SDK class so that all its methods are callable as instance
 * methods, with the given `client` automatically injected into every call.
 *
 * The return type is preserved as `T` (= `typeof <StaticClass>`), so callers
 * get full TypeScript auto-complete and type checking without having to pass
 * `client` themselves.
 */
const bindResource = <T>(SdkClass: T, client: Client): T => {
  return new Proxy(SdkClass as object, {
    get: (target, prop) => {
      const value = (target as Record<string | symbol, unknown>)[
        prop as string | symbol
      ];
      if (typeof value === 'function') {
        return (options?: { client?: Client; [key: string]: unknown }) => {
          return (
            value as (o: { client?: Client; [key: string]: unknown }) => unknown
          )({ ...options, client });
        };
      }
      return value;
    },
  }) as T;
};

export interface SoatClientOptions {
  /**
   * Base URL of the SOAT API host.
   * Defaults to the current origin when not provided.
   *
   * @example 'https://api.example.com'
   */
  baseUrl?: string;
  /**
   * Bearer token (JWT or API key starting with `sk_`) used for authentication.
   * Sets the `Authorization: Bearer <token>` header on every request.
   */
  token?: string;
  /**
   * Custom headers merged into every request. Use this when you need fine-
   * grained control over auth headers or want to pass additional headers.
   */
  headers?: Record<string, string>;
}

/**
 * Stripe-style SOAT client.
 *
 * Create an instance once and reuse it throughout your application:
 *
 * ```ts
 * import { SoatClient } from '@soat/sdk';
 *
 * const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });
 *
 * const { data, error } = await soat.sessions.addSessionMessage({
 *   path: { agent_id: AGENT_ID, session_id: SESSION_ID },
 *   body: { message: 'What is the capital of France?' },
 * });
 * ```
 *
 * The instance exposes one property per API resource. Each property mirrors
 * the corresponding static class from the generated SDK, so all method
 * signatures, types, and return values are identical — the only difference
 * is that you never need to supply `client` yourself.
 *
 * The list is exhaustive by construction: `NoUnregisteredResource` at the
 * bottom of this file fails `pnpm typecheck` when a spec adds a resource this
 * class does not expose.
 */
export class SoatClient {
  readonly activity: typeof ActivitySdk;
  readonly actors: typeof ActorsSdk;
  readonly agents: typeof AgentsSdk;
  readonly agentVersions: typeof AgentVersionsSdk;
  readonly aiProviders: typeof AiProvidersSdk;
  readonly apiKeys: typeof ApiKeysSdk;
  readonly approvals: typeof ApprovalsSdk;
  readonly auditLog: typeof AuditLogSdk;
  readonly chats: typeof ChatsSdk;
  readonly conversations: typeof ConversationsSdk;
  readonly discussions: typeof DiscussionsSdk;
  readonly documents: typeof DocumentsSdk;
  readonly embeddings: typeof EmbeddingsSdk;
  readonly evaluations: typeof EvaluationsSdk;
  readonly exceptions: typeof ExceptionsSdk;
  readonly files: typeof FilesSdk;
  readonly formations: typeof FormationsSdk;
  readonly generations: typeof GenerationsSdk;
  readonly guardrails: typeof GuardrailsSdk;
  readonly ingestionRules: typeof IngestionRulesSdk;
  readonly knowledge: typeof KnowledgeSdk;
  readonly memories: typeof MemoriesSdk;
  readonly memoryEntries: typeof MemoryEntriesSdk;
  readonly modelRoutes: typeof ModelRoutesSdk;
  readonly orchestrations: typeof OrchestrationsSdk;
  readonly policies: typeof PoliciesSdk;
  readonly projects: typeof ProjectsSdk;
  readonly quotas: typeof QuotasSdk;
  readonly secrets: typeof SecretsSdk;
  readonly sessions: typeof SessionsSdk;
  readonly tasks: typeof TasksSdk;
  readonly tools: typeof ToolsSdk;
  readonly traces: typeof TracesSdk;
  readonly triggers: typeof TriggersSdk;
  readonly usage: typeof UsageSdk;
  readonly users: typeof UsersSdk;
  readonly webhooks: typeof WebhooksSdk;
  readonly workflows: typeof WorkflowsSdk;

  constructor({ baseUrl, token, headers }: SoatClientOptions = {}) {
    const authHeaders: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    const httpClient = createClient(
      createConfig({
        baseUrl: baseUrl ?? '',
        headers: { ...authHeaders, ...headers },
      })
    );

    this.activity = bindResource(ActivitySdk, httpClient);
    this.actors = bindResource(ActorsSdk, httpClient);
    this.agents = bindResource(AgentsSdk, httpClient);
    this.agentVersions = bindResource(AgentVersionsSdk, httpClient);
    this.aiProviders = bindResource(AiProvidersSdk, httpClient);
    this.apiKeys = bindResource(ApiKeysSdk, httpClient);
    this.approvals = bindResource(ApprovalsSdk, httpClient);
    this.auditLog = bindResource(AuditLogSdk, httpClient);
    this.chats = bindResource(ChatsSdk, httpClient);
    this.conversations = bindResource(ConversationsSdk, httpClient);
    this.discussions = bindResource(DiscussionsSdk, httpClient);
    this.documents = bindResource(DocumentsSdk, httpClient);
    this.embeddings = bindResource(EmbeddingsSdk, httpClient);
    this.evaluations = bindResource(EvaluationsSdk, httpClient);
    this.exceptions = bindResource(ExceptionsSdk, httpClient);
    this.files = bindResource(FilesSdk, httpClient);
    this.formations = bindResource(FormationsSdk, httpClient);
    this.generations = bindResource(GenerationsSdk, httpClient);
    this.guardrails = bindResource(GuardrailsSdk, httpClient);
    this.ingestionRules = bindResource(IngestionRulesSdk, httpClient);
    this.knowledge = bindResource(KnowledgeSdk, httpClient);
    this.memories = bindResource(MemoriesSdk, httpClient);
    this.memoryEntries = bindResource(MemoryEntriesSdk, httpClient);
    this.modelRoutes = bindResource(ModelRoutesSdk, httpClient);
    this.orchestrations = bindResource(OrchestrationsSdk, httpClient);
    this.policies = bindResource(PoliciesSdk, httpClient);
    this.projects = bindResource(ProjectsSdk, httpClient);
    this.quotas = bindResource(QuotasSdk, httpClient);
    this.secrets = bindResource(SecretsSdk, httpClient);
    this.sessions = bindResource(SessionsSdk, httpClient);
    this.tasks = bindResource(TasksSdk, httpClient);
    this.tools = bindResource(ToolsSdk, httpClient);
    this.traces = bindResource(TracesSdk, httpClient);
    this.triggers = bindResource(TriggersSdk, httpClient);
    this.usage = bindResource(UsageSdk, httpClient);
    this.users = bindResource(UsersSdk, httpClient);
    this.webhooks = bindResource(WebhooksSdk, httpClient);
    this.workflows = bindResource(WorkflowsSdk, httpClient);
  }
}

/**
 * Every resource class the generator emits, keyed the way `SoatClient` exposes
 * it (`Evaluations` → `evaluations`, `AgentVersions` → `agentVersions`).
 */
type GeneratedResourceKey = Uncapitalize<
  Extract<
    {
      [
        K in keyof typeof GeneratedSdk
      ]: (typeof GeneratedSdk)[K] extends abstract new (
        ...args: never[]
      ) => unknown
        ? K
        : never;
    }[keyof typeof GeneratedSdk],
    string
  >
>;

/**
 * Fails `pnpm typecheck` when a generated resource is missing from
 * `SoatClient`, naming the missing keys in the error.
 *
 * The property list above is written out by hand so the class reads clearly and
 * its `.d.ts` stays stable; this constraint is what keeps that list honest.
 * Fifteen resources had drifted off it — `evaluations`, `agentVersions` and
 * `generations` among them — and nothing failed, because a missing property is
 * only ever discovered by a caller reaching for it. Tutorials referenced all
 * three.
 *
 * When this errors, add the named resource to the imports, the property list,
 * and the constructor.
 */
export type NoUnregisteredResource<
  T extends never = Exclude<GeneratedResourceKey, keyof SoatClient>,
> = T;
