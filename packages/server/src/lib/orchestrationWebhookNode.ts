import { createHmac } from 'node:crypto';

import { DomainError } from '../errors';
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
 * artifact.
 *
 * Delivery failure handling depends on `requireDelivery`:
 * - `false`/unset (default) — a transport failure or non-2xx response records
 *   `delivered: false` without failing the run (fire-and-observe).
 * - `true` — a transport failure or non-2xx response throws a retriable
 *   `ORCHESTRATION_WEBHOOK_DELIVERY_FAILED`, so the failed attempt is recorded
 *   and the node's `retry` policy governs re-delivery; once attempts are
 *   exhausted the run fails rather than dropping a critical alert.
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
  const signed = Boolean(node.signingSecret);
  const requireDelivery = Boolean(node.requireDelivery);

  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body });
  } catch (error: unknown) {
    if (requireDelivery) {
      // Throw a retriable error so the node's retry policy applies and, once
      // exhausted, the run fails — a required alert is never silently dropped.
      throw new DomainError(
        'ORCHESTRATION_WEBHOOK_DELIVERY_FAILED',
        `Webhook node '${node.id}' failed to deliver: ${
          error instanceof Error ? error.message : String(error)
        }.`
      );
    }
    return {
      kind: 'artifact',
      artifact: { emitted: true, delivered: false, signed },
    };
  }

  if (requireDelivery && !response.ok) {
    throw new DomainError(
      'ORCHESTRATION_WEBHOOK_DELIVERY_FAILED',
      `Webhook node '${node.id}' delivery returned a non-2xx status (${response.status}).`
    );
  }

  return {
    kind: 'artifact',
    artifact: {
      emitted: true,
      delivered: response.ok,
      status: response.status,
      signed,
    },
  };
};
