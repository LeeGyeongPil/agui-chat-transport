// Quickstart: run the transport against a mock AG-UI server (or your own with --url).
// Read top to bottom: send -> assemble -> run the browser tool -> send the result back.
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { AgUiChatTransport, type UnmappedReport } from '../src/index.js';
import { startMockAgUiServer, type MockAgUiServer } from '../src/testing/index.js';
import { parseLang, resolveCliLang, t, type Lang } from './shared/i18n.js';

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const langFlag = readArg('--lang');
if (langFlag !== undefined && !parseLang(langFlag)) {
  console.error(t(resolveCliLang(undefined, process.env), 'badLang', { value: langFlag }));
  process.exit(2);
}
const lang: Lang = resolveCliLang(langFlag, process.env);
if (process.argv.includes('--help')) {
  console.log(t(lang, 'usage'));
  process.exit(0);
}
const say = (text: string) => console.log(text);

// The one tool the browser executes. The weather is a fixed fake value.
const getWeather = {
  name: 'getWeather',
  description: 'Current weather for a city (fixed fake data)',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

/** Read a chunk stream to the end: assemble the message and count chunk types. */
async function assemble(stream: ReadableStream<UIMessageChunk>) {
  const [a, b] = stream.tee();
  const counts = new Map<string, number>();
  const counting = (async () => {
    const reader = b.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      counts.set(value.type, (counts.get(value.type) ?? 0) + 1);
    }
  })();
  let message: UIMessage | undefined;
  // An error chunk makes readUIMessageStream report it; keep the transport's text (url + fix hint).
  let errorText: string | undefined;
  try {
    for await (const m of readUIMessageStream({
      stream: a,
      onError: (e) => {
        errorText = e instanceof Error ? e.message : String(e);
      },
    }))
      message = m;
  } catch (e) {
    errorText ??= e instanceof Error ? e.message : String(e);
  }
  await counting;
  return { message, counts, errorText };
}

class RunFailed extends Error {}

const realUrl = readArg('--url') ?? process.env.AGUI_URL;
let mock: MockAgUiServer | undefined;
let exitCode = 0;
try {
  say(t(lang, 'title'));
  let url: string;
  if (realUrl) {
    url = realUrl;
    say(t(lang, 'realNote', { url }));
  } else {
    mock = await startMockAgUiServer({ scenario: 'weather' });
    url = mock.url;
    say(t(lang, 'mockNote'));
  }

  // 1) The only line that differs from a normal useChat setup: the transport.
  const unmapped: UnmappedReport[] = [];
  const transport = new AgUiChatTransport({ url, tools: [getWeather], onUnmapped: (r) => unmapped.push(r) });
  const user: UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Weather in Seoul?' }] };

  say('');
  say(t(lang, 'run1'));
  const first = await assemble(
    await transport.sendMessages({ trigger: 'submit-message', chatId: 'quickstart', messageId: undefined, messages: [user], abortSignal: undefined }),
  );
  if (first.errorText !== undefined || !first.message) throw new RunFailed(first.errorText ?? 'empty stream');
  const total = [...first.counts.values()].reduce((x, y) => x + y, 0);
  say(t(lang, 'chunks', { count: total, types: [...first.counts].map(([k, v]) => `${k} x${v}`).join(', ') }));
  say(t(lang, 'parts'));
  for (const p of first.message.parts as Array<Record<string, any>>) {
    const detail = p.type === 'text' || p.type === 'reasoning' ? JSON.stringify(p.text) : p.type === 'dynamic-tool' ? `${p.toolName} ${p.state} ${JSON.stringify(p.input)}` : p.type === 'data-agui-state' ? JSON.stringify(p.data) : '';
    say(`  - ${p.type} ${detail}`.trimEnd());
  }

  // 2) The browser runs the tool (this is what onToolCall + addToolOutput do in useChat).
  const withResult = structuredClone(first.message) as UIMessage;
  for (const p of withResult.parts as Array<Record<string, any>>) {
    if (p.type === 'dynamic-tool' && p.state === 'input-available') {
      const result = { tempC: 21, sky: 'sunny' };
      say(t(lang, 'toolRunning', { city: JSON.stringify(p.input.city), result: JSON.stringify(result) }));
      p.state = 'output-available';
      p.output = result;
    }
  }

  // 3) Send the history again: the transport turns it into user / assistant(toolCalls) / tool messages.
  say('');
  say(t(lang, 'run2'));
  const second = await assemble(
    await transport.sendMessages({ trigger: 'submit-message', chatId: 'quickstart', messageId: undefined, messages: [user, withResult], abortSignal: undefined }),
  );
  if (second.errorText !== undefined || !second.message) throw new RunFailed(second.errorText ?? 'empty stream');
  const answer = (second.message.parts as Array<Record<string, any>>).filter((p) => p.type === 'text').map((p) => p.text).join('');
  say(t(lang, 'answer', { text: JSON.stringify(answer) }));

  // 4) Verify the round trip. With the mock we can also look at what the server received.
  let failure: string | undefined;
  if (!answer) failure = 'no answer text';
  if (mock) {
    const roles = mock.received[1]?.messages.map((m) => m.role).join(',');
    if (roles !== 'user,assistant,tool') failure = `server saw roles ${roles}`;
  }
  say('');
  if (failure) {
    say(t(lang, 'roundTripFail', { reason: failure }));
    exitCode = 1;
  } else {
    say(t(lang, 'roundTripOk'));
  }
  const kinds = [...new Set(unmapped.map((r) => r.eventType))];
  say(unmapped.length ? t(lang, 'unmapped', { count: unmapped.length, types: kinds.join(', ') }) : t(lang, 'unmappedNone'));
} catch (err) {
  // Show the library's own message (it names the url and how to fix it) and stop; no further runs.
  if (!(err instanceof RunFailed)) throw err;
  console.error(t(lang, 'runFailed', { error: err.message }));
  exitCode = 1;
} finally {
  await mock?.close();
}
process.exit(exitCode);
