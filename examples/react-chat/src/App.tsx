import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AgUiChatTransport, type UnmappedReport } from 'agui-chat-transport';
import { BROWSER_MOCK_URL, installBrowserMock } from './browser-mock.js';
import { LANGS, WEB_LANG_STORAGE_KEY, parseLang, resolveWebLang, t, type Lang } from '../../shared/i18n.js';

// The browser tool: fixed fake weather, no network involved.
const getWeather = {
  name: 'getWeather',
  description: 'Current weather for a city (fixed fake data)',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

/** Saved choice > ?lang=ko in the address > browser language (first visit only). */
function initialLang(): Lang {
  const fromQuery = parseLang(new URLSearchParams(window.location.search).get('lang'));
  if (fromQuery) return fromQuery;
  return resolveWebLang(window.localStorage.getItem(WEB_LANG_STORAGE_KEY), window.navigator.language);
}

/** Where the AG-UI server lives: VITE_AGUI_URL, or the mock started by vite.config.ts. */
function useAgentUrl(): string | undefined {
  const [url, setUrl] = useState<string | undefined>(import.meta.env.VITE_AGUI_URL as string | undefined);
  useEffect(() => {
    if (url) return;
    // Opened from disk (static build): answer with the in-page practice agent.
    if (window.location.protocol === 'file:') {
      installBrowserMock();
      setUrl(BROWSER_MOCK_URL);
      return;
    }
    void fetch('/__mock-url')
      .then((r) => r.json())
      .then((j: { url: string }) => setUrl(j.url));
  }, [url]);
  return url;
}

export function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [passthrough, setPassthrough] = useState(false);
  const url = useAgentUrl();
  const isMock = !import.meta.env.VITE_AGUI_URL;
  const choose = (next: Lang) => {
    window.localStorage.setItem(WEB_LANG_STORAGE_KEY, next);
    setLang(next);
  };
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return (
    <>
      <header>
        <h1>
          {t(lang, 'appTitle')}
          {isMock && <span className="badge">{t(lang, 'mockBadge')}</span>}
        </h1>
        <label>
          {t(lang, 'language')}{' '}
          <select value={lang} onChange={(e) => choose(e.target.value as Lang)} aria-label={t(lang, 'language')}>
            {LANGS.map((l) => (
              <option key={l} value={l}>
                {l === 'en' ? 'English' : '한국어'}
              </option>
            ))}
          </select>
        </label>
      </header>
      {url ? <Chat key={`${url}-${passthrough}`} url={url} lang={lang} passthrough={passthrough} setPassthrough={setPassthrough} /> : null}
    </>
  );
}

function Chat(props: { url: string; lang: Lang; passthrough: boolean; setPassthrough: (v: boolean) => void }) {
  const { url, lang, passthrough } = props;
  const [unmapped, setUnmapped] = useState<UnmappedReport[]>([]);
  const toolCallsHandled = useRef(new Set<string>());

  // The one line that connects useChat to an AG-UI server.
  const transport = useMemo(
    () =>
      new AgUiChatTransport({
        url,
        tools: [getWeather],
        passthrough: passthrough ? ['CUSTOM'] : [],
        onUnmapped: (r) => setUnmapped((prev) => [...prev, r].slice(-20)),
      }),
    [url, passthrough],
  );

  const { messages, sendMessage, status, stop, error, addToolOutput } = useChat({
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    async onToolCall({ toolCall }) {
      if (toolCall.toolName !== 'getWeather' || toolCallsHandled.current.has(toolCall.toolCallId)) return;
      toolCallsHandled.current.add(toolCall.toolCallId);
      // Do not await addToolOutput inside onToolCall (it would deadlock the stream).
      void addToolOutput({ tool: 'getWeather', toolCallId: toolCall.toolCallId, output: { tempC: 21, sky: 'sunny' } } as never);
    },
  });
  const [text, setText] = useState('');

  // The latest shared state is the last data-agui-state part in the history.
  const state = useMemo(() => {
    for (const m of [...messages].reverse()) {
      for (const p of [...m.parts].reverse()) if (p.type === 'data-agui-state') return (p as { data: unknown }).data;
    }
    return undefined;
  }, [messages]);

  return (
    <main>
      <section>
        <div className="panel">
          {messages.map((m) => (
            <div className="msg" key={m.id}>
              <b>{m.role === 'user' ? t(lang, 'userLabel') : t(lang, 'agentLabel')}</b>
              {m.parts.map((p, i) => {
                const part = p as Record<string, any>;
                if (part.type === 'text') return <div key={i}>{part.text}</div>;
                if (part.type === 'reasoning')
                  return (
                    <details className="reasoning" key={i}>
                      <summary>{t(lang, 'reasoning')}</summary>
                      {part.text}
                    </details>
                  );
                if (part.type === 'dynamic-tool')
                  return (
                    <div className="tool" key={i}>
                      {t(lang, 'toolCard')}: <b style={{ display: 'inline' }}>{part.toolName}</b> {JSON.stringify(part.input)} -{' '}
                      {part.state === 'output-available' ? `${t(lang, 'toolDone')}: ${JSON.stringify(part.output)}` : t(lang, 'toolWaiting')}
                    </div>
                  );
                if (part.type === 'data-agui-custom')
                  return (
                    <pre className="tool" key={i}>
                      {JSON.stringify(part.data)}
                    </pre>
                  );
                return null;
              })}
            </div>
          ))}
          {error && (
            <div className="error">
              {t(lang, 'errorLabel')}: {error.message}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim()) return;
              void sendMessage({ text });
              setText('');
            }}
          >
            <input type="text" value={text} placeholder={t(lang, 'inputPlaceholder')} onChange={(e) => setText(e.target.value)} />
            <button type="submit" disabled={status === 'streaming'}>
              {t(lang, 'send')}
            </button>
            <button type="button" className="secondary" onClick={() => void stop()} disabled={status !== 'streaming'}>
              {t(lang, 'stop')}
            </button>
          </form>
        </div>
      </section>
      <aside>
        <div className="panel">
          <h2>{t(lang, 'statePanel')}</h2>
          <pre>{state === undefined ? '-' : JSON.stringify(state, null, 2)}</pre>
        </div>
        <div className="panel">
          <h2>{t(lang, 'unmappedPanel')}</h2>
          <label>
            <input type="checkbox" checked={passthrough} onChange={(e) => props.setPassthrough(e.target.checked)} /> {t(lang, 'passthrough')}
          </label>
          {unmapped.length === 0 ? (
            <p>{t(lang, 'unmappedEmpty')}</p>
          ) : (
            <ul>
              {unmapped.map((r, i) => (
                <li key={i}>
                  <code>
                    {r.eventType} ({r.reason})
                  </code>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </main>
  );
}
