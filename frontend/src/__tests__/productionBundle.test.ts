// @vitest-environment node
import path from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';

it('omits mock fixture code from a real production build but retains opt-in mock mode', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  for (const mock of ['false', 'true']) {
    const result = await build({root, logLevel: 'silent',
      define: {'import.meta.env.VITE_USE_MOCK': JSON.stringify(mock)},
      build: {write: false, copyPublicDir: false, emptyOutDir: false}});
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(bundle => 'output' in bundle ? bundle.output : []);
    const included = outputs.some(output => output.type === 'chunk' &&
      Object.entries(output.modules).some(([id, module]) => id.endsWith('/api/mockAdapter.ts') && module.renderedLength > 0));
    expect(included, `VITE_USE_MOCK=${mock}`).toBe(mock === 'true');
    const entry = outputs.find(output => output.type === 'chunk' && output.isEntry);
    expect(entry?.type).toBe('chunk');
    if (entry?.type === 'chunk') {
      expect(entry.code.length).toBeLessThan(12_000);
      expect(entry.dynamicImports.some(file => outputs.some(output => output.type === 'chunk'
        && output.fileName === file && output.facadeModuleId?.endsWith('/src/renderApp.tsx')))).toBe(true);
      expect(Object.keys(entry.modules).some(id => id.includes('/node_modules/react-dom/'))).toBe(false);
    }
  }
}, 60_000);
