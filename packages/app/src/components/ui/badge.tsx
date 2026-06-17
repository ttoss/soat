import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * SOAT Badge — compact status/label pill. Tonal by default (soft tinted
 * background); the `glow` tone emits a cyan halo for the dark-mode HUD feel.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold leading-tight',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-muted-foreground',
        primary: 'bg-primary/15 text-primary',
        success: 'bg-green-500/15 text-green-600 dark:text-green-400',
        danger: 'bg-destructive/15 text-destructive',
        warning: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
        glow: 'bg-brand-cyan/15 text-primary shadow-glow-cyan-sm',
      },
    },
    defaultVariants: {
      tone: 'neutral',
    },
  }
);

const dotColors: Record<string, string> = {
  neutral: 'bg-muted-foreground',
  primary: 'bg-primary',
  success: 'bg-green-500',
  danger: 'bg-destructive',
  warning: 'bg-orange-500',
  glow: 'bg-brand-cyan shadow-glow-cyan-sm',
};

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

export const Badge = ({
  className,
  tone,
  dot = false,
  children,
  ...props
}: BadgeProps) => {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot ? (
        <span
          data-slot="badge-dot"
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            dotColors[tone ?? 'neutral']
          )}
        />
      ) : null}
      {children}
    </span>
  );
};
