import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 避开本机 Node 24 / Windows 清理非空目录时的原生崩溃；保留带哈希的旧静态资源。
  build: { emptyOutDir: false },
  server: {
    port: 5179,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4317' },
  },
});
