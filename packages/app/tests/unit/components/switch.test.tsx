import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { Switch } from '@/components/ui/switch';

describe('Switch', () => {
  test('renders a switch role reflecting checked state', () => {
    render(<Switch checked={false} onCheckedChange={() => {}} />);
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  test('on state fills with gradient and cyan glow', () => {
    render(<Switch checked onCheckedChange={() => {}} />);
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw.className).toContain('bg-galaxy-gradient');
    expect(sw.className).toMatch(/shadow-glow/);
  });

  test('calls onCheckedChange with the next value when clicked', async () => {
    function Controlled() {
      const [on, setOn] = useState(false);
      return (
        <Switch checked={on} onCheckedChange={setOn} label="Dark mode" />
      );
    }
    render(<Controlled />);
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  test('renders an associated label', () => {
    render(<Switch checked={false} onCheckedChange={() => {}} label="Wifi" />);
    expect(screen.getByText('Wifi')).toBeInTheDocument();
  });

  test('does not fire onCheckedChange when disabled', async () => {
    let calls = 0;
    render(
      <Switch
        checked={false}
        onCheckedChange={() => {
          calls += 1;
        }}
        disabled
      />
    );
    await userEvent.click(screen.getByRole('switch'));
    expect(calls).toBe(0);
  });
});
