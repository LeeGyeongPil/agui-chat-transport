// Guard for the CI setup (AC-9): keeps the workflow small, the Node version pinned, the
// local `npm run ci` identical to the workflow, and the install free of platform-specific
// packages. The workflow is read line by line (no YAML parser dependency).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { repoRoot } from './helpers.js';

const read = (file: string) => readFileSync(resolve(repoRoot, file), 'utf8');

/** Workflow lines without comments and blank lines, indentation kept. */
function workflowLines(): string[] {
  return read('.github/workflows/ci.yml')
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, ''))
    .filter((line) => line.trim() !== '');
}

/** Values of every `key: value` line for the given key (also `- key: value` list items). */
function values(lines: string[], key: string): string[] {
  const re = new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(.*)$`);
  return lines.flatMap((line) => {
    const m = re.exec(line);
    return m ? [m[1]!.trim().replace(/^["']|["']$/g, '')] : [];
  });
}

const indentOf = (line: string) => line.length - line.trimStart().length;

describe('AC-9 minimal CI', () => {
  it('has one job on ubuntu-24.04 with a job timeout of at most 10 minutes', () => {
    const lines = workflowLines();
    const jobsAt = lines.findIndex((l) => l.trim() === 'jobs:');
    assert.ok(jobsAt >= 0, 'jobs: block');
    // Job names are the keys one level under `jobs:`.
    const jobIndent = indentOf(lines[jobsAt + 1]!);
    const jobs = lines.slice(jobsAt + 1).filter((l) => indentOf(l) === jobIndent && /^\s*[\w-]+:\s*$/.test(l));
    assert.equal(jobs.length, 1, `jobs: ${jobs.join(', ')}`);
    assert.deepStrictEqual(values(lines, 'runs-on'), ['ubuntu-24.04']);
    const timeouts = values(lines, 'timeout-minutes').map(Number);
    assert.equal(timeouts.length, 1, 'exactly one timeout-minutes (the job)');
    assert.ok(timeouts[0]! > 0 && timeouts[0]! <= 10, `timeout-minutes ${timeouts[0]}`);
  });

  it('has no matrix, cache or schedule', () => {
    const lines = workflowLines();
    for (const key of ['matrix', 'cache', 'schedule', 'strategy']) {
      assert.deepStrictEqual(values(lines, key), [], `${key} must not be used`);
    }
  });

  it('pins Node with .nvmrc 22.23.5 and uses the v4 checkout and setup-node actions', () => {
    const lines = workflowLines();
    assert.deepStrictEqual(values(lines, 'node-version-file'), ['.nvmrc']);
    assert.deepStrictEqual(values(lines, 'node-version'), []);
    assert.equal(read('.nvmrc').trim(), '22.23.5');
    assert.deepStrictEqual(values(lines, 'uses'), ['actions/checkout@v4', 'actions/setup-node@v4']);
  });

  it('runs exactly npm ci -> npm run typecheck -> npm test', () => {
    assert.deepStrictEqual(values(workflowLines(), 'run'), ['npm ci', 'npm run typecheck', 'npm test']);
  });

  it('npm run ci is the same commands, in the same order, as the workflow after npm ci', () => {
    const pkg = JSON.parse(read('package.json'));
    const afterInstall = values(workflowLines(), 'run').slice(1);
    assert.equal(pkg.scripts.ci, 'npm run typecheck && npm test');
    assert.equal(pkg.scripts.ci, afterInstall.join(' && '));
  });

  it('the README Development sections list the same three commands in order', () => {
    for (const [file, heading] of [
      ['README.md', '## Development'],
      ['README.ko.md', '## 개발·기여'],
    ] as const) {
      const text = read(file);
      const start = text.indexOf(heading);
      assert.ok(start >= 0, `${file}: ${heading}`);
      const end = text.indexOf('\n## ', start + heading.length);
      const section = text.slice(start, end < 0 ? undefined : end);
      const at = ['npm ci', 'npm run typecheck', 'npm test'].map((cmd) => section.indexOf(`\n${cmd}\n`));
      assert.ok(at.every((i) => i >= 0), `${file}: commands found at ${at.join(', ')}`);
      assert.ok(at[0]! < at[1]! && at[1]! < at[2]!, `${file}: order ${at.join(', ')}`);
    }
  });
});

describe('AC-9 plain JavaScript development tools', () => {
  it('root devDependencies have no native-binary tools and TypeScript is 6.x', () => {
    const dev = JSON.parse(read('package.json')).devDependencies as Record<string, string>;
    const forbidden = Object.keys(dev).filter(
      (name) =>
        ['vitest', 'vite', 'tsx', 'esbuild', 'rolldown', 'react', 'react-dom'].includes(name) || name.startsWith('@vitejs/'),
    );
    assert.deepStrictEqual(forbidden, []);
    assert.ok(dev.typescript?.startsWith('6.'), `typescript ${dev.typescript}`);
  });

  it('package-lock.json has no os, cpu, libc or install-script entries', () => {
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, Record<string, unknown>> };
    const platformSpecific = Object.entries(lock.packages)
      .filter(([, entry]) => ['os', 'cpu', 'libc', 'hasInstallScript'].some((key) => key in entry))
      .map(([path]) => path);
    assert.deepStrictEqual(platformSpecific, []);
    // The locked TypeScript is the JavaScript compiler (6.x), not the native 7.x one.
    assert.match(String(lock.packages['node_modules/typescript']?.version), /^6\./);
  });
});
