/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: 'rgb(var(--surface) / <alpha-value>)',
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
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          light: '#818cf8',
          dark: 'rgb(var(--accent-hover) / <alpha-value>)',
          bg: 'rgb(var(--accent-bg) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
