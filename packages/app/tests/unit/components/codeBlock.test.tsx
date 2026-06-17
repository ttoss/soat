import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CodeBlock } from '@/components/ui/codeBlock';

describe('CodeBlock', () => {
  test('renders the code content and a default title bar', () => {
    render(<CodeBlock>{'docker compose up -d'}</CodeBlock>);
    expect(screen.getByText('docker compose up -d')).toBeInTheDocument();
    expect(screen.getByText('Terminal')).toBeInTheDocument();
  });

  test('language overrides the title', () => {
    render(<CodeBlock language="bash">{'ls -la'}</CodeBlock>);
    expect(screen.getByText('bash')).toBeInTheDocument();
  });

  test('copy button writes the code to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<CodeBlock title="Terminal">{'echo hi'}</CodeBlock>);
    await userEvent.click(screen.getByRole('button', { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith('echo hi');
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });

  test('merges custom className on the wrapper', () => {
    const { container } = render(
      <CodeBlock className="extra">{'x'}</CodeBlock>
    );
    expect(container.firstElementChild?.className).toContain('extra');
  });
});
