import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { repoRoot as root } from './helpers.js';

describe('AC-1 build output and public names', () => {
  it('dist contains the entry points', () => {
    for (const f of ['dist/index.js', 'dist/index.d.ts', 'dist/testing/index.js', 'dist/testing/index.d.ts']) {
      assert.equal(existsSync(resolve(root, f)), true, f);
    }
  });

  it('public names import from dist', async () => {
    const mod = await import(pathToFileURL(resolve(root, 'dist/index.js')).href);
    for (const name of [
      'AgUiChatTransport',
      'createAgUiChunkConverter',
      'aguiEventsToUIMessageChunks',
      'uiMessagesToRunAgentInput',
      'AgUiTransportConfigError',
    ]) {
      assert.equal(typeof mod[name], 'function', name);
    }
    const testing = await import(pathToFileURL(resolve(root, 'dist/testing/index.js')).href);
    assert.equal(typeof testing.startMockAgUiServer, 'function');
  });

  it('package.json publishes dist/ and every export target exists', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    assert.ok(pkg.files.includes('dist'), 'files contains dist');
    // Only the build output is published: no sources, tests, examples or the test build.
    for (const notPublished of ['src', 'test', 'examples', '.build']) {
      assert.ok(!pkg.files.includes(notPublished), `files must not contain ${notPublished}`);
    }
    assert.ok(!pkg.files.some((f: string) => f.startsWith('.build')), 'files must not contain .build');
    const exportsMap = pkg.exports as Record<string, { import?: string; types?: string } | string>;
    for (const [key, target] of Object.entries(exportsMap)) {
      if (typeof target === 'string') continue;
      for (const f of [target.import, target.types]) {
        assert.equal(existsSync(resolve(root, f!)), true, `${key} -> ${f}`);
      }
    }
  });
});
