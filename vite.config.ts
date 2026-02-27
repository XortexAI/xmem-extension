import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';
import path from 'path';

export default defineConfig({
  plugins: [crx({ manifest })],
  build: { outDir: 'dist', emptyOutDir: true },
  resolve: {
    alias: {
      'xmem-ai': path.resolve(__dirname, '../sdk/xmem-ts/src/index.ts'),
    },
  },
  define: {
    'process.env.XMEM_API_URL': JSON.stringify(''),
    'process.env.XMEM_API_KEY': JSON.stringify(''),
  },
});
