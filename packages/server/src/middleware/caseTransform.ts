import type { Context } from 'src/Context';
import {
  camelToSnakeKey as camelToSnake,
  isPlainObject,
  snakeToCamelKey as snakeToCamel,
} from 'src/lib/resource-inputs/normalizers';

type Next = () => Promise<void>;

const transformKeys = (
  obj: unknown,
  transform: (key: string) => string,
  skipKeys: Set<string> = new Set()
): unknown => {
  if (Array.isArray(obj)) {
    return obj.map((item) => {
      return transformKeys(item, transform, skipKeys);
    });
  }
  if (isPlainObject(obj)) {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => {
        const newKey = transform(key);
        if (skipKeys.has(newKey)) {
          // Pass-through fields (e.g. formation templates) must not be
          // recursively transformed — their inner keys are validated against
          // the OpenAPI spec which uses snake_case.
          return [newKey, value];
        }
        return [newKey, transformKeys(value, transform, skipKeys)];
      })
    );
  }
  return obj;
};

// The OpenAPI document is served as authored: valid OpenAPI uses camelCase
// structural keys (operationId, requestBody, …) while the API field names it
// describes stay snake_case. Running it through caseTransform would rewrite
// those structural keys to snake_case and produce an invalid spec, so the spec
// endpoint is excluded from case conversion entirely.
const OPENAPI_SPEC_PATH = '/api/v1/openapi.json';

// Only the documents module treats `metadata` as an arbitrary user-defined
// bag that must round-trip in the exact casing the caller wrote it in (e.g.
// `strapiDocumentId`). Other resources (e.g. conversation/session messages)
// store server-generated camelCase data under `metadata` and rely on the
// normal outbound camelCase → snake_case conversion, so the pass-through
// must be scoped to these paths rather than applied globally.
const METADATA_PASSTHROUGH_PATH_PREFIXES = [
  '/api/v1/documents',
  '/api/v1/knowledge/search',
];

const isMetadataPassthroughPath = (path: string): boolean => {
  return METADATA_PASSTHROUGH_PATH_PREFIXES.some((prefix) => {
    return path === prefix || path.startsWith(`${prefix}/`);
  });
};

// A tool's `input` is not part of SOAT's own resource contract — it is an
// opaque payload the tool forwards to its target (an `http` tool serializes it
// as the request body verbatim; a `pipeline` step's `input` mapping keys become
// the sub-tool's body keys). Case-transforming it would rewrite the field names
// a caller authored in snake_case (e.g. `fundamental_truth` → `fundamentalTruth`)
// before they reach the target API, which then rejects them. So on the tools
// routes `input` rounds-trips verbatim in both directions, exactly like
// `execute` and document `metadata`.
// An orchestration run's `input` is the same kind of opaque, caller-authored
// payload: its keys are seeded into run state (under the `input` namespace)
// and read back by node expressions via `{ "var": "input.<name>" }`.
// Case-transforming it would rewrite a caller's
// snake_case key (`cycle_task` → `cycleTask`) in state while the graph's `var`
// references keep the original casing, so every underscore-bearing input key
// resolves to null inside node logic even though it still shows up in the
// snake_case-restored final-state dump. So `input` rounds-trips verbatim on the
// orchestration-run routes too, exactly like a tool's `input`.
//
// `state` and `artifacts` (and the run's terminal `output`, which is just the
// terminal nodes' artifacts) carry the same problem one level deeper: their
// keys are either a `state_mapping` author's own state-path
// segments, or — since every node's artifact is recorded at
// `state.nodes.<nodeId>` / `artifacts.<nodeId>` / `output.<nodeId>` — the
// caller's own node ids. A node id like `nodeA` is exactly as
// caller-authored as a run-input key, and a graph's `{ "var": "nodes.nodeA...
// " }` reference keeps that casing internally, so rewriting it to `node_a` on
// the way out would desync the response from what the graph itself reads.
const INPUT_PASSTHROUGH_PATH_PREFIXES = [
  '/api/v1/tools',
  '/api/v1/orchestration-runs',
];

const isToolInputPassthroughPath = (path: string): boolean => {
  return INPUT_PASSTHROUGH_PATH_PREFIXES.some((prefix) => {
    return path === prefix || path.startsWith(`${prefix}/`);
  });
};

// A task's `payload` is an opaque, caller-authored bag exactly like an
// orchestration run's `input`: its keys are read back by guards and dispatch
// `input_mapping`s via `{ "var": "task.payload.<name>" }`, whose paths keep the
// authored casing. Case-transforming the payload would rewrite an underscore
// key (`approved_by_legal` → `approvedByLegal`) in storage while every guard/
// mapping reference still reads the original casing, so the reference resolves
// to null. So `payload` rounds-trips verbatim on the tasks routes.
const isTasksPath = (path: string): boolean => {
  return path === '/api/v1/tasks' || path.startsWith('/api/v1/tasks/');
};

// A workflow's `payload_schema` describes the shape of a task payload; its
// `properties` keys must stay in lockstep with the (pass-through) payload keys,
// so it round-trips verbatim on the workflows routes for the same reason.
const isWorkflowsPath = (path: string): boolean => {
  return path === '/api/v1/workflows' || path.startsWith('/api/v1/workflows/');
};

// A guardrail's `document` is a JSON Logic-bearing action-class bag: its keys
// are the contract fields `default_class` (two-word snake), `class`, `guard`,
// `escalate`, plus author-authored JSON Logic operators/vars. Case-transforming
// it would rewrite `default_class` → `defaultClass`, which the validator then
// rejects as an unknown field, and would mangle any snake_case `context.*` /
// `args.*` var the caller wrote. So `document` rounds-trips verbatim on the
// guardrails routes, exactly like a workflow `guard`. Scoped to this path so the
// IAM policies module's own `document` (single-word keys, a no-op either way) is
// untouched.
const isGuardrailsPath = (path: string): boolean => {
  return (
    path === '/api/v1/guardrails' || path.startsWith('/api/v1/guardrails/')
  );
};

// A `requires_action` generation returns the pending tool calls the caller must
// execute, each carrying an `args` object. For a client tool those keys mirror
// the caller-authored `parameters` JSON Schema (which is itself a `parameters`
// pass-through, stored and returned verbatim). Case-transforming `args` would
// rewrite the caller's own key names (e.g. `adAccountId` → `ad_account_id`) so
// the delivered payload diverges from the schema the caller owns — and a
// casing-sensitive downstream API then rejects it. So on every endpoint that
// can emit a `requires_action` result, `args` rounds-trips verbatim, exactly
// like `input`/`execute`/`parameters`. This is response-only: no request body
// carries an `args` key.
const TOOL_CALL_ARGS_PASSTHROUGH_PATH_PREFIXES = [
  '/api/v1/agents',
  '/api/v1/sessions',
  '/api/v1/conversations',
  '/api/v1/orchestrations',
];

const isToolCallArgsPassthroughPath = (path: string): boolean => {
  return TOOL_CALL_ARGS_PASSTHROUGH_PATH_PREFIXES.some((prefix) => {
    return path === prefix || path.startsWith(`${prefix}/`);
  });
};

// The inbound (snake→camel) pass-through keys for a given path.
// 'template' is a pass-through user document (formation templates),
// 'parameters' is the formation deploy-time value bag keyed against
// `template.parameters` and must stay in lockstep with those (also
// pass-through) names — independently case-transforming it would silently
// break the lookup for any parameter name containing an underscore.
// 'presetParameters' (the camelCase form of the request's preset_parameters
// field) is verbatim converter-tool input, and 'execute'/'mcp' are
// pass-through tool configs whose inner keys (HTTP header names, `body_mode`,
// …) must be preserved verbatim. 'stateMapping' (an orchestration node's
// state_mapping) is keyed by dotted run-state paths (e.g.
// `state.proposed.action_id`) — author-chosen, not schema field names — so
// case-transforming its keys would rewrite any underscore-bearing path
// segment while the node's own `{"var": "proposed.action_id"}` reads keep the
// original casing, silently desyncing the write from every downstream read.
// 'expression' (transform/condition nodes) and 'exitCondition' (poll nodes)
// are raw JSON Logic bodies whose inner object keys are author-authored data,
// not SOAT field names. The templating doc promises those keys round-trip
// verbatim: a `{"preserve": {"action_id": "x"}}` expression must land in
// `state.nodes.<id>.result` as `action_id`, so a downstream
// `{"var": "nodes.<id>.result.action_id"}` resolves it. Case-transforming them
// would rewrite `action_id` to `actionId` while the `var` reads keep the
// authored casing, so every underscore-bearing key resolves to null.
// 'metadata' (documents) and 'input' (tools) are path-scoped pass-throughs.
// This mirrors the outbound set below so each key round-trips unchanged.
const buildBodySkipKeys = (path: string): Set<string> => {
  const keys = new Set([
    'template',
    'parameters',
    'presetParameters',
    'execute',
    'mcp',
    'stateMapping',
    'expression',
    'exitCondition',
    // A workflow transition `guard` and an `on_complete` rule's `when` are raw
    // JSON Logic bodies, exactly like an orchestration node's `expression`:
    // their inner keys are author-authored data, not SOAT field names, so they
    // round-trip verbatim.
    'guard',
    'when',
    // A `headers` object is an HTTP header bag — its keys are header names
    // (`X-Auth`, `Content-Type`) that must round-trip verbatim, exactly like
    // the header names nested under `execute`/`mcp`. Case-transforming them
    // would rewrite `X-Auth` to `_x-_auth` on the way out (and mangle any
    // underscore-bearing name on the way in). Covers the orchestration webhook
    // emit node's `headers`.
    'headers',
    // A `guardrail_context` is an opaque, application-owned bag exactly like a
    // tool's `input` or a task's `payload`: the platform never interprets it, it
    // only evaluates a guardrail's JSON Logic `class` / `guard` over it via
    // `{ "var": "context.<name>" }`, whose paths keep the authored casing.
    // Case-transforming it would rewrite an underscore key (`max_daily_budget` →
    // `maxDailyBudget`) while the document's `var` reads keep the original
    // casing, so every underscore-bearing context key resolves to null and a
    // class-B guard fails closed. It appears on every generation / run-start /
    // dry-run body (agents, sessions, conversations, orchestrations, guardrails),
    // so it round-trips verbatim globally, exactly like `parameters`/`execute`.
    'guardrailContext',
  ]);
  if (isMetadataPassthroughPath(path)) keys.add('metadata');
  if (isToolInputPassthroughPath(path)) keys.add('input');
  if (isTasksPath(path)) keys.add('payload');
  if (isWorkflowsPath(path)) keys.add('payloadSchema');
  if (isGuardrailsPath(path)) {
    keys.add('document');
    // The dry-run `POST /guardrails/:id/evaluate` body carries `args` — the
    // proposed call's arguments, read back by the document via
    // `{ "var": "args.<name>" }`. At real dispatch these come from the model's
    // tool call (never case-transformed); the dry-run must match that fidelity,
    // so `args` round-trips verbatim on the guardrails routes too.
    keys.add('args');
  }
  return keys;
};

// The outbound (camel→snake) pass-through keys — the mirror of the inbound set.
// 'preset_parameters' is the snake_case form of the response's presetParameters.
// 'template' is a pass-through user document (formation templates): its inner
// keys — resource logical IDs and parameter names — are author-chosen
// identifiers that are stored verbatim on the way in, so they must be returned
// verbatim on the way out. Rewriting them (e.g. `DefaultProvider` →
// `_default_provider`, `aiProviderName` → `ai_provider_name`) would make the
// returned template diverge from what was stored and break `--parameter`
// overrides that reference the original key. 'parameters' and 'mcp' mirror
// the inbound set for the same reason (tool `parameters` is a free-form JSON
// Schema; `mcp` carries HTTP header names, same as `execute`). 'state_mapping',
// 'expression', and 'exit_condition' mirror the inbound 'stateMapping' /
// 'expression' / 'exitCondition' entries above so JSON Logic bodies round-trip
// with their author-authored inner keys intact.
const buildResponseSkipKeys = (path: string): Set<string> => {
  const keys = new Set([
    'template',
    'parameters',
    'execute',
    'mcp',
    'preset_parameters',
    'state_mapping',
    'expression',
    'exit_condition',
    // Mirror of the inbound `guard`/`when` skip — JSON Logic bodies round-trip
    // verbatim in responses.
    'guard',
    'when',
    // Mirror of the inbound `headers` skip — HTTP header names round-trip
    // verbatim in responses (e.g. the orchestration webhook node's `headers`).
    'headers',
  ]);
  if (isMetadataPassthroughPath(path)) keys.add('metadata');
  if (isToolInputPassthroughPath(path)) {
    keys.add('input');
    keys.add('state');
    keys.add('artifacts');
    keys.add('output');
  }
  if (isToolCallArgsPassthroughPath(path)) keys.add('args');
  if (isTasksPath(path)) keys.add('payload');
  if (isWorkflowsPath(path)) keys.add('payload_schema');
  if (isGuardrailsPath(path)) keys.add('document');
  return keys;
};

export const caseTransformMiddleware = async (ctx: Context, next: Next) => {
  if (!ctx.path.startsWith('/api/v1') || ctx.path === OPENAPI_SPEC_PATH) {
    await next();
    return;
  }

  // Transform incoming request body from snake_case to camelCase.
  if (isPlainObject(ctx.request.body) || Array.isArray(ctx.request.body)) {
    ctx.request.body = transformKeys(
      ctx.request.body,
      snakeToCamel,
      buildBodySkipKeys(ctx.path)
    ) as typeof ctx.request.body;
  }

  // Transform incoming query params from snake_case to camelCase
  const rawQuery = ctx.query as Record<string, unknown>;
  if (isPlainObject(rawQuery)) {
    ctx.query = transformKeys(rawQuery, snakeToCamel) as typeof ctx.query;
  }

  await next();

  // Transform outgoing response body from camelCase to snake_case.
  if (isPlainObject(ctx.body) || Array.isArray(ctx.body)) {
    ctx.body = transformKeys(
      ctx.body,
      camelToSnake,
      buildResponseSkipKeys(ctx.path)
    );
  }
};
