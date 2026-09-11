import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发代理目标可用 VITE_API_TARGET 覆盖（默认本机 8787，与 npm run server 一致）
const apiTarget = process.env.VITE_API_TARGET || 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
    },
  },
  build: {
    // 把体积大、更新频率低的依赖单独切块，首屏主包更小、缓存命中率更高。
    // mammoth 已在 handleDocx 内动态 import，Rollup 会自动把它切成独立 chunk。
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          icons: ['lucide-react'],
        },
      },
    },
    chunkSizeWarningLimit: 400,
  },
});
