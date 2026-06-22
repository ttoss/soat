import React from 'react';

/**
 * SOAT Switch — boolean toggle. On state fills with brand color and, in
 * dark mode, emits a soft cyan glow.
 */
export function Switch({ checked = false, onChange, label, disabled = false, id, style, ...rest }) {
  const switchId = id || (label ? `sw-${label.replace(/\s+/g, '-').toLowerCase()}` : undefined);
  return (
    <label
      htmlFor={switchId}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.6rem',
        fontFamily: 'var(--font-body)',
        fontSize: 'var(--text-sm)',
        color: 'var(--text-body)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
    >
      <button
        id={switchId}
        role="switch"
        aria-checked={checked}
        type="button"
        disabled={disabled}
        onClick={() => !disabled && onChange && onChange(!checked)}
        style={{
          position: 'relative',
          width: 40,
          height: 22,
          padding: 0,
          flexShrink: 0,
          borderRadius: 'var(--radius-full)',
          border: '1px solid',
          borderColor: checked ? 'transparent' : 'var(--border-strong)',
          background: checked ? 'var(--gradient-brand)' : 'var(--surface-sunken)',
          boxShadow: checked ? 'var(--glow-cyan-sm)' : 'none',
          cursor: 'inherit',
          transition: 'background var(--duration-base) var(--ease-standard), box-shadow var(--duration-base) var(--ease-standard)',
        }}
        {...rest}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 20 : 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#ffffff', /* light knob reads on both the cyan track (on) and sunken track (off) in either theme */
            boxShadow: 'var(--shadow-sm)',
            transition: 'left var(--duration-base) var(--ease-out)',
          }}
        />
      </button>
      {label ? <span>{label}</span> : null}
    </label>
  );
}
