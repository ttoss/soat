import { createHmac } from 'node:crypto';

import { inspectDeliverySignature } from '../../../src/webhookSignature';

/**
 * `soat listen` is the tool the docs point users at before they aim a webhook
 * at a real endpoint, so it has to verify the schemes it actually receives. A
 * webhook delivery signs `<t>.<body>` under `X-Soat-Signature-V2`; a trigger
 * payload signs the bare body under `X-Soat-Signature`. The listener accepts
 * either and says which one it checked.
 */

const SECRET = 'whsec_test_secret';
const BODY = JSON.stringify({ event: 'files.created', resource_id: 'fil_1' });

const timestampedHeader = (args: {
  secret?: string;
  body?: string;
  timestamp?: string;
}) => {
  const timestamp = args.timestamp ?? '1769865600';
  const digest = createHmac('sha256', args.secret ?? SECRET)
    .update(`${timestamp}.${args.body ?? BODY}`)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
};

const bareBodyHeader = (args: { secret?: string; body?: string }) => {
  return createHmac('sha256', args.secret ?? SECRET)
    .update(args.body ?? BODY)
    .digest('hex');
};

describe('inspectDeliverySignature', () => {
  test('verifies a timestamped v2 signature', () => {
    const result = inspectDeliverySignature({
      secret: SECRET,
      payload: BODY,
      headers: { 'x-soat-signature-v2': timestampedHeader({}) },
    });

    expect(result).toEqual({
      signature: timestampedHeader({}),
      scheme: 'v2',
      valid: true,
    });
  });

  test('rejects a v2 signature computed with the wrong secret', () => {
    const result = inspectDeliverySignature({
      secret: SECRET,
      payload: BODY,
      headers: {
        'x-soat-signature-v2': timestampedHeader({ secret: 'wrong-secret' }),
      },
    });

    expect(result.valid).toBe(false);
  });

  test('rejects a v2 signature whose timestamp was tampered with', () => {
    // The digest covers `<t>.<body>`, so swapping the timestamp alone must
    // break verification — that is the whole point of signing it.
    const tampered = timestampedHeader({}).replace(
      't=1769865600',
      't=1769999999'
    );

    const result = inspectDeliverySignature({
      secret: SECRET,
      payload: BODY,
      headers: { 'x-soat-signature-v2': tampered },
    });

    expect(result.valid).toBe(false);
  });

  test('rejects a v2 header missing its digest element', () => {
    const result = inspectDeliverySignature({
      secret: SECRET,
      payload: BODY,
      headers: { 'x-soat-signature-v2': 't=1769865600' },
    });

    expect(result.valid).toBe(false);
  });

  test('checks the bare-body scheme when v2 is absent', () => {
    const result = inspectDeliverySignature({
      secret: SECRET,
      payload: BODY,
      headers: { 'x-soat-signature': bareBodyHeader({}) },
    });

    expect(result).toEqual({
      signature: bareBodyHeader({}),
      scheme: 'v1',
      valid: true,
    });
  });

  test('rejects a bare-body signature computed with the wrong secret', () => {
    const result = inspectDeliverySignature({
      secret: SECRET,
      payload: BODY,
      headers: {
        'x-soat-signature': bareBodyHeader({ secret: 'wrong-secret' }),
      },
    });

    expect(result.valid).toBe(false);
  });

  test('prefers v2 when a payload carries both headers', () => {
    const result = inspectDeliverySignature({
      secret: SECRET,
      payload: BODY,
      headers: {
        'x-soat-signature-v2': timestampedHeader({}),
        'x-soat-signature': bareBodyHeader({}),
      },
    });

    expect(result.scheme).toBe('v2');
    expect(result.valid).toBe(true);
  });

  test('reports nothing verified when no secret is supplied', () => {
    const result = inspectDeliverySignature({
      payload: BODY,
      headers: { 'x-soat-signature-v2': timestampedHeader({}) },
    });

    expect(result.valid).toBeNull();
    expect(result.scheme).toBe('v2');
  });

  test('reports an unsigned delivery as invalid rather than throwing', () => {
    const result = inspectDeliverySignature({
      secret: SECRET,
      payload: BODY,
      headers: {},
    });

    expect(result).toEqual({ signature: '', scheme: 'v1', valid: false });
  });
});
