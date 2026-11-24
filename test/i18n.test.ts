import { execFileSync } from 'node:child_process';
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

  const run = (args: string[], env: Record<string, string>) =>
    execFileSync(process.execPath, ['--import', 'tsx', 'examples/quickstart.ts', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      timeout: 60_000,
    });

  it('the quickstart prints Korean with --lang ko and with AGUI_EXAMPLE_LANG=ko', () => {
    expect(run(['--lang', 'ko'], {})).toContain('도구 왕복: 성공');
    expect(run([], { AGUI_EXAMPLE_LANG: 'ko' })).toContain('도구 왕복: 성공');
    expect(run([], { LANG: 'ko_KR.UTF-8' })).toContain('미대응 이벤트: 1건 (CUSTOM)');
    expect(run([], { LANG: 'ja_JP.UTF-8' })).toContain('Tool round trip: OK');
  }, 90_000);

  it('the quickstart prints English with --lang en and reports the CUSTOM event', () => {
    const out = run(['--lang', 'en'], { LANG: 'ko_KR.UTF-8' });
    expect(out).toContain('Tool round trip: OK');
    expect(out).toContain('Unmapped events: 1 (CUSTOM)');
  }, 90_000);

  it('the quickstart shows the library error and exits non-zero when the server is unreachable', () => {
    for (const [lang, head] of [['en', 'The run failed:'], ['ko', '실행 실패:']] as const) {
      let out = '';
      let code = 0;
      try {
        execFileSync(process.execPath, ['--import', 'tsx', 'examples/quickstart.ts', '--lang', lang, '--url', 'http://127.0.0.1:9/agent'], {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
          timeout: 60_000,
        });
      } catch (e) {
        const err = e as { status: number; stdout: string; stderr: string };
        code = err.status;
        out = err.stdout + err.stderr;
      }
      expect(code, lang).toBe(1);
      expect(out).toContain(head);
      expect(out).toContain('Could not reach the AG-UI server at http://127.0.0.1:9/agent');
      expect(out).not.toContain('Run 2');
      expect(out).not.toContain('Tool round trip');
    }
  }, 90_000);
});
