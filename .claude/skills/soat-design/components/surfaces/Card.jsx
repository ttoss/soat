import React from 'react';

/**
 * SOAT Card — raised surface container. Default is a calm bordered panel;
 * the "glass" variant uses backdrop blur for the HUD feel; set `interactive`
 * to lift and glow on hover (used for feature/surface grids).
 */
export function Card({
  children,
  variant = 'solid',
  interactive = false,
  padding = 'var(--space-6)',
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);

  const variants = {
    solid: { background: 'var(--surface-raised)', backdropFilter: 'none' },
    glass: {
      background: 'var(--surface-overlay)',
      backdropFilter: 'blur(var(--blur-glass))',
      WebkitBackdropFilter: 'blur(var(--blur-glass))',
    },
  };

  const hoverStyle = interactive && hover
    ? { transform: 'translateY(-4px)', boxShadow: 'var(--shadow-lg), var(--glow-cyan-sm)', borderColor: 'var(--color-primary)' }
    : {};

  return (
    <div
      onMouseEnter={() => interactive && setHover(true)}
      onMouseLeave={() => interactive && setHover(false)}
      style={{
        padding,
        borderRadius: 'var(--radius-xl)',
        border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-sm)',
        color: 'var(--text-body)',
        transition: 'transform var(--duration-slow) var(--ease-out), box-shadow var(--duration-slow) var(--ease-standard), border-color var(--duration-slow) var(--ease-standard)',
        ...variants[variant],
        ...hoverStyle,
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
