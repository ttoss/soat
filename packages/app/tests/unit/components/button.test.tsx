import { render, screen } from '@testing-library/react';

import { Button } from '@/components/ui/button';

describe('Button', () => {
  test('renders default variant with flat primary background (backward compat)', () => {
    render(<Button>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn.className).toContain('bg-primary');
    expect(btn.className).not.toContain('bg-action');
  });

  test('action variant paints the solid action colour with its text color and dark glow', () => {
    render(<Button variant="action">Get started</Button>);
    const btn = screen.getByRole('button', { name: 'Get started' });
    expect(btn.className).toContain('bg-action');
    expect(btn.className).not.toMatch(/gradient/);
    expect(btn.className).toContain('text-action-foreground');
    expect(btn.className).not.toContain('text-white');
    expect(btn.className).toContain('dark:shadow-glow');
  });

  test('action variant steps to the measured hover shade, not a brightness filter', () => {
    render(<Button variant="action">Bright</Button>);
    const btn = screen.getByRole('button', { name: 'Bright' });
    expect(btn.className).toContain('hover:bg-action-hover');
    expect(btn.className).not.toMatch(/brightness/);
  });

  test('action variant lifts on hover', () => {
    render(<Button variant="action">Lift</Button>);
    const btn = screen.getByRole('button', { name: 'Lift' });
    expect(btn.className).toMatch(/hover:-translate-y/);
  });

  test('forwards arbitrary props and merges className', () => {
    render(
      <Button variant="action" className="custom" disabled>
        X
      </Button>
    );
    const btn = screen.getByRole('button', { name: 'X' });
    expect(btn.className).toContain('custom');
    expect(btn).toBeDisabled();
  });
});
