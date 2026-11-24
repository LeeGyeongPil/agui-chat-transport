# Event mapping

How every AG-UI event type (protocol package `@ag-ui/core` 1.0.5, 31 types) becomes AI SDK UIMessage chunks.
The table in code is `EVENT_CLASSIFICATION` in `src/report.ts`; a test checks that it covers every `EventType` of the installed protocol package.

- **mapped**: turned into chunks that `useChat` renders in `message.parts`.
- **reported**: no UIMessage equivalent. `onUnmapped({ eventType, reason: 'no-mapping', event })` is called once per event.
  With `emitUnmapped: true` a transient `data-agui-unmapped` chunk is emitted too, and with `passthrough: ['<TYPE>']`
  the event becomes a `data-agui-<type>` part instead of a report.

| AG-UI event | Class | UIMessage chunk(s) |
|---|---|---|
| `RUN_STARTED` | mapped | `start` (with a never empty `messageId`: the `messageId` converter option if given, e.g. the last assistant message when a tool round trip continues, otherwise generated; `messageMetadata: { runId, threadId }`) + `start-step` |
| `RUN_FINISHED` | mapped | closes open parts, `finish-step`, `finish`; an `interrupt` outcome adds a `data-agui-interrupt` part (interrupt ids kept) |
| `RUN_ERROR` | mapped | closes open parts, then `error` (`errorText` = message). Nothing follows |
| `STEP_STARTED` / `STEP_FINISHED` | mapped | transient `data-agui-step` `{ name, status }` |
| `TEXT_MESSAGE_START` / `_CONTENT` / `_END` | mapped | `text-start` / `text-delta` / `text-end` (id = `messageId`, `providerMetadata.agui.messageId` kept) |
| `TEXT_MESSAGE_CHUNK` | mapped | expanded to start/delta/end; a new `messageId` or any other event closes the previous text part |
| `REASONING_START` / `REASONING_END` | mapped | containers, no chunk of their own |
| `REASONING_MESSAGE_START` / `_CONTENT` / `_END` | mapped | `reasoning-start` / `reasoning-delta` / `reasoning-end` |
| `REASONING_MESSAGE_CHUNK` | mapped | expanded like text chunks |
| `TOOL_CALL_START` | mapped | `tool-input-start` (`dynamic: true`, `parentMessageId` kept in `providerMetadata.agui`) |
| `TOOL_CALL_ARGS` | mapped | `tool-input-delta`; the arguments are accumulated |
| `TOOL_CALL_END` | mapped | `tool-input-available` with the parsed arguments, or `tool-input-error` + report `invalid-tool-args` |
| `TOOL_CALL_CHUNK` | mapped | expanded to start/args/end (first chunk must carry `toolCallName`) |
| `TOOL_CALL_RESULT` | mapped | `tool-output-available` (string JSON is parsed), the tool is marked `providerExecuted: true` |
| `STATE_SNAPSHOT` | mapped | `data-agui-state` with fixed id `agui-state` (same id overwrites, so the part always holds the full state) |
| `STATE_DELTA` | mapped | RFC 6902 patch applied to a copy, then `data-agui-state`; a failing patch keeps the old state and reports `patch-failed` |
| `MESSAGES_SNAPSHOT` | reported | no chunk (history reconciliation is planned) |
| `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` | reported | no chunk |
| `SUBAGENT_STARTED` / `_FINISHED` / `_ERROR` | reported | no chunk |
| `RAW` | reported | no chunk |
| `CUSTOM` | reported | no chunk |
| `REASONING_ENCRYPTED_VALUE` | reported | no chunk |

After `RUN_FINISHED`/`RUN_ERROR` nothing more is emitted: later events go only to `onUnmapped` (`orphan-event`).
Events that break the protocol (for example `TOOL_CALL_ARGS` for an unknown call) are reported with reason `orphan-event`. So are events that arrive after the run already finished or failed (ignored, reported only through `onUnmapped`) and tool calls still open when the run ends (closed, then reported).
Event types a newer protocol version might add are treated like the reported ones: never dropped silently.

## Which tools run in the browser

If you pass `tools`, only those names are treated as browser tools. Any other tool call is marked `providerExecuted: true`
(the server runs it), so `useChat` does not wait for an output. Without `tools`, a call is marked `providerExecuted`
as soon as its `TOOL_CALL_RESULT` arrives.

## The way back: `uiMessagesToRunAgentInput`

| UIMessage part | AG-UI message |
|---|---|
| user / system `text` parts | `user` / `system` message |
| assistant `text` | `assistant` message (id from `providerMetadata.agui.messageId`, so merged messages split back) |
| tool part `input-available` / `approval-*` | `toolCalls` entry on the assistant message |
| tool part `output-available` | plus a `tool` message (`content` = the output, JSON-encoded unless it is a string) |
| tool part `output-error` / `output-denied` | plus a `tool` message with `error` |
| tool part `input-streaming` | skipped (incomplete) |
| last `data-agui-state` | `state` |
| `resume` option | `resume` |
