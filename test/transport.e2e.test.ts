import { afterEach, describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { HttpAgent } from '@ag-ui/client';
import { AgUiChatTransport } from '../src/index.js';
import { startMockAgUiServer, type MockAgUiServer } from '../src/testing/index.js';
import { collect, user } from './helpers.js';

const getWeather = {
  name: 'getWeather',
  description: 'Weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
};

let server: MockAgUiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const send = (t: AgUiChatTransport, messages: UIMessage[], extra: Record<string, unknown> = {}) =>
  t.sendMessages({ trigger: 'submit-message', chatId: 'chat-1', messageId: undefined, messages, abortSignal: undefined, ...extra });

describe('AC-2 weather run 1', () => {
  it('weather run 1 assembles expected parts', async () => {
    server = await startMockAgUiServer({ scenario: 'weather' });
    const transport = new AgUiChatTransport({ url: server.url, tools: [getWeather] });
    const { chunks, message, schemaFailures } = await collect(await send(transport, [user('Weather in Seoul?')]));

    expect(schemaFailures).toEqual([]);
    expect(message).toBeDefined();
    expect(message!.id).not.toBe('');
    const parts = message!.parts as Array<Record<string, any>>;
    expect(parts.map((p) => p.type)).toEqual(['step-start', 'reasoning', 'text', 'dynamic-tool', 'data-agui-state']);
    expect(parts[1]!.text).toBe('need weather');
    expect(parts[2]!.text).toBe('Checking Seoul.');
    expect(parts[3]).toMatchObject({ toolName: 'getWeather', state: 'input-available', input: { city: 'Seoul' } });
    expect(parts[3]!.providerExecuted).toBeUndefined();
    expect(parts[4]!.data).toEqual({ step: 1, cities: ['Seoul'] });
    expect(parts.filter((p) => p.type === 'data-agui-state')).toHaveLength(1);
    expect(chunks.filter((c) => c.type === 'start')).toHaveLength(1);
  });
});

describe('AC-3 tool round trip', () => {
  it('tool round trip', async () => {
    server = await startMockAgUiServer({ scenario: 'weather' });
    const transport = new AgUiChatTransport({ url: server.url, tools: [getWeather] });
    const u = user('Weather in Seoul?');
    const first = await collect(await send(transport, [u]));
    const assistant = structuredClone(first.message!) as UIMessage;
    for (const p of assistant.parts as Array<Record<string, any>>) {
      if (p.type === 'dynamic-tool') {
        p.state = 'output-available';
        p.output = { tempC: 21, sky: 'sunny' };
      }
    }
    const second = await collect(await send(transport, [u, assistant]));
    expect(second.schemaFailures).toEqual([]);
    expect((second.message!.parts as Array<Record<string, any>>).find((p) => p.type === 'text')!.text).toBe('It is sunny.');

    const input = server.received[1]!;
    expect(input.threadId).toBe('chat-1');
    expect(input.state).toEqual({ step: 1, cities: ['Seoul'] });
    expect(input.tools).toEqual([getWeather]);
    expect(input.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    const a = input.messages[1] as any;
    expect(a.id).toBe('m1');
    expect(a.content).toBe('Checking Seoul.');
    expect(a.toolCalls[0]).toMatchObject({ id: 'tc1', function: { name: 'getWeather', arguments: '{"city":"Seoul"}' } });
    const tool = input.messages[2] as any;
    expect(tool.toolCallId).toBe('tc1');
    expect(JSON.parse(tool.content)).toEqual({ tempC: 21, sky: 'sunny' });
  });
});

describe('request options', () => {
  it('sends headers, body (as forwardedProps) and the mapped thread id', async () => {
    server = await startMockAgUiServer({ scenario: 'chunked' });
    const transport = new AgUiChatTransport({
      url: server.url,
      headers: async () => ({ 'x-token': 'abc' }),
      threadId: (id) => `thread-${id}`,
    });
    await collect(await send(transport, [user('hi')], { body: { locale: 'ko' }, headers: { 'x-extra': '1' } }));
    expect(server.received[0]!.threadId).toBe('thread-chat-1');
    expect(server.received[0]!.forwardedProps).toEqual({ locale: 'ko' });
    expect(server.receivedHeaders[0]!['x-token']).toBe('abc');
    expect(server.receivedHeaders[0]!['x-extra']).toBe('1');
  });

  it('overlapping requests on a shared agent do not leak headers into later requests', async () => {
    server = await startMockAgUiServer({ scenario: 'chunked' });
    const agent = new HttpAgent({ url: server.url, headers: { 'x-base': 'b' } });
    const transport = new AgUiChatTransport({ agent });
    const [a, b] = await Promise.all([
      send(transport, [user('one')], { headers: { 'x-a': '1' } }),
      send(transport, [user('two')], { headers: { 'x-b': '2' } }),
    ]);
    await Promise.all([collect(a), collect(b)]);
    expect(agent.headers).toEqual({ 'x-base': 'b' });
    await collect(await send(transport, [user('three')]));
    const last = server.receivedHeaders.at(-1)!;
    expect(last['x-base']).toBe('b');
    expect(last['x-a']).toBeUndefined();
    expect(last['x-b']).toBeUndefined();
  });

  it('reconnectToStream returns null', async () => {
    const transport = new AgUiChatTransport({ url: 'http://127.0.0.1:1/agent' });
    expect(await transport.reconnectToStream()).toBeNull();
  });
});
