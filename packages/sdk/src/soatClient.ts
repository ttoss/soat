import type { Client } from './generated/client/index.js';
import { createClient, createConfig } from './generated/client/index.js';
import {
  Actors as ActorsSdk,
  Agents as AgentsSdk,
  AiProviders as AiProvidersSdk,
  ApiKeys as ApiKeysSdk,
  Chats as ChatsSdk,
  Conversations as ConversationsSdk,
  Documents as DocumentsSdk,
  Files as FilesSdk,
  Formations as FormationsSdk,
  IngestionRules as IngestionRulesSdk,
  Knowledge as KnowledgeSdk,
  Memories as MemoriesSdk,
  MemoryEntries as MemoryEntriesSdk,
  Policies as PoliciesSdk,
  Projects as ProjectsSdk,
  Secrets as SecretsSdk,
  Sessions as SessionsSdk,
  Tools as ToolsSdk,
  Traces as TracesSdk,
  Triggers as TriggersSdk,
  Users as UsersSdk,
  Webhooks as WebhooksSdk,
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
 */
export class SoatClient {
  readonly actors: typeof ActorsSdk;
  readonly agents: typeof AgentsSdk;
  readonly aiProviders: typeof AiProvidersSdk;
  readonly apiKeys: typeof ApiKeysSdk;
  readonly chats: typeof ChatsSdk;
  readonly conversations: typeof ConversationsSdk;
  readonly documents: typeof DocumentsSdk;
  readonly files: typeof FilesSdk;
  readonly formations: typeof FormationsSdk;
  readonly ingestionRules: typeof IngestionRulesSdk;
  readonly knowledge: typeof KnowledgeSdk;
  readonly memories: typeof MemoriesSdk;
  readonly memoryEntries: typeof MemoryEntriesSdk;
  readonly policies: typeof PoliciesSdk;
  readonly projects: typeof ProjectsSdk;
  readonly secrets: typeof SecretsSdk;
  readonly sessions: typeof SessionsSdk;
  readonly tools: typeof ToolsSdk;
  readonly traces: typeof TracesSdk;
  readonly triggers: typeof TriggersSdk;
  readonly users: typeof UsersSdk;
  readonly webhooks: typeof WebhooksSdk;

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

    this.actors = bindResource(ActorsSdk, httpClient);
    this.agents = bindResource(AgentsSdk, httpClient);
    this.aiProviders = bindResource(AiProvidersSdk, httpClient);
    this.apiKeys = bindResource(ApiKeysSdk, httpClient);
    this.chats = bindResource(ChatsSdk, httpClient);
    this.conversations = bindResource(ConversationsSdk, httpClient);
    this.documents = bindResource(DocumentsSdk, httpClient);
    this.files = bindResource(FilesSdk, httpClient);
    this.formations = bindResource(FormationsSdk, httpClient);
    this.ingestionRules = bindResource(IngestionRulesSdk, httpClient);
    this.knowledge = bindResource(KnowledgeSdk, httpClient);
    this.memories = bindResource(MemoriesSdk, httpClient);
    this.memoryEntries = bindResource(MemoryEntriesSdk, httpClient);
    this.policies = bindResource(PoliciesSdk, httpClient);
    this.projects = bindResource(ProjectsSdk, httpClient);
    this.secrets = bindResource(SecretsSdk, httpClient);
    this.sessions = bindResource(SessionsSdk, httpClient);
    this.tools = bindResource(ToolsSdk, httpClient);
    this.traces = bindResource(TracesSdk, httpClient);
    this.triggers = bindResource(TriggersSdk, httpClient);
    this.users = bindResource(UsersSdk, httpClient);
    this.webhooks = bindResource(WebhooksSdk, httpClient);
  }
}
