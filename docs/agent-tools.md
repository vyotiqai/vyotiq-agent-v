# Agent-built tools

The agent can write a tool for itself. `build_tool` composes a `.mjs` module
under `<userData>/agent-tools/`, and from the next step that module is a tool in
the catalog like any other. This document states what that actually permits,
because the honest summary is that it is the most powerful thing in the tool
list, and it does not look like it.

## The shape of one

`build_tool` takes a `name`, a `description`, a JSON Schema for its arguments,
and `code`. The file it writes is the code preceded by a single header comment:

```js
/* @agent-tool {"name":"adder","description":"Adds two numbers","inputSchema":{...}} */

export async function handler(args, ctx) {
  return { sum: args.a + args.b }
}
```

The header is the contract. `scanAgentTools` reads it as text and **never
imports the module at scan time**, so a broken or hostile tool cannot execute
by being listed. `loadAgentToolsSnapshot` caches on the directory's `.mjs`
mtimes, which is what lets a tool written on one step appear on the next with no
restart — the same live-reload property agent-authored skills have.

## Where it joins the run

Three seams, all in the ordinary path rather than beside it:

1. **Catalog** — `agentBuiltToolDefinitions()` is appended to `wireToolDefs` in
   `loop.ts`, next to the builtins and the selected MCP tools. Never deferred:
   the set is small and it is the user's own code.
2. **Dispatch** — `executeTool` resolves the name against the snapshot before
   the builtin lookup, then calls `runAgentTool`, which forks the module in an
   Electron `utilityProcess` with a 30-second timeout. A module that fails,
   times out, or dies without answering becomes a tool failure, not a crashed
   step.
3. **Catalog UI** — the entries appear in Settings under *Agent-built tools*,
   so what exists is visible without reading a directory.

It lives in `agentTools/loader.ts` rather than beside the dispatcher in
`tools/index.ts` because `loop.ts` imports it: importing that barrel closes the
cycle loop → tools → instanceTools → agentInstances → loop, which leaves
`AGENT_TOOLS` empty at module-init time and silently strips every builtin off
the wire.

## What bounds it

A tool module is dynamically imported in a utility process with **full Node
privileges**. The "Node builtins only" note in `agentTools/paths.ts` describes
the bootstrap, not the tool module, which may import `child_process` freely.
`build_tool` plus a call to what it wrote is therefore strictly more capable
than `terminal`. Four things hold it in place.

**`build_tool` is approval-gated and high-risk.** It is in
`isAutonomousHighRiskTool`, so autonomous mode does not auto-grant it. The
approval card carries the `code` argument, and that is the one moment anyone
reads the module before it exists.

**Calls are gated even when approvals are off.** `isToolGated` treats an
agent-built name the way it treats an MCP server tool: "approvals off" is a
judgement about the tools that shipped with the app, not about code this run
wrote minutes ago. Autonomous mode gates them too, through the
`!BUILTIN_TOOL_NAMES.includes(...)` catch-all.

**An allow is bound to the module's contents, not its name.** `build_tool` with
`overwrite: true` rewrites the file behind a stable name, so an "always allow"
keyed on the name would follow the name onto code the user never read. The
allowlist entry is `<name>@<sha256 prefix>`, and editing the module stops the
old key matching. This mirrors `acceptedOverrides` in
`settings/agentProfiles.ts`, which hashes an override file's bytes for the same
reason.

**A tool cannot impersonate another.** `build_tool` refuses a name that is a
builtin or one of its aliases — `read`, `terminal`, `write` — and refuses the
`mcp__` prefix. Dispatch is by name, so without this a module could put
arbitrary Node behind the tool the model reaches for most.

Two more constraints it inherits: it is **Agent-mode only** by omission, pinned
by the exhaustive classification test in `tests/main/unit/modePolicy.test.ts`;
and a **path-scoped inline instance without a worktree is refused**, the same
guard MCP gets, because an agent-built module has no path scope of its own and
would otherwise write straight past the boundary the worktree exists to
enforce.

## What is NOT bounded

- **The module is not sandboxed.** Approval is the control; there is no
  filesystem or network restriction inside the utility process beyond the
  30-second timeout.
- **Nothing expires.** A tool written once stays in the catalog for every later
  run in this install until the file is deleted by hand.
- **There is no review surface for the code.** Settings lists what exists by
  name and description; reading the module means opening
  `<userData>/agent-tools/<name>.mjs`.

## Tests

| Area | Suite |
| --- | --- |
| Header composition, overwrite refusal, name validation, shadowing and `mcp__` refusals, content hashing | `tests/main/agent/tools.buildTool.test.ts` |
| Text-only scan, duplicate handling, mtime-cached snapshot | `tests/main/agent/agentTools.loader.test.ts` |
| Fork, result, timeout, exit-before-result | `tests/main/agent/agentTools.runner.test.ts`, `agentTools.bootstrap.integration.test.ts` |
| Write → catalog → dispatch through `executeTool`, failure and timeout reporting, Agent-mode only | `tests/main/agent/agentTools.dispatch.test.ts` |
| Gating when approvals are off, content-bound allow, high-risk classification | `tests/main/unit/toolApproval.test.ts` |
| **In the real app**: a previous session's tool is in the catalog on a fresh launch, and Settings names it | `tests/gui-e2e/agent-built-tools.spec.ts` |

The e2e one earns its place: every other suite calls `build_tool` first, which
is what resolved the directory and hid the bug above. Reverting
`resolveAgentToolsDir()` to the synchronous call fails it with an empty
catalog — verified, not assumed.
