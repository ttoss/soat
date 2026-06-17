import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * SOAT Tag — small outlined token chip for tech tags, filters, or resource
 * identifiers (project keys, model names). Lower emphasis than Badge. Set
 * `mono` for code-like values.
 */
export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  mono?: boolean;
}

export const Tag = ({
  className,
  mono = false,
  children,
  ...props
}: TagProps) => {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border border-border bg-transparent px-2 py-0.5 text-xs font-medium leading-tight text-muted-foreground',
        mono && 'font-mono',
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
};
