import * as React from 'react';

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Use monospace font (for keys, model ids, code-like values) */
  mono?: boolean;
  children?: React.ReactNode;
}

/** Low-emphasis outlined chip for tech tags, filters, and resource labels. */
export function Tag(props: TagProps): React.ReactElement;
