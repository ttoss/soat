import type { JsonObjectSchema } from '@ttoss/http-server-mcp';

export interface SoatToolDefinition {
  name: string;
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: (args: Record<string, unknown>) => string;
  body?: (args: Record<string, unknown>) => unknown;
  inputSchema: JsonObjectSchema;
  iamAction?: string;
}
