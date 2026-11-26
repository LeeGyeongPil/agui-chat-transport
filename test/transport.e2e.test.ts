import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { UIMessage } from 'ai';
import { HttpAgent } from '@ag-ui/client';
import { AgUiChatTransport } from '../src/index.js';
import { startMockAgUiServer, type MockAgUiServer } from '../src/testing/index.js';
import { assertMatch, collect, user } from './helpers.js';

const getWeather = {
  name: 'getWeather',
  description: 'Weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
};

let server: MockAgUiServer | undefined;
async function closeServer() {
  await server?.close();
  server = undefined;
}

const send = (t: AgUiChatTransport, messages: UIMessage[], extra: Record<string, unknown> = {}) =>
  t.sendMessages({ trigger: 'submit-message', chatId: 'chat-1', messageId: undefined, messages, abortSignal: undefined, ...extra });

describe('AC-2 weather run 1', () => {
  afterEach(closeServer);

  it('weather run 1 assembles expected parts', async () => {
    server = await startMockAgUiServer({ scenario: 'weather' });
    const transport = new AgUiChatTransport({ url: server.url, tools: [getWeather] });
    const { chunks, message, schemaFailures } = await collect(await send(transport, [user('Weather in Seoul?')]));

    assert.deepStrictEqual(schemaFailures, []);
    assert.notEqual(message, undefined);
    assert.notEqual(message!.id, '');
    const parts = message!.parts as Array<Record<string, any>>;
    assert.deepStrictEqual(
      parts.map((p) => p.type),
      ['step-start', 'reasoning', 'text', 'dynamic-tool', 'data-agui-state'],
    );
    assert.equal(parts[1]!.text, 'need weather');
    assert.equal(parts[2]!.text, 'Checking Seoul.');
    assertMatch(parts[3], { toolName: 'getWeather', state: 'input-available', input: { city: 'Seoul' } });
    assert.equal(parts[3]!.providerExecuted, undefined);
    assert.deepStrictEqual(parts[4]!.data, { step: 1, cities: ['Seoul'] });
    assert.equal(parts.filter((p) => p.type === 'data-agui-state').length, 1);
    assert.equal(chunks.filter((c) => c.type === 'start').length, 1);
  });
});

describe('AC-3 tool round trip', () => {
  afterEach(closeServer);

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
    assert.deepStrictEqual(second.schemaFailures, []);
    assert.equal((second.message!.parts as Array<Record<string, any>>).find((p) => p.type === 'text')!.text, 'It is sunny.');

    const input = server.received[1]!;
    assert.equal(input.threadId, 'chat-1');
    assert.deepStrictEqual(input.state, { step: 1, cities: ['Seoul'] });
    assert.deepStrictEqual(input.tools, [getWeather]);
    assert.deepStrictEqual(
      input.messages.map((m) => m.role),
      ['user', 'assistant', 'tool'],
    );
    const a = input.messages[1] as any;
    assert.equal(a.id, 'm1');
    assert.equal(a.content, 'Checking Seoul.');
    assertMatch(a.toolCalls[0], { id: 'tc1', function: { name: 'getWeather', arguments: '{"city":"Seoul"}' } });
    const tool = input.messages[2] as any;
    assert.equal(tool.toolCallId, 'tc1');
    assert.deepStrictEqual(JSON.parse(tool.content), { tempC: 21, sky: 'sunny' });
  });
});

describe('request options', () => {
  afterEach(closeServer);

  it('sends headers, body (as forwardedProps) and the mapped thread id', async () => {
    server = await startMockAgUiServer({ scenario: 'chunked' });
    const transport = new AgUiChatTransport({
      url: server.url,
      headers: async () => ({ 'x-token': 'abc' }),
      threadId: (id) => `thread-${id}`,
    });
    await collect(await send(transport, [user('hi')], { body: { locale: 'ko' }, headers: { 'x-extra': '1' } }));
    assert.equal(server.received[0]!.threadId, 'thread-chat-1');
    assert.deepStrictEqual(server.received[0]!.forwardedProps, { locale: 'ko' });
    assert.equal(server.receivedHeaders[0]!['x-token'], 'abc');
    assert.equal(server.receivedHeaders[0]!['x-extra'], '1');
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
    assert.deepStrictEqual(agent.headers, { 'x-base': 'b' });
    await collect(await send(transport, [user('three')]));
    const last = server.receivedHeaders.at(-1)!;
    assert.equal(last['x-base'], 'b');
    assert.equal(last['x-a'], undefined);
    assert.equal(last['x-b'], undefined);
  });

  it('reconnectToStream returns null', async () => {
    const transport = new AgUiChatTransport({ url: 'http://127.0.0.1:1/agent' });
    assert.equal(await transport.reconnectToStream(), null);
  });
});
