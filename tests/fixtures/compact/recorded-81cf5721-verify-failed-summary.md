Session Intent

Design (and build via TDD) a general-purpose agentic AI agent that: does whatever the user asks through tools; connects to external apps and plugins (MCP client + plugin system); adheres strictly to the user's request (safety/permission lay

Contract done-when:

An end-to-end executable agent exists that: takes a natural task, selects and runs tools via a real provider adapter (plus a deterministic FakeLLM for tests), enforces permission/confirmation for destructive actions, persists memory in indexed SQLite, connects to an external MCP server, and serves both CLI and HTTP/SSE interfaces.

All unit/integration/E2E suites green; realistic (non-lorem-ipsum) data; no table scans/over-fetching; HTTP non-streamed responses <200ms; error path audited (client-safe messages, verbose logs, no swallowed exceptions).

The design + phase roadmap has been agreed and is being built in increments, each green before the next.

Files Touched

plan.md (created, 6176 chars; updated 3 times with settled decisions)

contract.md (created, 1381 chars)

@modelcontextprotocol/sdk (referenced as dependency)

LLMProvider.chat (interface defined in design)

core/agent, core/context, core/llm, core/mcp, core/memory, core/plugins, core/safety, core/tools (design layers, not yet created)

Key Decisions

Primary language/runtime for the agent core: Not sure — recommend one → TypeScript + Node.js LTS 22 (pnpm)

MCP transports to implement in phase P5: Both stdio and HTTP/SSE transports at P5

Provider strategy: Provider-agnostic via thin adapter (OpenAI, Anthropic, Ollama local, FakeLLM for tests)

Core architecture: Original orchestration core + MCP for external connections (hybrid)

Interface surface: Library-first core (createAgent) with thin CLI + HTTP/SSE server

Confirmation UX: Both interactive CLI prompt AND programmable approval callback

MCP server auth: Token/header auth at P5

Observability: pino (redaction) + minimal OpenTelemetry from P0

Stack: TypeScript, pnpm, Vitest, Zod (schema-first tools → JSON Schema), better-sqlite3, @modelcontextprotocol/sdk

Constraints

Strict TDD: define "done" as passing tests before implementation; realistic (non-lorem-ipsum) data only

No over-fetching: DB-pushed queries with indexes/pagination; never table scans

Strict perf: <200ms for HTTP non-streamed responses; streaming via SSE

Fail early/hard: typed errors at boundaries, client-safe messages, verbose server logs, no swallowed exceptions

No bloat: pinned to 9 layers; no auth/OAuth until needed; minimal clean architecture

Greenfield workspace; design-first, build in phases (P0–P7), each green before next

Open Bugs/Blockers

No code bugs yet (design phase only). Potential blockers to watch:

MCP SDK ecosystem churn → keep pinned + behind own thin interface

LLM tool-call parsing variance → strict schema validation per adapter + normalized shape

Destructive-actions safety → required permission layer + confirmation, never bypass

Scope creep → pinned to 9 layers; defer OTel after P6 baseline, auth until external-app case requires it

Next Steps

For the next turn:

Begin P0 (scaffolding) as instructed: pnpm init, strict tsconfig, Vitest, CI, minimal OTel setup

Create core layer files per plan.md:

src/core/llm/ — provider interface + adapters + FakeLLM

src/core/agent/ — orchestration loop

src/core/tools/ — Tool type, registry, validation, error mapping

src/core/safety/ — permissions + confirmation

src/core/context/ — token budgeting

src/core/memory/ — sqlite repos

src/core/mcp/ — MCP client (stdio + HTTP/SSE + auth at P5)

src/core/plugins/ — plugin loader + manifest schema

Proceed through phases P1–P7 in strict order, each TDD-green before next:

P1: model adapter + FakeLLM + normalized tool calling

P2: tool registry + validation + safety/permission

P3: agent orchestration loop

P4: memory (SQLite, indexed, paginated)

P5: MCP client (stdio + HTTP/SSE + auth) + plugin system

P6: CLI + HTTP/SSE server

P7: E2E hardening, perf bounds, error-path audit

Recheck plan.md and contract.md at start (they contain the full roadmap and done-when criteria)

Write tests first per TDD, with realistic fixtures — begin with P0 scaffold tests
