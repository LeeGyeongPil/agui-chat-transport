# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.3] - 2026-11-26

The library code is the same as 0.1.2; only the development tools and CI changed.

### Changed
- Development tools are plain JavaScript only: TypeScript 6.0.3 (the JavaScript compiler) and the built-in Node test runner. Vitest, Vite, tsx and React left the root package, so `npm ci` installs nothing platform-specific (no `os`/`cpu` packages, no install scripts) and gives the same result on every OS and CPU.
- Tests moved from Vitest to `node:test` + `node:assert/strict` with the same checks. `npm test` builds `dist/`, compiles sources, tests and the quickstart to `.build/` (`tsconfig.dev.json`) and runs `node --test`. New guard tests (`test/ci-config.test.ts`) pin the workflow steps, the Node version and a lockfile without platform-specific packages.
- `npm run example` compiles the quickstart with `tsc` and runs it with `node` (no tsx).
- CI is one job on `ubuntu-24.04` with Node from `.nvmrc` (22.23.5) and three run steps: `npm ci`, `npm run typecheck`, `npm test`. `npm ci && npm run ci` runs the same commands locally. No matrix, cache, schedule or extra steps; actions `actions/checkout@v4` and `actions/setup-node@v4`.
- The web example (`examples/react-chat`) is its own local-only package with its own lockfile; `npm run example:web` installs it on first use.
- `npm run release:check` (`npm pack --dry-run`) is a local release check instead of a CI step.

### Removed
- `scripts/check-native.mjs` and `vitest.config.ts`.

## [0.1.2] - 2026-11-26

### Changed
- CI runs on `ubuntu-24.04` instead of `ubuntu-latest`, which moved to Ubuntu 26.04 in November 2026 while early 26.04 images froze during native `tsc` 7 steps (actions/runner-images#15343). The job is split into named steps (versions, install, native binary check, typecheck, build, test, pack, example) with a diagnostics step after a failure, so a failing run names what broke.
- `scripts/check-native.mjs` (repository only, not published) checks that the native `tsc`, esbuild and rolldown binaries load on the current platform.
- The quickstart child-process tests print exit code, signal, run time and full output when they fail.

## [0.1.1] - 2026-11-25

### Fixed
- `startMockAgUiServer`: `waitForAbort()` no longer leaves its waiter behind after a timeout, and `close()` settles any pending `waitForAbort()` call right away instead of letting its timer run on.
- Tests no longer depend on machine speed: stop/abort checks count the events the server sent after stop instead of wall time, the chat round-trip test waits on chat state changes instead of polling, and the quickstart child processes run asynchronously and in parallel with generous hang guards. A golden file (`test/fixtures/chunked.parts.json`) now pins the parts of the `chunked` scenario.

## [0.1.0] - 2026-11-25

### Added
- `AgUiChatTransport`: an AI SDK v7 `ChatTransport` for AG-UI agent servers (`url` or your own `agent`, `headers`, `body` as `forwardedProps`, `tools`, `context`, `threadId` mapping).
- `createAgUiChunkConverter` / `aguiEventsToUIMessageChunks`: AG-UI events to `UIMessageChunk`, with `*_CHUNK` expansion, tool-name and partial-argument tracking, RFC 6902 state patches and `RUN_ERROR` handling.
- `uiMessagesToRunAgentInput`: the reverse direction (history, tool results, shared state, `resume`), restoring the original AG-UI message ids.
- Loss reporting: every one of the 31 AG-UI event types is either mapped or reported through `onUnmapped`; optional `emitUnmapped` chunks and `passthrough` data parts.
- `agui-chat-transport/testing`: `startMockAgUiServer` with the `weather`, `chunked`, `run-error`, `all-events` and `slow` scenarios.
- Examples: Node quickstart (English/Korean) and a Vite + React web example (English/Korean menu).
- `docs/mapping.md`: the full event mapping table.
