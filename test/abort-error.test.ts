import { afterEach, describe, expect, it } from 'vitest';
import { AgUiChatTransport, AgUiTransportConfigError } from '../src/index.js';
import { SCENARIOS, startMockAgUiServer, type MockAgUiServer, type Scenario } from '../src/testing/index.js';
import { collect, user } from './helpers.js';

let server: MockAgUiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const send = (t: AgUiChatTransport, abortSignal?: AbortSignal) =>
  t.sendMessages({ trigger: 'submit-message', chatId: 'c', messageId: undefined, messages: [user('go')], abortSignal });

/** Only fails a real hang; the checks below never depend on how fast the machine is. */
const HANG_GUARD_MS = 15_000;
/** The built-in 'slow' scenario sends one event every 50 ms: 20 events = 1 second of output. */
const ONE_SECOND_OF_EVENTS = 20;

/**
 * The built-in 'slow' scenario, unchanged, plus a counter of the events the server
 * handed out after the test pressed stop.
 */
function countingSlowScenario() {
  let stopped = false;
  let afterStop = 0;
  const scenario: Scenario = async function* (input) {
    for await (const event of SCENARIOS.slow(input)) {
      if (stopped) afterStop++;
      yield event;
    }
  };
  return {
    scenario,
    markStop: () => void (stopped = true),
    sentAfterStop: () => afterStop,
  };
}

describe('AC-7 errors and stop()', () => {
  it('RUN_ERROR becomes an error chunk carrying the message', async () => {
    server = await startMockAgUiServer({ scenario: 'run-error' });
    const { chunks, schemaFailures } = await collect(await send(new AgUiChatTransport({ url: server.url })));
    expect(schemaFailures).toEqual([]);
    expect(chunks.at(-1)).toEqual({ type: 'error', errorText: 'model overloaded' });
    // The partial text is closed before the error.
    expect(chunks.some((c) => c.type === 'text-end')).toBe(true);
  });

  it('an HTTP 500 becomes an error chunk', async () => {
    server = await startMockAgUiServer({ httpStatus: 500 });
    const { chunks } = await collect(await send(new AgUiChatTransport({ url: server.url })));
    const err = chunks.find((c) => c.type === 'error') as { errorText: string } | undefined;
    expect(err).toBeDefined();
    expect(err!.errorText).toMatch(/500/);
  });

  it('a refused connection becomes an error chunk, not a throw', async () => {
    const { chunks } = await collect(await send(new AgUiChatTransport({ url: 'http://127.0.0.1:1/agent' })));
    const err = chunks.find((c) => c.type === 'error') as { errorText: string } | undefined;
    expect(err).toBeDefined();
    expect(err!.errorText).toContain('http://127.0.0.1:1/agent');
    expect(err!.errorText).toMatch(/Is the agent server running/);
  });

  it('abortSignal closes the server response within 1 second and ends the stream', async () => {
    const slow = countingSlowScenario();
    server = await startMockAgUiServer({ events: slow.scenario });
    const controller = new AbortController();
    const stream = await send(new AgUiChatTransport({ url: server.url }), controller.signal);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    slow.markStop();
    controller.abort();
    // Wait for the server's own 'close' event (no fixed sleep). HANG_GUARD_MS only fails a hang.
    expect(await server.waitForAbort(HANG_GUARD_MS)).toBe(true);
    // "Within 1 second" is measured on the scenario's own clock: it sends one event every
    // 50 ms, so 1 second is 20 events. Counting events (not wall time) keeps the check exact
    // when a busy machine pauses the whole process (client and mock server share it).
    expect(slow.sentAfterStop()).toBeLessThan(ONE_SECOND_OF_EVENTS);
    // Stream terminates (no hang): drain until done.
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  });

  it('cancelling the stream reader also stops the run', async () => {
    const slow = countingSlowScenario();
    server = await startMockAgUiServer({ events: slow.scenario });
    const reader = (await send(new AgUiChatTransport({ url: server.url }))).getReader();
    await reader.read();
    slow.markStop();
    await reader.cancel();
    expect(await server.waitForAbort(HANG_GUARD_MS)).toBe(true);
    expect(slow.sentAfterStop()).toBeLessThan(ONE_SECOND_OF_EVENTS);
  });

  it('an already aborted signal never contacts the server', async () => {
    server = await startMockAgUiServer({ scenario: 'slow' });
    const controller = new AbortController();
    controller.abort();
    const { chunks } = await collect(await send(new AgUiChatTransport({ url: server.url }), controller.signal));
    expect(chunks).toEqual([]);
    expect(server.received).toHaveLength(0);
  });

  it('url or agent is required, and not both', () => {
    expect(() => new AgUiChatTransport({})).toThrow(AgUiTransportConfigError);
    expect(() => new AgUiChatTransport({})).toThrow(/url/);
    expect(() => new AgUiChatTransport({ url: 'http://x', agent: {} as never })).toThrow(AgUiTransportConfigError);
  });

  it('accepts a custom agent factory', async () => {
    server = await startMockAgUiServer({ scenario: 'chunked' });
    const { HttpAgent } = await import('@ag-ui/client');
    const url = server.url;
    const { chunks } = await collect(await send(new AgUiChatTransport({ agent: () => new HttpAgent({ url }) })));
    expect(chunks.at(-1)!.type).toBe('finish');
  });
});
