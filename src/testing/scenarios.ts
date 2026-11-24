import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';

/** A scripted AG-UI event: a plain object that the mock server encodes as SSE. */
export type ScriptedEvent = BaseEvent & Record<string, unknown>;

export type ScenarioName = 'weather' | 'chunked' | 'run-error' | 'all-events' | 'slow';

/** A scenario turns the received run input into the events the mock "agent" replays. */
export type Scenario = (input: RunAgentInput) => AsyncIterable<ScriptedEvent> | Iterable<ScriptedEvent>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ev = (e: Record<string, unknown>): ScriptedEvent => e as ScriptedEvent;

/**
 * Fixed fake weather: the mock never calls any real service, `{ tempC: 21, sky: "sunny" }`
 * is what the example's browser tool returns.
 */
const weather: Scenario = (input) => {
  const { threadId, runId } = input;
  const hasToolResult = input.messages.some((m) => m.role === 'tool');
  if (hasToolResult) {
    return [
      ev({ type: EventType.RUN_STARTED, threadId, runId }),
      ev({ type: EventType.TEXT_MESSAGE_START, messageId: 'm2', role: 'assistant' }),
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm2', delta: 'It is sunny.' }),
      ev({ type: EventType.TEXT_MESSAGE_END, messageId: 'm2' }),
      ev({ type: EventType.RUN_FINISHED, threadId, runId }),
    ];
  }
  return [
    ev({ type: EventType.RUN_STARTED, threadId, runId }),
    ev({ type: EventType.REASONING_START, messageId: 'r1' }),
    ev({ type: EventType.REASONING_MESSAGE_START, messageId: 'r1', role: 'reasoning' }),
    ev({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'r1', delta: 'need weather' }),
    ev({ type: EventType.REASONING_MESSAGE_END, messageId: 'r1' }),
    ev({ type: EventType.REASONING_END, messageId: 'r1' }),
    ev({ type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' }),
    ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'Checking ' }),
    ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'Seoul.' }),
    ev({ type: EventType.TEXT_MESSAGE_END, messageId: 'm1' }),
    ev({ type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'getWeather', parentMessageId: 'm1' }),
    ev({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"city":' }),
    ev({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '"Seoul"}' }),
    ev({ type: EventType.TOOL_CALL_END, toolCallId: 'tc1' }),
    ev({ type: EventType.STATE_SNAPSHOT, snapshot: { step: 1, cities: [] } }),
    ev({ type: EventType.STATE_DELTA, delta: [{ op: 'add', path: '/cities/-', value: 'Seoul' }] }),
    ev({ type: EventType.CUSTOM, name: 'progress', value: { pct: 50 } }),
    ev({ type: EventType.RUN_FINISHED, threadId, runId }),
  ];
};

/** The abbreviated `*_CHUNK` forms that many servers emit. */
const chunked: Scenario = ({ threadId, runId }) => [
  ev({ type: EventType.RUN_STARTED, threadId, runId }),
  ev({ type: EventType.REASONING_MESSAGE_CHUNK, messageId: 'r1', delta: 'thinking' }),
  ev({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'm1', role: 'assistant', delta: 'Hel' }),
  ev({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'm1', delta: 'lo' }),
  ev({ type: EventType.TOOL_CALL_CHUNK, toolCallId: 't1', toolCallName: 'getWeather', parentMessageId: 'm1', delta: '{"city":' }),
  ev({ type: EventType.TOOL_CALL_CHUNK, toolCallId: 't1', delta: '"Busan"}' }),
  ev({ type: EventType.RUN_FINISHED, threadId, runId }),
];

/** RUN_ERROR arrives as an ordinary event, not as a transport error. */
const runError: Scenario = ({ threadId, runId }) => [
  ev({ type: EventType.RUN_STARTED, threadId, runId }),
  ev({ type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' }),
  ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'partial' }),
  ev({ type: EventType.RUN_ERROR, message: 'model overloaded', code: 'E_OVERLOAD' }),
];

/** Every one of the 31 event types once, to prove none is silently dropped. */
const allEvents: Scenario = ({ threadId, runId }) => [
  ev({ type: EventType.RUN_STARTED, threadId, runId }),
  ev({ type: EventType.STEP_STARTED, stepName: 'plan' }),
  ev({ type: EventType.REASONING_START, messageId: 'r1' }),
  ev({ type: EventType.REASONING_MESSAGE_START, messageId: 'r1', role: 'reasoning' }),
  ev({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'r1', delta: 'hmm' }),
  ev({ type: EventType.REASONING_MESSAGE_END, messageId: 'r1' }),
  ev({ type: EventType.REASONING_MESSAGE_CHUNK, messageId: 'r2', delta: 'more' }),
  ev({ type: EventType.REASONING_END, messageId: 'r1' }),
  ev({ type: EventType.REASONING_ENCRYPTED_VALUE, subtype: 'message', entityId: 'r1', encryptedValue: 'c2VjcmV0' }),
  ev({ type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' }),
  ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'Hi' }),
  ev({ type: EventType.TEXT_MESSAGE_END, messageId: 'm1' }),
  ev({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'm2', role: 'assistant', delta: 'there' }),
  ev({ type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'lookup', parentMessageId: 'm1' }),
  ev({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"q":1}' }),
  ev({ type: EventType.TOOL_CALL_END, toolCallId: 'tc1' }),
  ev({ type: EventType.TOOL_CALL_RESULT, messageId: 'tm1', toolCallId: 'tc1', content: '{"ok":true}' }),
  ev({ type: EventType.TOOL_CALL_CHUNK, toolCallId: 'tc2', toolCallName: 'lookup', delta: '{}' }),
  ev({ type: EventType.STATE_SNAPSHOT, snapshot: { n: 1 } }),
  ev({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/n', value: 2 }] }),
  ev({ type: EventType.MESSAGES_SNAPSHOT, messages: [{ id: 'u1', role: 'user', content: 'hi' }] }),
  ev({ type: EventType.ACTIVITY_SNAPSHOT, messageId: 'a1', activityType: 'PLAN', content: { steps: 1 } }),
  ev({ type: EventType.ACTIVITY_DELTA, messageId: 'a1', activityType: 'PLAN', patch: [{ op: 'replace', path: '/steps', value: 2 }] }),
  ev({ type: EventType.RAW, event: { any: 'thing' }, source: 'test' }),
  ev({ type: EventType.CUSTOM, name: 'progress', value: { pct: 10 } }),
  ev({ type: EventType.SUBAGENT_STARTED, subagentRunId: 's1', name: 'researcher' }),
  ev({ type: EventType.SUBAGENT_ERROR, subagentRunId: 's1', message: 'boom' }),
  ev({ type: EventType.SUBAGENT_FINISHED, subagentRunId: 's1', outcome: { type: 'success' } }),
  ev({ type: EventType.STEP_FINISHED, stepName: 'plan' }),
  ev({ type: EventType.RUN_FINISHED, threadId, runId }),
];

/** Never finishes on its own: lets tests check that stop() reaches the server. */
const slow: Scenario = async function* ({ threadId, runId }) {
  yield ev({ type: EventType.RUN_STARTED, threadId, runId });
  yield ev({ type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' });
  for (;;) {
    await sleep(50);
    yield ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: '.' });
  }
};

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  weather,
  chunked,
  'run-error': runError,
  'all-events': allEvents,
  slow,
};
