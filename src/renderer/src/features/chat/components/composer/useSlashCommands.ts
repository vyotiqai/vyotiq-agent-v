import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SlashCommandDescriptor, SlashMcpServer } from '@shared/ipc'
import { fuzzyMatchCommands, findActiveSlashToken } from '@shared/slashCommands'
import { findSlashChipSubmit } from './mentionModel'
import {
  SLASH_GROUP_ORDER,
  clusterMcpByServer,
  isComposerModeSlashCommand
} from './slashCommandPresentation'

/**
 * Fuzzy-filter then flatten in SLASH_GROUP_ORDER so highlight index matches
 * accept. Everything ready comes first, every group's; what still needs
 * installing, enabling or signing in follows in its own band. Typing `/` used
 * to list 15 catalog skills, each with Install, above `/compact` and `/goal`.
 */
export function buildSlashDisplayList(
  query: string,
  commands: SlashCommandDescriptor[]
): SlashCommandDescriptor[] {
  const catalog =
    query.trim().length === 0
      ? commands.filter((cmd) => !isComposerModeSlashCommand(cmd))
      : commands
  const matched = fuzzyMatchCommands(query, catalog)
  const byGroup = new Map<string, SlashCommandDescriptor[]>()
  for (const cmd of matched) {
    const list = byGroup.get(cmd.group) ?? []
    list.push(cmd)
    byGroup.set(cmd.group, list)
  }
  const groups = [...SLASH_GROUP_ORDER, ...[...byGroup.keys()].filter((g) => !(SLASH_GROUP_ORDER as readonly string[]).includes(g))]
  const band = (ready: boolean): SlashCommandDescriptor[] =>
    groups.flatMap((g) => {
      const items = (byGroup.get(g) ?? []).filter((cmd) => (cmd.availability === 'ready') === ready)
      return g === 'MCP' ? clusterMcpByServer(items) : items
    })
  return [...band(true), ...band(false)]
}

export function useSlashCommands({
  workspacePath,
  text,
  cursor,
  enabled,
  onListError
}: {
  workspacePath?: string | null
  text: string
  cursor: number
  enabled: boolean
  onListError?: (message: string) => void
}) {
  const [commands, setCommands] = useState<SlashCommandDescriptor[]>([])
  const [mcpServers, setMcpServers] = useState<SlashMcpServer[]>([])
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const reqIdRef = useRef(0)
  const onListErrorRef = useRef(onListError)
  onListErrorRef.current = onListError
  const hasLoadedRef = useRef(false)
  const commandsStaleRef = useRef(false)

  const reload = useCallback(async (): Promise<SlashCommandDescriptor[]> => {
    if (!window.vyotiq?.slashCommandsList) {
      setCommands([])
      setMcpServers([])
      return []
    }
    const reqId = ++reqIdRef.current
    setLoading(true)
    try {
      const res = await window.vyotiq.slashCommandsList({
        workspacePath: workspacePath ?? null
      })
      if (reqId !== reqIdRef.current) return []
      if (res.ok) {
        hasLoadedRef.current = true
        commandsStaleRef.current = false
        setCommands(res.data.commands)
        setMcpServers(res.data.mcpServers ?? [])
        setListError(null)
        return res.data.commands
      }
      setCommands([])
      setMcpServers([])
      setListError(res.error)
      onListErrorRef.current?.(res.error)
      return []
    } catch (err) {
      if (reqId === reqIdRef.current) {
        setCommands([])
        const message = err instanceof Error ? err.message : 'Failed to load slash commands'
        setListError(message)
        onListErrorRef.current?.(message)
      }
      return []
    } finally {
      if (reqId === reqIdRef.current) setLoading(false)
    }
  }, [workspacePath])

  useEffect(() => {
    setCommands([])
    setMcpServers([])
    if (hasLoadedRef.current) void reload()
  }, [workspacePath, reload])

  useEffect(() => {
    if (!window.vyotiq?.onSkillsChanged) return
    return window.vyotiq.onSkillsChanged(() => {
      commandsStaleRef.current = true
      void reload()
    })
  }, [reload])

  /** Prefer in-memory catalog unless a skills/slash invalidation landed. */
  const ensureCommands = useCallback(async (): Promise<SlashCommandDescriptor[]> => {
    if (commands.length > 0 && !commandsStaleRef.current) return commands
    commandsStaleRef.current = false
    return reload()
  }, [commands, reload])

  const token = useMemo(() => {
    if (!enabled) return null
    return findActiveSlashToken(text, cursor)
  }, [enabled, text, cursor])

  // Defer list IPC until the user types `/` — cold list was ~720ms on every Composer mount.
  // Also prefetch once when a slash chip is already in the draft (inline edit remount).
  useEffect(() => {
    if (!enabled) return
    if (token) {
      void reload()
      return
    }
    if (commands.length > 0) return
    if (findSlashChipSubmit(text)) void reload()
  }, [enabled, token?.start, text, commands.length, reload])

  useEffect(() => {
    setDismissed(false)
  }, [token?.start, token?.query])

  const filtered = useMemo(() => {
    if (!token) return []
    return buildSlashDisplayList(token.query, commands)
  }, [token, commands])

  const open = Boolean(enabled && token && !dismissed)

  useEffect(() => {
    setActiveIndex(0)
  }, [token?.query, open])

  useEffect(() => {
    if (!open) return
    setActiveIndex((i) => {
      if (filtered.length === 0) return 0
      return Math.min(i, filtered.length - 1)
    })
  }, [filtered.length, open])

  const moveActive = useCallback(
    (delta: number) => {
      if (filtered.length === 0) return
      setActiveIndex((i) => Math.max(0, Math.min(filtered.length - 1, i + delta)))
    },
    [filtered.length]
  )

  const dismiss = useCallback(() => setDismissed(true), [])

  const activeCommand = open && filtered.length > 0 ? filtered[activeIndex] ?? null : null

  return {
    commands,
    mcpServers,
    filtered,
    open,
    activeIndex,
    setActiveIndex,
    moveActive,
    dismiss,
    activeCommand,
    token,
    loading,
    listError,
    reload,
    ensureCommands
  }
}
