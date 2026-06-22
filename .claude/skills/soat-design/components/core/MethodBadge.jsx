import React from 'react';

/**
 * SOAT MethodBadge — HTTP method tag used throughout the API reference.
 * Fixed-width, uppercase, color-coded per method. Mirrors the docs site
 * sidebar badges (GET=blue/cyan, POST=green, DELETE=red, PUT=blue, PATCH=orange).
 */
export function MethodBadge({ method = 'GET', style, ...rest }) {
  const m = String(method).toUpperCase();
  const colors = {
    GET: 'var(--method-get)',
    POST: 'var(--method-post)',
    DELETE: 'var(--method-delete)',
    DEL: 'var(--method-delete)',
    PUT: 'var(--method-put)',
    PATCH: 'var(--method-patch)',
    HEAD: 'var(--text-faint)',
  };
  const label = m === 'DELETE' ? 'DEL' : m;
  return (
    <span
      style={{
        display: 'inline-block',
        minWidth: '52px',
        padding: '0.15rem 0',
        textAlign: 'center',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        fontWeight: 'var(--weight-semibold)',
        textTransform: 'uppercase',
        letterSpacing: 'var(--tracking-label)',
        color: 'var(--method-fg)',
        background: colors[m] || 'var(--text-faint)',
        border: '1px solid var(--method-border)',
        borderRadius: 'var(--radius-xs)',
        lineHeight: 1.5,
        ...style,
      }}
      {...rest}
    >
      {label}
    </span>
  );
}
