import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LocalSkillItem, SkillFrontmatter, SkillsReadLocalResult } from '@shared/ipc'
import { serializeSkillMarkdown } from '@shared/utils/skillMarkdown'
import { ActionMenu, Button, IconButton, Input } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { usePrompt } from '@renderer/lib/hooks/usePrompt'
import { MarketplaceMarkdownBody } from './MarketplaceMarkdownBody'
import type { MarketplaceController } from './useMarketplaceController'

const OPTIONAL_KEYS = ['license', 'compatibility', 'allowed-tools'] as const
type OptionalSkillKey = (typeof OPTIONAL_KEYS)[number]

function pathsEqual(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

export function MarketplaceSkillsPane({
  controller,
  activeWorkspacePath,
  focusSkillPath,
  onFocusSkillConsumed
}: {
  controller: MarketplaceController
  activeWorkspacePath?: string | null
  focusSkillPath?: string | null
  onFocusSkillConsumed?: () => void
}) {
  const { localSkills, formLocked, setFeedback } = controller
  const { prompt, dialog: promptDialog } = usePrompt()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [menuPath, setMenuPath] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const reportEditorError = useCallback((text: string): void => {
    setFeedback({ kind: 'error', text })
  }, [setFeedback])

  const userSkills = useMemo(
    () => localSkills.filter((s) => s.source === 'personal'),
    [localSkills]
  )
  const workspaceSkills = useMemo(
    () => localSkills.filter((s) => s.source === 'project'),
    [localSkills]
  )

  useEffect(() => {
    if (!focusSkillPath) return
    setSelectedPath(focusSkillPath)
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-skill-path="${CSS.escape(focusSkillPath)}"]`
      )
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      el?.focus?.()
    }, 50)
    onFocusSkillConsumed?.()
    return () => window.clearTimeout(t)
  }, [focusSkillPath, onFocusSkillConsumed])

  const selected =
    localSkills.find((s) => selectedPath != null && pathsEqual(s.skillPath, selectedPath)) ?? null

  const createSkill = async (scope: 'personal' | 'project'): Promise<void> => {
    if (scope === 'project' && !activeWorkspacePath) {
      setFeedback({ kind: 'error', text: 'Open a workspace to create a project skill.' })
      return
    }
    const title = await prompt(
      scope === 'personal' ? 'New user skill name' : 'New workspace skill name',
      ''
    )
    if (title == null) return
    const trimmed = title.trim()
    if (!trimmed) {
      setFeedback({ kind: 'error', text: 'Skill name cannot be empty.' })
      return
    }
    setCreating(true)
    try {
      const res = await window.vyotiq.slashCommandsCreateSkill({
        workspacePath: activeWorkspacePath ?? null,
        title: trimmed,
        scope
      })
      if (!res.ok) {
        setFeedback({ kind: 'error', text: res.error })
        return
      }
      setFeedback({ kind: 'success', text: `Created ${res.data.relativePath}` })
      setSelectedPath(res.data.path)
    } finally {
      setCreating(false)
    }
  }

  const deleteSkill = async (skill: LocalSkillItem): Promise<void> => {
    const ok = await confirm(`Delete skill “${skill.name}”? This cannot be undone.`, {
      title: 'Delete skill',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    const res = await window.vyotiq.skillsDeleteLocal({
      workspacePath: activeWorkspacePath ?? null,
      skillPath: skill.skillPath
    })
    if (!res.ok) {
      setFeedback({ kind: 'error', text: res.error })
      return
    }
    if (selectedPath && pathsEqual(selectedPath, skill.skillPath)) setSelectedPath(null)
    setFeedback({ kind: 'success', text: `Deleted ${skill.name}` })
  }

  const openExternally = async (skill: LocalSkillItem): Promise<void> => {
    const res = await window.vyotiq.skillsOpenLocal({
      workspacePath: activeWorkspacePath ?? null,
      skillPath: skill.skillPath
    })
    if (!res.ok) setFeedback({ kind: 'error', text: res.error })
  }

  const revealProject = async (skill: LocalSkillItem): Promise<void> => {
    if (!activeWorkspacePath || skill.source !== 'project') return
    const res = await window.vyotiq.workspaceFileReveal({
      workspacePath: activeWorkspacePath,
      path: skill.relativePath
    })
    if (!res.ok) setFeedback({ kind: 'error', text: res.error })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
      {promptDialog}
      {confirmDialog}
      <div className="flex flex-col gap-4">
        <SkillGroup
          title="User"
          skills={userSkills}
          selectedPath={selectedPath}
          menuPath={menuPath}
          formLocked={formLocked || creating}
          onSelect={setSelectedPath}
          onMenuPath={setMenuPath}
          onNew={() => void createSkill('personal')}
          newLabel="New user skill"
          onDelete={(s) => void deleteSkill(s)}
          onOpenExternally={(s) => void openExternally(s)}
        />
        <SkillGroup
          title="Workspace"
          skills={workspaceSkills}
          selectedPath={selectedPath}
          menuPath={menuPath}
          formLocked={formLocked || creating}
          newDisabled={!activeWorkspacePath}
          newDisabledReason="Open a workspace to create a project skill."
          onSelect={setSelectedPath}
          onMenuPath={setMenuPath}
          onNew={() => void createSkill('project')}
          newLabel="New workspace skill"
          onDelete={(s) => void deleteSkill(s)}
          onOpenExternally={(s) => void openExternally(s)}
          onReveal={activeWorkspacePath ? (s) => void revealProject(s) : undefined}
        />
      </div>
      {selected ? (
        <SkillEditor
          key={selected.skillPath}
          skill={selected}
          workspacePath={activeWorkspacePath ?? null}
          disabled={formLocked}
          onSaved={(nextPath) => setSelectedPath(nextPath)}
          onError={reportEditorError}
          onSuccess={(text) => setFeedback({ kind: 'success', text })}
        />
      ) : (
        <p className="m-0 text-xs text-muted">Select a skill to edit, or create one with New.</p>
      )}
    </div>
  )
}

function SkillGroup({
  title,
  skills,
  selectedPath,
  menuPath,
  formLocked,
  newDisabled,
  newDisabledReason,
  onSelect,
  onMenuPath,
  onNew,
  newLabel,
  onDelete,
  onOpenExternally,
  onReveal
}: {
  title: string
  skills: LocalSkillItem[]
  selectedPath: string | null
  menuPath: string | null
  formLocked: boolean
  newDisabled?: boolean
  newDisabledReason?: string
  onSelect: (path: string) => void
  onMenuPath: (path: string | null) => void
  onNew: () => void
  newLabel: string
  onDelete: (skill: LocalSkillItem) => void
  onOpenExternally: (skill: LocalSkillItem) => void
  onReveal?: (skill: LocalSkillItem) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="m-0 text-caption font-medium text-secondary">{title}</p>
        <Button
          variant="subtle"
          disabled={formLocked || newDisabled}
          title={newDisabled ? newDisabledReason : newLabel}
          aria-label={newLabel}
          onClick={onNew}
        >
          <Icon name="plus" size={14} />
          New
        </Button>
      </div>
      {newDisabled && newDisabledReason ? (
        <p className="m-0 text-xs text-muted">{newDisabledReason}</p>
      ) : null}
      {skills.length === 0 ? (
        <p className="m-0 text-xs text-muted">No {title.toLowerCase()} skills yet.</p>
      ) : (
        skills.map((skill) => {
          const selected = selectedPath != null && pathsEqual(skill.skillPath, selectedPath)
          const origin =
            skill.origin === 'cursor'
              ? ' · .cursor/skills'
              : skill.source === 'project'
                ? ' · .vyotiq/skills'
                : ''
          return (
            <div
              key={skill.id}
              data-skill-path={skill.skillPath}
              className={`flex items-start gap-1 rounded-md border px-2 py-1.5 ${
                selected ? 'border-border-strong bg-surface-2' : 'border-border bg-surface'
              }`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => onSelect(skill.skillPath)}
              >
                <p className="m-0 text-xs font-medium text-fg">{skill.name}</p>
                <p className="m-0 mt-0.5 text-caption text-secondary">
                  {skill.description || '—'}
                  {origin}
                </p>
              </button>
              <ActionMenu
                aria-label={`${skill.name} actions`}
                open={menuPath === skill.skillPath}
                onOpenChange={(open) => onMenuPath(open ? skill.skillPath : null)}
                placement="down"
                align="end"
                items={[
                  {
                    id: 'open-external',
                    label: 'Open externally',
                    icon: 'folderOpen',
                    onSelect: () => onOpenExternally(skill)
                  },
                  ...(onReveal && skill.source === 'project'
                    ? [
                        {
                          id: 'reveal',
                          label: 'Reveal in folder',
                          icon: 'folder' as const,
                          onSelect: () => onReveal(skill)
                        }
                      ]
                    : []),
                  {
                    id: 'delete',
                    label: 'Delete',
                    icon: 'trash',
                    onSelect: () => onDelete(skill)
                  }
                ]}
                trigger={(props) => (
                  <IconButton
                    ref={props.ref}
                    icon="menu"
                    label={`${skill.name} actions`}
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
          )
        })
      )}
    </div>
  )
}

function SkillEditor({
  skill,
  workspacePath,
  disabled,
  onSaved,
  onError,
  onSuccess
}: {
  skill: LocalSkillItem
  workspacePath: string | null
  disabled: boolean
  onSaved: (skillPath: string) => void
  onError: (text: string) => void
  onSuccess: (text: string) => void
}) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState(skill.name)
  const [description, setDescription] = useState(skill.description)
  const [license, setLicense] = useState('')
  const [compatibility, setCompatibility] = useState('')
  const [allowedTools, setAllowedTools] = useState('')
  const [visibleOptional, setVisibleOptional] = useState<Set<OptionalSkillKey>>(new Set())
  const [metadata, setMetadata] = useState<Array<{ key: string; value: string }>>([])
  const [body, setBody] = useState('')
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const { prompt, dialog: promptDialog } = usePrompt()

  const applyLoaded = (data: SkillsReadLocalResult): void => {
    setName(data.name)
    setDescription(data.description)
    setLicense(data.license ?? '')
    setCompatibility(data.compatibility ?? '')
    setAllowedTools(data.allowedTools ?? '')
    const next = new Set<OptionalSkillKey>()
    if (data.license) next.add('license')
    if (data.compatibility) next.add('compatibility')
    if (data.allowedTools) next.add('allowed-tools')
    setVisibleOptional(next)
    setMetadata(
      data.metadata
        ? Object.entries(data.metadata).map(([key, value]) => ({ key, value }))
        : []
    )
    setBody(data.body)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setLoadError(null)
      const res = await window.vyotiq.skillsReadLocal({
        workspacePath,
        skillPath: skill.skillPath
      })
      if (cancelled) return
      if (!res.ok) {
        onError(res.error)
        setLoadError(res.error)
        setLoading(false)
        return
      }
      applyLoaded(res.data)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [skill.skillPath, workspacePath, onError])

  const hiddenOptional = OPTIONAL_KEYS.filter((key) => !visibleOptional.has(key))

  const save = async (): Promise<void> => {
    const metadataRecord: Record<string, string> = {}
    for (const entry of metadata) {
      const key = entry.key.trim()
      if (!key) continue
      metadataRecord[key] = entry.value
    }
    const fm: SkillFrontmatter = {
      name: name.trim(),
      description: description.trim(),
      ...(visibleOptional.has('license') && license.trim()
        ? { license: license.trim() }
        : {}),
      ...(visibleOptional.has('compatibility') && compatibility.trim()
        ? { compatibility: compatibility.trim() }
        : {}),
      ...(visibleOptional.has('allowed-tools') && allowedTools.trim()
        ? { 'allowed-tools': allowedTools.trim() }
        : {}),
      ...(Object.keys(metadataRecord).length > 0 ? { metadata: metadataRecord } : {})
    }
    const content = serializeSkillMarkdown(fm, body)
    setSaving(true)
    try {
      const res = await window.vyotiq.skillsWriteLocal({
        workspacePath,
        skillPath: skill.skillPath,
        content
      })
      if (!res.ok) {
        onError(res.error)
        return
      }
      onSaved(res.data.skillPath)
      onSuccess(`Saved ${res.data.relativePath}`)
    } finally {
      setSaving(false)
    }
  }

  const addMetadata = async (): Promise<void> => {
    const key = await prompt('Metadata key', '')
    if (key == null) return
    const trimmed = key.trim()
    if (!trimmed) {
      onError('Metadata key cannot be empty.')
      return
    }
    setMetadata((prev) => [...prev, { key: trimmed, value: '' }])
  }

  if (loading) {
    return (
      <p className="m-0 text-xs text-muted" role="status">Loading skill…</p>
    )
  }
  if (loadError) {
    return (
      <p className="m-0 text-xs text-danger" role="alert">{loadError}</p>
    )
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {promptDialog}
      <div className="flex flex-col gap-2">
        <p className="m-0 text-caption font-medium text-secondary">Properties</p>
        <label className="flex flex-col gap-1 text-xs text-secondary">
          name
          <Input
            value={name}
            disabled={disabled || saving}
            aria-label="Skill name"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-secondary">
          description
          <Input
            value={description}
            disabled={disabled || saving}
            aria-label="Skill description"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {visibleOptional.has('license') ? (
          <label className="flex flex-col gap-1 text-xs text-secondary">
            license
            <Input
              value={license}
              disabled={disabled || saving}
              aria-label="Skill license"
              onChange={(e) => setLicense(e.target.value)}
            />
          </label>
        ) : null}
        {visibleOptional.has('compatibility') ? (
          <label className="flex flex-col gap-1 text-xs text-secondary">
            compatibility
            <Input
              value={compatibility}
              disabled={disabled || saving}
              aria-label="Skill compatibility"
              onChange={(e) => setCompatibility(e.target.value)}
            />
          </label>
        ) : null}
        {visibleOptional.has('allowed-tools') ? (
          <label className="flex flex-col gap-1 text-xs text-secondary">
            allowed-tools
            <Input
              value={allowedTools}
              disabled={disabled || saving}
              aria-label="Skill allowed-tools"
              onChange={(e) => setAllowedTools(e.target.value)}
            />
          </label>
        ) : null}
        {metadata.map((entry, index) => (
          <label key={`${entry.key}-${index}`} className="flex flex-col gap-1 text-xs text-secondary">
            metadata.{entry.key}
            <Input
              value={entry.value}
              disabled={disabled || saving}
              aria-label={`Skill metadata ${entry.key}`}
              onChange={(e) => {
                const value = e.target.value
                setMetadata((prev) => prev.map((row, i) => (i === index ? { ...row, value } : row)))
              }}
            />
          </label>
        ))}
        <ActionMenu
          aria-label="Add skill property"
          open={addMenuOpen}
          onOpenChange={setAddMenuOpen}
          placement="down"
          items={[
            ...hiddenOptional.map((key) => ({
              id: key,
              label: key,
              onSelect: () => setVisibleOptional((prev) => new Set(prev).add(key))
            })),
            {
              id: 'metadata',
              label: 'metadata…',
              onSelect: () => void addMetadata()
            }
          ]}
          trigger={(props) => (
            <button
              ref={props.ref}
              type="button"
              disabled={disabled || saving}
              className="inline-flex min-h-[var(--vy-control-min-h)] items-center justify-center gap-[var(--vy-control-gap)] rounded-md border border-border bg-surface px-[var(--vy-control-px)] text-sm text-fg hover:bg-surface-2 focus-visible:vy-focus-ring disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]"
              aria-expanded={props['aria-expanded']}
              aria-controls={props['aria-controls']}
              aria-haspopup={props['aria-haspopup']}
              onClick={props.onClick}
            >
              <Icon name="plus" size={14} />
              Add property
            </button>
          )}
        />
      </div>
      <MarketplaceMarkdownBody
        path={skill.relativePath}
        value={body}
        disabled={disabled || saving}
        onChange={setBody}
      />
      <div className="flex justify-end">
        <Button disabled={disabled || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
