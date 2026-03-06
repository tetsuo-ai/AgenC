import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const REACT_VENDOR_MATCHERS = [
  '/react/',
  'react-dom',
  'scheduler',
];

const MARKDOWN_VENDOR_MATCHERS = [
  'react-markdown',
  'remark-',
  'rehype-',
  'micromark',
  'mdast-',
  'hast-',
  'unist-',
  'vfile',
  'property-information',
  'html-url-attributes',
  'space-separated-tokens',
  'comma-separated-tokens',
  'style-to-object',
  'style-to-js',
  'trim-lines',
  'bail',
  'trough',
  'devlop',
  'is-plain-obj',
];

function matchesAny(id: string, matchers: string[]): boolean {
  return matchers.some((matcher) => id.includes(matcher));
}

function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;
  if (matchesAny(id, REACT_VENDOR_MATCHERS)) return 'react-vendor';
  if (matchesAny(id, MARKDOWN_VENDOR_MATCHERS)) return 'markdown-vendor';
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
});
