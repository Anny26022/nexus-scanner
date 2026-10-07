import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';

function scannerBridge(): Plugin {
  let worker: ChildProcessWithoutNullStreams | undefined;
  let sequence = 0;
  const pending = new Map<number, { res: ServerResponse; timer: ReturnType<typeof setTimeout> }>();
  const stopWorker = () => {
    const current = worker;
    worker = undefined;
    current?.kill();
    for (const { res, timer } of pending.values()) {
      clearTimeout(timer);
      if (!res.destroyed) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'Scanner restarted. Please run the screen again.' }));
      }
    }
    pending.clear();
  };
  const ensureWorker = () => {
    if (worker) return worker;
    const current = spawn('python3', ['-u', path.resolve(import.meta.dirname, 'scanner_worker.py')], { stdio: 'pipe' });
    worker = current;
    current.stderr.on('data', chunk => console.error('Local scanner:', chunk.toString()));
    createInterface({ input: current.stdout }).on('line', line => {
      try {
        const message = JSON.parse(line);
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (!item.res.destroyed) {
          item.res.statusCode = message.status;
          item.res.end(JSON.stringify(message.payload));
        }
      } catch {
        console.error('Invalid local scanner response');
        stopWorker();
      }
    });
    current.on('error', error => { console.error(error); if (worker === current) stopWorker(); });
    current.on('exit', () => { if (worker === current) stopWorker(); });
    return current;
  };
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url?.split('?')[0] !== '/api/screens/run') return next();
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: 'Use POST to run a screen' }));
      return;
    }
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 100_000) req.destroy();
    });
    req.on('end', () => {
      let request;
      try { request = JSON.parse(body); } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Invalid JSON request' }));
        return;
      }
      const current = ensureWorker();
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        if (!res.destroyed) {
          res.statusCode = 504;
          res.end(JSON.stringify({ error: 'Scanner request timed out.' }));
        }
        stopWorker();
      }, 120_000);
      pending.set(id, { res, timer });
      current.stdin.write(JSON.stringify({ id, request }) + '\n');
      res.on('close', () => {
        const item = pending.get(id);
        if (item) { clearTimeout(item.timer); pending.delete(id); }
      });
    });
  };
  return {
    name: 'local-edl-scanner',
    configureServer(server) {
      server.middlewares.use(middleware);
      server.httpServer?.on('close', stopWorker);
      server.watcher.add(['scanner_bridge.py', 'scanner_cache.py', 'scanner_worker.py'].map(file => path.resolve(import.meta.dirname, file)));
      server.watcher.add(path.resolve(import.meta.dirname, '../DO NOT DELETE EDL PIPELINE/src'));
      server.watcher.on('change', file => { if (file.endsWith('.py')) stopWorker(); });
    },
    configurePreviewServer(server) { server.middlewares.use(middleware); server.httpServer.on('close', stopWorker); },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), scannerBridge()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
});
