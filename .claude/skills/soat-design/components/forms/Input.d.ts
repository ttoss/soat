import * as React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Field label rendered above the input */
  label?: string;
  /** Icon node rendered inside, before the text */
  iconLeft?: React.ReactNode;
  /** Helper text below the field */
  hint?: string;
  /** Error message — turns the field red and replaces the hint */
  error?: string;
}

/**
 * Labeled text input with focus ring and optional leading icon.
 * @startingPoint section="Forms" subtitle="Text field with label, icon, hint & error states" viewport="700x140"
 */
export function Input(props: InputProps): React.ReactElement;
