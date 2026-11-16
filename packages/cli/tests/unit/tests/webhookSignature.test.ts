import { createHmac } from 'node:crypto';

import { inspectDeliverySignature } from '../../../src/webhookSignature';

/**
 * Every sender, webhook delivery and trigger alike, signs `<t>.<body>` as
 * `X-Soat-Signature: t=<unix>,v1=<hex>`; any other value is invalid.
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

const bareBodyDigest = () => {
  return createHmac('sha256', SECRET).update(BODY).digest('hex');
};

describe('inspectDeliverySignature', () => {
  test('verifies a timestamped signature', () => {
    const result = inspectDeliverySignature({
      secret: SECRET,
      payload: BODY,
      headers: { 'x-soat-signature': timestampedHeader({}) },
    });

    expect(result).toEqual({ signature: timestampedHeader({}), valid: true });
  });

  test('rejects a timestamped signature computed with the wrong secret', () => {
    const result = inspectDeliverySignature({
      secret: SECRET,
      payload: BODY,
      headers: {
        'x-soat-signature': timestampedHeader({ secret: 'wrong-secret' }),
      },
    });

    expect(result.valid).toBe(false);
  });

  test('rejects a timestamped signature whose timestamp was tampered with', () => {
    const tampered = timestampedHeader({}).replace(
      't=1769865600',
      't=1769999999'
    );

    const result = inspectDeliverySignature({
      secret: SECRET,
      payload: BODY,
      headers: { 'x-soat-signature': tampered },
    });

    expect(result.valid).toBe(false);
  });

  test('rejects a timestamped-looking header missing its digest element', () => {
    const result = inspectDeliverySignature({
      secret: SECRET,
      payload: BODY,
      headers: { 'x-soat-signature': 't=1769865600' },
    });

    expect(result.valid).toBe(false);
  });

  test.each([
    ['a bare-body hex digest', bareBodyDigest()],
    ['a sha256= bare-body digest', `sha256=${bareBodyDigest()}`],
  ])('rejects %s', (_label, header) => {
    const result = inspectDeliverySignature({
      secret: SECRET,
      payload: BODY,
      headers: { 'x-soat-signature': header },
    });

    expect(result).toEqual({ signature: header, valid: false });
  });

  test('reports nothing verified when no secret is supplied', () => {
    const result = inspectDeliverySignature({
      payload: BODY,
      headers: { 'x-soat-signature': timestampedHeader({}) },
    });

    expect(result.valid).toBeNull();
  });

  test('reports an unsigned delivery as invalid rather than throwing', () => {
    const result = inspectDeliverySignature({
      secret: SECRET,
      payload: BODY,
      headers: {},
    });

    expect(result).toEqual({ signature: '', valid: false });
  });
});
