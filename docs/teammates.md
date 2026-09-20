# Teammates — Feature Documentation

> **Status:** Shipped and verified (see §12 Verification history).
> **Scope:** Everything in this document reflects the implemented, wired-up behavior of the codebase — not aspirations. Every section is grounded in the referenced source files.

---

## Table of contents

1. [What teammates are](#1-what-teammates-are)
2. [Core concepts](#2-core-concepts)
3. [Architecture overview](#3-architecture-overview)
4. [Data & storage layout](#4-data--storage-layout)
5. [Teammate profiles](#5-teammate-profiles)
6. [Memory namespaces](#6-memory-namespaces)
7. [Chat binding](#7-chat-binding)
8. [Model pin](#8-model-pin)
9. [Delegated tasks & the scheduler](#9-delegated-tasks--the-scheduler)
10. [Run survival: restart, resume, auto-resume](#10-run-survival-restart-resume-auto-resume)
11. [Deletion cascade](#11-deletion-cascade)
12. [Verification history](#12-verification-history)
13. [Robustness invariants & field incidents](#13-robustness-invariants--field-incidents)
14. [Testing map](#14-testing-map)
15. [Known limitations & non-goals](#15-known-limitations--non-goals)
16. [User guide & use cases](#16-user-guide--use-cases)

---

## 1. What teammates are

A **teammate** is a persistent agent identity inside the app. Agent V chat and inline
instances solve *parallelism*; teammates solve *memory, identity, and availability*:

| Surface | Lifetime | Memory | Runs unattended |
| --- | --- | --- | --- |
| Agent V chat | Per conversation | Shared workspace brain | No — you send and wait |
| Inline instance | Inside one run | None (ephemeral worker) | No — born and dies with your run |
| **Teammate** | **Permanent across sessions** | **Private namespace per workspace** | **Yes — scheduled tasks, queued work, auto-resume** |

A teammate's run can still spawn instances for parallel hands — instances are the
*hands*, teammates are the *who*.

## 2. Core concepts

- **Profile** — a roster entry: `id`, `name`, `persona`, `identity`, `tone`,
  `autoResumeOnLaunch`, and an optional `model` pin
  (`{ provider, model }`, see `src/shared/ipc/schemas/agentProfile.ts`).
  **Names are not unique** — the *id* is. It is slugified from the name at creation
  and de-duplicated against both live and **retired** ids, so two teammates may share
  a display name while their identities and memory stay distinct.
- **Binding** — a chat (run or draft) pointed at a profile id. Persisted per workspace
  in `agentProfileIdByRunId` (bucket key = run id, or `__draft__` for the composer
  draft), `src/shared/ipc/schemas/workspace.ts`.
- **Memory namespace** — a teammate's private memory tree per workspace
  (`.vyotiq/agents/<profileId>/memory/`). Two teammates in one project never share
  knowledge; a *deleted* teammate's runs keep their own id-keyed namespace so the
  shared brain is never contaminated (loop.ts fallback). Deleting a teammate does
  **not** erase that namespace — the id is retired instead, so nothing created later
  can inherit it (§11).
- **Delegated task** — an assignment enqueued for a teammate, optionally scheduled at
  a future time. Persisted, survives restarts, executes through the normal agent loop.
- **Runtime seam** — runs execute through pluggable runtimes. A runtime is a
  *lifecycle handle*, not just an event source: `events` / `cancel` / `steer` /
  `reconnect` / `record` / `dispose`, plus a `capabilities` record surfaces read to
  hide actions a substrate cannot perform. `dispose` and `cancel` are deliberately
  distinct — detaching a listener must not stop work the user expects to find
  finished later. `local` is the only **registered** runtime (§15).

## 3. Architecture overview

Layering (top → bottom), all paths relative to the repo root:

```
Renderer (React)
  App.tsx                      roster load + prune effect + pin resolver wiring
  useWorkspaceManager.ts       binding map, controller pin-seeding, bind-time adoption, prune
  createChatStreamController   send payload: provider/model/agentProfileId, rewind anchor
  features/teammates/          the Teammates pane — roster, identity editor,
                               model pin, autonomy, scope, per-workspace
                               overrides, per-teammate history, task inbox
  AgentProfilePicker           bind / unbind / delete (composer pill)
  TeammatesSection             sidebar roster — presence, live work, assign
        │  IPC (window.vyotiq.*)
        ▼
Main process
  ipc/register.ts              chatStart / chatRewindAndStart / agentProfilesDelete /
                               workspacesAdd (task re-arm) handlers
  agent/launchRun.ts           THE run launcher: workspace validation, run-id
                               allocation, immutable-binding checks, atomic teammate
                               claim, follow-up hydration, background start
  agent/runtimes/              execution substrates. types.ts is the lifecycle
                               handle (events / cancel / steer / reconnect /
                               record / dispose) + declared capabilities;
                               local.ts wraps runAgent unchanged; index.ts
                               resolves and availability-gates a runtime
  agent/taskScheduler.ts       queue, timers, durable task store, boot reconcile
  agent/runRegistry.ts         active-run registry + profile binding + finish events
  agent/startAgentRun.ts       background runner, terminal cleanup, finish notification
  agent/loop.ts                the agent loop: identity resolution, memory namespace,
                               storage-loss tripwire, persist-failure terminal errors
  agent/rewindRun.ts           edit/rewind anchor resolution (compaction-aware)
  settings/agentProfiles.ts    roster store (agents.json), workspace overrides, deletion
  storage/retention.ts         retention sweeps — never touch active runs
        │
        ▼
Shared contracts (Zod)
  src/shared/ipc/schemas/agentProfile.ts   profile + roster push event
  src/shared/ipc/schemas/agent.ts          chatStart fields incl. agentProfileId
  src/shared/ipc/schemas/delegatedTask.ts  task shape, scheduledAt validation
  src/shared/ipc/schemas/workspace.ts      agentProfileIdByRunId persistence shape
```

Identity resolution on send: the renderer puts `agentProfileId` in the
`chatStart` payload (createChatStreamController payload builder). Main resolves the
profile (`resolveAgentProfile` → workspace-scope check + base roster/workspace override
merge). New bindings to missing profiles are rejected; existing runs recover their
persisted profile snapshot after deletion. Stale UI bindings are still pruned
renderer-side (§7).

## 4. Data & storage layout

Packaged app root: `%APPDATA%\vyotiq` (dev profile: `%APPDATA%\vyotiq-dev`).

```
%APPDATA%\vyotiq\
  agents.json                          global roster, version 2 (corrupt → backed up,
                                       empty start). Holds `profiles` plus `retiredIds`
                                       — ids of deleted teammates, never handed out again.
                                       A version-1 file migrates forward on read.
  workspaces.json                      registry: openPaths, recentPaths,
                                       uiStateByPath (incl. agentProfileIdByRunId)
  logs\vyotiq.log                      main+renderer runtime log
  workspaces\<uuid>\sessions\<runId>\  run traces: status.json, events.jsonl, messages.jsonl
  workspaces\<uuid>\...                per-workspace state

<workspace>\.vyotiq\
  agents\<profileId>.profile.json      workspace-scope override (hand-authored, git-shareable)
  agents\<profileId>\memory\           teammate memory namespace (index.md, state.md, notes/*)
  tasks.json                           delegated tasks for this workspace
                                       (corrupt → renamed tasks.json.corrupt-<ts>, empty start)
```

Invariants:

- A corrupt `agents.json` or `tasks.json` is renamed aside (`*.corrupt-<timestamp>`)
  **before** the empty store takes over — the corrupt bytes are never silently
  overwritten by the next write (settings/agentProfiles.ts, taskScheduler.ts).
- Task ids are `task-<ms>-<seq>-<hex4>` — collision-safe across restarts.
- `events.jsonl` rotates at `EVENTS_FILE_MAX_BYTES` (2 MB, 1 MB tail kept).

## 5. Teammate profiles

- **Roster** lives in `agents.json`, loaded through a cache with
  `clearAgentProfilesCacheForTests`. Loaded once per change; pushed to the renderer
  as a **full-list replace** event (`agentProfilesChanged`) — the push payload is the
  authoritative roster, not a delta.
- **Workspace scope** — a workspace-scoped profile resolves only when the requested
  workspace matches its stored `workspacePath`; the global sidebar roster remains
  unfiltered.
- **Workspace overrides** (`.vyotiq/agents/<profileId>.profile.json`) merge over the
  base profile for that workspace only. They can adjust behavior fields (e.g. `tone`)
  but **cannot** hijack `id`, `name`, timestamps, `scope`, or `workspacePath`.
  Written from the Teammates pane or by hand, and git-shareable by design. The
  write **replaces** the file rather than merging into it (one form owns the whole
  override, and merging would leave no way to clear a single field), so the editor
  carries through any field it does not itself expose.
- **Deletion** removes the roster entry and cancels everything downstream (§11).

## 6. Memory namespaces

- Every memory tool call validates that the target resolves inside the workspace's
  teammate memory root via a **nearest-existing-ancestor realpath walk**
  (`assertMemoryRootInsideWorkspace`, memory.ts). Symlinked ancestors that escape the
  workspace throw `Memory directory escapes workspace` (regression-tested).
- The walk is **not** on the per-step read hot path — memory index/state reads stay
  single-`existsSync`+read. The walk guards write/layout paths only.
- Namespace selection precedence: `effectiveProfile?.id ?? persistedNamespaceId`
  (loop.ts, both memory sites identical). `persistedNamespaceId` applies when a run
  resumes whose teammate was deleted — the run stays isolated in the deleted id's
  namespace and **never falls back to the shared brain**.

## 7. Chat binding

- Bindings live in `agentProfileIdByRunId` per workspace context; the composer draft
  bucket is `__draft__`. When a draft send is assigned a run id, the binding **migrates**
  from the draft bucket to the run bucket (`onRunIdAssigned` rekey,
  useWorkspaceManager.ts) so follow-up sends keep the teammate.
- **Prune** — `pruneAgentProfileBindings(validIds)` (useWorkspaceManager.ts) drops
  every binding whose profile id is no longer in the roster. App.tsx calls it on every
  roster load/push (once the roster is ready). Without this, deleting a teammate left
  every other bound chat sending a dead id → deterministic `Unknown agent profile`
  send failures, surviving restart. The picker also rendered the raw id string; the
  prune fixes that class entirely.
- Stale-id sends are impossible through the UI after a prune; the main-side throw
  remains as the last-resort guard.

## 8. Model pin

A profile may pin `{ provider, model }`. Semantics (implemented in the renderer):

- **Seeding at controller creation** — when a session controller is created for a
  bucket that has a binding, the pin seeds the session's `providerModel`
  (useWorkspaceManager `ensureController`). Creation happens once per session, so
  toolbar remounts (dictation, panes) never re-fire it.
- **Adoption at bind time** — `setAgentProfileIdForRun` seeds the pin immediately when
  a user binds a teammate mid-session. Pre-bound chats (sidebar "start teammate chat")
  are covered by creation-time seeding.
- **Session-scoped only** — the pin never writes the workspace/global default model.
  A manual pick after binding always wins; unbind → rebind re-adopts; a pin-less
  teammate keeps the current selection.
- The seeded selection rides the normal `chatStart` `provider`/`model` fields — what
  the model pill shows is what sends (`resolveTurnProviderModel`).
- **Explicit beats default.** The renderer always sends *something* in `model`, so the
  payload also carries `modelExplicit`, true only when the user picked the model by
  hand. Main resolves, in order: explicit choice → this run's persisted selection →
  the teammate's pin → the renderer's workspace/global default (`resolveTurnModel`,
  loop.ts). Without that flag a teammate's pin could never win on its own first turn,
  because an ambient default is indistinguishable from a deliberate one.
- Pins unknown to the live catalog still send (by explicit design, `modelReadiness.ts`
  — catalogs omit servable models); failures surface through the chat error banner.
  An unknown pin renders via the raw-id display fallback.
- Delegated tasks use the pinned model automatically.

> History: an earlier component-level hook (`useTeammateModelPin`) adopted the pin
> through the manual-pick handler and **leaked it into the global default** (binding a
> teammate in pane A changed pane B's fresh chats) and re-fired on toolbar remounts.
> It was deleted; adoption now lives with session state (controller creation + bind).

## 9. Delegated tasks & the scheduler

`src/main/agent/taskScheduler.ts`. Per-workspace `tasks.json` (versioned envelope,
cross-field validated); statuses `queued → running → done | failed | cancelled`, plus
`scheduled` (future start) and `cancelling` (stop requested, run not yet unwound).

**Persistence is write-first.** A mutation is validated, written atomically, and only
then published to the cache and pushed to the renderer; a failed write throws so the
IPC caller learns it failed. The earlier cache-first store logged write errors and
acknowledged the mutation anyway, so an enqueue could be confirmed to the user and
then vanish on the next launch.

- **Assign** — task enqueued with `profileId`, `workspacePath`, `prompt`, optional
  `scheduledAt` (Zod-validated in the shared schema: parseable date, `min` floor;
  unparseable dates rejected).
- **One run per teammate** — the claim is taken **atomically with the run
  registration** (`tryRegisterRunAbort(..., { requireProfileSlot: true })`,
  runRegistry.ts), not as a separate precheck. A scheduler-side "is the teammate
  free?" test followed by a distinct register left a window in which a user chat and
  a delegated task could both observe the identity as free and both start, then
  interleave writes to one memory namespace. Task runs register **with** the profile;
  the registry **backfills** a missing binding on the reuse path.
- **Timers** — scheduled tasks arm a timer; delays beyond `MAX_TIMEOUT_MS` are
  re-armed in chunks (far-future schedules honored exactly). The `fire` callback
  **re-reads the live task record** (the captured object can go stale) and only
  transitions tasks still in `scheduled`. The boot reconcile disarms timers of
  past-due tasks before flipping them to queued.
- **Closed-workspace hold** — `startTask` refuses to start in a workspace that is not
  open; the task stays queued. Re-arm happens on workspace re-add and on both window
  recreation paths.
- **Boot reconciliation** (`resumeTasksForWorkspaces`) — on app start and workspace
  open. A task whose run is **still live in this process** has its in-memory
  ownership rebuilt (teammate claim + completion watcher); without that the run
  finishes with nothing listening and the row sticks at `running` forever while the
  teammate stays blocked. A task left `running` by a *dead* process is finalized from
  the durable run status, falling back to *failed — "Interrupted by app restart —
  retry to run it again"*. Past-due scheduled tasks flip to `queued`; still-future
  tasks re-arm. The whole sweep is **one write and one push per workspace**.
- **The run id is never cleared on a terminal task** — it is the only link from a
  finished row back to its transcript.
- **Legacy rows are repaired, not dropped** — a record written before the cross-field
  rules (e.g. `running` with no `startedAt`) is brought up to the invariants where its
  intent is unambiguous, and a row whose embedded `workspacePath` disagrees with the
  file it was read from is re-homed. Dropping a non-terminal row would silently
  discard delegated work.
- **Completion** — `startAgentRun`'s finally calls
  `notifyProfileRunFinished(profileId, runId)`; the scheduler finalizes that exact
  task directly from its durable status. A **single bounded reconcile loop** (5 s)
  is the backstop for a run that dies without notifying — replacing one polling
  interval per task. A run whose `status.json` never appears is finalized after 12
  sweeps (60 s) and the slot is freed. Notification is suppressed while a **delayed
  goal relaunch** is pending (the identity stays busy).
- **Cancellation** — `cancelTask` / `cancelTasksForProfile` clear timers, cancel live
  runs via the real cancel path, and park the record in the durable `cancelling`
  state so a restart mid-cancel resumes as *stopping* rather than reviving it as
  running. `cancelRun`'s boolean answer is honoured: a task whose run had already
  gone reports `false` and is finalized from its status instead of claiming to have
  stopped work that already finished.
- **Retry is explicit** — `tasksRetry` clones a terminal task to a **new id**; the
  original stays in history. Nothing auto-re-runs a delegated task, because replaying
  it would replay whatever side effects the first attempt already had. The clone
  records `retryOf`, so a retry is distinguishable from a fresh assignment and
  retention cannot prune the attempt that failed while keeping the one that replaced
  it. `retryOf` is an **internal** argument, never a field on `TaskEnqueueRequest`:
  a renderer that could set it could forge the audit chain.
- **Retention** — terminal rows are capped (200 per workspace, newest first); active
  work is never trimmed.
- **Two control surfaces, one rule.** The sidebar shows work that is running or
  wants attention (everything non-terminal, plus `failed`); finished work is
  history and lives in the Teammates pane, which shows every task with its
  timing, its provenance and its failure text. Both render rows through the same
  `taskControls` helper, so the rule cannot drift between them: a terminal task
  offers retry (*Run again* when it succeeded), a live one offers cancel, and a
  task already `cancelling` offers **neither** — `cancelTask` refuses a second
  stop, so showing the button would be a control that silently does nothing.
- **A refused stop is reported.** `cancelTask` answers `false` when the task was
  already terminal, and emits no push, so the click changed nothing. The task
  store turns that into a visible error instead of letting every caller discard
  the boolean.
- **A row shows what the record holds.** `scheduledAt` (when it starts),
  `startedAt`/`finishedAt` (how long it took), `retryOf` (that this attempt
  replaced an earlier one) and `error` (why it failed) are all rendered. Each was
  persisted from the beginning and none of it reached a screen.
- **Reads are async, writes are deliberately not.** Boot and workspace-open warm the
  cache through a parallel `fs/promises` preload, so the synchronous paths below it
  find the cache warm and touch no disk. The mutation path stays synchronous on
  purpose: the durable `running` write runs inside `launchRunSync`'s claim window,
  which must contain **no await** (see §10) or two launches could overlap one run
  dir. Its cost is bounded — `syncRenameWorstCaseDelayMs()` caps the sync writer at
  ~18 ms against the async ladder’s 385 ms. Resume passes share one promise chain,
  and a failure is absorbed into it so one bad workspace cannot stop every later
  reconciliation.

## 10. Run survival: restart, resume, auto-resume

- Every run persists status **immediately** after `createRun`: immutable runtime,
  `agentProfileId`/`agentProfileName`, and a timestamp-free versioned behavioral
  profile snapshot. A crash during the first message flush still resumes with the
  teammate binding intact. Existing runs reject explicit bind/unbind or runtime
  changes; omission recovers the persisted values. A deleted profile resumes from
  the snapshot for persona, tone, identity, model-pin fallback, autonomy, and runtime.
  The snapshot refreshes only when that same profile still resolves.
- **Auto-resume on launch** (`resumeActiveGoals.ts`): teammate-bound runs stopped as
  `cancelled`/`error` **and resumable** restart with a synthetic
  *"Continue where you left off."* — gated strictly on the profile's
  `autoResumeOnLaunch`. Quota-exhausted errors short-circuit before the teammate
  block (never relaunch into a dead quota). The loop re-arm runs **before** the quota
  gate so a quota-hold doesn't consume the resume.
- **An active goal relaunches at boot once, not forever.** The goal branch of the
  same pass relaunches runs whose `goal.json` is `active`, which is the grant the
  user made when they set the goal — but a run that crashes on every launch would
  otherwise be relaunched at every launch and drain the plan with nobody watching.
  `autoResumeCount` bounds it: one unattended relaunch, after which the goal stays
  active and visible and the banner's **Resume** is the way back in. Any real user
  turn clears the counter (a loop tick carries the user's own prompt, so it counts).
  A `proposed` goal is not relaunched at all — app start is not a grant.
- Deleted teammate on resume: the run keeps its own id-keyed memory namespace (§6).
- **"Resume" means a new invocation rebuilt from durable state** — never a revived
  process, provider stream, terminal session, or approval promise. An interrupted
  *isolated inline instance* has its dirty edits committed and its **branch
  preserved**; only the checkout is removed, and recovery recreates one from the
  branch. Earlier the interrupt deleted that branch and still wrote
  `resumable: true`, offering a resume whose work had been destroyed. When the
  prerequisites genuinely fail (no recorded branch; a shared-workspace instance
  whose workspace is gone) the run is marked **non-resumable with the actual
  reason** rather than resumable-in-name-only.
- **Protected checkouts are identified before pruning.** Stale-worktree pruning
  protects only runs live in *this* process, and at boot nothing is live — so every
  instance checkout looked stale and was deleted moments after the interrupt pass
  promised a resume. `collectProtectedInstanceRunIds` reads durable statuses and
  keeps running and resumable instances out of the sweep.
- **An interrupted tool call does not claim it never ran.** A crash between
  dispatching a tool and recording its result leaves a stub, and that stub is what
  the resumed model reads. Saying *"Cancelled"* there invites a replay of a
  consequential action as if it had no effect — exactly the exactly-once guarantee a
  crash cannot offer. The stub (`TOOL_STUB_RESTART_INTERRUPTED`, `src/shared/toolStubs.ts`)
  states that the tool may already have run and asks for the current state to be
  checked. Abort-stub accounting recognises it, so it is still not billed as a failed
  execution.
- **A delegated run is never double-owned.** Generic profile auto-resume skips any
  run carrying `delegatedTaskId`: the scheduler's boot pass either rebuilds its
  watcher or finalizes it, and relaunching here would put two owners on one teammate
  and re-run work the task already accounted for.
- **Local terminal sessions are not resumable** and are not presented as such; they
  die with the process that hosted them.

## 11. Deletion cascade

`agentProfilesDelete` (ipc/register.ts) performs, in order:

1. **Preflight — end the teammate's work first.** `cancelTasksForProfile` over
   **every path this install knows** (open + recent + persisted-UI-state, not just
   open ones), then cancel every **active run** whose registry entry carries the
   profile id. This happens *before* the roster entry is removed: committing first
   left a window in which tasks and runs referenced a profile that no longer
   resolved, so they failed as *"profile no longer exists"* instead of being
   cancelled with their teammate.
2. Roster entry removed and the id **retired** — recorded in `agents.json` so it is
   never handed to a future teammate.
3. Per-workspace **override files** removed (a dead identity's behavior must not
   re-skin a future teammate). **Run history and the memory namespace are kept.**
   Deleting a teammate ends its work; it does not erase what it wrote. Retiring the
   id is what makes keeping the data safe.
4. `agentProfilesChanged` pushed → renderer prunes stale chat bindings (§7).

The result is not a bare `true`: it reports how many tasks and runs were stopped plus
a `warnings` list naming anything cleanup could not finish (a locked override file, a
run that refused to stop). The roster row disappears either way, so a swallowed
failure would otherwise be invisible.

Deletion from the composer picker uses the same cascade and clears the *current*
chat's binding; the roster push covers every other chat.

## 12. Verification history

- **Deep audit rounds** (3 sweeps: pin wiring, self-audit of prior fixes, binding
  lifecycle) — every finding evidence-based, fixed with regression tests.
- **Full battery** at each landing: typecheck (both tsconfigs), lint (0 problems),
  full vitest suite (split runs: `tests/main + tests/shared`,
  `tests/renderer + tests/agent + tests/gui-e2e`), production build
  (`pnpm build`) + bundle greps confirming wiring survived minification.
- Known suite noise: `terminalExecuteTool.test.ts` real-child-process tests can fail
  under full-suite CPU contention (tight child timeouts) and **pass in isolation** —
  documented flake family, not a product bug.
- A **field-log audit** (`%APPDATA%\vyotiq\logs\vyotiq.log` + all run traces) drove
  two product fixes (§13).

## 13. Robustness invariants & field incidents

Invariants enforced in code:

- **Never serve what you can't vouch for** — corrupt stores are backed up, never
  overwritten in place; nothing recreates a vanished run dir silently.
- **A run must not outlive its storage** — both append queues classify `ENOENT` as
  storage loss (`markRunStorageLost`, one `error` log `EVENTS_DIR_MISSING` per dir)
  and fire a registered handler; the loop trips its own abort controller mid-step
  (loop.ts `abortOnStorageLost`) instead of streaming into an unpersistable void
  until the next step boundary. The existing boundary machinery then emits the
  terminal persist error.
- **Registry slots are self-healing** — `startAgentRun`'s finally clears the registry
  entry with an invokeId-guarded `clearRunAbort`, covering generators that throw
  before the loop's `try` (a leak there would permanently blind the scheduler's
  one-run-per-teammate gate).
- **Retention never touches active runs** — `sweepRetentionAuto` builds
  `protectedRuns` from `activeRunDirs()` and every sweep path skips them.
- **One roster, one truth; one queue, one truth** — the sidebar, the composer’s teammate picker and App’s
  pane routing read a single module-level store (`useAgentProfiles`), not three
  `useState` copies. Three copies meant three IPC loads and three push
  subscriptions, but the real hazard was divergence: an optimistic create or delete
  updated only the copy that issued it, and `deleteProfile`’s partial-failure
  warnings landed in whichever copy made the call — so the surface actually showing
  the roster never displayed them. Those warnings now render in a `role="alert"`
  region, because a delete can half-succeed (a locked override file, a run that
  refused to stop) while the row disappears regardless. `useDelegatedTasks` and
  `useWorkspaceProfileOverrides` are the same shape for the same reason: the
  moment a second surface read either one, an optimistic enqueue or a written
  override would have landed in one copy and not the other.
- **Hidden row actions stay reachable** — teammate row controls fade in on hover but
  also on `group-focus-within` and on `[@media(hover:none)]`. `opacity-0` alone
  leaves a button focusable but invisible, so a keyboard user tabs onto controls
  they cannot see and a touch device never reveals them.
- **Edits are anchor-honest** — rewind resolves the edit anchor against the persisted
  transcript (timestamp anchor preferred). A missing anchor (post-compaction) fails
  with *"Edited message no longer exists in the saved transcript — it was compacted
  away. Reload the chat and edit a newer message."* instead of a misleading
  out-of-range error; the preview path guards the same way. Index-only out-of-range
  keeps the generic error.

Field incidents that produced the above (from the audited packaged-app log):

- Run `5adcf808`: 6× `events.jsonl` ENOENT at 03:11, run streamed 11 more minutes
  into a deleted dir until manual cancel → storage-loss tripwire (this fix).
- 8× `editMessageIndex out of range` across 3 runs, one hammered 5× in 4 s after
  auto-compaction → anchor-honest errors (this fix).
- Run trace carrying `agentProfileId: frontend-fixer` while the roster had 2 other
  profiles → validated the binding-prune fix against real deleted-teammate data.

## 14. Testing map

Suites mirror `src/` under `tests/`:

| Area | Suite |
| --- | --- |
| Scheduler (queue, timers, reconcile loop, boot watcher rebuild, write-failure refusal, atomic teammate claim, preserved run ids, repair, retention, retry + `retryOf`, cancel, async preload, corrupt-file parity, chain-failure recovery) | `tests/main/unit/taskScheduler.test.ts` |
| Sidebar roster (presence, scope refusal, live work, retry vs. cancel vs. cancelling, failure text, alert region, assign) | `tests/renderer/app/TeammatesSection.test.tsx` |
| Teammates pane (roster, identity editing, avatar, model pin over configured providers only, autonomy, scope hazards, delete counts) | `tests/renderer/teammates/teammatesView.test.tsx` |
| Task surfaces (timing, retry provenance, controls, full history, assign cap, cross-workspace inbox, filters) | `tests/renderer/teammates/teammateTasks.test.tsx` |
| Workspace overrides in the UI (seed from global, partial write, round-trip of unexposed fields, clear) | `tests/renderer/teammates/teammateOverrides.test.tsx` |
| Shared task queue store (one load, cross-surface enqueue, refused-stop error, ordering) | `tests/renderer/hooks/useDelegatedTasks.test.tsx` |
| Shared UI primitives + the settings form shim (`data-settings-field` contract) | `tests/renderer/ui/primitives.test.tsx` |
| Shared roster store (one load, cross-surface mutations, partial-delete warnings) | `tests/renderer/hooks/useAgentProfiles.test.tsx` |
| Model precedence + run invariants | `tests/main/unit/agentProfileSchemas.test.ts` |
| Instance interrupt survival (branch preserved / honest non-resumable / protected checkouts) | `tests/main/unit/runsState.test.ts` |
| Runtime lifecycle + golden event-sequence equivalence for `local` | `tests/main/unit/runtimes.test.ts` |
| Delegated-run ownership vs. auto-resume | `tests/main/unit/resumeActiveGoals.test.ts` |
| Registry (profile registration, backfill, finish listeners) | `tests/main/unit/*runRegistry*`, `ipcRegister.test.ts` |
| Rewind anchors | `tests/main/unit/rewindRun.test.ts` |
| Append queues + storage-loss tripwire | `tests/main/unit/eventAppendQueue.test.ts`, `messageAppendQueue.test.ts` |
| Memory escape guard | profiles/memory suites (`tests/main/unit/...`) |
| Renderer binding/prune/pin seeding + adoption | `tests/renderer/chat/useWorkspaceManager.test.tsx` |
| Profiles store (corrupt backup, override removal, override write/clear, memory preserved on reset, unsafe-id refusal) | `tests/main/unit/agentProfiles.test.ts` |
| IPC surface parity for the override channels | `tests/main/integration/ipcContract.test.ts`, `tests/main/unit/ipcChannelParity.test.ts` |

Run the suite in halves to stay under the 10-minute window:
`pnpm vitest run tests/main tests/shared` then
`pnpm vitest run tests/renderer tests/agent tests/gui-e2e`.

## 15. Known limitations & non-goals

- **There is no cloud execution, by decision rather than by blocker.** Every run
  executes locally. An away-mode adapter for the OpenAI Agents API was built to the
  groundwork stage and then **removed at the owner’s direction**, together with its
  readiness probe, its `cloud:status` IPC and the `openai` SDK dependency that would
  have carried repository contents to a hosted sandbox. Nothing on the provider side
  blocks it — the API surface was verified to exist — so this is a reversible
  product choice, not a missing capability. Reintroducing it means re-running the
  capability gate and re-adding the dependency deliberately.
- **`runtime` still accepts `'cloud'`, and nothing registers it.** The profile schema
  has carried that value since before this work, so it stays. Because no cloud runtime
  is registered, `resolveAvailableRuntime` **refuses** such a run rather than falling
  back to local: a profile pinned to cloud fails visibly instead of quietly executing
  on this machine, which is the outcome someone choosing a non-local runtime is trying
  to avoid.
- **A scheduled task cannot start while the app is fully closed.** This app is the
  scheduling control plane; closed-app scheduling and closed-app notifications would
  need a separately operated hosted service.
- **Workspace overrides now have a UI writer** (reversed 2026-09-20). This was a
  deliberate non-goal — the files were hand-authored and git-shareable — and the
  decision was taken again the other way, not quietly dropped. The files are still
  git-shareable and still hand-editable; the Teammates pane simply writes them too.
  A file edited on disk outside the app is picked up the next time the workspace is
  read, not pushed: there is no watcher.
- **No fsync on atomic writes** — systemic to all run artifacts (crash may lose the
  last write); a separate blast-radius decision, not teammates-specific.
- **One running task per teammate** — the identity is single-threaded by design.
- **Storage cap warnings** — `Workspace snapshot file cap reached` means checkpoint
  diffs may be incomplete for that window (documented cap behavior).
- **Interrupted-by-restart tasks fail honestly** (*"retry to run it again"*) rather
  than silently auto-re-running — the explicit path is the safe path. Retry always
  creates a new task record rather than reopening the audited one.

## 16. User guide & use cases

Teammates live in two places on purpose. The **sidebar roster** is the ambient
view — who exists, who is working, one click to start. The **Teammates pane**
(sidebar footer → *Teammates*) is where everything with substance happens, and it
stays reachable when the sidebar is collapsed or no workspace is open.

**Create** — Teammates → *New* → name → Create. You land in the editor; persona,
identity, tone, avatar, model and availability are all there. The composer pill can
also create one inline and binds it to the current chat immediately.

**Chat** — click a teammate in the sidebar (pre-bound new chat) or bind mid-chat via
the composer's teammate pill. The model pill snaps to the teammate's pin (if set);
a manual pick still wins; rebinding re-adopts.

**Tune** — in the pane: *Identity* (name, avatar, persona, identity, tone),
*Model and behaviour* (a pinned provider/model, and whether this teammate asks
before running tools), *Availability* (every workspace, or one), then
*Per-workspace overrides* — a shareable file committed with the repo that retunes
this teammate for that project only. Edits are explicit: nothing is written until
you press *Save changes*.

**Assign & walk away** — hover a teammate in the sidebar → `+`, or use *Assign
task* in the pane → brief + optional schedule → Assign. Status
(Queued/Scheduled/Running/Stopping/Done/Failed) streams live. The sidebar keeps
work that is running or wants attention; the pane keeps the whole history, with
how long each task took, when a scheduled one fires, and whether an attempt
replaced an earlier one. A finished task keeps a link to its transcript, and a
failed one can be retried explicitly — which queues a **new** task and leaves the
failed attempt in history. Schedules >25 days out are honored exactly.

**Tasks tab** — every teammate's work across your open workspaces in one list,
filterable by teammate and searchable. Workspaces this session has not opened are
not loaded, so they are not in it.

**Delete** — Teammates → the teammate → *Delete*, and confirm. Deletion stops tasks
and live runs *first*, then removes the roster entry and its per-workspace
overrides, and prunes stale bindings; the toast reports how many tasks and runs it
stopped. **Run history and the teammate's memory are kept**; the id is retired so
no future teammate inherits them.

**Use cases**

1. *Project specialist with memory* — Scout holds only frontend facts; never
   re-explain conventions; separate brain per project.
2. *Overnight researcher* — assign at 6 PM for 2 AM; done by morning, approval
   requests become notifications instead of silent hangs.
3. *Recurring ops teammate* — queue Friday's release tasks; they serialize
   one-at-a-time and survive restarts.
4. *Crash-proof long worker* — auto-resume restarts interrupted runs with full
   identity, checkpoint, and memory.
5. *Walk-away chat* — a normal chat message behaves like a task: needs-you
   notifications, live browser watching, Stop works.
6. *Per-project personality* — commit `.vyotiq/agents/<id>.profile.json` with a
   house-tone override for one client repo.
7. *Model per teammate* — pin a strong model for Scout, a cheap one for Ops; chats
   and tasks use it automatically.

**Honest verdict:** teammates pay off when you re-explain instructions, run multiple
workstreams that shouldn't share a brain, want work while away, or want day-to-day
behavioral consistency. For one-off, fully-contextualized one-chat work, they add
ceremony without payoff.
