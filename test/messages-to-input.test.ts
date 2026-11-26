import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { UIMessage } from 'ai';
import { uiMessagesToRunAgentInput } from '../src/index.js';
import { assertMatch, user } from './helpers.js';

const opts = { threadId: 'th', runId: 'run' };
const meta = (agui: Record<string, unknown>) => ({ agui });

describe('uiMessagesToRunAgentInput', () => {
  it('splits a merged UIMessage back into the original AG-UI message ids', () => {
    const merged = {
      id: 'ui-1',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'first', providerMetadata: meta({ messageId: 'm1' }) },
        { type: 'dynamic-tool', toolName: 'a', toolCallId: 'c1', state: 'output-available', input: { x: 1 }, output: 'done', callProviderMetadata: meta({ parentMessageId: 'm1' }) },
        { type: 'text', text: 'second', providerMetadata: meta({ messageId: 'm2' }) },
      ],
    } as unknown as UIMessage;
    const input = uiMessagesToRunAgentInput([user('hi'), merged], opts);
    assert.deepStrictEqual(
      input.messages.map((m) => [m.role, m.id]),
      [
        ['user', 'u1'],
        ['assistant', 'm1'],
        ['tool', 'c1-result'],
        ['assistant', 'm2'],
      ],
    );
    const m1 = input.messages[1] as any;
    assert.equal(m1.content, 'first');
    assert.equal(m1.toolCalls.length, 1);
    assert.equal((input.messages[2] as any).content, 'done');
    assert.equal((input.messages[3] as any).content, 'second');
  });

  it('output-error becomes a tool message with error; denied too', () => {
    const msg = {
      id: 'a',
      role: 'assistant',
      parts: [
        { type: 'dynamic-tool', toolName: 't', toolCallId: 'c1', state: 'output-error', input: {}, errorText: 'boom' },
        { type: 'dynamic-tool', toolName: 't', toolCallId: 'c2', state: 'output-denied', input: {} },
      ],
    } as unknown as UIMessage;
    const input = uiMessagesToRunAgentInput([msg], opts);
    assertMatch(input.messages[0], { role: 'assistant', id: 'a' });
    assertMatch(input.messages[1], { role: 'tool', toolCallId: 'c1', error: 'boom', content: '' });
    assertMatch(input.messages[2], { role: 'tool', toolCallId: 'c2' });
    assert.match((input.messages[2] as any).error, /denied/);
  });

  it('skips tool calls that are still streaming and empty assistant messages', () => {
    const msg = {
      id: 'a',
      role: 'assistant',
      parts: [{ type: 'step-start' }, { type: 'dynamic-tool', toolName: 't', toolCallId: 'c', state: 'input-streaming' }],
    } as unknown as UIMessage;
    assert.deepStrictEqual(uiMessagesToRunAgentInput([msg], opts).messages, []);
  });

  it('handles static tool parts (tool-<name>)', () => {
    const msg = {
      id: 'a',
      role: 'assistant',
      parts: [{ type: 'tool-getWeather', toolCallId: 'c', state: 'output-available', input: { city: 'Seoul' }, output: { t: 1 } }],
    } as unknown as UIMessage;
    const input = uiMessagesToRunAgentInput([msg], opts);
    assert.deepStrictEqual((input.messages[0] as any).toolCalls[0].function, { name: 'getWeather', arguments: '{"city":"Seoul"}' });
    assert.equal((input.messages[1] as any).content, '{"t":1}');
  });

  it('uses the last data-agui-state, explicit state wins, and resume is forwarded', () => {
    const history = [
      user('hi'),
      { id: 'a', role: 'assistant', parts: [{ type: 'data-agui-state', id: 'agui-state', data: { n: 1 } }] },
      { id: 'b', role: 'assistant', parts: [{ type: 'data-agui-state', id: 'agui-state', data: { n: 2 } }] },
    ] as unknown as UIMessage[];
    assert.deepStrictEqual(uiMessagesToRunAgentInput(history, opts).state, { n: 2 });
    assert.deepStrictEqual(uiMessagesToRunAgentInput(history, { ...opts, state: { n: 9 } }).state, { n: 9 });
    const resume = [{ interruptId: 'int1', status: 'resolved' as const, payload: { ok: true } }];
    const input = uiMessagesToRunAgentInput(history, { ...opts, resume });
    assert.deepStrictEqual(input.resume, resume);
    assert.equal(uiMessagesToRunAgentInput(history, opts).resume, undefined);
  });

  it('fills defaults: empty state, tools, context and a generated runId', () => {
    const input = uiMessagesToRunAgentInput([user('x')], { threadId: 't' });
    assertMatch(input, { threadId: 't', state: {}, tools: [], context: [], forwardedProps: {} });
    assert.match(input.runId, /[0-9a-f-]{36}/);
  });

  it('includeReasoning sends reasoning messages', () => {
    const msg = {
      id: 'a',
      role: 'assistant',
      parts: [{ type: 'reasoning', text: 'why', providerMetadata: meta({ messageId: 'r1' }) }, { type: 'text', text: 'ok', providerMetadata: meta({ messageId: 'r1' }) }],
    } as unknown as UIMessage;
    assert.deepStrictEqual(
      uiMessagesToRunAgentInput([msg], opts).messages.map((m) => m.role),
      ['assistant'],
    );
    assert.deepStrictEqual(
      uiMessagesToRunAgentInput([msg], { ...opts, includeReasoning: true }).messages.map((m) => m.role),
      ['reasoning', 'assistant'],
    );
  });
});
