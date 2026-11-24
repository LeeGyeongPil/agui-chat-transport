import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('AC-1 build output and public names', () => {
  it('dist contains the entry points', () => {
    for (const f of ['dist/index.js', 'dist/index.d.ts', 'dist/testing/index.js', 'dist/testing/index.d.ts']) {
      expect(existsSync(resolve(root, f)), f).toBe(true);
    }
  });

  it('public names import from dist', async () => {
    const mod = await import(resolve(root, 'dist/index.js'));
    for (const name of [
      'AgUiChatTransport',
      'createAgUiChunkConverter',
      'aguiEventsToUIMessageChunks',
      'uiMessagesToRunAgentInput',
      'AgUiTransportConfigError',
    ]) {
      expect(typeof mod[name], name).toBe('function');
    }
    const testing = await import(resolve(root, 'dist/testing/index.js'));
    expect(typeof testing.startMockAgUiServer).toBe('function');
  });

  it('package.json publishes dist/ and every export target exists', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('dist');
    expect(pkg.files).not.toContain('src');
    expect(pkg.files).not.toContain('test');
    const exportsMap = pkg.exports as Record<string, { import?: string; types?: string } | string>;
    for (const [key, target] of Object.entries(exportsMap)) {
      if (typeof target === 'string') continue;
      for (const f of [target.import, target.types]) {
        expect(existsSync(resolve(root, f!)), `${key} -> ${f}`).toBe(true);
      }
    }
  });
});
