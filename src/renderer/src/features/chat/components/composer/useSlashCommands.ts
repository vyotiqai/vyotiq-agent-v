import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SlashCommandDescriptor } from '@shared/ipc'
import { fuzzyMatchCommands, findActiveSlashToken } from '@shared/slashCommands'
import { findSlashChipSubmit } from './mentionModel'
import {
  SLASH_GROUP_ORDER,
  clusterMcpByServer,
  isComposerModeSlashCommand,
  partitionSlashGroupByAvailability
} from './slashCommandPresentation'

/** Fuzzy-filter then flatten in SLASH_GROUP_ORDER so highlight index matches accept. */
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
  const out: SlashCommandDescriptor[] = []
  for (const g of SLASH_GROUP_ORDER) {
    const items = byGroup.get(g)
    if (items?.length) {
      const partitioned = partitionSlashGroupByAvailability(items)
      out.push(...(g === 'MCP' ? clusterMcpByServer(partitioned) : partitioned))
    }
    byGroup.delete(g)
  }
  for (const [g, items] of byGroup) {
    const partitioned = partitionSlashGroupByAvailability(items)
    out.push(...(g === 'MCP' ? clusterMcpByServer(partitioned) : partitioned))
  }
  return out
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
        setListError(null)
        return res.data.commands
      }
      setCommands([])
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
