import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * SOAT Switch — accessible boolean toggle. On-state fills with the brand
 * galaxy gradient and emits a soft cyan glow in dark mode. Controlled via
 * `checked` / `onCheckedChange`.
 */
export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export const Switch = ({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  id,
  className,
}: SwitchProps) => {
  const handleClick = () => {
    if (!disabled) {
      onCheckedChange(!checked);
    }
  };

  const control = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={handleClick}
      className={cn(
        'relative inline-flex h-[22px] w-10 flex-shrink-0 items-center rounded-full border transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        checked
          ? 'border-transparent bg-galaxy-gradient shadow-glow-cyan-sm'
          : 'border-border bg-muted'
      )}
    >
      <span
        className={cn(
          'pointer-events-none absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all',
          checked ? 'left-5' : 'left-0.5'
        )}
      />
    </button>
  );

  if (!label) {
    return <span className={className}>{control}</span>;
  }

  return (
    <label
      className={cn(
        'inline-flex items-center gap-2 text-sm text-foreground',
        disabled && 'cursor-not-allowed opacity-50',
        className
      )}
    >
      {control}
      <span>{label}</span>
    </label>
  );
};
