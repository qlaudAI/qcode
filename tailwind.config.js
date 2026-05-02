/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Class-based dark mode: we set `<html class="dark">` from JS so
  // we can honor either system preference (default) or an explicit
  // user override (Settings → Theme). Token swap happens via the
  // CSS vars in styles.css; tailwind utilities (bg-background,
  // text-foreground, etc.) automatically pick up the active mode.
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Inter',
          'Segoe UI',
          'system-ui',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SF Mono', 'Menlo', 'monospace'],
      },
      colors: {
        // Tokens flow through CSS vars so a single `<html class="dark">`
        // toggle swaps the entire palette atomically. Same hue family
        // (neutral hue 0, primary qlaud red 0 72% 51%) across both
        // modes so brand stays consistent.
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        muted: 'hsl(var(--muted) / <alpha-value>)',
        'muted-foreground': 'hsl(var(--muted-foreground) / <alpha-value>)',
        border: 'hsl(var(--border) / <alpha-value>)',
        destructive: 'hsl(var(--primary) / <alpha-value>)',
        primary: 'hsl(var(--primary) / <alpha-value>)',
        'primary-foreground': 'hsl(var(--primary-foreground) / <alpha-value>)',
      },
    },
  },
  plugins: [],
};
