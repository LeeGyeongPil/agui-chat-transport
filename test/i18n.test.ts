import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { MESSAGES, parseLang, resolveCliLang, resolveWebLang, t } from '../examples/shared/i18n.js';
import { repoRoot as root } from './helpers.js';

describe('AC-8 languages', () => {
  it('English and Korean tables have exactly the same keys, none empty', () => {
    assert.deepStrictEqual(Object.keys(MESSAGES.ko).sort(), Object.keys(MESSAGES.en).sort());
    for (const lang of ['en', 'ko'] as const) {
      for (const [k, v] of Object.entries(MESSAGES[lang])) assert.ok(v.length > 0, `${lang}.${k}`);
    }
  });

  it('placeholders match between languages', () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(MESSAGES.en) as Array<keyof typeof MESSAGES.en>) {
      assert.deepStrictEqual(names(MESSAGES.ko[k]), names(MESSAGES.en[k]), k);
    }
  });

  it('CLI order: --lang > AGUI_EXAMPLE_LANG > LC_ALL > LC_MESSAGES > LANG; not Korean means English', () => {
    assert.equal(resolveCliLang('ko', { AGUI_EXAMPLE_LANG: 'en', LANG: 'en_US.UTF-8' }), 'ko');
    assert.equal(resolveCliLang(undefined, { AGUI_EXAMPLE_LANG: 'ko', LANG: 'en_US.UTF-8' }), 'ko');
    assert.equal(resolveCliLang(undefined, { LC_ALL: 'ko_KR.UTF-8', LANG: 'en_US.UTF-8' }), 'ko');
    assert.equal(resolveCliLang(undefined, { LC_MESSAGES: 'ko_KR.UTF-8', LANG: 'en_US.UTF-8' }), 'ko');
    assert.equal(resolveCliLang(undefined, { LANG: 'ko_KR.UTF-8' }), 'ko');
    assert.equal(resolveCliLang(undefined, { LANG: 'ja_JP.UTF-8' }), 'en');
    assert.equal(resolveCliLang(undefined, { LC_ALL: 'C', LANG: 'ko_KR.UTF-8' }), 'en');
    assert.equal(resolveCliLang(undefined, {}), 'en');
    assert.equal(resolveCliLang('xx', { LANG: 'ko_KR.UTF-8' }), 'ko');
  });

  it('web order: saved choice > first-visit navigator.language', () => {
    assert.equal(resolveWebLang('en', 'ko-KR'), 'en');
    assert.equal(resolveWebLang('ko', 'en-US'), 'ko');
    assert.equal(resolveWebLang(null, 'ko-KR'), 'ko');
    assert.equal(resolveWebLang(undefined, 'fr-FR'), 'en');
    assert.equal(resolveWebLang('garbage', 'ko'), 'ko');
  });

  it('switching language changes the text', () => {
    assert.equal(t('en', 'roundTripOk'), 'Tool round trip: OK');
    assert.equal(t('ko', 'roundTripOk'), '도구 왕복: 성공');
    assert.equal(t('en', 'unmapped', { count: 1, types: 'CUSTOM' }), 'Unmapped events: 1 (CUSTOM)');
    assert.equal(parseLang('ko_KR.UTF-8'), 'ko');
  });
});

// The quickstart runs as a real child process: plain `node` on the compiled example
// (`.build/examples/quickstart.js`, made by `npm run build:dev` before the tests run).
// No loader, no transpiler cache. The children run asynchronously and in parallel (the
// test waits for their exit events), and the time limits are hang guards only:
// CHILD_KILL_MS kills a stuck child, CHILD_TEST_MS ends the test.
const QUICKSTART = resolve(root, '.build/examples/quickstart.js');
const CHILD_KILL_MS = 90_000;
const CHILD_TEST_MS = 110_000;

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Everything needed to tell why a child failed (exit code, signal, time, output) in a CI log. */
  why: string;
}

/** Run the quickstart with only the given environment; resolves when the child exits. */
function quickstart(args: string[], env: Record<string, string> = {}): Promise<ChildResult> {
  const started = Date.now();
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [QUICKSTART, ...args],
      {
        cwd: root,
        encoding: 'utf8',
        // Minimal environment so the parent's locale cannot leak in.
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
          ...env,
        },
        timeout: CHILD_KILL_MS,
      },
      (error, stdout, stderr) => {
        // A non-zero exit is a normal result here (the unreachable-server case expects 1).
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        const signal = error && 'signal' in error ? error.signal : null;
        const killed = error && 'killed' in error ? error.killed : false;
        const why = [
          `quickstart ${args.join(' ')} env=${JSON.stringify(env)}`,
          `exit=${code} signal=${signal ?? ''} killedByTimeout=${killed} after ${Date.now() - started} ms`,
          `--- stdout ---\n${stdout}`,
          `--- stderr ---\n${stderr}`,
        ].join('\n');
        resolveRun({ code, stdout, stderr, why });
      },
    );
  });
}

describe('AC-8 quickstart in a child process', () => {
  it('the compiled quickstart exists (npm test runs build:dev first)', () => {
    assert.equal(existsSync(QUICKSTART), true, QUICKSTART);
  });

  it(
    'prints Korean with --lang ko, AGUI_EXAMPLE_LANG=ko and LANG=ko_KR; English for other locales',
    { timeout: CHILD_TEST_MS },
    async () => {
      const [flag, toolEnv, langKo, langJa] = await Promise.all([
        quickstart(['--lang', 'ko']),
        quickstart([], { AGUI_EXAMPLE_LANG: 'ko' }),
        quickstart([], { LANG: 'ko_KR.UTF-8' }),
        quickstart([], { LANG: 'ja_JP.UTF-8' }),
      ]);
      for (const r of [flag, toolEnv, langKo, langJa]) assert.equal(r.code, 0, r.why);
      assert.ok(flag.stdout.includes('도구 왕복: 성공'), flag.why);
      assert.ok(toolEnv.stdout.includes('도구 왕복: 성공'), toolEnv.why);
      assert.ok(langKo.stdout.includes('미대응 이벤트: 1건 (CUSTOM)'), langKo.why);
      assert.ok(langJa.stdout.includes('Tool round trip: OK'), langJa.why);
    },
  );

  it('prints English with --lang en and reports the CUSTOM event', { timeout: CHILD_TEST_MS }, async () => {
    const r = await quickstart(['--lang', 'en'], { LANG: 'ko_KR.UTF-8' });
    assert.equal(r.code, 0, r.why);
    assert.ok(r.stdout.includes('Tool round trip: OK'), r.why);
    assert.ok(r.stdout.includes('Unmapped events: 1 (CUSTOM)'), r.why);
  });

  it('shows the library error and exits non-zero when the server is unreachable', { timeout: CHILD_TEST_MS }, async () => {
    const cases = [
      ['en', 'The run failed:'],
      ['ko', '실행 실패:'],
    ] as const;
    const results = await Promise.all(cases.map(([lang]) => quickstart(['--lang', lang, '--url', 'http://127.0.0.1:9/agent'])));
    results.forEach((r, i) => {
      const [lang, head] = cases[i]!;
      const out = r.stdout + r.stderr;
      assert.equal(r.code, 1, `${lang}\n${r.why}`);
      assert.ok(out.includes(head), r.why);
      assert.ok(out.includes('Could not reach the AG-UI server at http://127.0.0.1:9/agent'), r.why);
      assert.ok(!out.includes('Run 2'), r.why);
      assert.ok(!out.includes('Tool round trip'), r.why);
    });
  });
});
