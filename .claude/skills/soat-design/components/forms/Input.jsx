import React from 'react';

/**
 * SOAT Input — text field with optional label and leading icon.
 * Focus state shows the brand focus ring; in dark mode both the border and
 * ring resolve to Core Cyan via the theme tokens.
 */
export function Input({
  label,
  id,
  iconLeft,
  hint,
  error,
  type = 'text',
  style,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const inputId = id || (label ? `in-${label.replace(/\s+/g, '-').toLowerCase()}` : undefined);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontFamily: 'var(--font-body)' }}>
      {label ? (
        <label htmlFor={inputId} style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)', color: 'var(--text-body)', letterSpacing: 'var(--tracking-ui)' }}>
          {label}
        </label>
      ) : null}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.6rem 0.75rem',
          background: 'var(--surface-page)',
          border: `1px solid ${error ? 'var(--color-danger)' : focus ? 'var(--border-focus)' : 'var(--border-default)'}`,
          borderRadius: 'var(--radius-md)',
          boxShadow: focus ? 'var(--ring-focus)' : 'none',
          transition: 'border-color var(--duration-base) var(--ease-standard), box-shadow var(--duration-base) var(--ease-standard)',
        }}
      >
        {iconLeft ? <span style={{ display: 'inline-flex', color: 'var(--text-faint)' }}>{iconLeft}</span> : null}
        <input
          id={inputId}
          type={type}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--text-strong)',
            fontFamily: 'inherit',
            fontSize: 'var(--text-sm)',
            ...style,
          }}
          {...rest}
        />
      </div>
      {error ? (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-danger)' }}>{error}</span>
      ) : hint ? (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>{hint}</span>
      ) : null}
    </div>
  );
}
