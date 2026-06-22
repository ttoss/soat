import * as React from 'react';

export interface MethodBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** HTTP method. @default "GET" */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
}

/** Fixed-width color-coded HTTP method tag for the API reference. */
export function MethodBadge(props: MethodBadgeProps): React.ReactElement;
