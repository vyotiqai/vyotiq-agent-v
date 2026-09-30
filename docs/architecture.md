# Architecture

How Agent V is put together, for someone about to change it. Each section
names the files that own the behavior; read those before trusting this page.

## Three processes

| Process | Source | Built to | What it may do |
| --- | --- | --- | --- |
| Main | `src/main/` | `out/main/index.js` (one bundle) | Everything with side effects: files, git, child processes, the network, the agent loop |
| Preload | `src/preload/index.ts` | `out/preload/` | Exposes `window.vyotiq`, the only bridge; nothing else crosses |
| Renderer | `src/renderer/src/` | `out/renderer/` | React UI; no Node, no direct file or network access |

Main is a single bundled file, so a lazy `require('./x')` inside it throws at
runtime (and a surrounding `catch` hides that). Load code with static imports,
or register a hook from the module that owns it.

`src/shared/` holds what both sides need: IPC channel names and zod schemas
(`shared/ipc`), settings schema, pricing, and pure utilities. It must not import
from `main` or `renderer`.

## The IPC boundary

A call from the UI touches five places, and a contract test holds them together:

1. `src/shared/ipc/channels.ts` — the channel name.
2. `src/shared/vyotiqApi.ts` — the typed `window.vyotiq` method.
3. `src/preload/index.ts` — the method, as `ipcRenderer.invoke(channel, payload)`.
4. `src/main/ipc/register.ts` — the handler: `senderOk(event)` first, then the
   payload through its zod schema, then the work, answering `ok(data)` or
   `failFrom(err, channel)`.
5. `tests/main/integration/ipcContract.test.ts` — `VYOTIQ_INVOKE_MAP` lists every
   invoke method against its channel; a method missing on either side fails it.

Main-to-renderer pushes (`webContents.send`) are events such as `IPC.chatEvent`;
the renderer subscribes through `on…` methods on the same bridge, each returning
its unsubscribe.

## A task, from brief to record

1. **Launch** (`agent/launchRun.ts`): the one path that starts a run — workspace
   checks, run id, atomic registration in `agent/runRegistry.ts`, then a
   background start. Chat IPC and boot relaunch both come through here.
2. **Runtime** (`agent/startAgentRun.ts`, `agent/runtimes/`): resolves the
   execution substrate. Only `local` exists: `LocalRunHandle.events()` is
   `runAgent` from `agent/loop.ts`, unchanged. Every event is forwarded to the
   window as `IPC.chatEvent` with the invoke id.
3. **The loop** (`agent/loop.ts`, an async generator): each step assembles the
   prompt (`agent/context/assemble.ts`), streams a model turn through a provider
   adapter (`agent/providers/`), and runs the tool calls it asked for
   (`agent/executeStepTools.ts` → handlers in `agent/tools/index.ts`).
   Approvals (`agent/toolApproval.ts`) and questions to the person
   (`agent/agentQuestion.ts`) park the step until answered or cancelled.
4. **The record** (`agent/state.ts`): every message and event is appended to the
   task's folder through write queues (`messageAppendQueue.ts`,
   `eventAppendQueue.ts`, `statusWriteQueue.ts`) that rotate large files into
   archives. Records are redacted on the way to disk (`agent/recordRedaction.ts`);
   the objects the loop holds are not.

`status.json` is a snapshot, not the truth about liveness: a run that died with
the process still says "running". Anything that asks "is this running?" reads
`runRegistry`, and boot interrupts orphans it finds.

`loop.ts` must not import the `./tools` barrel: the cycle empties the tool list
at module init, and the failures that follow never mention the import.

## The prompt

`resources/harness/default.md` is the harness prompt. The system prefix has to
stay byte-stable across steps or the provider's prompt cache misses every step;
anything that changes per step (time, plan, todos) goes after it. The task's
contract and plan are frozen per invoke for the same reason. Context sizing
(the meter) and billing read different parts of the same usage object.

MCP tools are not in every request: the catalog lists them and the model pins
the ones it needs (`agent/mcp/`, `agent/toolsCatalog.ts`).

## Settings, keys and data

- Settings: `main/settings/settings.ts` against `SettingsSchema`
  (`shared/ipc/schemas/settings.ts`). A file that fails to parse is kept aside
  and the app runs on defaults without overwriting it.
- Keys: `secrets.json`, each value encrypted with the OS's secure storage; the
  renderer only ever sees whether a key is set.
- Everything else under `userData` is listed in
  `site/src/content/docs/data-and-storage.md`; storage retention lives in
  `main/storage/retention.ts`.
- "Delete all my data" (`main/storage/dataWipe.ts`, `wipeUserData.ts`): the app
  leaves a request, quits normally, and the next launch empties the folder
  before anything opens a file in it, holding the single-instance lock.

## Quitting

`before-quit` in `src/main/index.ts` stops runs, shuts down child processes
(terminals, MCP servers, dictation), then `flushBeforeQuit` (`main/quitFlush.ts`)
waits for the write queues and asks the window to save open editors. The window
answers from its root (`lib/hooks/useEditorFlushResponder.ts`), so the answer
comes whichever view is showing. Only a flush that really stalls asks the
person whether to quit anyway.

## The renderer

- `app/App.tsx` owns app state (view, settings, workspaces); `app/AppShell.tsx`
  is the frame every view sits in (navigator, command palette, notifications).
- `features/` holds the surfaces (task, chat record, settings, extensions, home…);
  `lib/ui/` the shared primitives; `styles.css` the tokens every skin maps.
  The UI rules are in the root `CLAUDE.md`.

## Testing

| Suite | Command | Notes |
| --- | --- | --- |
| Unit and integration | `node node_modules/vitest/vitest.mjs run` | `tests/main`, `tests/renderer` (jsdom), `tests/shared` |
| GUI end to end | `pnpm build`, then `playwright test -c tests/gui-e2e/playwright.config.ts` | Real Electron via Playwright; CI sets `VYOTIQ_E2E_FIXTURE=1`, which replays a scripted model reply |
| Types | `tsc -p tsconfig.node.json` / `tsconfig.web.json` | Tests have their own configs; `scripts/typecheck-tests-ratchet.mjs` keeps their error count from growing |
| Lint | `eslint .` | The formatting gate; don't run `prettier --write` |

A spec that needs the real loop sets `e2eFixture: false` and serves an
OpenAI-compatible endpoint on localhost (see `tests/gui-e2e/agent-tool-env.spec.ts`).
