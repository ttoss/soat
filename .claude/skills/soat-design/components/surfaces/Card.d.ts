import * as React from 'react';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Surface style. @default "solid" */
  variant?: 'solid' | 'glass';
  /** Lift and glow on hover (for clickable feature grids) */
  interactive?: boolean;
  /** CSS padding value. @default var(--space-6) */
  padding?: string;
  children?: React.ReactNode;
}

/**
 * Raised surface container — solid panel or blurred glass HUD.
 * @startingPoint section="Surfaces" subtitle="Solid & glass card containers, optional hover lift" viewport="700x220"
 */
export function Card(props: CardProps): React.ReactElement;
