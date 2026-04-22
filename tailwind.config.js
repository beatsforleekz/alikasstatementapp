/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Refined dark-mode operations palette
        ops: {
          bg: '#0d0f12',
          surface: '#13161b',
          border: '#1e2330',
          borderHover: '#2a3040',
          text: '#e2e8f0',
          muted: '#64748b',
          subtle: '#334155',
        },
        accent: {
          blue: '#3b82f6',
          blueHover: '#2563eb',
          green: '#22c55e',
          amber: '#f59e0b',
          red: '#ef4444',
          purple: '#a855f7',
          cyan: '#06b6d4',
        },
        status: {
          payable: '#22c55e',
          recouping: '#f59e0b',
          approved: '#3b82f6',
          pending: '#94a3b8',
          blocked: '#ef4444',
          sent: '#06b6d4',
          draft: '#64748b',
        }
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        sans: ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        display: ['IBM Plex Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
