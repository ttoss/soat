import React from 'react';

/**
 * SOAT Tag — small outlined token chip. Use for tech tags, filters, or
 * resource labels (project keys, model names). Lower emphasis than Badge.
 */
export function Tag({ children, mono = false, style, ...rest }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
        padding: '0.2rem 0.55rem',
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-body)',
        fontSize: 'var(--text-xs)',
        fontWeight: 'var(--weight-medium)',
        color: 'var(--text-muted)',
        background: 'transparent',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-sm)',
        lineHeight: 1.4,
        ...style,
      }}
      {...rest}
    >
      {children}
    </span>
  );
}
