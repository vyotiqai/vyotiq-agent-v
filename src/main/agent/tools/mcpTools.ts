import type { AgentToolName } from '../schemas/tools'
import { canonicalizeAgentToolName } from '../schemas/tools'
import { isOptionalBuiltinName } from '../context/toolsBudget'
import {
  listMcpToolDefinitions,
  getMcpReadOnlyHint,
  listMcpResources,
  readMcpResource,
  listMcpPrompts,
  getMcpPrompt,
  getMcpServerStatus,
  parseMcpToolName,
  assertMcpServerAccess
} from '../mcp'
import { resolveEffectiveMcpServers } from '@main/marketplace'
import { throwIfAborted, toolOk, toolFail } from './index'
import type { ToolExecutionContext, ToolResult, ToolHandler } from './index'

function optionalBuiltinCatalogName(raw: string): string | undefined {
  const canonical = canonicalizeAgentToolName(raw)
  return isOptionalBuiltinName(canonical) ? canonical : undefined
}

function optionalMcpServerId(args: Record<string, unknown>): string | undefined {
  const value = args.serverId
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function mcpServerGate(
  toolName: string,
  serverId: string,
  summary: string,
  context: ToolExecutionContext,
  workspacePath?: string | null
): { ok: true } | { ok: false; result: ToolResult } {
  const access = assertMcpServerAccess(serverId, context.runEnabledMcpIds, workspacePath)
  if (!access.ok) {
    return { ok: false, result: toolFail(toolName, summary, access.error) }
  }
  return { ok: true }
}

function formatMcpResourceLines(entries: Awaited<ReturnType<typeof listMcpResources>>): string {
  return entries
    .map((entry) => {
      const label = entry.name ? `${entry.uri} (${entry.name})` : entry.uri
      const meta = [entry.mimeType, entry.description?.replace(/\s+/g, ' ').trim()]
        .filter(Boolean)
        .join(' — ')
      return `- [${entry.serverId}] ${label}${meta ? `: ${meta}` : ''}`
    })
    .join('\n')
}

function formatMcpPromptLines(entries: Awaited<ReturnType<typeof listMcpPrompts>>): string {
  return entries
    .map((entry) => {
      const argNames = (entry.arguments ?? []).map((arg) => arg.name).filter(Boolean)
      const argsNote = argNames.length ? ` args=[${argNames.join(', ')}]` : ''
      const desc = entry.description?.replace(/\s+/g, ' ').trim()
      return `- [${entry.serverId}] ${entry.name}${argsNote}${desc ? `: ${desc}` : ''}`
    })
    .join('\n')
}

export const mcpHandlers = {
  mcp_list_tools: (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    const filter = optionalMcpServerId(args)?.toLowerCase() ?? ''
    const enabled = context.runEnabledMcpIds
    const stepCatalog = context.stepMcpToolNames
    const defs = listMcpToolDefinitions().filter((t) => {
      const parsed = parseMcpToolName(t.name)
      if (!parsed) return false
      if (filter && parsed.serverId.toLowerCase() !== filter) return false
      if (enabled && !enabled.has(parsed.serverId)) return false
      return true
    })
    if (defs.length === 0) {
      const statuses = getMcpServerStatus(resolveEffectiveMcpServers()).filter((s) => {
        if (!s.enabled) return false
        if (enabled && !enabled.has(s.id)) return false
        if (filter && s.id.toLowerCase() !== filter) return false
        return true
      })
      const down = statuses.filter((s) => !s.connected)
      if (down.length > 0) {
        const lines = down.map(
          (s) => `- ${s.id}${s.error ? `: ${s.error}` : ': not connected'}`
        )
        return toolFail(
          'mcp_list_tools',
          filter || 'mcp',
          [
            'Enabled MCP server(s) are configured but not connected:',
            ...lines,
            '',
            'Fix in Marketplace → Manage (ensure uv/uvx is on PATH), then Refresh MCP connections.'
          ].join('\n')
        )
      }
      const none = filter
        ? `No MCP tools matching serverId=${filter}`
        : 'No MCP tools connected.'
      return toolOk('mcp_list_tools', filter || 'none', none)
    }
    const lines = defs.map((t) => {
      const hint = getMcpReadOnlyHint(t.name)
      const hintNote =
        hint === true ? ' readOnlyHint=true' : hint === false ? ' readOnlyHint=false' : ''
      const omitted =
        stepCatalog && !stepCatalog.has(t.name) ? ' [omitted from this step catalog]' : ''
      const desc = (t.description || '').replace(/\s+/g, ' ').trim().slice(0, 160)
      return `- ${t.name}${hintNote}${omitted}${desc ? `: ${desc}` : ''}`
    })
    return toolOk('mcp_list_tools', `${defs.length} tools`, lines.join('\n'))
  },
  request_mcp_tools: (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    const pinned = context.runPinnedMcpToolNames
    if (!pinned) {
      return toolFail(
        'request_mcp_tools',
        'pin',
        'request_mcp_tools requires an active agent run.'
      )
    }
    const serverId =
      (typeof args.serverId === 'string' && args.serverId.trim()) ||
      (typeof args.server_id === 'string' && args.server_id.trim()) ||
      ''
    const requested = Array.isArray(args.tools)
      ? args.tools.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : []
    if (!serverId && requested.length === 0) {
      return toolFail(
        'request_mcp_tools',
        'pin',
        'Provide tools: string[] and/or serverId to pin MCP tools for the next step.'
      )
    }
    const enabled = context.runEnabledMcpIds
    const connected = listMcpToolDefinitions().filter((t) => {
      const parsed = parseMcpToolName(t.name)
      if (!parsed) return false
      if (enabled && !enabled.has(parsed.serverId)) return false
      return true
    })
    const byFull = new Map(connected.map((t) => [t.name, t]))
    const byBare = new Map<string, string[]>()
    for (const t of connected) {
      const parsed = parseMcpToolName(t.name)
      if (!parsed) continue
      const list = byBare.get(parsed.toolName) ?? []
      list.push(t.name)
      byBare.set(parsed.toolName, list)
    }

    const newlyPinned: string[] = []
    const unknown: string[] = []
    const already: string[] = []

    const notes: string[] = []
    if (serverId) {
      const fromServer = connected.filter((t) => {
        const parsed = parseMcpToolName(t.name)
        return parsed?.serverId.toLowerCase() === serverId.toLowerCase()
      })
      if (fromServer.length === 0) {
        notes.push(`No connected MCP tools for serverId=${serverId}.`)
      }
      for (const t of fromServer) {
        if (pinned.has(t.name)) already.push(t.name)
        else {
          pinned.add(t.name)
          newlyPinned.push(t.name)
        }
      }
    }

    const sticky = context.runStickyToolNames
    const newlyPinnedBuiltins: string[] = []

    for (const raw of requested) {
      const name = raw.trim()
      if (byFull.has(name)) {
        if (pinned.has(name)) already.push(name)
        else {
          pinned.add(name)
          newlyPinned.push(name)
        }
        continue
      }
      const bareMatches = byBare.get(name) ?? []
      if (bareMatches.length === 1) {
        const full = bareMatches[0]!
        if (pinned.has(full)) already.push(full)
        else {
          pinned.add(full)
          newlyPinned.push(full)
        }
        continue
      }
      if (bareMatches.length > 1) {
        unknown.push(`${name} (ambiguous: ${bareMatches.join(', ')})`)
        continue
      }
      const builtinName = optionalBuiltinCatalogName(name)
      if (builtinName) {
        if (!sticky) {
          unknown.push(`${builtinName} (no sticky catalog — requires an active run step)`)
          continue
        }
        if (sticky.has(builtinName)) already.push(builtinName)
        else {
          sticky.add(builtinName)
          newlyPinnedBuiltins.push(builtinName)
        }
        continue
      }
      unknown.push(name)
    }

    if (newlyPinned.length > 0) {
      const stamp = Math.max(context.currentStep ?? 1, 1)
      const lastUsed = context.mcpLastUsedByName
      if (lastUsed) {
        for (const name of newlyPinned) lastUsed.set(name, stamp)
      }
    }
    if (newlyPinned.length > 0 || newlyPinnedBuiltins.length > 0) {
      context.invalidateMcpToolCatalogCache?.()
    }

    const allNew = [...newlyPinned, ...newlyPinnedBuiltins]
    const lines = [
      allNew.length
        ? `Pinned for next step (${allNew.length}): ${allNew.join(', ')}`
        : 'No new tools pinned.',
      already.length ? `Already pinned: ${already.join(', ')}` : '',
      unknown.length ? `Unknown / unresolved: ${unknown.join(', ')}` : '',
      ...notes,
      'Connected MCP tools are already in the step catalog. Pins are optional bookkeeping; call release_mcp_tools when finished.'
    ].filter(Boolean)
    return toolOk(
      'request_mcp_tools',
      `${allNew.length} pinned`,
      lines.join('\n')
    )
  },
  release_mcp_tools: (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    const pinned = context.runPinnedMcpToolNames
    if (!pinned) {
      return toolFail(
        'release_mcp_tools',
        'release',
        'release_mcp_tools requires an active agent run.'
      )
    }
    const serverId =
      (typeof args.serverId === 'string' && args.serverId.trim()) ||
      (typeof args.server_id === 'string' && args.server_id.trim()) ||
      ''
    const requested = Array.isArray(args.tools)
      ? args.tools.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : []
    if (!serverId && requested.length === 0) {
      return toolFail(
        'release_mcp_tools',
        'release',
        'Provide tools: string[] and/or serverId to release pinned MCP tools.'
      )
    }

    const toRelease = new Set<string>()
    const unknown: string[] = []
    const notes: string[] = []

    if (serverId) {
      const needle = serverId.toLowerCase()
      let found = 0
      for (const name of pinned) {
        const parsed = parseMcpToolName(name)
        if (parsed?.serverId.toLowerCase() === needle) {
          toRelease.add(name)
          found++
        }
      }
      if (found === 0) {
        notes.push(`No pinned MCP tools for serverId=${serverId}.`)
      }
    }

    const sticky = context.runStickyToolNames
    const releasedBuiltins: string[] = []

    for (const raw of requested) {
      const name = raw.trim()
      if (pinned.has(name) || toRelease.has(name)) {
        toRelease.add(name)
        continue
      }
      const bareMatches = [...pinned].filter((full) => {
        const parsed = parseMcpToolName(full)
        return parsed?.toolName === name
      })
      if (bareMatches.length === 1) {
        toRelease.add(bareMatches[0]!)
        continue
      }
      if (bareMatches.length > 1) {
        unknown.push(`${name} (ambiguous: ${bareMatches.join(', ')})`)
        continue
      }
      const builtinName = optionalBuiltinCatalogName(name)
      if (builtinName) {
        if (sticky?.has(builtinName)) {
          sticky.delete(builtinName)
          releasedBuiltins.push(builtinName)
        } else {
          unknown.push(`${builtinName} (not in sticky catalog)`)
        }
        continue
      }
      unknown.push(name)
    }

    const released: string[] = []
    for (const name of toRelease) {
      if (!pinned.has(name)) continue
      pinned.delete(name)
      context.mcpLastUsedByName?.delete(name)
      released.push(name)
    }

    const allReleased = [...released, ...releasedBuiltins]
    if (allReleased.length > 0) context.invalidateMcpToolCatalogCache?.()

    const lines = [
      allReleased.length
        ? `Released (${allReleased.length}): ${allReleased.join(', ')}`
        : 'No pinned tools released.',
      unknown.length ? `Unknown / unresolved: ${unknown.join(', ')}` : '',
      ...notes,
      'Pins are optional bookkeeping. Re-pin with request_mcp_tools if needed.'
    ].filter(Boolean)
    return toolOk(
      'release_mcp_tools',
      `${allReleased.length} released`,
      lines.join('\n')
    )
  },
  mcp_list_resources: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const serverId = optionalMcpServerId(args)
    if (serverId) {
      const gate = mcpServerGate('mcp_list_resources', serverId, serverId, context, workspace)
      if (!gate.ok) return gate.result
    }
    const entries = await listMcpResources(
      serverId,
      context.runEnabledMcpIds,
      signal,
      workspace
    )
    if (entries.length === 0) {
      const none = serverId
        ? `No MCP resources for server ${serverId}`
        : 'No MCP resources connected.'
      return toolOk('mcp_list_resources', serverId || 'none', none)
    }
    return toolOk(
      'mcp_list_resources',
      `${entries.length} resources`,
      formatMcpResourceLines(entries)
    )
  },
  mcp_read_resource: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const serverId = typeof args.serverId === 'string' ? args.serverId.trim() : ''
    const uri = typeof args.uri === 'string' ? args.uri.trim() : ''
    if (!serverId) return toolFail('mcp_read_resource', uri || 'resource', 'serverId is required')
    if (!uri) return toolFail('mcp_read_resource', serverId, 'uri is required')
    const gate = mcpServerGate('mcp_read_resource', serverId, uri, context, workspace)
    if (!gate.ok) return gate.result
    const result = await readMcpResource(
      serverId,
      uri,
      signal,
      context.runEnabledMcpIds,
      workspace
    )
    if (!result.ok) return toolFail('mcp_read_resource', uri, result.error)
    return toolOk('mcp_read_resource', uri, result.content)
  },
  mcp_list_prompts: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const serverId = optionalMcpServerId(args)
    if (serverId) {
      const gate = mcpServerGate('mcp_list_prompts', serverId, serverId, context, workspace)
      if (!gate.ok) return gate.result
    }
    const entries = await listMcpPrompts(
      serverId,
      context.runEnabledMcpIds,
      signal,
      workspace
    )
    if (entries.length === 0) {
      const none = serverId
        ? `No MCP prompts for server ${serverId}`
        : 'No MCP prompts connected.'
      return toolOk('mcp_list_prompts', serverId || 'none', none)
    }
    return toolOk('mcp_list_prompts', `${entries.length} prompts`, formatMcpPromptLines(entries))
  },
  mcp_get_prompt: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const serverId = typeof args.serverId === 'string' ? args.serverId.trim() : ''
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!serverId) return toolFail('mcp_get_prompt', name || 'prompt', 'serverId is required')
    if (!name) return toolFail('mcp_get_prompt', serverId, 'name is required')
    const gate = mcpServerGate('mcp_get_prompt', serverId, name, context, workspace)
    if (!gate.ok) return gate.result
    const promptArgs =
      args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
        ? Object.fromEntries(
            Object.entries(args.arguments).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          )
        : undefined
    const result = await getMcpPrompt(
      serverId,
      name,
      promptArgs,
      signal,
      context.runEnabledMcpIds,
      workspace
    )
    if (!result.ok) return toolFail('mcp_get_prompt', name, result.error)
    return toolOk('mcp_get_prompt', name, result.content)
  }
} satisfies Partial<Record<AgentToolName, ToolHandler>>
