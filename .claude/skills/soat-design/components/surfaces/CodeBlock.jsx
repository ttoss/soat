import React from 'react';

/**
 * SOAT CodeBlock — terminal/CLI-styled code surface with an uppercase title
 * bar and a copy button. Matches the docs site code blocks (dark #0d1117
 * content, cyan-tinted title bar in dark mode). Pass plain string children.
 */
export function CodeBlock({ children, title = 'Terminal', language, style, ...rest }) {
  const [copied, setCopied] = React.useState(false);
  const code = typeof children === 'string' ? children : String(children ?? '');

  const copy = () => {
    try {
      navigator.clipboard?.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      /* noop */
    }
  };

  return (
    <div
      style={{
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-sm)',
        fontFamily: 'var(--font-mono)',
        ...style,
      }}
      {...rest}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.45rem 0.9rem',
          background: 'var(--surface-sunken)',
          borderBottom: '1px solid var(--border-default)',
          fontSize: 'var(--text-xs)',
          fontWeight: 'var(--weight-semibold)',
          letterSpacing: 'var(--tracking-label)',
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
        }}
      >
        <span>{language || title}</span>
        <button
          type="button"
          onClick={copy}
          style={{
            border: 'none',
            background: 'transparent',
            color: copied ? 'var(--color-success)' : 'var(--text-faint)',
            fontFamily: 'var(--font-body)',
            fontSize: 'var(--text-xs)',
            fontWeight: 'var(--weight-medium)',
            cursor: 'pointer',
            padding: '0.15rem 0.4rem',
            borderRadius: 'var(--radius-sm)',
            textTransform: 'none',
            letterSpacing: 0,
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: '1.1rem 1.3rem',
          background: 'var(--surface-code)',
          color: 'var(--text-body)',
          fontSize: 'var(--text-code)',
          lineHeight: 'var(--leading-code)',
          overflowX: 'auto',
        }}
      >
        <code style={{ background: 'none', border: 'none', padding: 0, fontFamily: 'var(--font-mono)' }}>{code}</code>
      </pre>
    </div>
  );
}
