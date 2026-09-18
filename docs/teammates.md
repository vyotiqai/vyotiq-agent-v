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

- **Profile** — a roster entry: `id`, `name` (unique), `persona`, `identity`, `tone`,
  `autoResumeOnLaunch`, and an optional `model` pin
  (`{ provider, model }`, see `src/shared/ipc/schemas/agentProfile.ts`).
- **Binding** — a chat (run or draft) pointed at a profile id. Persisted per workspace
  in `agentProfileIdByRunId` (bucket key = run id, or `__draft__` for the composer
  draft), `src/shared/ipc/schemas/workspace.ts`.
- **Memory namespace** — a teammate's private memory tree per workspace
  (`.vyotiq/agents/<profileId>/memory/`). Two teammates in one project never share
  knowledge; a *deleted* teammate's runs keep their own id-keyed namespace so the
  shared brain is never contaminated (loop.ts fallback).
- **Delegated task** — an assignment enqueued for a teammate, optionally scheduled at
  a future time. Persisted, survives restarts, executes through the normal agent loop.
- **Runtime seam** — runs execute through pluggable runtimes; `local` is the only
  shipped runtime. The away-mode cloud adapter is **blocked on the industry**, not on
  this codebase (§15).

## 3. Architecture overview

Layering (top → bottom), all paths relative to the repo root:

```
Renderer (React)
  App.tsx                      roster load + prune effect + pin resolver wiring
  useWorkspaceManager.ts       binding map, controller pin-seeding, bind-time adoption, prune
  createChatStreamController   send payload: provider/model/agentProfileId, rewind anchor
  AgentProfilePicker           bind / unbind / delete (composer pill)
  TeammatesSection             sidebar roster, task list, assign dialog, delete confirm
        │  IPC (window.vyotiq.*)
        ▼
Main process
  ipc/register.ts              chatStart / chatRewindAndStart / agentProfilesDelete /
                               workspacesAdd (task re-arm) handlers
  agent/taskScheduler.ts       queue, timers, one-run-per-teammate gate, boot reconcile
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
profile (`resolveAgentProfile` → base roster + workspace override merge) and throws
`Unknown agent profile: <id>` when it no longer exists — this is why stale bindings
are pruned renderer-side (§7).

## 4. Data & storage layout

Packaged app root: `%APPDATA%\vyotiq` (dev profile: `%APPDATA%\vyotiq-dev`).

```
%APPDATA%\vyotiq\
  agents.json                          global roster (corrupt file → backed up, empty start)
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
- **Workspace overrides** (`.vyotiq/agents/<profileId>.profile.json`) merge over the
  base profile for that workspace only. They can adjust behavior fields (e.g. `tone`)
  but **cannot** hijack `id`, `name`, or timestamps. This is a *read-side* feature:
  there is no UI writer — override files are hand-authored and git-shareable by
  design (documented non-goal, §15).
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
- Pins unknown to the live catalog still send (by explicit design, `modelReadiness.ts`
  — catalogs omit servable models); failures surface through the chat error banner.
  An unknown pin renders via the raw-id display fallback.
- Delegated tasks use the pinned model automatically.

> History: an earlier component-level hook (`useTeammateModelPin`) adopted the pin
> through the manual-pick handler and **leaked it into the global default** (binding a
> teammate in pane A changed pane B's fresh chats) and re-fired on toolbar remounts.
> It was deleted; adoption now lives with session state (controller creation + bind).

## 9. Delegated tasks & the scheduler

`src/main/agent/taskScheduler.ts`. Per-workspace `tasks.json`; statuses
`queued → running → done | failed | cancelled`, plus `scheduled` (future start).

- **Assign** — task enqueued with `profileId`, `workspacePath`, `prompt`, optional
  `scheduledAt` (Zod-validated in the shared schema: parseable date, `min` floor;
  unparseable dates rejected).
- **One run per teammate** — `pumpProfile` starts a queued task only when the
  teammate has no active run: `runningByProfile` map **plus** a
  `listActiveRuns()` gate over registry entries carrying `agentProfileId`. Task runs
  register **with** the profile; the registry **backfills** a missing binding on the
  reuse path (runRegistry.ts) — the gate can't be blinded by a profile-less entry.
- **Timers** — scheduled tasks arm a timer; delays beyond `MAX_TIMEOUT_MS` are
  re-armed in chunks (far-future schedules honored exactly). The `fire` callback
  **re-reads the live task record** (the captured object can go stale) and only
  transitions tasks still in `scheduled`. The boot reconcile disarms timers of
  past-due tasks before flipping them to queued.
- **Closed-workspace hold** — `startTask` refuses to start in a workspace that is not
  open; the task stays queued. Re-arm happens on workspace re-add and on both window
  recreation paths.
- **Boot reconciliation** (`resumeTasksForWorkspaces`) — on app start and workspace
  open: tasks left `running` by a dead process are **finalized** (guarded by
  `isActive(runId)` so live runs are never double-finalized) as
  *failed — "Interrupted by app restart — reassign to retry"*; past-due scheduled
  tasks flip to `queued`; still-future tasks re-arm.
- **Missing-status backstop** — a running task whose run dir never writes
  `status.json` is finalized after 12 polls (60 s) and the slot is freed. (Legit slow
  starts can't trip it: `status.json` is written synchronously before the first
  `await` of the loop — verified against createRun/state.ts.)
- **Finish notification** — `startAgentRun`'s finally calls
  `notifyProfileRunFinished(profileId)` → the scheduler pumps the next queued task.
  Suppressed while a **delayed goal relaunch** is pending (the identity stays busy).
- **Cancellation** — `cancelTask` / `cancelTasksForProfile` clear timers, finalize
  records, emit `tasksChanged`, and cancel live runs via the real cancel path.

## 10. Run survival: restart, resume, auto-resume

- Every run persists a status snapshot **immediately** after `createRun`
  (runtime + `agentProfileId`/`agentProfileName`) — a crash during the first message
  flush still resumes with the teammate binding intact (loop.ts early `writeStatus`).
  Later `writeStatus` calls merge; they cannot erase the snapshot.
- **Auto-resume on launch** (`resumeActiveGoals.ts`): teammate-bound runs stopped as
  `cancelled`/`error` **and resumable** restart with a synthetic
  *"Continue where you left off."* — gated strictly on the profile's
  `autoResumeOnLaunch`. Quota-exhausted errors short-circuit before the teammate
  block (never relaunch into a dead quota). The loop re-arm runs **before** the quota
  gate so a quota-hold doesn't consume the resume.
- Deleted teammate on resume: the run keeps its own id-keyed memory namespace (§6).

## 11. Deletion cascade

`agentProfilesDelete` (ipc/register.ts) performs, in order:

1. `cancelTasksForProfile` — scheduled timers disarmed, queued tasks cancelled,
   live task runs cancelled via the real cancel path; each transition emits
   `tasksChanged` so the UI updates live.
2. Cancel every **active run** whose registry entry carries the profile id.
3. `removeProfileOverridesForWorkspaces` over **every path this install knows** —
   open + recent + persisted-UI-state paths (not just open ones; a closed workspace
   must not revive a dead identity's override).
4. Roster entry removed, `agentProfilesChanged` pushed → renderer prunes stale chat
   bindings (§7).

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
| Scheduler (queue, timers, backstop, boot reconcile, closed-workspace hold, corrupt backup, cancel) | `tests/main/unit/taskScheduler.test.ts` |
| Registry (profile registration, backfill, finish listeners) | `tests/main/unit/*runRegistry*`, `ipcRegister.test.ts` |
| Rewind anchors | `tests/main/unit/rewindRun.test.ts` |
| Append queues + storage-loss tripwire | `tests/main/unit/eventAppendQueue.test.ts`, `messageAppendQueue.test.ts` |
| Memory escape guard | profiles/memory suites (`tests/main/unit/...`) |
| Renderer binding/prune/pin seeding + adoption | `tests/renderer/chat/useWorkspaceManager.test.tsx` |
| Profiles store (corrupt backup, override removal) | profiles suites under `tests/main/unit/` |

Run the suite in halves to stay under the 10-minute window:
`pnpm vitest run tests/main tests/shared` then
`pnpm vitest run tests/renderer tests/agent tests/gui-e2e`.

## 15. Known limitations & non-goals

- **Away-mode cloud execution is blocked on the industry, not the codebase.**
  Research findings (verified against official sources, not marketing): OpenAI's
  `openai-codex` SDK drives a *local* app-server; Claude Code cloud sessions had no
  documented public API; no hosted Codex REST surface. The runtime seam (P4A) is
  ready; do not ship an adapter against unverified APIs.
- **Workspace overrides have no UI writer** — hand-authored, git-shareable files;
  the edit dialog touches the global base profile only. Deliberate, documented.
- **No fsync on atomic writes** — systemic to all run artifacts (crash may lose the
  last write); a separate blast-radius decision, not teammates-specific.
- **One running task per teammate** — the identity is single-threaded by design.
- **Storage cap warnings** — `Workspace snapshot file cap reached` means checkpoint
  diffs may be incomplete for that window (documented cap behavior).
- **Interrupted-by-restart tasks fail honestly** (*"reassign to retry"*) rather than
  silently auto-re-running — the explicit path is the safe path.

## 16. User guide & use cases

**Create** — sidebar → *Teammates* → `+` → Name / Persona / Identity / Tone /
*Auto-resume interrupted runs at app launch* → Create.

**Chat** — click a teammate in the sidebar (pre-bound new chat) or bind mid-chat via
the composer's teammate pill. The model pill snaps to the teammate's pin (if set);
a manual pick still wins; rebinding re-adopts.

**Assign & walk away** — hover a teammate → `+` task → prompt + optional schedule →
Assign. Status (Queued/Scheduled/Running/Done/Failed) streams live into the sidebar;
hover to cancel. Schedules >25 days out are honored exactly.

**Edit / Delete** — hover → pencil (persona/tone/auto-resume) → trash (two-click
confirm). Deletion cancels tasks, stops live runs, removes overrides, prunes stale
bindings.

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
