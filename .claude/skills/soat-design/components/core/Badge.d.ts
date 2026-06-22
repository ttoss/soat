import * as React from 'react';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Color tone. @default "neutral" */
  tone?: 'neutral' | 'primary' | 'success' | 'danger' | 'warning' | 'glow';
  /** Show a leading status dot */
  dot?: boolean;
  children?: React.ReactNode;
}

/** Compact status/label pill with tonal backgrounds and optional glow. */
export function Badge(props: BadgeProps): React.ReactElement;
