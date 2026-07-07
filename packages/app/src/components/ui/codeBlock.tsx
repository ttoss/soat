import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * SOAT CodeBlock — terminal/CLI-styled code surface with an uppercase title
 * bar and a copy button. Pass code as a plain string child.
 */
export interface CodeBlockProps {
  children: string;
  title?: string;
  language?: string;
  className?: string;
}

const COPIED_RESET_MS = 1400;

export const CodeBlock = ({
  children,
  title = 'Terminal',
  language,
  className,
}: CodeBlockProps) => {
  const [copied, setCopied] = React.useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(children);
    setCopied(true);
    window.setTimeout(() => {
      return setCopied(false);
    }, COPIED_RESET_MS);
  };

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-border font-mono shadow-xs',
        className
      )}
    >
      <div className="flex items-center justify-between border-b border-border bg-muted px-3.5 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span>{language ?? title}</span>
        <button
          type="button"
          onClick={copy}
          className={cn(
            'rounded-sm px-1.5 py-0.5 text-xs font-medium normal-case tracking-normal transition-colors',
            copied
              ? 'text-green-600 dark:text-green-400'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="m-0 overflow-x-auto bg-card px-5 py-4 text-foreground">
        <code className="bg-transparent p-0 font-mono">{children}</code>
      </pre>
    </div>
  );
};
