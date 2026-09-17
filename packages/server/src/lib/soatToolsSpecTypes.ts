/**
 * The slices of an OpenAPI document this package reads, and the `x-soat-*`
 * extensions it adds to them.
 *
 * Apart from keeping `soatToolsHelpers.ts` under the module ceiling, these
 * living on their own breaks the type-only cycle that file had with
 * `soatToolsSchemaHelpers.ts`, which needs `OpenApiSpec` and nothing else.
 */

export interface OpenApiSpec {
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
  };
}

export type RequestBodySpec = {
  required?: boolean;
  content?: {
    'application/json'?: {
      schema?: {
        type?: string;
        required?: string[];
        properties?: Record<string, unknown>;
        oneOf?: Array<Record<string, unknown>>;
        anyOf?: Array<Record<string, unknown>>;
        $ref?: string;
      };
    };
  };
};

export interface OperationSpec {
  operationId?: string;
  description?: string;
  parameters?: Array<{
    name?: string;
    in?: string;
    required?: boolean;
    description?: string;
    schema?: {
      type?: string;
      items?: { type?: string };
    };
    $ref?: string;
  }>;
  requestBody?: RequestBodySpec;
  'x-iam-action'?: string;
  /**
   * The argument that names this operation's target, as `{ kind, from }`:
   * `from` is the path parameter, query parameter or body field carrying a
   * public id, and `kind` is the resource type that id belongs to.
   *
   * It is what lets an agent's `boundary_policy` be evaluated against the SRN
   * and tags of the resource a call actually touches, the way the route
   * evaluates the caller's policy. An operation that declares none —
   * a listing, a create, anything project-scoped — is evaluated against `*`,
   * which is the whole truth about a call that names no resource.
   */
  'x-soat-resource'?: { kind?: string; from?: string };
  /** When true, the operation is excluded from the MCP tool surface. */
  'x-soat-mcp-exclude'?: boolean;
  /**
   * When true, an **agent** may not be bound to this operation, though an MCP
   * client still can.
   *
   * The two surfaces differ in who chooses the arguments. An MCP client is a
   * person acting as themselves; an agent's builtin tool is an LLM acting
   * inside a generation, under a bearer somebody else handed it. So an
   * operation that mints a credential, rewrites authorization, reads secret
   * material or settles an approval is one the agent surface withholds even
   * where that bearer would allow it — the approval gate in particular exists
   * to put a person between an agent and an action, and an agent that can
   * resolve its own approval has removed them.
   */
  'x-soat-agent-exclude'?: boolean;
}
