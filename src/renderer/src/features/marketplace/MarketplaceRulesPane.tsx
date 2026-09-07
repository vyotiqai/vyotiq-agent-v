import { useCallback, useEffect, useRef, useState } from 'react'
import type { Settings, UserRule } from '@shared/ipc'
import {
  MAX_USER_RULES,
  USER_RULE_BODY_MAX,
  USER_RULE_NAME_MAX
} from '@shared/ipc'
import { ActionMenu, Button, IconButton, Input, Switch } from '@renderer/lib/ui'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Icon } from '@renderer/lib/icons'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { usePrompt } from '@renderer/lib/hooks/usePrompt'
import { MarketplaceMarkdownBody } from './MarketplaceMarkdownBody'
import { parseRuleEditor, serializeRuleEditor } from './ruleEditorMarkdown'
import type { MarketplaceController } from './useMarketplaceController'

type ListedRule = {
  path: string
  description?: string
  alwaysApply: boolean
}

type Selection =
  | { kind: 'user'; id: string }
  | { kind: 'project'; path: string }

function workspaceLabel(path: string | null | undefined): string {
  if (!path) return 'Workspace'
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || 'Workspace'
}

function isRootRulePath(path: string): boolean {
  const n = path.replace(/\\/g, '/').toLowerCase()
  const base = n.split('/').pop() ?? n
  return base === 'agents.md' || base === 'claude.md' || base === '.cursorrules'
}

export function MarketplaceRulesPane({
  controller,
  settings,
  onUpdate,
  activeWorkspacePath,
  focusRulePath,
  onFocusRuleConsumed
}: {
  controller: MarketplaceController
  settings: Settings
  onUpdate: (partial: Partial<Settings>) => Promise<{ ok: true } | { ok: false; error: string }>
  activeWorkspacePath?: string | null
  focusRulePath?: string | null
  onFocusRuleConsumed?: () => void
}) {
  const { formLocked, setFeedback } = controller
  const { confirm, dialog: confirmDialog } = useConfirm()
  const { prompt, dialog: promptDialog } = usePrompt()
  const [projectRules, setProjectRules] = useState<ListedRule[]>([])
  const [selection, setSelection] = useState<Selection | null>(null)
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const [newUserOpen, setNewUserOpen] = useState(false)
  const [newUserName, setNewUserName] = useState('')
  const newUserInputRef = useRef<HTMLInputElement>(null)
  const userRules = settings.userRules ?? []

  const reportEditorError = useCallback((text: string): void => {
    setFeedback({ kind: 'error', text })
  }, [setFeedback])

  const loadProjectRules = useCallback(async (): Promise<void> => {
    if (!activeWorkspacePath) {
      setProjectRules([])
      return
    }
    const res = await window.vyotiq.workspaceListRules({ workspacePath: activeWorkspacePath })
    if (!res.ok) {
      setFeedback({ kind: 'error', text: res.error })
      return
    }
    setProjectRules(res.data.rules)
  }, [activeWorkspacePath, setFeedback])

  useEffect(() => {
    void loadProjectRules()
  }, [loadProjectRules])

  useEffect(() => {
    const unsub = window.vyotiq.onSkillsChanged?.(() => {
      void loadProjectRules()
    })
    return () => {
      unsub?.()
    }
  }, [loadProjectRules])

  useEffect(() => {
    if (!focusRulePath) return
    const match = projectRules.find(
      (r) => r.path.replace(/\\/g, '/') === focusRulePath.replace(/\\/g, '/')
    )
    if (match) setSelection({ kind: 'project', path: match.path })
    else setSelection({ kind: 'project', path: focusRulePath.replace(/\\/g, '/') })
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-rule-path="${CSS.escape(focusRulePath.replace(/\\/g, '/'))}"]`
      )
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      el?.focus?.()
    }, 50)
    onFocusRuleConsumed?.()
    return () => window.clearTimeout(t)
  }, [focusRulePath, projectRules, onFocusRuleConsumed])

  const createProjectRule = async (): Promise<void> => {
    if (!activeWorkspacePath) {
      setFeedback({ kind: 'error', text: 'Open a workspace to create a project rule.' })
      return
    }
    const title = await prompt('New project rule name', '')
    if (title == null) return
    const trimmed = title.trim()
    if (!trimmed) {
      setFeedback({ kind: 'error', text: 'Rule name cannot be empty.' })
      return
    }
    const res = await window.vyotiq.slashCommandsCreateRule({
      workspacePath: activeWorkspacePath,
      title: trimmed
    })
    if (!res.ok) {
      setFeedback({ kind: 'error', text: res.error })
      return
    }
    setFeedback({ kind: 'success', text: `Created ${res.data.relativePath}` })
    setSelection({ kind: 'project', path: res.data.relativePath.replace(/\\/g, '/') })
    await loadProjectRules()
  }

  const persistUserRules = async (next: UserRule[]): Promise<boolean> => {
    const res = await onUpdate({ userRules: next })
    if (!res.ok) {
      setFeedback({ kind: 'error', text: res.error })
      return false
    }
    return true
  }

  const confirmNewUser = async (): Promise<void> => {
    const name = newUserName.trim()
    if (!name) {
      setFeedback({ kind: 'error', text: 'User rule name cannot be empty.' })
      return
    }
    if (userRules.length >= MAX_USER_RULES) {
      setFeedback({ kind: 'error', text: `You can have at most ${MAX_USER_RULES} user rules.` })
      return
    }
    const rule: UserRule = {
      id: crypto.randomUUID(),
      name: name.slice(0, USER_RULE_NAME_MAX),
      body: '',
      enabled: true
    }
    const ok = await persistUserRules([...userRules, rule])
    if (!ok) return
    setNewUserOpen(false)
    setNewUserName('')
    setSelection({ kind: 'user', id: rule.id })
  }

  const selectedUser =
    selection?.kind === 'user' ? userRules.find((r) => r.id === selection.id) ?? null : null
  const selectedProject =
    selection?.kind === 'project'
      ? projectRules.find((r) => r.path === selection.path) ?? {
          path: selection.path,
          alwaysApply: true
        }
      : null

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
      {promptDialog}
      {confirmDialog}
      <Dialog
        open={newUserOpen}
        onClose={() => setNewUserOpen(false)}
        title="New User Rule"
        description="User Rules apply to all of your chats."
        initialFocusRef={newUserInputRef}
        useNativeDialog={false}
        className="w-[min(92vw,28rem)] rounded-xl border border-border bg-surface p-4 text-fg shadow-xl"
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void confirmNewUser()
          }}
        >
          <h2 className="m-0 text-sm font-medium text-fg">New User Rule</h2>
          <p className="m-0 text-xs text-secondary">User Rules apply to all of your chats.</p>
          <label className="flex flex-col gap-1 text-xs text-secondary">
            Name
            <Input
              ref={newUserInputRef}
              value={newUserName}
              maxLength={USER_RULE_NAME_MAX}
              aria-label="User rule name"
              onChange={(e) => setNewUserName(e.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="subtle" onClick={() => setNewUserOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Confirm</Button>
          </div>
        </form>
      </Dialog>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="m-0 text-caption font-medium text-secondary">User</p>
            <Button
              variant="subtle"
              disabled={formLocked || userRules.length >= MAX_USER_RULES}
              aria-label="New user rule"
              title={
                userRules.length >= MAX_USER_RULES
                  ? `You can have at most ${MAX_USER_RULES} user rules.`
                  : 'New user rule'
              }
              onClick={() => {
                if (userRules.length >= MAX_USER_RULES) {
                  setFeedback({
                    kind: 'error',
                    text: `You can have at most ${MAX_USER_RULES} user rules.`
                  })
                  return
                }
                setNewUserName('')
                setNewUserOpen(true)
              }}
            >
              <Icon name="plus" size={14} />
              New
            </Button>
          </div>
          {userRules.length === 0 ? (
            <p className="m-0 text-xs text-muted">No user rules yet.</p>
          ) : (
            userRules.map((rule) => (
              <div
                key={rule.id}
                data-rule-path={`user:${rule.id}`}
                className={`flex items-start gap-1 rounded-md border px-2 py-1.5 ${
                  selection?.kind === 'user' && selection.id === rule.id
                    ? 'border-border-strong bg-surface-2'
                    : 'border-border bg-surface'
                }`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setSelection({ kind: 'user', id: rule.id })}
                >
                  <p className="m-0 text-xs font-medium text-fg">{rule.name}</p>
                  <p className="m-0 mt-0.5 text-caption text-secondary">
                    {rule.enabled ? 'Enabled' : 'Disabled'}
                  </p>
                </button>
                <Switch
                  checked={rule.enabled}
                  disabled={formLocked}
                  label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`}
                  onCheckedChange={(enabled) => {
                    void persistUserRules(
                      userRules.map((r) => (r.id === rule.id ? { ...r, enabled } : r))
                    )
                  }}
                />
                <ActionMenu
                  aria-label={`${rule.name} actions`}
                  open={menuKey === `user:${rule.id}`}
                  onOpenChange={(open) => setMenuKey(open ? `user:${rule.id}` : null)}
                  placement="down"
                  align="end"
                  items={[
                    {
                      id: 'delete',
                      label: 'Delete',
                      icon: 'trash',
                      onSelect: () => {
                        void (async () => {
                          const ok = await confirm(
                            `Delete user rule “${rule.name}”? This cannot be undone.`,
                            { title: 'Delete user rule', confirmLabel: 'Delete', danger: true }
                          )
                          if (!ok) return
                          const next = userRules.filter((r) => r.id !== rule.id)
                          const saved = await persistUserRules(next)
                          if (saved && selection?.kind === 'user' && selection.id === rule.id) {
                            setSelection(null)
                          }
                        })()
                      }
                    }
                  ]}
                  trigger={(props) => (
                    <IconButton
                      ref={props.ref}
                      icon="menu"
                      label={`${rule.name} actions`}
                      size="xs"
                      variant="ghost"
                      disabled={formLocked}
                      aria-expanded={props['aria-expanded']}
                      aria-controls={props['aria-controls']}
                      aria-haspopup={props['aria-haspopup']}
                      onClick={props.onClick}
                    />
                  )}
                />
              </div>
            ))
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="m-0 text-caption font-medium text-secondary">
              {workspaceLabel(activeWorkspacePath)}
            </p>
            <Button
              variant="subtle"
              disabled={formLocked || !activeWorkspacePath}
              aria-label="New project rule"
              title={
                activeWorkspacePath
                  ? 'New project rule'
                  : 'Open a workspace to create a project rule.'
              }
              onClick={() => void createProjectRule()}
            >
              <Icon name="plus" size={14} />
              New
            </Button>
          </div>
          {!activeWorkspacePath ? (
            <p className="m-0 text-xs text-muted">Open a workspace to create a project rule.</p>
          ) : projectRules.length === 0 ? (
            <p className="m-0 text-xs text-muted">No project rules yet.</p>
          ) : (
            projectRules.map((rule) => (
              <div
                key={rule.path}
                data-rule-path={rule.path}
                tabIndex={-1}
                className={`flex items-start gap-1 rounded-md border px-2 py-1.5 ${
                  selection?.kind === 'project' && selection.path === rule.path
                    ? 'border-border-strong bg-surface-2'
                    : 'border-border bg-surface'
                }`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setSelection({ kind: 'project', path: rule.path })}
                >
                  <p className="m-0 text-xs font-medium text-fg">{rule.path}</p>
                  <p className="m-0 mt-0.5 text-caption text-secondary">
                    {rule.description || (rule.alwaysApply ? 'Always apply' : 'On request')}
                  </p>
                </button>
                <ActionMenu
                  aria-label={`${rule.path} actions`}
                  open={menuKey === `project:${rule.path}`}
                  onOpenChange={(open) => setMenuKey(open ? `project:${rule.path}` : null)}
                  placement="down"
                  align="end"
                  items={[
                    ...(activeWorkspacePath
                      ? [
                          {
                            id: 'open-external',
                            label: 'Open externally',
                            icon: 'folderOpen' as const,
                            onSelect: () => {
                              void window.vyotiq.slashCommandsOpenFile({
                                workspacePath: activeWorkspacePath,
                                path: rule.path
                              })
                            }
                          }
                        ]
                      : []),
                    ...(!isRootRulePath(rule.path) && activeWorkspacePath
                      ? [
                          {
                            id: 'delete',
                            label: 'Delete',
                            icon: 'trash' as const,
                            onSelect: () => {
                              void (async () => {
                                const ok = await confirm(
                                  `Delete project rule “${rule.path}”? This cannot be undone.`,
                                  {
                                    title: 'Delete project rule',
                                    confirmLabel: 'Delete',
                                    danger: true
                                  }
                                )
                                if (!ok || !activeWorkspacePath) return
                                const res = await window.vyotiq.workspaceFileDelete({
                                  workspacePath: activeWorkspacePath,
                                  path: rule.path,
                                  recursive: false
                                })
                                if (!res.ok) {
                                  setFeedback({ kind: 'error', text: res.error })
                                  return
                                }
                                if (selection?.kind === 'project' && selection.path === rule.path) {
                                  setSelection(null)
                                }
                                await loadProjectRules()
                              })()
                            }
                          }
                        ]
                      : [])
                  ]}
                  trigger={(props) => (
                    <IconButton
                      ref={props.ref}
                      icon="menu"
                      label={`${rule.path} actions`}
                      size="xs"
                      variant="ghost"
                      disabled={formLocked}
                      aria-expanded={props['aria-expanded']}
                      aria-controls={props['aria-controls']}
                      aria-haspopup={props['aria-haspopup']}
                      onClick={props.onClick}
                    />
                  )}
                />
              </div>
            ))
          )}
        </div>
      </div>

      {selectedUser ? (
        <UserRuleEditor
          key={selectedUser.id}
          rule={selectedUser}
          disabled={formLocked}
          onSave={async (next) => {
            const ok = await persistUserRules(
              userRules.map((r) => (r.id === next.id ? next : r))
            )
            if (ok) setFeedback({ kind: 'success', text: `Saved ${next.name}` })
          }}
        />
      ) : selectedProject && activeWorkspacePath ? (
        <ProjectRuleEditor
          key={selectedProject.path}
          path={selectedProject.path}
          workspacePath={activeWorkspacePath}
          disabled={formLocked}
          onError={reportEditorError}
          onSaved={() => {
            setFeedback({ kind: 'success', text: `Saved ${selectedProject.path}` })
            void loadProjectRules()
          }}
        />
      ) : (
        <p className="m-0 text-xs text-muted">Select a rule to edit, or create one with New.</p>
      )}
    </div>
  )
}

function UserRuleEditor({
  rule,
  disabled,
  onSave
}: {
  rule: UserRule
  disabled: boolean
  onSave: (next: UserRule) => Promise<void>
}) {
  const [name, setName] = useState(rule.name)
  const [body, setBody] = useState(rule.body)
  const [saving, setSaving] = useState(false)

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-secondary">
        Name
        <Input
          value={name}
          maxLength={USER_RULE_NAME_MAX}
          disabled={disabled || saving}
          aria-label="User rule name"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <MarketplaceMarkdownBody
        path={`${rule.name}.md`}
        value={body}
        disabled={disabled || saving}
        onChange={(next) => setBody(next.slice(0, USER_RULE_BODY_MAX))}
      />
      <p className="m-0 text-caption text-muted">
        {body.length}/{USER_RULE_BODY_MAX}
      </p>
      <div className="flex justify-end">
        <Button
          disabled={disabled || saving || !name.trim()}
          onClick={() => {
            void (async () => {
              setSaving(true)
              try {
                await onSave({
                  ...rule,
                  name: name.trim().slice(0, USER_RULE_NAME_MAX),
                  body: body.slice(0, USER_RULE_BODY_MAX)
                })
              } finally {
                setSaving(false)
              }
            })()
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

function ProjectRuleEditor({
  path,
  workspacePath,
  disabled,
  onError,
  onSaved
}: {
  path: string
  workspacePath: string
  disabled: boolean
  onError: (text: string) => void
  onSaved: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [alwaysApply, setAlwaysApply] = useState(true)
  const [hadAlwaysApplyKey, setHadAlwaysApplyKey] = useState(false)
  const [frontmatterLines, setFrontmatterLines] = useState<string[] | null>(null)
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [encoding, setEncoding] = useState<'utf8' | 'utf16le' | 'utf16be' | 'binary'>('utf8')
  const [eol, setEol] = useState<'lf' | 'crlf' | 'cr' | 'mixed' | 'none'>('lf')
  const [bom, setBom] = useState(false)
  const [expectedVersion, setExpectedVersion] = useState<{
    size: number
    mtimeMs: number
    sha256: string
  } | null>(null)
  const rootFile = isRootRulePath(path)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setLoadError(null)
      const res = await window.vyotiq.workspaceFileRead({ workspacePath, path })
      if (cancelled) return
      if (!res.ok) {
        onError(res.error)
        setLoadError(res.error)
        setLoading(false)
        return
      }
      if (res.data.kind !== 'text') {
        const text = 'This rule file is not text and cannot be edited here.'
        onError(text)
        setLoadError(text)
        setLoading(false)
        return
      }
      if (rootFile) {
        setAlwaysApply(true)
        setHadAlwaysApplyKey(false)
        setFrontmatterLines(null)
        setDescription('')
        setBody(res.data.content)
      } else {
        const parsed = parseRuleEditor(res.data.content)
        setAlwaysApply(parsed.alwaysApply)
        setHadAlwaysApplyKey(parsed.hadAlwaysApplyKey)
        setFrontmatterLines(parsed.frontmatterLines)
        setDescription(parsed.description)
        setBody(parsed.body)
      }
      setEncoding(res.data.encoding)
      setEol(res.data.eol)
      setBom(res.data.bom)
      setExpectedVersion(res.data.version)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [path, workspacePath, rootFile, onError])

  if (loading)
    return <p className="m-0 text-xs text-muted" role="status">Loading rule…</p>
  if (loadError) {
    return (
      <p className="m-0 text-xs text-danger" role="alert">{loadError}</p>
    )
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {rootFile ? (
        <p className="m-0 text-xs text-secondary">
          Root instruction files are always applied. Edit the markdown body below.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-caption font-medium text-secondary">Properties</p>
          <div className="flex items-center gap-2">
            <Switch
              checked={alwaysApply}
              disabled={disabled || saving}
              label="Always apply"
              onCheckedChange={setAlwaysApply}
            />
            <span className="text-xs text-secondary">Always apply</span>
          </div>
          <label className="flex flex-col gap-1 text-xs text-secondary">
            description
            <Input
              value={description}
              disabled={disabled || saving}
              aria-label="Rule description"
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </div>
      )}
      <MarketplaceMarkdownBody
        path={path}
        value={body}
        disabled={disabled || saving}
        onChange={setBody}
      />
      <div className="flex justify-end">
        <Button
          disabled={disabled || saving}
          onClick={() => {
            void (async () => {
              setSaving(true)
              try {
                const content = rootFile
                  ? body
                  : serializeRuleEditor({
                      alwaysApply,
                      hadAlwaysApplyKey,
                      description,
                      body,
                      frontmatterLines
                    })
                const res = await window.vyotiq.workspaceFileSave({
                  workspacePath,
                  path,
                  kind: 'text',
                  content,
                  encoding: encoding === 'binary' ? 'utf8' : encoding,
                  eol,
                  bom,
                  expectedVersion,
                  replaceExisting: false
                })
                if (!res.ok) {
                  onError(res.error)
                  return
                }
                setExpectedVersion(res.data.version)
                onSaved()
              } finally {
                setSaving(false)
              }
            })()
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
