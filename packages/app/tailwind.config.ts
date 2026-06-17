import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Brand DNA — decorative accents (logo, gradients, glows).
        brand: {
          violet: 'hsl(var(--brand-violet))',
          cyan: 'hsl(var(--brand-cyan))',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        heading: ['"Space Grotesk"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      letterSpacing: {
        heading: '0.02em',
      },
      boxShadow: {
        // Neon glow for active elements in dark mode (Core Cyan).
        glow: '0 0 16px 0 hsl(var(--brand-cyan) / 0.45)',
        // Full glow / elevation scale from the design system (effects.css).
        'glow-cyan-sm': '0 0 8px 0 hsl(var(--brand-cyan) / 0.3)',
        'glow-cyan-md': '0 0 20px 0 hsl(var(--brand-cyan) / 0.3)',
        'glow-cyan-lg': '0 0 30px 0 hsl(var(--brand-cyan) / 0.5)',
        'glow-violet-md': '0 0 24px 0 hsl(var(--brand-violet) / 0.3)',
      },
      backgroundImage: {
        // Vector Galaxy flow gradient (Deep Violet -> primary).
        'galaxy-gradient':
          'linear-gradient(135deg, hsl(var(--brand-violet)), hsl(var(--primary)))',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [],
};

export default config;
