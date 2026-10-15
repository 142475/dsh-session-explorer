# dsh-session-explorer

> **English** | [中文](./README.zh.md)

DSH Web plugin: message-level full-text search across sessions. Search a specific message (user / assistant / tool / system-injected), preview context read-only, and jump to the real session with one click.

## Features

- **Message-level full-text search** — user / assistant / system-injected text at high weight, tool name / arguments / error summary at low weight. FTS5 trigram index supports arbitrary substrings without Chinese tokenization; queries shorter than 3 characters fall back to LIKE matching.
- **Four message kinds** — user / assistant / steering (plugin-injected prompts, skill-catalog, skill-invocation, compaction summaries, …) / tool (tool name, arguments and error summary searchable).
- **Deduplicated results across fork/continued sessions** — fork/continuation sessions share parent history, so the same message is stored once per session; search groups by (seq, kind, text) and keeps the session with a non-empty title and the latest index time.
- **Read-only preview** — focused hit plus a surrounding context window; the focus message auto-scrolls to the center of the viewport, and one click opens it in the real session.
- **Session browser entry** — sidebar tool entry + an overlay panel inside the conversation column (no global overlay); the top-left "back to session" button closes the panel.
- **Searchable session overview** — CSS Grid cards with metadata, first/latest message summaries, main/subagent filtering, text search, and sorting. Clicking a card opens an in-place message summary detail; it does not depend on original-session anchor jumping.
- **i18n** — full zh/en coverage (panel / dialogs / search / preview); language follows the DSH Host locale service (instant switch in Settings → General), no manual setting needed.
- **Rebuild (incremental / full + health check)** — incremental mode fast-diffs via engine revision tokens (O(1) skip), re-flushes changed sessions by content fingerprint and removes ghost sessions; full mode resets the database and rebuilds session by session. The rebuild dialog runs a health check (integrity + table readability) and recommends a mode.
- **Index status (corrupted-session classification)** — indexed / stale / failed (source log corrupted, not indexable); opening the panel triggers a light sync (live + not-yet-indexed sessions), turn end syncs incrementally, and startup reconciles.

## Installation

### From npm (recommended)

```sh
dsh plugin --profile web add dsh-session-explorer
```

Package page: [https://www.npmjs.com/package/dsh-session-explorer](https://www.npmjs.com/package/dsh-session-explorer)

### Build from source

```sh
pnpm install
pnpm pack
dsh plugin --profile web add ./dsh-session-explorer-*.tgz
```

After installation, restart `dsh web`; the "Session Explorer" entry appears in the sidebar tool area. The index lives at `~/.dsh/storages/session-explorer.sqlite` (auto-created and indexed on first use).

## Development

```sh
pnpm install
pnpm test      # 41 unit tests (requires Node ≥ 22.5, uses node:sqlite)
pnpm build     # tsc + rolldown client bundle
```

## Architecture

- `src/protocol.ts` — RPC contract types (shared Host/Client)
- `src/transcript.ts` — SessionEvent log → indexable message entries, pure fold layer (zero deps, unit-testable)
- `src/indexer.ts` — SQLite FTS5 trigram derived index (host side, application_id + user_version dual check, 0600 perms)
- `src/rpc.ts` — RPC validation and routing
- `src/index.ts` — host assembly (event sync + RPC + startup reconciliation)
- `src/client/` — browser bundle (sidebar entry + search/preview views + conversation-column overlay panel)

## Known limitations

- Full tool-result body full-text search is deferred to V2 (only tool name / args / error summary enter the low-weight field today).
- Session deletion has no engine API; index cleanup only covers the plugin's own database.
- The timeline canvas (@xyflow/react) has a serious rendering bug; the entry is hidden since 0.2.0 and will return once fixed.

## Screenshots

See the `assets/` directory for installation, search, and timeline overview screenshots, and `screenshots.json` for the curated list the dsh-market uses to render the marketplace card preview.

## Release & listing

- npm package: [dsh-session-explorer](https://www.npmjs.com/package/dsh-session-explorer)
- GitHub Releases: [Releases page](https://github.com/Zn-Dk/dsh-session-explorer/releases)
- Listed in:
  - [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (main channel, `data/plugins/Zn-Dk__dsh-session-explorer.yml`)
  - [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) (README + README.zh-CN)
  - [AdamPlatin123/awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins) (PLUGINS.md)

## License

MIT

## Fork notes — DeepSeek Harness 0.2.x compatibility

This fork ports the plugin to DSH `0.2.0-rc.2`. On 0.2.x the upstream code loaded but did nothing: empty index, `HTTP 405` on the RPC channel, "open & locate" dead.

### What changed
| Area | 0.1.x (upstream) | 0.2.x (this fork) |
| --- | --- | --- |
| Read session history | `sessionPersistence.inspect(id)` | `open(id, 'read')` + `handle.read()` -> `{ eventState, events }`, meta from `stat(id).header` |
| RPC channel | `connection.rpc.handle(channel, handler, { authority: 'loopback' })` | `webServer.register({ kind: 'prefix', path: channel, handler })`, replicating the `/api` transport (415 / 400 / 413 / 500, `{ type: 'server-response', rpcId, result }`) |
| Open a session from the client | `sessions.open(id)` / `openSubagent` | `uiWorkspace.openSession(target)` (client inject now includes `uiWorkspace`) |
| Open & locate | scroll to the hit message via DOM anchors | switch session + scroll the conversation to the bottom, no flashing |
| Preview scrolling | auto-scrolled to the focus message on every render | scrolls once; the fetch effect no longer depends on `t` |
| Sidebar entry | plain text row: no icon, own font and colour | clones the host's nav row (icon, font, colour, padding all inherited), swapped to a magnifier icon; rebuilt automatically once the host row exists |
| Panel state | the search view was unmounted when switching to preview/timeline | all views stay mounted (`display:none`), so the query and its results survive |

### Behaviour notes
- The conversation view is a paged window and old turns collapse into summary rows, so locating an arbitrary historical message in the conversation DOM is not reliable. "Open & locate" switches to the session and scrolls to the bottom; read the hit in the panel preview (host `preview` endpoint), which shows the message with its surrounding context.
- The index lives at `<dshHome>/storages/session-explorer.sqlite` (FTS5, `tokenize='trigram'`). Quote your query to search literally.

### Install from this fork
`lib/` is git-ignored, so build before installing (a plain `github:` install ships no bundle):
```
git clone https://github.com/142475/dsh-session-explorer && cd dsh-session-explorer
pnpm install
node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/build-client.mjs
```
