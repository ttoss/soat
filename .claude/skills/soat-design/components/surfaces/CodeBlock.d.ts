import * as React from 'react';

export interface CodeBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Code as a plain string */
  children?: string;
  /** Title bar label. @default "Terminal" */
  title?: string;
  /** Language label (overrides title when set) */
  language?: string;
}

/** Terminal-styled code surface with title bar and copy button. */
export function CodeBlock(props: CodeBlockProps): React.ReactElement;
