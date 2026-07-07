import crypto from 'node:crypto';

import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { findWebhookTriggerForDelivery } from 'src/lib/triggers';

const hooksRouter = new Router<Context>();

/** Timing-safe check of `X-Soat-Signature: sha256=<hex>` over the raw body. */
const verifySignature = (args: {
  secret: string;
  rawBody: string;
  header?: string;
}): boolean => {
  if (!args.header) return false;
  const expected = `sha256=${crypto
    .createHmac('sha256', args.secret)
    .update(args.rawBody)
    .digest('hex')}`;
  const provided = Buffer.from(args.header);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length) return false;
  return crypto.timingSafeEqual(provided, computed);
};

/**
 * Turns the raw request body into fire-time input. A JSON object is used as-is;
 * any other JSON value is wrapped as `{ payload: <value> }`. Invalid JSON is a
 * `400`.
 */
const parseHookInput = (rawBody: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new DomainError(
      'HOOK_INVALID_JSON',
      'Inbound hook body is not valid JSON.'
    );
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return { payload: parsed };
};

/**
 * Public, HMAC-authenticated inbound endpoint for webhook triggers. Deliberately
 * outside `/api/v1`: no bearer auth, no snake→camel case transform of the
 * external payload, and excluded from the generated SDK/CLI/MCP surface.
 */
hooksRouter.post('/hooks/triggers/:trigger_id', async (ctx: Context) => {
  const triggerId = ctx.params.trigger_id;

  const trigger = await findWebhookTriggerForDelivery({ id: triggerId });
  // Unknown or non-webhook trigger → 404 (existence is not leaked).
  if (!trigger) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Not found.');
  }

  const rawBody = (ctx.hookRawBody as string | undefined) ?? '';
  const signatureOk = verifySignature({
    secret: trigger.secret,
    rawBody,
    header: ctx.headers['x-soat-signature'] as string | undefined,
  });
  if (!signatureOk) {
    throw new DomainError('UNAUTHORIZED', 'Invalid or missing signature.');
  }

  // Inactive is only revealed after a valid signature.
  if (!trigger.active) {
    throw new DomainError('TRIGGER_NOT_ACTIVE', 'Trigger is inactive.');
  }

  const fireInput = parseHookInput(rawBody);

  // Loaded lazily (not a static import) so mounting this router at app level
  // does not front-load triggerDispatch's heavy graph (agents/tools/
  // orchestration) at server init — that reordered module init and broke the
  // orchestrations↔engine import cycle. By first hook call, all modules are
  // fully initialized.
  const { prepareFiring, runFiringDispatch } =
    await import('../lib/triggerDispatch');

  // Pre-flight synchronously (invalid input → 400, etc.), then dispatch in the
  // background and acknowledge with 202 + the auditable firing id.
  const prepared = await prepareFiring({
    triggerPublicId: triggerId,
    source: 'webhook',
    fireInput,
  });

  // Acknowledge before kicking off dispatch — runFiringDispatch mutates the
  // shared firing instance (→ `running`) synchronously once invoked.
  ctx.status = 202;
  ctx.body = {
    firing_id: prepared.firing.publicId,
    trigger_id: triggerId,
    status: prepared.firing.status,
  };

  // Fire-and-forget: runFiringDispatch never rejects (failures are recorded on
  // the firing record), so no rejection handler is needed.
  void runFiringDispatch(prepared);
});

export { hooksRouter };
