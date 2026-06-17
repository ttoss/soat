import { render, screen } from '@testing-library/react';

import { Tag } from '@/components/ui/tag';

describe('Tag', () => {
  test('renders an outlined chip', () => {
    render(<Tag>TypeScript</Tag>);
    const el = screen.getByText('TypeScript');
    expect(el.className).toContain('border');
    expect(el.className).toContain('text-muted-foreground');
  });

  test('mono prop applies a monospace font', () => {
    render(<Tag mono>qwen2.5:0.5b</Tag>);
    expect(screen.getByText('qwen2.5:0.5b').className).toContain('font-mono');
  });

  test('merges custom className', () => {
    render(<Tag className="extra">x</Tag>);
    expect(screen.getByText('x').className).toContain('extra');
  });
});
