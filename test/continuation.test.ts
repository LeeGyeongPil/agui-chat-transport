import { AbstractChat, lastAssistantMessageIsCompleteWithToolCalls, type UIMessage } from 'ai';
import { EventType } from '@ag-ui/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AgUiChatTransport, createAgUiChunkConverter } from '../src/index.js';
import { startMockAgUiServer, type MockAgUiServer } from '../src/testing/index.js';

let server: MockAgUiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

class State {
  status: 'ready' | 'submitted' | 'streaming' | 'error' = 'ready';
  error: Error | undefined = undefined;
  messages: UIMessage[] = [];
  pushMessage = (m: UIMessage) => void (this.messages = this.messages.concat(m));
  popMessage = () => void (this.messages = this.messages.slice(0, -1));
  replaceMessage = (i: number, m: UIMessage) => void (this.messages = this.messages.map((x, j) => (j === i ? m : x)));
  snapshot = <T>(t: T): T => structuredClone(t);
}

const getWeather = { name: 'getWeather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } };

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
}

describe('browser tool round trip through AbstractChat (what useChat uses)', () => {
  it('continues one assistant message and never repeats a tool call in the next request', async () => {
    server = await startMockAgUiServer({ scenario: 'weather' });
    const transport = new AgUiChatTransport({ url: server.url, tools: [getWeather] });
    let chat!: AbstractChat<UIMessage>;
    chat = new (class extends AbstractChat<UIMessage> {})({
      id: 'chat-1',
      state: new State(),
      transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      onToolCall({ toolCall }) {
        void chat.addToolOutput({ tool: 'getWeather', toolCallId: toolCall.toolCallId, output: { tempC: 21, sky: 'sunny' } });
      },
    });

    await chat.sendMessage({ text: 'Weather in Seoul?' });
    await until(() => server!.received.length >= 2 && chat.status === 'ready');

    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const types = chat.messages[1]!.parts.map((p) => p.type);
    expect(types.filter((t) => t === 'dynamic-tool')).toHaveLength(1);
    expect(types.at(-1)).toBe('text');
    const lastText = chat.messages[1]!.parts.at(-1) as { text: string };
    expect(lastText.text).toBe('It is sunny.');

    await chat.sendMessage({ text: 'And Busan?' });
    await until(() => server!.received.length >= 3 && chat.status === 'ready');
    const third = server.received[2]!;
    const callIds = third.messages.flatMap((m: any) => (m.toolCalls ?? []).map((t: any) => t.id));
    const resultIds = third.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.id);
    expect(new Set(callIds).size).toBe(callIds.length);
    expect(new Set(resultIds).size).toBe(resultIds.length);
    expect(new Set(third.messages.map((m: any) => m.id)).size).toBe(third.messages.length);
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
    expect(out.map((x) => x.type)).toContain('tool-input-available');
    expect(reports.some((r) => r.startsWith('orphan-event:') && r.includes('never received TOOL_CALL_END'))).toBe(true);
  });

  it('reports events that arrive after the terminal event', () => {
    const reports: string[] = [];
    const c = createAgUiChunkConverter({ onUnmapped: (r) => reports.push(`${r.reason}:${r.detail}`) });
    c.push({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' } as any);
    c.push({ type: EventType.RUN_FINISHED, threadId: 't', runId: 'r' } as any);
    const out = c.push({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'm', delta: 'late' } as any);
    expect(out).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('after the terminal event');
  });

  it('uses the given messageId in the start chunk', () => {
    const c = createAgUiChunkConverter({ messageId: 'keep-me' });
    const out = c.push({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' } as any);
    expect(out[0]).toMatchObject({ type: 'start', messageId: 'keep-me' });
  });
});
