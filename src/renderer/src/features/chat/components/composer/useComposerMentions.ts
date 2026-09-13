import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RunSummary } from '@shared/ipc'
import {
  buildChatMentionItems,
  buildDocsMentionItems,
  buildFileMentionItems,
  buildRootMentionItems,
  buildRuleMentionItems,
  findActiveMentionToken,
  insertMentionAtToken,
  isSafeWorkspaceRelPath,
  type ComposerMention,
  type MentionMenuItem,
  type MentionMenuView
} from './mentionModel'

export { findActiveMentionToken }
export type ActiveMentionToken = NonNullable<ReturnType<typeof findActiveMentionToken>>

const FILES_PAGE = 12

type RuleRow = { path: string; description?: string; alwaysApply: boolean }

export function useComposerMentions({
  workspacePath,
  text,
  cursor,
  enabled
}: {
  workspacePath?: string | null
  text: string
  cursor: number
  enabled: boolean
}) {
  const [view, setView] = useState<MentionMenuView>('root')
  const [paths, setPaths] = useState<string[]>([])
  const [pathsTotal, setPathsTotal] = useState(0)
  const [filesLimit, setFilesLimit] = useState(FILES_PAGE)
  const [docPaths, setDocPaths] = useState<string[]>([])
  const [rules, setRules] = useState<RuleRow[]>([])
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [recentFiles, setRecentFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [chatsLoading, setChatsLoading] = useState(false)
  const [docsLoading, setDocsLoading] = useState(false)
  const [rulesLoading, setRulesLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [branchName, setBranchName] = useState<string | null>(null)
  const reqIdRef = useRef(0)
  const activeIdRef = useRef<string | null>(null)

  const token = useMemo(() => {
    if (!enabled) return null
    return findActiveMentionToken(text, cursor)
  }, [enabled, text, cursor])

  // File/folder suggestions are bound to the selected workspace only.
  useEffect(() => {
    setRecentFiles([])
    setPaths([])
    setPathsTotal(0)
    setDocPaths([])
    setRules([])
    setRuns([])
    setBranchName(null)
    setView('root')
    setFilesLimit(FILES_PAGE)
    setActiveIndex(0)
    setDismissed(false)
  }, [workspacePath])

  // New @-token only — do not reset view when the query edits (allows Files/Chats filter).
  useEffect(() => {
    setDismissed(false)
    setView('root')
    setFilesLimit(FILES_PAGE)
  }, [token?.start])

  // File search (root matching + files view) — selected workspace only
  useEffect(() => {
    if (!token || !workspacePath || !window.vyotiq?.workspaceSuggestPaths) {
      setPaths([])
      setPathsTotal(0)
      setLoading(false)
      return
    }
    if (view !== 'root' && view !== 'files') return
    const reqId = ++reqIdRef.current
    setLoading(true)
    const maxResults = view === 'files' ? filesLimit : 8
    const handle = window.setTimeout(() => {
      void window.vyotiq
        .workspaceSuggestPaths({
          workspacePath,
          query: token.query,
          maxResults
        })
        .then((res) => {
          if (reqId !== reqIdRef.current) return
          if (res.ok) {
            setPaths(res.data.paths)
            setPathsTotal(res.data.total)
          } else {
            setPaths([])
            setPathsTotal(0)
          }
        })
        .catch(() => {
          if (reqId === reqIdRef.current) {
            setPaths([])
            setPathsTotal(0)
          }
        })
        .finally(() => {
          if (reqId === reqIdRef.current) setLoading(false)
        })
    }, 80)
    return () => {
      window.clearTimeout(handle)
    }
  }, [token?.query, token?.start, workspacePath, view, filesLimit])

  // Docs subview
  useEffect(() => {
    if (!token || view !== 'docs' || !workspacePath || !window.vyotiq?.workspaceListDocs) {
      if (view !== 'docs') setDocsLoading(false)
      return
    }
    let cancelled = false
    setDocsLoading(true)
    void window.vyotiq
      .workspaceListDocs({ workspacePath, query: token.query })
      .then((res) => {
        if (cancelled) return
        if (res.ok) setDocPaths(res.data.paths)
        else setDocPaths([])
      })
      .catch(() => {
        if (!cancelled) setDocPaths([])
      })
      .finally(() => {
        if (!cancelled) setDocsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token, view, workspacePath])

  // Rules subview
  useEffect(() => {
    if (!token || view !== 'rules' || !workspacePath || !window.vyotiq?.workspaceListRules) {
      if (view !== 'rules') setRulesLoading(false)
      return
    }
    let cancelled = false
    setRulesLoading(true)
    void window.vyotiq
      .workspaceListRules({ workspacePath })
      .then((res) => {
        if (cancelled) return
        if (res.ok) setRules(res.data.rules)
        else setRules([])
      })
      .catch(() => {
        if (!cancelled) setRules([])
      })
      .finally(() => {
        if (!cancelled) setRulesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token, view, workspacePath])

  // Past chats when entering chats view
  useEffect(() => {
    if (!token || view !== 'chats' || !workspacePath || !window.vyotiq?.listRuns) {
      setChatsLoading(false)
      return
    }
    let cancelled = false
    setChatsLoading(true)
    void window.vyotiq
      .listRuns(workspacePath)
      .then((res) => {
        if (cancelled) return
        if (res.ok) setRuns(res.data.runs)
        else setRuns([])
      })
      .catch(() => {
        if (!cancelled) setRuns([])
      })
      .finally(() => {
        if (!cancelled) setChatsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token, view, workspacePath])

  // Branch name for chip label
  useEffect(() => {
    if (!token || !workspacePath || !window.vyotiq?.gitStatus) return
    let cancelled = false
    void window.vyotiq.gitStatus(workspacePath).then((res) => {
      if (cancelled) return
      if (res.ok && res.data.kind === 'ok') setBranchName(res.data.status.branch)
      else setBranchName(null)
    })
    return () => {
      cancelled = true
    }
  }, [token?.start, workspacePath])

  const hasWorkspace = Boolean(workspacePath)

  const items: MentionMenuItem[] = useMemo(() => {
    if (!token) return []
    if (view === 'files') {
      if (!hasWorkspace) return []
      return buildFileMentionItems(paths, pathsTotal, paths.length)
    }
    if (view === 'docs') {
      if (!hasWorkspace) return []
      const q = token.query.trim().toLowerCase()
      const filtered = q
        ? docPaths.filter(
            (p) =>
              p.toLowerCase().includes(q) ||
              p.split('/').pop()?.toLowerCase().includes(q)
          )
        : docPaths
      return buildDocsMentionItems(filtered.slice(0, 40))
    }
    if (view === 'rules') {
      if (!hasWorkspace) return []
      const q = token.query.trim().toLowerCase()
      const filtered = q
        ? rules.filter(
            (r) =>
              r.path.toLowerCase().includes(q) ||
              (r.description ?? '').toLowerCase().includes(q)
          )
        : rules
      return buildRuleMentionItems(filtered.slice(0, 40))
    }
    if (view === 'chats') {
      const q = token.query.trim().toLowerCase()
      const filtered = q
        ? runs.filter(
            (r) =>
              r.runId.toLowerCase().includes(q) ||
              (r.goal ?? '').toLowerCase().includes(q)
          )
        : runs
      return buildChatMentionItems(filtered.slice(0, 24))
    }
    return buildRootMentionItems({
      query: token.query,
      recentFiles: hasWorkspace ? recentFiles : [],
      matchingFiles: hasWorkspace ? paths : [],
      includeCodebase: hasWorkspace,
      branchName
    })
  }, [
    token,
    view,
    paths,
    pathsTotal,
    docPaths,
    rules,
    runs,
    recentFiles,
    hasWorkspace,
    branchName
  ])

  useEffect(() => {
    const id = activeIdRef.current
    const idx = id ? items.findIndex((item) => item.id === id) : -1
    setActiveIndex(idx >= 0 ? idx : 0)
  }, [items])

  const menuLoading =
    loading ||
    (view === 'chats' && chatsLoading) ||
    (view === 'docs' && docsLoading) ||
    (view === 'rules' && rulesLoading)
  const open = Boolean(token && !dismissed)

  const activeItem = items[activeIndex] ?? null
  useEffect(() => {
    activeIdRef.current = activeItem?.id ?? null
  }, [activeItem])

  const rememberFile = useCallback((path: string) => {
    const norm = path.replace(/\\/g, '/')
    setRecentFiles((prev) => [norm, ...prev.filter((p) => p !== norm)].slice(0, 8))
  }, [])

  const acceptItem = useCallback(
    (
      item: MentionMenuItem
    ):
      | { action: 'insert'; nextText: string; nextCursor: number; mention: ComposerMention }
      | { action: 'navigate'; view: MentionMenuView }
      | { action: 'show-more' }
      | null => {
      if (!token) return null
      if (item.kind === 'nav') {
        if (
          (item.view === 'files' ||
            item.view === 'docs' ||
            item.view === 'rules' ||
            item.view === 'chats') &&
          !workspacePath
        ) {
          return null
        }
        return { action: 'navigate', view: item.view }
      }
      if (item.kind === 'show-more') {
        return { action: 'show-more' }
      }
      let mention: ComposerMention
      switch (item.kind) {
        case 'branch':
          mention = { kind: 'branch', branch: branchName }
          break
        case 'browser':
          mention = { kind: 'browser' }
          break
        case 'lints':
          if (!workspacePath) return null
          mention = { kind: 'lints', diagnosticsKind: item.diagnosticsKind }
          break
        case 'file': {
          if (!workspacePath || !isSafeWorkspaceRelPath(item.path)) return null
          mention = { kind: 'file', path: item.path.replace(/\\/g, '/') }
          rememberFile(mention.path)
          break
        }
        case 'docs': {
          if (!workspacePath || !isSafeWorkspaceRelPath(item.path)) return null
          mention = { kind: 'docs', path: item.path.replace(/\\/g, '/') }
          break
        }
        case 'rule': {
          if (!workspacePath || !isSafeWorkspaceRelPath(item.path)) return null
          mention = { kind: 'rule', path: item.path.replace(/\\/g, '/') }
          break
        }
        case 'chat':
          mention = { kind: 'chat', runId: item.runId, title: item.label }
          break
        default: {
          const _exhaustive: never = item
          return _exhaustive
        }
      }
      const { nextText, nextCursor } = insertMentionAtToken(
        text,
        token.start,
        token.end,
        mention
      )
      return { action: 'insert', nextText, nextCursor, mention }
    },
    [token, text, branchName, rememberFile, workspacePath]
  )

  const goBack = useCallback((): boolean => {
    if (view === 'root') return false
    setView('root')
    setFilesLimit(FILES_PAGE)
    return true
  }, [view])

  return {
    open,
    view,
    setView,
    items,
    loading: menuLoading,
    activeIndex,
    setActiveIndex,
    activeItem,
    dismiss: () => setDismissed(true),
    acceptItem,
    goBack,
    showMore: () => setFilesLimit((n) => n + FILES_PAGE),
    token,
    pathsTotal,
    filesLimit,
    branchName
  }
}
