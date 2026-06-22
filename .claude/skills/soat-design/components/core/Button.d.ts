import * as React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. @default "primary" */
  variant?: 'primary' | 'secondary' | 'ghost';
  /** Control size. @default "md" */
  size?: 'sm' | 'md' | 'lg';
  /** Icon node rendered before the label */
  iconLeft?: React.ReactNode;
  /** Icon node rendered after the label */
  iconRight?: React.ReactNode;
  disabled?: boolean;
  children?: React.ReactNode;
}

/**
 * Primary interactive control for SOAT surfaces.
 * @startingPoint section="Core" subtitle="Brand-gradient button with variants & sizes" viewport="700x180"
 */
export function Button(props: ButtonProps): React.ReactElement;
