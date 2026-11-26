import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { startMockAgUiServer, type MockAgUiServer } from '../../src/testing/index.js';

const src = (p: string) => fileURLToPath(new URL(`../../src/${p}`, import.meta.url));

/**
 * Starts the practice mock AG-UI server next to the dev server and tells the page
 * where it is (GET /__mock-url). If VITE_AGUI_URL is set the page uses that instead.
 */
function mockAgUiServer(): Plugin {
  let mock: MockAgUiServer | undefined;
  return {
    name: 'mock-ag-ui-server',
    async configureServer(server) {
      if (process.env.VITE_AGUI_URL) return;
      mock = await startMockAgUiServer({ scenario: 'weather', delayMs: 120 });
      server.middlewares.use('/__mock-url', (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ url: mock!.url }));
      });
      server.httpServer?.once('close', () => void mock?.close());
    },
  };
}

/** file:// cannot load module scripts, so the static build is one classic deferred script. */
function classicScript(): Plugin {
  return {
    name: 'classic-script',
    enforce: 'post',
    transformIndexHtml: (html) => html.replace(/<script type="module" crossorigin/g, '<script defer'),
  };
}

export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { output: { format: 'iife' } } },
  plugins: [react(), mockAgUiServer(), classicScript()],
  resolve: {
    alias: {
      // Use the library sources directly, as an installed app would use the package.
      'agui-chat-transport': src('index.ts'),
    },
    // The library sources live outside this package (../../src). Resolve their imports from
    // this package's own node_modules, so the page uses one copy of each.
    dedupe: ['ai', '@ag-ui/client', '@ag-ui/core', 'fast-json-patch', 'react', 'react-dom'],
  },
  server: { host: '127.0.0.1' },
});
