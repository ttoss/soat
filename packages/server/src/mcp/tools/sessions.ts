import type { McpServer } from '@ttoss/http-server-mcp';
import { apiCall, registerToolFromSchema } from '@ttoss/http-server-mcp';

import { tools } from '../../lib/soat-tools/sessions';

const registerTools = (server: McpServer) => {
  for (const def of tools) {
    registerToolFromSchema(server, {
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      handler: async (args) => {
        const data = await apiCall(def.method, def.path(args), {
          body: def.body?.(args),
        });
        const text =
          data != null ? JSON.stringify(data) : 'Deleted successfully.';
        return { content: [{ type: 'text', text }] };
      },
    });
  }
};

export { registerTools };
