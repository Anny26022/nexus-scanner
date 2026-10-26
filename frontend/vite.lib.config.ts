import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { readFileSync } from 'node:fs';
import { scopeCss } from './lib/scopeCss';

// Library build of `src/embed.tsx` for hosts such as Nexus Journal: `npm run build:lib` writes ESM, one scoped
// stylesheet and type declarations to dist-lib/. The standalone site keeps using vite.config.ts.
const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf8'));
const external = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})];

/** Swaps each `*WorkerFactory` module for its `.inline` twin, so the workers ship inside the package's JavaScript. */
function inlineWorkers(): Plugin {
  return {
    name: 'nexus-inline-workers',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !/\/(snapshot|study)WorkerFactory$/.test(source)) return null;
      return this.resolve(`${source}.inline.ts`, importer, {...options, skipSelf: true});
    },
  };
}

/** Confines the emitted CSS (preflight, element defaults, tokens) to `.nexus-scanner-root`. */
function scopedCss(): Plugin {
  return {
    name: 'nexus-scoped-css',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'asset' && file.fileName.endsWith('.css')) file.source = scopeCss(String(file.source));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), inlineWorkers(), scopedCss()],
  publicDir: false,
  worker: {format: 'es'},
  build: {
    outDir: 'dist-lib',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(import.meta.dirname, 'src/embed.tsx'),
      formats: ['es'],
      fileName: () => 'index.js',
      cssFileName: 'style',
    },
    rolldownOptions: {
      external: id => external.some(name => id === name || id.startsWith(`${name}/`)),
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
