import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { StatusBadge } from '@/engine/statusBadge';

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
