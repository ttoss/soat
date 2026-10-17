import { describe, expect, test } from 'vitest';

import { statusTone } from '@/engine/statusUtils';

describe('statusTone', () => {
  test('maps active/completed/open to success', () => {
    expect(statusTone('active')).toBe('success');
    expect(statusTone('completed')).toBe('success');
    expect(statusTone('open')).toBe('success');
  });

  test('maps error/failed/expired to danger', () => {
    expect(statusTone('error')).toBe('danger');
    expect(statusTone('failed')).toBe('danger');
    expect(statusTone('expired')).toBe('danger');
  });

  test('maps pending/queued/running to warning', () => {
    expect(statusTone('pending')).toBe('warning');
    expect(statusTone('queued')).toBe('warning');
    expect(statusTone('running')).toBe('warning');
  });

  test('maps inactive/closed to neutral', () => {
    expect(statusTone('inactive')).toBe('neutral');
    expect(statusTone('closed')).toBe('neutral');
  });

  test('falls back to neutral for unknown values', () => {
    expect(statusTone('whatever')).toBe('neutral');
  });

  test('is case-insensitive', () => {
    expect(statusTone('ACTIVE')).toBe('success');
    expect(statusTone('Requires_Action')).toBe('warning');
  });
});
