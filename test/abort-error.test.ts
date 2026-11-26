import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { EventType } from '@ag-ui/core';
import { AgUiChatTransport, AgUiTransportConfigError } from '../src/index.js';
import { SCENARIOS, startMockAgUiServer, type MockAgUiServer, type Scenario } from '../src/testing/index.js';
import { collect, user } from './helpers.js';

let server: MockAgUiServer | undefined;

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
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('RUN_ERROR becomes an error chunk carrying the message', async () => {
    server = await startMockAgUiServer({ scenario: 'run-error' });
    const { chunks, schemaFailures } = await collect(await send(new AgUiChatTransport({ url: server.url })));
    assert.deepStrictEqual(schemaFailures, []);
    assert.deepStrictEqual(chunks.at(-1), { type: 'error', errorText: 'model overloaded' });
    // The partial text is closed before the error.
    assert.equal(chunks.some((c) => c.type === 'text-end'), true);
  });

  it('an HTTP 500 becomes an error chunk', async () => {
    server = await startMockAgUiServer({ httpStatus: 500 });
    const { chunks } = await collect(await send(new AgUiChatTransport({ url: server.url })));
    const err = chunks.find((c) => c.type === 'error') as { errorText: string } | undefined;
    assert.notEqual(err, undefined);
    assert.match(err!.errorText, /500/);
  });

  it('a refused connection becomes an error chunk, not a throw', async () => {
    const { chunks } = await collect(await send(new AgUiChatTransport({ url: 'http://127.0.0.1:1/agent' })));
    const err = chunks.find((c) => c.type === 'error') as { errorText: string } | undefined;
    assert.notEqual(err, undefined);
    assert.ok(err!.errorText.includes('http://127.0.0.1:1/agent'), err!.errorText);
    assert.match(err!.errorText, /Is the agent server running/);
  });

  it('abortSignal closes the server response within 1 second and ends the stream', async () => {
    const slow = countingSlowScenario();
    server = await startMockAgUiServer({ events: slow.scenario });
    const controller = new AbortController();
    const stream = await send(new AgUiChatTransport({ url: server.url }), controller.signal);
    const reader = stream.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    slow.markStop();
    controller.abort();
    // Wait for the server's own 'close' event (no fixed sleep). HANG_GUARD_MS only fails a hang.
    assert.equal(await server.waitForAbort(HANG_GUARD_MS), true);
    // "Within 1 second" is measured on the scenario's own clock: it sends one event every
    // 50 ms, so 1 second is 20 events. Counting events (not wall time) keeps the check exact
    // when a busy machine pauses the whole process (client and mock server share it).
    assert.ok(slow.sentAfterStop() < ONE_SECOND_OF_EVENTS, `sent after stop: ${slow.sentAfterStop()}`);
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
    assert.equal(await server.waitForAbort(HANG_GUARD_MS), true);
    assert.ok(slow.sentAfterStop() < ONE_SECOND_OF_EVENTS, `sent after stop: ${slow.sentAfterStop()}`);
  });

  it('stop() unsubscribes from a custom agent that cannot abort its run', async () => {
    // A custom agent whose run() is a bare observable and whose abortRun() does nothing:
    // only unsubscribing (the transport's own stop path) ends its event timer.
    let timer: ReturnType<typeof setInterval> | undefined;
    let tornDown = false;
    let sentAfterStop = 0;
    let stopped = false;
    const agent = {
      run: () => ({
        subscribe(observer: { next(e: unknown): void }) {
          observer.next({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' });
          let n = 0;
          timer = setInterval(() => {
            if (stopped) sentAfterStop++;
            observer.next({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'm', delta: `${n++} ` });
          }, 10);
          return {
            unsubscribe() {
              clearInterval(timer);
              tornDown = true;
            },
          };
        },
      }),
      abortRun() {},
    };
    try {
      const controller = new AbortController();
      const reader = (await send(new AgUiChatTransport({ agent: agent as never }), controller.signal)).getReader();
      assert.equal((await reader.read()).done, false);
      stopped = true;
      controller.abort();
      // The subscription is torn down synchronously by stop(); nothing to wait for.
      assert.equal(tornDown, true, 'the transport unsubscribed from the agent run');
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      assert.equal(sentAfterStop, 0);
    } finally {
      clearInterval(timer);
    }
  });

  it('an already aborted signal never contacts the server', async () => {
    server = await startMockAgUiServer({ scenario: 'slow' });
    const controller = new AbortController();
    controller.abort();
    const { chunks } = await collect(await send(new AgUiChatTransport({ url: server.url }), controller.signal));
    assert.deepStrictEqual(chunks, []);
    assert.equal(server.received.length, 0);
  });

  it('url or agent is required, and not both', () => {
    assert.throws(() => new AgUiChatTransport({}), AgUiTransportConfigError);
    assert.throws(() => new AgUiChatTransport({}), /url/);
    assert.throws(() => new AgUiChatTransport({ url: 'http://x', agent: {} as never }), AgUiTransportConfigError);
  });

  it('accepts a custom agent factory', async () => {
    server = await startMockAgUiServer({ scenario: 'chunked' });
    const { HttpAgent } = await import('@ag-ui/client');
    const url = server.url;
    const { chunks } = await collect(await send(new AgUiChatTransport({ agent: () => new HttpAgent({ url }) })));
    assert.equal(chunks.at(-1)!.type, 'finish');
  });
});
