import { render, screen } from '@testing-library/react';

import { Button } from '@/components/ui/button';

describe('Button', () => {
  test('renders default variant with flat primary background (backward compat)', () => {
    render(<Button>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn.className).toContain('bg-primary');
    expect(btn.className).not.toContain('bg-galaxy-gradient');
  });

  test('gradient variant paints the action gradient with its text color and dark glow', () => {
    render(<Button variant="gradient">Get started</Button>);
    const btn = screen.getByRole('button', { name: 'Get started' });
    expect(btn.className).toContain('bg-action-gradient');
    expect(btn.className).toContain('text-action-foreground');
    expect(btn.className).not.toContain('text-white');
    expect(btn.className).toContain('dark:shadow-glow');
  });

  test('gradient variant does not brighten on hover, which would drop its text contrast', () => {
    render(<Button variant="gradient">Bright</Button>);
    const btn = screen.getByRole('button', { name: 'Bright' });
    expect(btn.className).not.toMatch(/brightness/);
  });

  test('gradient variant lifts on hover', () => {
    render(<Button variant="gradient">Lift</Button>);
    const btn = screen.getByRole('button', { name: 'Lift' });
    expect(btn.className).toMatch(/hover:-translate-y/);
  });

  test('forwards arbitrary props and merges className', () => {
    render(
      <Button variant="gradient" className="custom" disabled>
        X
      </Button>
    );
    const btn = screen.getByRole('button', { name: 'X' });
    expect(btn.className).toContain('custom');
    expect(btn).toBeDisabled();
  });
});
