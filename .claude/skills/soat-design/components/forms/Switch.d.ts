import * as React from 'react';

export interface SwitchProps {
  /** On/off state */
  checked?: boolean;
  /** Called with the next boolean value */
  onChange?: (checked: boolean) => void;
  /** Optional trailing label */
  label?: string;
  disabled?: boolean;
  id?: string;
}

/** Boolean toggle switch with brand-gradient on-state and dark-mode glow. */
export function Switch(props: SwitchProps): React.ReactElement;
