import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MESSAGES, parseLang, resolveCliLang, resolveWebLang, t } from '../examples/shared/i18n.js';

const root = resolve(import.meta.dirname, '..');

describe('AC-9 languages', () => {
  it('English and Korean tables have exactly the same keys, none empty', () => {
    expect(Object.keys(MESSAGES.ko).sort()).toEqual(Object.keys(MESSAGES.en).sort());
    for (const lang of ['en', 'ko'] as const) {
      for (const [k, v] of Object.entries(MESSAGES[lang])) expect(v.length, `${lang}.${k}`).toBeGreaterThan(0);
    }
  });

  it('placeholders match between languages', () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(MESSAGES.en) as Array<keyof typeof MESSAGES.en>) {
      expect(names(MESSAGES.ko[k]), k).toEqual(names(MESSAGES.en[k]));
    }
  });

  it('CLI order: --lang > AGUI_EXAMPLE_LANG > LC_ALL > LC_MESSAGES > LANG; not Korean means English', () => {
    expect(resolveCliLang('ko', { AGUI_EXAMPLE_LANG: 'en', LANG: 'en_US.UTF-8' })).toBe('ko');
    expect(resolveCliLang(undefined, { AGUI_EXAMPLE_LANG: 'ko', LANG: 'en_US.UTF-8' })).toBe('ko');
    expect(resolveCliLang(undefined, { LC_ALL: 'ko_KR.UTF-8', LANG: 'en_US.UTF-8' })).toBe('ko');
    expect(resolveCliLang(undefined, { LC_MESSAGES: 'ko_KR.UTF-8', LANG: 'en_US.UTF-8' })).toBe('ko');
    expect(resolveCliLang(undefined, { LANG: 'ko_KR.UTF-8' })).toBe('ko');
    expect(resolveCliLang(undefined, { LANG: 'ja_JP.UTF-8' })).toBe('en');
    expect(resolveCliLang(undefined, { LC_ALL: 'C', LANG: 'ko_KR.UTF-8' })).toBe('en');
    expect(resolveCliLang(undefined, {})).toBe('en');
    expect(resolveCliLang('xx', { LANG: 'ko_KR.UTF-8' })).toBe('ko');
  });

  it('web order: saved choice > first-visit navigator.language', () => {
    expect(resolveWebLang('en', 'ko-KR')).toBe('en');
    expect(resolveWebLang('ko', 'en-US')).toBe('ko');
    expect(resolveWebLang(null, 'ko-KR')).toBe('ko');
    expect(resolveWebLang(undefined, 'fr-FR')).toBe('en');
    expect(resolveWebLang('garbage', 'ko')).toBe('ko');
  });

  it('switching language changes the text', () => {
    expect(t('en', 'roundTripOk')).toBe('Tool round trip: OK');
    expect(t('ko', 'roundTripOk')).toBe('도구 왕복: 성공');
    expect(t('en', 'unmapped', { count: 1, types: 'CUSTOM' })).toBe('Unmapped events: 1 (CUSTOM)');
    expect(parseLang('ko_KR.UTF-8')).toBe('ko');
  });

});

// The quickstart runs as a real child process (node --import tsx). Each start costs
// little CPU (~0.6 s) but reads hundreds of files; on a busy machine one start took
// 35 s. So the children run asynchronously and in parallel (the test waits for their
// exit events, it does not block the worker), and the time limits are hang guards set
// far above that: CHILD_KILL_MS kills a stuck child, CHILD_TEST_MS ends the test.
const CHILD_KILL_MS = 240_000;
const CHILD_TEST_MS = 300_000;

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the quickstart with only the given environment; resolves when the child exits. */
function quickstart(args: string[], env: Record<string, string> = {}): Promise<ChildResult> {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'examples/quickstart.ts', ...args],
      {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
        timeout: CHILD_KILL_MS,
      },
      (error, stdout, stderr) => {
        // A non-zero exit is a normal result here (the unreachable-server case expects 1).
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        resolveRun({ code, stdout, stderr });
      },
    );
  });
}

describe('AC-8/AC-9 quickstart in a child process', () => {
  it(
    'prints Korean with --lang ko, AGUI_EXAMPLE_LANG=ko and LANG=ko_KR; English for other locales',
    async () => {
      const [flag, toolEnv, langKo, langJa] = await Promise.all([
        quickstart(['--lang', 'ko']),
        quickstart([], { AGUI_EXAMPLE_LANG: 'ko' }),
        quickstart([], { LANG: 'ko_KR.UTF-8' }),
        quickstart([], { LANG: 'ja_JP.UTF-8' }),
      ]);
      for (const r of [flag, toolEnv, langKo, langJa]) expect(r.code, r.stderr).toBe(0);
      expect(flag.stdout).toContain('도구 왕복: 성공');
      expect(toolEnv.stdout).toContain('도구 왕복: 성공');
      expect(langKo.stdout).toContain('미대응 이벤트: 1건 (CUSTOM)');
      expect(langJa.stdout).toContain('Tool round trip: OK');
    },
    CHILD_TEST_MS,
  );

  it(
    'prints English with --lang en and reports the CUSTOM event',
    async () => {
      const r = await quickstart(['--lang', 'en'], { LANG: 'ko_KR.UTF-8' });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain('Tool round trip: OK');
      expect(r.stdout).toContain('Unmapped events: 1 (CUSTOM)');
    },
    CHILD_TEST_MS,
  );

  it(
    'shows the library error and exits non-zero when the server is unreachable',
    async () => {
      const cases = [
        ['en', 'The run failed:'],
        ['ko', '실행 실패:'],
      ] as const;
      const results = await Promise.all(
        cases.map(([lang]) => quickstart(['--lang', lang, '--url', 'http://127.0.0.1:9/agent'])),
      );
      results.forEach((r, i) => {
        const [lang, head] = cases[i]!;
        const out = r.stdout + r.stderr;
        expect(r.code, lang).toBe(1);
        expect(out).toContain(head);
        expect(out).toContain('Could not reach the AG-UI server at http://127.0.0.1:9/agent');
        expect(out).not.toContain('Run 2');
        expect(out).not.toContain('Tool round trip');
      });
    },
    CHILD_TEST_MS,
  );
});
