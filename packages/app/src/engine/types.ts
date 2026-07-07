export type ViewMode = 'list' | 'detail' | 'create' | 'edit' | 'action';

export type ViewDescriptor = {
  tag: string;
  operationId: string;
  pathParams: Record<string, string>;
  mode: ViewMode;
};

export type OpenApiSchema = {
  type?: string;
  format?: string;
  enum?: string[];
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  description?: string;
  default?: JsonValue;
  $ref?: string;
  /**
   * Vendor extension marking a field as a reference to another REST resource,
   * named by its path segment (e.g. `projects`, `ai-providers`). The generic
   * engine uses it two ways: form fields render as a picker populated from
   * `GET /api/v1/<ref>`, and list/detail cells render the id as a link that
   * opens that resource's detail view. Ignored by the SDK/CLI generators.
   */
  'x-soat-ref'?: string;
};

export type OpenApiParameter = {
  name: string;
  in: string;
  required?: boolean;
  schema?: OpenApiSchema;
  description?: string;
};

export type OpenApiOperation = {
  operationId: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: {
      'application/json'?: { schema?: OpenApiSchema };
      'multipart/form-data'?: { schema?: OpenApiSchema };
    };
  };
  responses?: Record<
    string,
    {
      content?: { 'application/json'?: { schema?: OpenApiSchema } };
    }
  >;
};

export type OpenApiPathItem = {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
};

export type OpenApiSpec = {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
  };
};

export type ModuleOp = {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  pathTemplate: string;
  operation: OpenApiOperation;
};

export type ModuleInfo = {
  tag: string;
  label: string;
  isProjectScoped: boolean;
  listOp?: ModuleOp;
  getOp?: ModuleOp;
  createOp?: ModuleOp;
  updateOp?: ModuleOp;
  deleteOp?: ModuleOp;
  // Item-scoped POST operations that are not the module's create
  // (e.g. POST /agents/{agent_id}/generate). Rendered as action forms.
  actions?: ModuleOp[];
};

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue =
  string | number | boolean | null | JsonValue[] | JsonObject;
