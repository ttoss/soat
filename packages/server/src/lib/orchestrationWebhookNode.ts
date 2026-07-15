import { createHmac } from 'node:crypto';

import { applyInputMapping } from './jsonLogicMapping';
import type { NodeExecutionResult } from './orchestrationNodeExecutors';
import type { OrchestrationNode } from './orchestrations';
import {
  resolveSecretRefsInRecord,
  resolveSecretRefsInString,
} from './secrets';

/**
 * Resolves the emit request's headers and signature. `headers` values may carry
 * `{{secret:...}}` tokens (auth), and when `signingSecret` is set the serialized
 * body is HMAC-SHA256 signed and the digest attached as `X-Soat-Signature`. Both
 * secrets are resolved against the run's project.
 */
const buildWebhookEmitHeaders = async (args: {
  node: OrchestrationNode;
  body: string;
  projectId?: number;
}): Promise<Record<string, string>> => {
  const { node, body, projectId } = args;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (node.headers && projectId !== undefined) {
    const resolved = await resolveSecretRefsInRecord({
      record: node.headers,
      projectId,
    });
    Object.assign(headers, resolved);
  } else if (node.headers) {
    // No project scope to resolve against — pass literal (non-secret) headers.
    Object.assign(headers, node.headers);
  }

  if (node.signingSecret) {
    const secret =
      projectId !== undefined
        ? await resolveSecretRefsInString({
            value: node.signingSecret,
            projectId,
          })
        : node.signingSecret;
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Soat-Signature'] = `sha256=${signature}`;
  }

  return headers;
};

/**
 * Executes a `webhook` node. `mode: "receive"` parks the run awaiting a
 * callback. `mode: "emit"` POSTs the input-mapped payload to `webhookUrl`,
 * optionally authenticated via secret-templated `headers` and/or HMAC signed
 * (`signingSecret`). The POST is awaited so delivery is observable in the node
 * artifact; a transport failure records `delivered: false` without failing the
 * run.
 */
export const executeWebhookNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectId?: number;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectId } = args;
  const mode = node.mode ?? 'emit';
  if (mode === 'receive') {
    const context = applyInputMapping(node.inputMapping, state);
    return {
      kind: 'requires_action',
      type: 'webhook_receive',
      nodeId: node.id,
      prompt: 'Waiting for webhook callback.',
      context,
    };
  }
  if (!node.webhookUrl) {
    return { kind: 'artifact', artifact: { emitted: true } };
  }

  const payload = applyInputMapping(node.inputMapping, state);
  const body = JSON.stringify(payload);
  const url =
    projectId !== undefined
      ? await resolveSecretRefsInString({ value: node.webhookUrl, projectId })
      : node.webhookUrl;
  const headers = await buildWebhookEmitHeaders({ node, body, projectId });

  try {
    const response = await fetch(url, { method: 'POST', headers, body });
    return {
      kind: 'artifact',
      artifact: {
        emitted: true,
        delivered: response.ok,
        status: response.status,
        signed: Boolean(node.signingSecret),
      },
    };
  } catch {
    return {
      kind: 'artifact',
      artifact: {
        emitted: true,
        delivered: false,
        signed: Boolean(node.signingSecret),
      },
    };
  }
};
