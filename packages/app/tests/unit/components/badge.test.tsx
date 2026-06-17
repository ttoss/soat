import { render, screen } from '@testing-library/react';

import { Badge } from '@/components/ui/badge';

describe('Badge', () => {
  test('renders neutral tone by default', () => {
    render(<Badge>v1.1</Badge>);
    const el = screen.getByText('v1.1');
    expect(el.className).toContain('rounded-full');
    expect(el.className).toContain('text-muted-foreground');
  });

  test('success tone uses success colors', () => {
    render(<Badge tone="success">healthy</Badge>);
    expect(screen.getByText('healthy').className).toMatch(/green|success/);
  });

  test('danger tone uses destructive colors', () => {
    render(<Badge tone="danger">failed</Badge>);
    expect(screen.getByText('failed').className).toMatch(/red|destructive/);
  });

  test('glow tone emits a cyan glow shadow', () => {
    render(<Badge tone="glow">MCP native</Badge>);
    expect(screen.getByText('MCP native').className).toMatch(/shadow-glow/);
  });

  test('renders a status dot when dot is set', () => {
    render(
      <Badge tone="primary" dot>
        running
      </Badge>
    );
    const el = screen.getByText('running');
    expect(el.querySelector('[data-slot="badge-dot"]')).not.toBeNull();
  });

  test('merges custom className', () => {
    render(<Badge className="extra">x</Badge>);
    expect(screen.getByText('x').className).toContain('extra');
  });
});
