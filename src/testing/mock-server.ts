import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEncoder } from '@ag-ui/encoder';
import type { RunAgentInput } from '@ag-ui/core';
import { SCENARIOS, type Scenario, type ScenarioName, type ScriptedEvent } from './scenarios.js';

export interface MockAgUiServerOptions {
  /** Built-in scenario name. Default `weather`. */
  scenario?: ScenarioName;
  /** Your own events (or a function of the run input) instead of a built-in scenario. */
  events?: ScriptedEvent[] | Scenario;
  /** Pause between events in milliseconds. Default 0. */
  delayMs?: number;
  /** Answer every request with this HTTP status instead of a stream (for example 500). */
  httpStatus?: number;
  /** Port to listen on. Default 0 (any free port). Always bound to 127.0.0.1. */
  port?: number;
}

export interface MockAgUiServer {
  /** Endpoint URL to give to `AgUiChatTransport`. */
  url: string;
  /** Every `RunAgentInput` the server has received, in order. */
  received: RunAgentInput[];
  /** HTTP request headers of each request, parallel to `received`. */
  receivedHeaders: http.IncomingHttpHeaders[];
  /** Number of responses the client closed before the server finished them. */
  readonly aborted: number;
  /** Resolves true as soon as the client has closed a response early, false after the timeout. */
  waitForAbort(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Practice AG-UI server: replays scripted events as real AG-UI SSE (encoded with
 * the official `@ag-ui/encoder`). It does not run any model; it only plays the script.
 */
export async function startMockAgUiServer(options: MockAgUiServerOptions = {}): Promise<MockAgUiServer> {
  const received: RunAgentInput[] = [];
  const receivedHeaders: http.IncomingHttpHeaders[] = [];
  let aborted = 0;
  const waiters: Array<(v: boolean) => void> = [];
  const scenario: Scenario | undefined =
    typeof options.events === 'function'
      ? options.events
      : Array.isArray(options.events)
        ? () => options.events as ScriptedEvent[]
        : SCENARIOS[options.scenario ?? 'weather'];
  if (!scenario) {
    throw new Error(`Unknown mock scenario "${options.scenario}". Use one of: ${Object.keys(SCENARIOS).join(', ')}.`);
  }

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let input: RunAgentInput;
      try {
        input = JSON.parse(body) as RunAgentInput;
      } catch {
        res.writeHead(400, cors).end('invalid JSON body');
        return;
      }
      received.push(input);
      receivedHeaders.push(req.headers);
      if (options.httpStatus && options.httpStatus >= 400) {
        res.writeHead(options.httpStatus, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `mock server answering ${options.httpStatus}` }));
        return;
      }
      const encoder = new EventEncoder({ accept: req.headers.accept });
      res.writeHead(200, { ...cors, 'content-type': encoder.getContentType(), 'cache-control': 'no-cache' });
      let clientGone = false;
      res.on('close', () => {
        if (res.writableEnded) return;
        clientGone = true;
        aborted++;
        for (const w of waiters.splice(0)) w(true);
      });
      for await (const event of scenario(input)) {
        if (clientGone) break;
        res.write(encoder.encodeSSE(event));
        if (options.delayMs) await sleep(options.delayMs);
      }
      if (!clientGone) res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/agent`,
    received,
    receivedHeaders,
    get aborted() {
      return aborted;
    },
    waitForAbort(timeoutMs = 1000) {
      if (aborted > 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        waiters.push((v) => {
          clearTimeout(timer);
          resolve(v);
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
