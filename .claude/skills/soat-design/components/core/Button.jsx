import React from 'react';

/**
 * SOAT Button — the primary interactive control.
 * Primary variant uses the brand gradient (Deep Violet -> Electric Blue in
 * light, -> Core Cyan in dark) and lifts on hover; in dark mode it emits a
 * cyan glow. Secondary is a bordered surface button; ghost is text-only.
 */
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  iconLeft,
  iconRight,
  disabled = false,
  type = 'button',
  onClick,
  style,
  ...rest
}) {
  const sizes = {
    sm: { padding: '0.4rem 0.85rem', fontSize: 'var(--text-sm)', gap: '0.4rem' },
    md: { padding: '0.6rem 1.2rem', fontSize: 'var(--text-sm)', gap: '0.5rem' },
    lg: { padding: '0.85rem 1.75rem', fontSize: 'var(--text-base)', gap: '0.6rem' },
  };

  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--font-body)',
    fontWeight: 'var(--weight-semibold)',
    letterSpacing: 'var(--tracking-ui)',
    borderRadius: 'var(--radius-md)',
    border: '1px solid transparent',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-standard), background var(--duration-base) var(--ease-standard)',
    whiteSpace: 'nowrap',
    lineHeight: 1.2,
    ...sizes[size],
  };

  const variants = {
    primary: {
      background: 'var(--gradient-brand)',
      color: '#ffffff', /* gradient stays dark in both themes, so white is the correct contrast (not --color-primary-contrast, which flips dark in dark mode) */
      boxShadow: 'var(--shadow-sm)',
    },
    secondary: {
      background: 'var(--surface-raised)',
      color: 'var(--text-strong)',
      borderColor: 'var(--border-default)',
    },
    ghost: {
      background: 'transparent',
      color: 'var(--color-primary)',
    },
  };

  const [hover, setHover] = React.useState(false);
  const hoverStyle = !disabled && hover
    ? variant === 'primary'
      ? { transform: 'translateY(-2px)', boxShadow: 'var(--glow-cyan-md)' }
      : variant === 'secondary'
        ? { borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }
        : { background: 'var(--surface-raised)' }
    : {};

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...base, ...variants[variant], ...hoverStyle, ...style }}
      {...rest}
    >
      {iconLeft ? <span style={{ display: 'inline-flex' }}>{iconLeft}</span> : null}
      {children}
      {iconRight ? <span style={{ display: 'inline-flex' }}>{iconRight}</span> : null}
    </button>
  );
}
