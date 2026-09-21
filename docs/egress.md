# Outbound network egress

Agent V routes the network requests it makes on your behalf through one policy
module, `src/main/net/egress.ts`. This document states exactly what that gate
covers and — more importantly — what it does not, because a security control
that is described as broader than it is does more harm than no control at all.

## What the gate does

`evaluateEgress()` judges a single request and never throws, so the per-request
hot path always gets a verdict rather than having to defend against an
exception. `checkEgress()` judges and records in one call, so nothing can be
enforced without also being auditable.

Three rules, applied in order:

1. **Scheme.** Non-network schemes (`about:`, `data:`, `blob:`, `file:`,
   `chrome*:`) resolve without touching the network.
2. **Host.** Loopback, private and link-local ranges are refused unless the
   caller passes `allowLocal`. This delegates to `isSyncBlockedUrl` in
   `webFetch.ts`, which remains the single definition of a blocked address.
3. **Allowlist.** When `browserDomainAllowlist` is non-empty, the host must
   match it exactly or by `*.suffix`. Empty means no extra host filter.

## Coverage

| Path | Gated | Enforced by |
| --- | --- | --- |
| Browser navigation | yes | `isSyncBlockedNavigation` → `checkEgress` |
| Browser subresources (`fetch`, XHR, images, WebSocket, form POST) | yes | per-partition `onBeforeRequest` in `guardPartitionEgress` |
| Remote MCP (`http` / `sse`) | recorded | `assertPublicUrl` still enforces; the gate records |
| **stdio MCP servers** | **no** | see below |
| **The terminal tool** | **no** | see below |

Until this gate existed the allowlist was enforced on navigation only, so a
page served from an allowed host could `fetch()` or POST to any host in the
world. That is the path `browser_subresource` closes.

## Telling the agent it was refused

A navigation refusal throws, and the message names the allowlist, so the agent
learns about it. A subresource refusal does not: the page loads, its XHRs are
cancelled, and what the agent sees is a page that merely looks broken. It then
retries, or reports the site as down, while the one fact that explains the page
sits in a ledger nothing reads mid-run.

So every browser tool result carries a note when the gate refused anything
during that call:

```
[egress policy] Refused 4 request(s) from this page to: https://tracker.example (3),
https://ads.example. The page may be incomplete. This is the host allowlist
refusing the request, not the site failing.
```

The note is attached by wrapping every handler in `browserTools.ts`, not by
each handler remembering to add it, so a new browser tool cannot omit it.

Bracketing uses the ledger's monotonic `seq`, not a timestamp: `Date.now()` has
millisecond resolution, so a refusal recorded in the same millisecond as the
start of a call is indistinguishable from one inside it, and the note would
blame a page for a previous call's refusals.

## What is deliberately not covered

**stdio MCP servers** run as child processes with their own sockets. Nothing in
this process can see or interrupt their traffic. They are trusted by
installation: you chose to install that server, and it talks to its vendor under
that vendor's terms (as PRIVACY.md §5 states). Blocking their egress would need
OS-level network controls, not a module.

**The terminal tool** runs arbitrary commands, and any of them — `curl`,
`git push`, a test runner — can open its own connection. It is governed by the
tool-approval gate (what you allow it to run), not by this one.

Both are outside the boundary by design, not by oversight. Do not describe this
gate as covering all agent network activity.

## Two ways to silently break it

**Electron keeps only one `onBeforeRequest` listener per session per event.**
Registering a second one anywhere on the agent-browser partition sessions
*replaces* this gate — no error, no warning, subresource egress simply stops
being checked. Before adding any `webRequest` handler, grep for existing ones on
the same session.

**`getSettings()` re-reads every configured MCP server's secrets from disk on
each call.** It must never be called per request; a single page issues hundreds.
The hook uses a one-second snapshot. Navigation still reads live settings, since
it is infrequent and a host you just removed should stop being reachable at
once.

## Scope of the relaxations

The non-network scheme exemption and the WebSocket host mapping (`wss:` judged
as `https:` rather than refused outright) apply to `browser_subresource` only.
Navigation keeps its original http(s)-only contract, so sharing one rule set
between the two cannot widen what the browser may open.

## The ledger

Every decision is recorded in a bounded in-memory ledger (1000 entries, oldest
dropped). Each entry keeps **scheme and host only** — paths and query strings
routinely carry tokens such as `?access_token=`, and this ledger is meant to be
safe to surface. Read it with `listEgress()`, filtered by run, workspace,
purpose, or refusals only.

That ledger is bounded and dies with the process, which is the wrong lifetime
for an audit trail — what a run talked to is usually asked after something went
wrong, often after a crash. So `src/main/agent/egressRunLedger.ts` subscribes to
it and writes a per-run summary to `egress.json` in the run directory, beside
`usage.json`.

The run file aggregates per origin rather than appending per request: one page
load can issue hundreds of requests to the same CDN, and five hundred identical
rows answer no question that one row with a count does not. Each origin carries
allowed and denied counts, the distinct purposes and deny reasons, and first and
last timestamps. Writes are debounced and serialized per run; a failed write
costs a log line, never the run. Origins are capped per run, and a truncated
file says how many it dropped.

Pending writes are flushed on quit, so a quit inside the debounce window does
not drop the tail of a record — usually the part worth reading, since it covers
whatever the run was doing when it stopped. That flush rides the bounded
child-teardown list rather than `flushBeforeQuit`: the latter can ask the user
to keep waiting, and a diagnostic write must never be the reason for that
prompt.

Egress that belongs to no run — you browsing by hand, app-level fetches — stays
in the in-memory ledger only, since there is no run file for it to belong to.

Neither ledger is surfaced in the UI yet.

## Tests

- `tests/main/unit/egressPolicy.test.ts` — the policy and the in-memory ledger
- `tests/main/unit/agentBrowserEgressHook.test.ts` — the wiring, driven through
  real tab creation; asserts one listener per partition
- `tests/main/unit/egressRunLedger.test.ts` — aggregation, run attribution and
  the durable file
- `tests/main/unit/browserEgressNote.test.ts` — the refusal note and its
  bracketing

Run all four after any change to browser egress.
