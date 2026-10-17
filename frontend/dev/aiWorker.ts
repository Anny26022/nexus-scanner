import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import type {Server} from 'node:http';
import type {Connect, Plugin} from 'vite';

const target = 'http://127.0.0.1:8787';

/** Own the local API process alongside Vite, rather than requiring a second terminal. */
export function localAiWorker(): Plugin {
  let child: ChildProcessWithoutNullStreams | undefined;
  let starting: Promise<void> | undefined;
  let closed = false;
  const root = path.resolve(import.meta.dirname, '../..');

  async function isReady() {
    try {
      const response = await fetch(`${target}/api/screener/ai-compile`, {signal:AbortSignal.timeout(1000)});
      const body = await response.json();
      return response.status === 405 && body.error === 'Use POST to build a screen.';
    } catch { return false; }
  }

  async function start() {
    if (await isReady()) return; // Reuse a manually started Worker without owning it.
    if (closed) throw new Error('Development server closed');
    const current = child ?? spawn(process.execPath, [
      path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev',
      '--config', path.join(root, 'wrangler.dev.jsonc'),
      '--ip', '127.0.0.1', '--port', '8787', '--show-interactive-dev-session=false',
    ], {cwd:root, stdio:'pipe', env: process.env});
    if (!child) {
      child = current;
      current.stdin.end();
      current.stdout.on('data', chunk => console.log('[AI Worker]', chunk.toString().trimEnd()));
      current.stderr.on('data', chunk => console.error('[AI Worker]', chunk.toString().trimEnd()));
      current.on('error', error => console.error('[AI Worker]', error.message));
      current.on('exit', () => { if (child === current) child = undefined; });
    }
    const deadline = Date.now() + 45000;
    while (!closed && current.exitCode === null && !current.killed && Date.now() < deadline) {
      if (await isReady()) return;
      await delay(250);
    }
    if (child === current) { current.kill(); child = undefined; }
    throw new Error('Local AI Worker did not start. Check Wrangler login and the dev terminal.');
  }

  function ensureRunning() {
    if (!starting) starting = start().finally(() => { starting = undefined; });
    return starting;
  }

  function stop() {
    closed = true;
    child?.kill();
    child = undefined;
  }

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url?.split('?')[0] !== '/api/screener/ai-compile') return next();
    void ensureRunning().then(() => {
      if (!res.destroyed) next();
    }).catch(() => {
      if (res.destroyed) return;
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({code:'AI_LOCAL_SERVICE_UNAVAILABLE',
        error:'The local AI service could not start. Check the dev terminal for Cloudflare login or startup errors, then retry.'}));
    });
  };

  function connect(middlewares: Connect.Server, server: Server | null) {
    closed = false;
    middlewares.use(middleware);
    process.once('exit', stop);
    server?.once('close', () => { stop(); process.off('exit', stop); });
    void ensureRunning().catch(error => console.error('[AI Worker]', error.message));
  }

  return {
    name:'local-ai-worker',
    configureServer(server) { connect(server.middlewares, server.httpServer); },
    configurePreviewServer(server) { connect(server.middlewares, server.httpServer); },
  };
}
