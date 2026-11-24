# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-25

### Added
- `AgUiChatTransport`: an AI SDK v7 `ChatTransport` for AG-UI agent servers (`url` or your own `agent`, `headers`, `body` as `forwardedProps`, `tools`, `context`, `threadId` mapping).
- `createAgUiChunkConverter` / `aguiEventsToUIMessageChunks`: AG-UI events to `UIMessageChunk`, with `*_CHUNK` expansion, tool-name and partial-argument tracking, RFC 6902 state patches and `RUN_ERROR` handling.
- `uiMessagesToRunAgentInput`: the reverse direction (history, tool results, shared state, `resume`), restoring the original AG-UI message ids.
- Loss reporting: every one of the 31 AG-UI event types is either mapped or reported through `onUnmapped`; optional `emitUnmapped` chunks and `passthrough` data parts.
- `agui-chat-transport/testing`: `startMockAgUiServer` with the `weather`, `chunked`, `run-error`, `all-events` and `slow` scenarios.
- Examples: Node quickstart (English/Korean) and a Vite + React web example (English/Korean menu).
- `docs/mapping.md`: the full event mapping table.
