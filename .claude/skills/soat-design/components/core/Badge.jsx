import React from 'react';

/**
 * SOAT Badge — compact status/label pill.
 * Tonal by default (soft tinted background); the "glow" tone emits a cyan
 * halo for the dark-mode HUD feel. Use for statuses like healthy/running.
 */
export function Badge({ children, tone = 'neutral', dot = false, style, ...rest }) {
  const tones = {
    neutral: { bg: 'var(--surface-sunken)', fg: 'var(--text-muted)', dot: 'var(--text-faint)' },
    primary: { bg: 'color-mix(in srgb, var(--color-primary) 14%, transparent)', fg: 'var(--color-primary)', dot: 'var(--color-primary)' },
    success: { bg: 'color-mix(in srgb, var(--color-success) 14%, transparent)', fg: 'var(--color-success)', dot: 'var(--color-success)' },
    danger: { bg: 'color-mix(in srgb, var(--color-danger) 14%, transparent)', fg: 'var(--color-danger)', dot: 'var(--color-danger)' },
    warning: { bg: 'color-mix(in srgb, var(--color-warning) 16%, transparent)', fg: 'var(--color-warning)', dot: 'var(--color-warning)' },
    glow: { bg: 'color-mix(in srgb, var(--color-glow) 14%, transparent)', fg: 'var(--color-primary)', dot: 'var(--color-glow)' },
  };
  const t = tones[tone] || tones.neutral;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.4rem',
        padding: '0.2rem 0.6rem',
        fontFamily: 'var(--font-body)',
        fontSize: 'var(--text-xs)',
        fontWeight: 'var(--weight-semibold)',
        letterSpacing: 'var(--tracking-ui)',
        lineHeight: 1.4,
        color: t.fg,
        background: t.bg,
        borderRadius: 'var(--radius-full)',
        boxShadow: tone === 'glow' ? 'var(--glow-cyan-sm)' : 'none',
        ...style,
      }}
      {...rest}
    >
      {dot ? (
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.dot, boxShadow: tone === 'glow' ? 'var(--glow-cyan-sm)' : 'none' }} />
      ) : null}
      {children}
    </span>
  );
}
