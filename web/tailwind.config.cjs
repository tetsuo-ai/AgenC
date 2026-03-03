/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: 'rgb(var(--surface) / <alpha-value>)',
        // BBS terminal palette
        bbs: {
          black: '#0A0A0F',
          purple: '#BB66FF',
          'purple-dim': '#6B3A99',
          pink: '#FF66AA',
          'pink-dim': '#993D66',
          orange: '#FF9933',
          green: '#33FF66',
          'green-dim': '#1F993D',
          cyan: '#33CCFF',
          magenta: '#CC66FF',
          'magenta-dim': '#7A3D99',
          red: '#FF3333',
          yellow: '#FFCC33',
          white: '#E8E8E8',
          lightgray: '#BBBBBB',
          gray: '#666666',
          dark: '#111118',
          surface: '#16161E',
          border: '#2A2A3A',
        },
        // Map tetsuo scale to BBS grayscale equivalents
        tetsuo: {
          50: 'rgb(var(--tetsuo-50) / <alpha-value>)',
          100: 'rgb(var(--tetsuo-100) / <alpha-value>)',
          200: 'rgb(var(--tetsuo-200) / <alpha-value>)',
          300: 'rgb(var(--tetsuo-300) / <alpha-value>)',
          400: 'rgb(var(--tetsuo-400) / <alpha-value>)',
          500: 'rgb(var(--tetsuo-500) / <alpha-value>)',
          600: 'rgb(var(--tetsuo-600) / <alpha-value>)',
          700: 'rgb(var(--tetsuo-700) / <alpha-value>)',
          800: 'rgb(var(--tetsuo-800) / <alpha-value>)',
          900: 'rgb(var(--tetsuo-900) / <alpha-value>)',
          950: 'rgb(var(--tetsuo-950) / <alpha-value>)',
        },
        accent: {
          DEFAULT: '#BB66FF',
          light: '#CC88FF',
          dark: '#9944DD',
          bg: 'rgba(187, 102, 255, 0.12)',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'monospace'],
        sans: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
