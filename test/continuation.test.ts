import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { AbstractChat, lastAssistantMessageIsCompleteWithToolCalls, type UIMessage } from 'ai';
import { EventType } from '@ag-ui/core';
import { AgUiChatTransport, createAgUiChunkConverter } from '../src/index.js';
import { startMockAgUiServer, type MockAgUiServer } from '../src/testing/index.js';
import { assertMatch } from './helpers.js';

let server: MockAgUiServer | undefined;

/** Minimal ChatState (what useChat keeps in React state) that tells listeners about every change. */
class State {
  readonly listeners = new Set<() => void>();
  #status: 'ready' | 'submitted' | 'streaming' | 'error' = 'ready';
  #messages: UIMessage[] = [];
  error: Error | undefined = undefined;
  get status() {
    return this.#status;
  }
  set status(v) {
    this.#status = v;
    this.changed();
  }
  get messages() {
    return this.#messages;
  }
  set messages(v) {
    this.#messages = v;
    this.changed();
  }
  pushMessage = (m: UIMessage) => void (this.messages = this.messages.concat(m));
  popMessage = () => void (this.messages = this.messages.slice(0, -1));
  replaceMessage = (i: number, m: UIMessage) => void (this.messages = this.messages.map((x, j) => (j === i ? m : x)));
  snapshot = <T>(t: T): T => structuredClone(t);
  private changed() {
    for (const fn of [...this.listeners]) fn();
  }
}

const getWeather = { name: 'getWeather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } };

/**
 * Resolve as soon as `cond()` is true, re-checking on every chat state change (no polling,
 * no fixed wait). Rejects right away if the chat reports an error; a real hang is ended
 * by the test timeout.
 */
function until(state: State, cond: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (state.status === 'error') {
        state.listeners.delete(check);
        reject(state.error ?? new Error('chat status became error'));
      } else if (cond()) {
        state.listeners.delete(check);
        resolve();
      }
    };
    state.listeners.add(check);
    check();
  });
}

describe('browser tool round trip through AbstractChat (what useChat uses)', () => {
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('continues one assistant message and never repeats a tool call in the next request', async () => {
    server = await startMockAgUiServer({ scenario: 'weather' });
    const transport = new AgUiChatTransport({ url: server.url, tools: [getWeather] });
    const state = new State();
    let chat!: AbstractChat<UIMessage>;
    chat = new (class extends AbstractChat<UIMessage> {})({
      id: 'chat-1',
      state,
      transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      onToolCall({ toolCall }) {
        void chat.addToolOutput({ tool: 'getWeather', toolCallId: toolCall.toolCallId, output: { tempC: 21, sky: 'sunny' } });
      },
    });

    await chat.sendMessage({ text: 'Weather in Seoul?' });
    await until(state, () => server!.received.length >= 2 && chat.status === 'ready');

    assert.deepStrictEqual(
      chat.messages.map((m) => m.role),
      ['user', 'assistant'],
    );
    const types = chat.messages[1]!.parts.map((p) => p.type);
    assert.equal(types.filter((t) => t === 'dynamic-tool').length, 1);
    assert.equal(types.at(-1), 'text');
    const lastText = chat.messages[1]!.parts.at(-1) as { text: string };
    assert.equal(lastText.text, 'It is sunny.');

    await chat.sendMessage({ text: 'And Busan?' });
    await until(state, () => server!.received.length >= 3 && chat.status === 'ready');
    const third = server.received[2]!;
    const callIds = third.messages.flatMap((m: any) => (m.toolCalls ?? []).map((t: any) => t.id));
    const resultIds = third.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.id);
    assert.equal(new Set(callIds).size, callIds.length);
    assert.equal(new Set(resultIds).size, resultIds.length);
    assert.equal(new Set(third.messages.map((m: any) => m.id)).size, third.messages.length);
  });
});

describe('converter edge reports', () => {
  it('closes and reports a tool call that never ended', () => {
    const reports: string[] = [];
    const c = createAgUiChunkConverter({ onUnmapped: (r) => reports.push(`${r.reason}:${r.detail}`) });
    c.push({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' } as any);
    c.push({ type: EventType.TOOL_CALL_START, toolCallId: 'a', toolCallName: 'x' } as any);
    c.push({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'a', delta: '{"k":1}' } as any);
    const out = c.finish();
    assert.ok(out.map((x) => x.type).includes('tool-input-available'));
    assert.equal(
      reports.some((r) => r.startsWith('orphan-event:') && r.includes('never received TOOL_CALL_END')),
      true,
    );
  });

  it('reports events that arrive after the terminal event', () => {
    const reports: string[] = [];
    const c = createAgUiChunkConverter({ onUnmapped: (r) => reports.push(`${r.reason}:${r.detail}`) });
    c.push({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' } as any);
    c.push({ type: EventType.RUN_FINISHED, threadId: 't', runId: 'r' } as any);
    const out = c.push({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'm', delta: 'late' } as any);
    assert.deepStrictEqual(out, []);
    assert.equal(reports.length, 1);
    assert.ok(reports[0]!.includes('after the terminal event'), reports[0]);
  });

  it('uses the given messageId in the start chunk', () => {
    const c = createAgUiChunkConverter({ messageId: 'keep-me' });
    const out = c.push({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' } as any);
    assertMatch(out[0], { type: 'start', messageId: 'keep-me' });
  });
});
