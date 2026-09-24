import { defineConfig } from 'vite';

export default defineConfig({
  base: '/chaitracker/',
  build: {
    assetsDir: 'assets',
    rollupOptions: { output: { entryFileNames: 'assets/[name]-[hash].js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' } }
  }
});
