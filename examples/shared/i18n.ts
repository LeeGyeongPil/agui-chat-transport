// All user-visible text of the examples lives in this one table (English and Korean).
// The library itself has no UI; only the quickstart output and the web example use it.

export type Lang = 'en' | 'ko';
export const LANGS: Lang[] = ['en', 'ko'];

export const MESSAGES = {
  en: {
    title: 'agui-chat-transport quickstart',
    mockNote: 'Practice mode: a mock AG-UI server replays a scripted conversation (no model, no network).',
    realNote: 'Using your AG-UI server: {url}',
    runFailed: 'The run failed: {error}',
    run1: 'Run 1: user asks "Weather in Seoul?"',
    chunks: 'Stream chunks: {count} ({types})',
    parts: 'Message parts:',
    toolRunning: 'Browser tool getWeather({city}) -> {result}',
    run2: 'Run 2: tool result sent back to the agent',
    answer: 'Agent answer: {text}',
    roundTripOk: 'Tool round trip: OK',
    roundTripFail: 'Tool round trip: FAILED ({reason})',
    unmapped: 'Unmapped events: {count} ({types})',
    unmappedNone: 'Unmapped events: 0',
    usage: 'Usage: npm run example -- [--lang en|ko] [--url <AG-UI endpoint>]',
    badLang: 'Unknown language "{value}". Use --lang en or --lang ko.',
    // web example
    appTitle: 'AG-UI chat (AI SDK useChat)',
    mockBadge: 'Practice mock server: replays a script',
    inputPlaceholder: 'Ask about the weather...',
    send: 'Send',
    stop: 'Stop',
    language: 'Language',
    reasoning: 'Reasoning',
    toolCard: 'Tool',
    toolWaiting: 'waiting for the browser tool',
    toolDone: 'done',
    statePanel: 'Shared state',
    unmappedPanel: 'Unmapped events',
    unmappedEmpty: 'Nothing was dropped silently.',
    passthrough: 'Show CUSTOM events as data parts (passthrough)',
    errorLabel: 'Error',
    userLabel: 'You',
    agentLabel: 'Agent',
  },
  ko: {
    title: 'agui-chat-transport 빠른 시작',
    mockNote: '연습용 모드: 목(mock) AG-UI 서버가 대본 대화를 재생합니다 (모델·네트워크 없음).',
    realNote: '사용자의 AG-UI 서버 사용: {url}',
    runFailed: '실행 실패: {error}',
    run1: '1회차: 사용자가 "서울 날씨는?" 하고 묻습니다',
    chunks: '스트림 청크: {count}개 ({types})',
    parts: '메시지 파트:',
    toolRunning: '브라우저 도구 getWeather({city}) -> {result}',
    run2: '2회차: 도구 결과를 에이전트에 돌려보냅니다',
    answer: '에이전트 답변: {text}',
    roundTripOk: '도구 왕복: 성공',
    roundTripFail: '도구 왕복: 실패 ({reason})',
    unmapped: '미대응 이벤트: {count}건 ({types})',
    unmappedNone: '미대응 이벤트: 0건',
    usage: '사용법: npm run example -- [--lang en|ko] [--url <AG-UI 주소>]',
    badLang: '알 수 없는 언어 "{value}". --lang en 또는 --lang ko 를 쓰세요.',
    // web example
    appTitle: 'AG-UI 채팅 (AI SDK useChat)',
    mockBadge: '연습용 목 서버: 대본을 재생합니다',
    inputPlaceholder: '날씨를 물어보세요...',
    send: '보내기',
    stop: '중단',
    language: '언어',
    reasoning: '추론',
    toolCard: '도구',
    toolWaiting: '브라우저 도구 실행 대기 중',
    toolDone: '완료',
    statePanel: '공유 상태',
    unmappedPanel: '미대응 이벤트',
    unmappedEmpty: '조용히 버려진 것은 없습니다.',
    passthrough: 'CUSTOM 이벤트를 data 파트로 보기 (passthrough)',
    errorLabel: '오류',
    userLabel: '나',
    agentLabel: '에이전트',
  },
} as const;

export type MessageKey = keyof (typeof MESSAGES)['en'];

/** Fill `{name}` placeholders. */
export function t(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
  return MESSAGES[lang][key].replace(/\{(\w+)\}/g, (_m, name: string) => String(vars[name] ?? `{${name}}`));
}

/** `ko`, `ko_KR.UTF-8`, `ko-KR` -> 'ko'; `en`, `en_US`, `en-GB` -> 'en'; anything else -> undefined. */
export function parseLang(value: string | undefined | null): Lang | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'ko' || v.startsWith('ko_') || v.startsWith('ko-') || v.startsWith('ko.')) return 'ko';
  if (v === 'en' || v.startsWith('en_') || v.startsWith('en-') || v.startsWith('en.')) return 'en';
  return undefined;
}

/**
 * CLI language: `--lang` > AGUI_EXAMPLE_LANG > LC_ALL > LC_MESSAGES > LANG.
 * The first of the locale variables that is set decides (as in POSIX); not Korean means English.
 */
export function resolveCliLang(flag: string | undefined, env: Record<string, string | undefined>): Lang {
  const explicit = parseLang(flag) ?? parseLang(env.AGUI_EXAMPLE_LANG);
  if (explicit) return explicit;
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const v = env[name];
    if (v) return parseLang(v) === 'ko' ? 'ko' : 'en';
  }
  return 'en';
}

/** Web language: the value saved by the language menu wins; the first visit uses the browser language. */
export function resolveWebLang(stored: string | null | undefined, navigatorLanguage: string | undefined): Lang {
  const saved = parseLang(stored);
  if (saved) return saved;
  return parseLang(navigatorLanguage) === 'ko' ? 'ko' : 'en';
}

/** localStorage key used by the web example; `?lang=ko` in the address also selects a language. */
export const WEB_LANG_STORAGE_KEY = 'agui-example-lang';
