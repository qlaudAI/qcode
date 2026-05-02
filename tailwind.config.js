/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
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
        // Brand-aligned palette — same hues as qlaud.ai dashboard so
        // surfaces match across the desktop app, web preview, and
        // marketing pages. Neutral hue 0 (pure grayscale, no blue
        // tint) keeps the primary red the only chromatic accent.
        background: 'hsl(0 0% 100%)',
        foreground: 'hsl(0 0% 3.9%)',
        muted: 'hsl(0 0% 96.1%)',
        'muted-foreground': 'hsl(0 0% 45.1%)',
        border: 'hsl(0 0% 89.8%)',
        destructive: 'hsl(0 72% 51%)',
        primary: 'hsl(0 72% 51%)',
        'primary-foreground': 'hsl(0 0% 100%)',
      },
    },
  },
  plugins: [],
};
