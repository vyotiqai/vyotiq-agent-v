# Phase 0 Audit — Tool Pipeline (for custom tools / create_tool)

Evidence collected this run from real file reads (line numbers verified). Facts only; bugs vs gaps separated at the end.

## (a) Tool-def flow, file:line per hop

1. **Builtin catalog**: `src/main/agent/schemas/tools.ts:987` `export const TOOL_REGISTRY = { … } as const` — per-tool `{ description, schema }` with zod schemas (e.g. `skillArgs` :833, `Skill` def :1194–1197). `:1280` `BUILTIN_TOOL_NAMES = Object.keys(TOOL_REGISTRY)`; `:1282–1289` `toToolDefinitions()` maps each entry to `{ name, description, parameters: zodToJsonSchema(schema) }`; `:1290` `export const AGENT_TOOLS = toToolDefinitions()` (computed once at module load). Re-exported by `src/main/agent/types.ts:1–2`.
2. **Loop import**: `src/main/agent/loop.ts:173` `import { AGENT_TOOLS } from './types'`; `:178` `listMcpToolDefinitions` from `./mcp`.
3. **Per-step assembly** (`refreshMcpToolsForStep`, loop.ts:1478–1563):
   - `:1526` `const mcpToolDefs = listMcpToolDefinitions().filter(...)` (server enabled + policy allow).
   - `:1533–1545` `allToolDefs = modelInfo.supportsTools !== false ? filterToolDefsForCodeIndex(filterToolDefsForMode(agentMode, [...AGENT_TOOLS, ...mcpToolDefs], { autoModeSwitch, inlineInstance }), liveCodeIndexEnabled) : []` — **the one insertion point for custom defs**.
   - `:1548` `const fullCatalog = buildStepToolCatalog(allToolDefs)`; `:1549–1553` `toolDefs = fullCatalog.tools.map(...)`; `toolsJsonEstimate`.
   - `:1560–1562` `stepMcpToolNames = new Set(toolDefs.map(t => t.name).filter(n => parseMcpToolName(n) != null))` — MCP-only; custom names would not be gated by this set.
   - `:2211` provider request carries `tools: toolDefs`.
4. **Refresh cadence**: pre-loop `:1565 await refreshMcpToolsForStep()`; per-step `:1704` runs only when `step > initialStep + 1 || autoModeSwitchChanged || modeChangedAtBoundary`. **Catalog cache**: `:1516–1521` `catalogFp` = refreshFp + agentMode + autoModeSwitch + tools-support + codeIndex flag; when unchanged, `return` reuses prior defs. `refreshFp` (:1479) = mcp session-map fingerprint + marketplace overrides + workspace — **does not include any custom-tools-dir state**.
5. **Dispatch**: `src/main/agent/executeStepTools.ts:360` `executeTool(call.name, call.arguments, ctx.workspace, toolSignal, {…})` inside `runSingleTool`; context sets passed at `:380–382` (stepMcpToolNames, runPinnedMcpToolNames, runStickyToolNames). `:674` `executeStepToolCalls` canonicalizes names (`:680`).
6. **Dispatcher**: `src/main/agent/tools/index.ts:2061` `export async function executeTool(rawName: string, argsJson: string | undefined, workspace: string, signal: AbortSignal, context: ToolExecutionContext = {}): Promise<ToolResult>`. Flow: `:2072` canonicalize name; `:2085` MCP branch (`parseMcpToolName` → runEnabledMcpIds/stepMcpToolNames/policy gates → `invokeMcpTool` :2140); `:2152` `validateParsedToolArgs(name, args)` (zod registry, schemas/tools.ts:1441 — fails with `formatUnknownToolError` for non-registry names); `:2170` mode gate `assertToolAllowedInMode`; `:2182` `if (!Object.prototype.hasOwnProperty.call(BUILTIN_HANDLERS, name)) return toolFail(name, name, formatUnknownToolError(name))`; `:517` `BUILTIN_HANDLERS: Record<AgentToolName, ToolHandler>`; handler shape `(workspace, args, signal, context) => Promise<ToolResult> | ToolResult`; `:2325` wrapped in try/catch → `toolFail(..., failureLogged)`.
7. **ToolResult**: tools/index.ts:167–172 `{ ok: boolean; summary: string; content: string; failureLogged?: boolean }`.
8. **Workspace-root resolution**: `executeTool` receives `workspace` (loop.ts:3252 `workspace: toolWorkspace` — worktree-remapped for instances; `sessionWorkspace: workspace` parent at :3253). Handlers that must bind session workspace use `context.sessionWorkspace` + `usesSessionWorkspaceIndex(name)` (tools/index.ts:~2310). Safe path resolution: `resolveInsideWorkspace` (`@main/workspace/safePath`).
9. **Skills live-refresh pattern to mirror**: loop.ts:~1410 `skillsSection = buildSkillsSection(loadEnabledSkills(marketplaceOverrides, workspace))`; `refreshSkillPromptSections()` re-reads disk at every step boundary (called :1702 when `step > initialStep + 1`) — no restart. skills/index.ts:83 `loadEnabledSkills`, :176 `buildSkillsSection`, :239 `findEnabledSkillByName`; prompt section id `available_skills` via `wrapPromptSection('available_skills', …)`.

## (b) Insertion points for the custom-tool subsystem

- **New builtin def (`create_tool`)**: add zod args schema + entry in `TOOL_REGISTRY` (schemas/tools.ts) + handler in `BUILTIN_HANDLERS` (tools/index.ts). Def and handler flow automatically into AGENT_TOOLS and the step catalog.
- **Custom defs merge**: in `refreshMcpToolsForStep` at loop.ts:1538 — `[...AGENT_TOOLS, ...mcpToolDefs, ...listCustomToolDefs(workspace)]` (loaded from `<workspace>/.vyotiq/tools/<name>/tool.json`). Must bust `lastMcpCatalogFp` when the tools dir changes: simplest is to include a cheap directory fingerprint (mtime of dir or count+mtimes) in `catalogFp`, or have the `create_tool` handler call `context.invalidateMcpToolCatalogCache?.()` (already exists, loop.ts:1465–1467, and reaches handlers via ToolExecutionContext).
- **Custom dispatch branch**: in `executeTool` after the MCP branch and before the `BUILTIN_HANDLERS` own-property check (:2182) — custom names pass through `canonicalizeAgentToolName` unchanged (schemas/tools.ts:1346–1366 returns trimmed name when not a builtin/alias). Validate args against the custom tool's JSON schema (Ajv is already a dependency of the app, used by mcp/index.ts) since zod registry can't hold dynamic schemas. Mode gate should run like builtins (custom tools callable in Agent mode; gate at least ask-mode out).
- **Workspace root for persistence**: use the `workspace` argument of the handler; when `context.sessionWorkspace` is set (instance worktree), tools whose artifacts must survive worktree removal should bind `sessionWorkspace` — mirror `usesSessionWorkspaceIndex(name)` remap (memory_* tools bind session workspace; live file tools stay on the worktree). For custom tools, invoke on the workspace the call targets (worktree) but resolve the tool definitions from the session workspace so instances see parent-authored tools; safest: load defs from `context.sessionWorkspace ?? workspace`.

## (c) Optional-builtin / mode gating mechanics

- `filterToolDefsForMode(agentMode, defs, { autoModeSwitch, inlineInstance })` (tools/modePolicy.ts, used loop.ts:1537) drops defs not allowed in the current mode; `assertToolAllowedInMode(agentMode, name, args, { autoModeSwitch, inlineInstance })` (tools/index.ts:2170, from modePolicy.ts) re-gates at dispatch with an explicit error. Custom tools should use both gates. Optional-builtins use `isOptionalBuiltinName` (context/toolsBudget.ts; tools/index.ts:470–472 `optionalBuiltinCatalogName`) — full catalog is never trimmed anymore ("Full catalog every step: nothing is trimmed, deferred, or evicted" loop.ts:1546–1547 comment; `buildStepToolCatalog` in context/).

## (d) Sticky-name analysis for mid-run-created tools

- `runStickyToolNames` (loop.ts:1463) is declared and threaded into toolCtx (:3282) and ToolExecutionContext (tools/index.ts:246), consumed only inside request_mcp_tools / release_mcp_tools handlers (tools/index.ts:1129, 1243). No `.add`/`.has` outside those — sticky names are bookkeeping for pin honesty, not a catalog filter.
- Catalog is rebuilt full every step and `stepMcpToolNames` filters MCP names only. **A custom tool created mid-run is callable the next step provided** the catalog actually rebuilds — which the `catalogFp` cache currently prevents when config is unchanged. Blocker: none structural; required change = invalidation on tool-dir change (see (b)).

## (e) Bugs vs gaps

**Bugs (each with evidence)**
1. **Custom-tool catalog staleness hazard (gap that becomes a bug once custom tools exist)**: loop.ts:1516–1521 caches the full catalog on `catalogFp` which excludes custom-tools state (refreshFp :1479 = mcp fingerprint + overrides + workspace only). A tool written by `create_tool` mid-run would never appear until some other config change busts the fingerprint. Fix: include a tools-dir fingerprint in `catalogFp` or invalidate on create (invalidateMcpToolCatalogCache is already plumbed through to handlers, loop.ts:1465–1467 → toolCtx :3292 → ToolExecutionContext → dispatch context :389).
2. **`validateParsedToolArgs` rejects any non-registry name with "Unknown tool"** (schemas/tools.ts:1445–1446) and the dispatcher's own check (:2182) — fine today, but any custom-tool branch added without adjusting validation would be dead on arrival; also `wireToolCallArguments(name, args)` (toolArgWire) is keyed on builtin names — custom tools must bypass or tolerate it (parseToolArgs tools/index.ts:2051–2064 falls back to `{}` on parse failure, then validation fails — acceptable: real errors surface).

**Gaps (missing capability, not defects)**
- No custom-tool subsystem exists: no loader, no runner, no `create_tool`, no custom def merge, no prompt wiring. That is the work, not a defect.
- No `utilityProcess`-based generic runner exists (search for `utilityProcess` matched only dictation/whisper and tokenizer pool) — per performance.mdc CPU-heavy work must run out-of-process; the custom runner must be new code.

**Unknowns**
- Exact test-file conventions for dispatcher tests (child was cancelled before locating them; Phase 1 child must find 2–3 vitest examples under tests/ before writing tests).
- Whether `buildStepToolCatalog` imposes any name-shape constraints that would reject custom tool names (verify in Phase 1; fallback = accept whatever it does to MCP names, which pass through).
