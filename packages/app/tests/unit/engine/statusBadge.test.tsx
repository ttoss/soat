import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { statusTone, StatusBadge } from '@/engine/statusBadge';

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

describe('StatusBadge', () => {
  test('renders the humanized status label inside a badge', () => {
    render(<StatusBadge status="in_progress" />);
    const badge = screen.getByText('In Progress');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('rounded-full');
  });

  test('renders an error badge when the error flag is set', () => {
    render(<StatusBadge error />);
    expect(screen.getByText('Error')).toBeInTheDocument();
  });

  test('renders nothing when status is empty and no error', () => {
    const { container } = render(<StatusBadge status="" />);
    expect(container).toBeEmptyDOMElement();
  });
});
