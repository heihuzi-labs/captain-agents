import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { productionCsp } from './app/main/security.ts';

export default defineConfig(({ command }) => ({
  main: { define: { __XA_DEVELOPMENT__: JSON.stringify(command === 'serve') },
    build: { rollupOptions: { input: resolve('app/main/index.ts'), output: { entryFileNames: 'index.js', format: 'es' } } } },
  // 开启 sandbox 的预加载只能使用一个 CommonJS 文件；桥内模块都打进这个文件。
  preload: { build: { rollupOptions: { input: resolve('app/preload/index.ts'), output: { entryFileNames: 'index.cjs', format: 'cjs' } } } },
  renderer: {
    root: 'app/renderer',
    plugins: [react(), {
      name: 'development-csp', apply: 'serve',
      // 只给 Vite HMR 和 React Refresh 放行本机连接、注入样式/刷新脚本；build 保持严格 CSP。
      transformIndexHtml(html) {
        return html.replace(productionCsp, "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' xa-icon:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-src 'none'");
      },
    }],
    build: { rollupOptions: { input: resolve('app/renderer/index.html') } },
  },
}));
