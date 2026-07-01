import { describe, expect, test } from 'vitest';

import { statusTone } from '@/engine/statusUtils';

describe('statusTone', () => {
  test('maps active/completed/open/succeeded to success', () => {
    expect(statusTone('active')).toBe('success');
    expect(statusTone('completed')).toBe('success');
    expect(statusTone('open')).toBe('success');
    expect(statusTone('succeeded')).toBe('success');
  });

  test('maps error/failed/expired to danger', () => {
    expect(statusTone('error')).toBe('danger');
    expect(statusTone('failed')).toBe('danger');
    expect(statusTone('expired')).toBe('danger');
  });

  test('maps pending/in_progress to warning', () => {
    expect(statusTone('pending')).toBe('warning');
    expect(statusTone('in_progress')).toBe('warning');
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
    expect(statusTone('In_Progress')).toBe('warning');
  });
});
