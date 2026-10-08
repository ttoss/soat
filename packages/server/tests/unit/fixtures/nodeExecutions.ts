import { authenticatedTestClient } from '../testClient';

/** One node execution of a run, as `GET .../node-executions` answers it. */
export type NodeExecutionRow = {
  node_id: string;
  node_type: string;
  attempt: number;
  dispatches: number;
  status: string;
  input: unknown;
  output: unknown;
  error: { code?: string; message: string } | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
};

/** Every node execution of a run, oldest first, read page by page. */
export const nodeExecutionsOf = async (args: {
  token: string;
  runId: string;
}): Promise<NodeExecutionRow[]> => {
  const rows: NodeExecutionRow[] = [];
  for (;;) {
    const res = await authenticatedTestClient(args.token)
      .get(`/api/v1/orchestration-runs/${args.runId}/node-executions`)
      .query({ limit: 100, offset: rows.length });
    if (res.status !== 200) {
      throw new Error(`node-executions answered ${res.status}`);
    }
    rows.push(...(res.body.data as NodeExecutionRow[]));
    if (rows.length >= res.body.total) return rows;
  }
};
