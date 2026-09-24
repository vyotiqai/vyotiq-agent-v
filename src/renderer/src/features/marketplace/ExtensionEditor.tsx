import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Settings, SkillFrontmatter, SkillsReadLocalResult, UserRule } from '@shared/ipc'
import { USER_RULE_BODY_MAX, USER_RULE_NAME_MAX } from '@shared/ipc'
import { serializeSkillMarkdown } from '@shared/utils/skillMarkdown'
import { ActionMenu, Button, IconButton, Input, MarkdownContent, Segmented, Switch, pushToast } from '@renderer/lib/ui'
import { useEscapeToClose } from '@renderer/lib/hooks/useEscapeToClose'
import { usePrompt } from '@renderer/lib/hooks/usePrompt'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import { TextCodeEditor } from '@renderer/features/chat/components/TextCodeEditor'
import { isRootRulePath, type ConfirmFn, type EditorTarget } from './ExtensionDetail'
import { FIELD_GRID } from './McpServerConfig'
import { parseRuleEditor, serializeRuleEditor } from './ruleEditorMarkdown'
import type { MarketplaceController } from './useMarketplaceController'

const OPTIONAL_KEYS = ['license', 'compatibility', 'allowed-tools'] as const
type OptionalSkillKey = (typeof OPTIONAL_KEYS)[number]

type SaveResult = { ok: true } | { ok: false; error: string }

/**
 * A skill or rule file, open full width in place of the list. Everything is
 * saved together with Save; Back asks first when there is something unsaved.
 */
export function ExtensionEditor({
  target,
  controller,
  settings,
  onUpdate,
  confirm,
  onBack,
  onRetarget
}: {
  target: EditorTarget
  controller: MarketplaceController
  settings: Settings
  onUpdate: (partial: Partial<Settings>) => Promise<SaveResult>
  confirm: ConfirmFn
  onBack: () => void
  /** A save can move the file (a renamed skill gets a new folder). */
  onRetarget: (next: EditorTarget) => void
}) {
  const [dirty, setDirty] = useState(false)
  const back = useCallback((): void => {
    void (async () => {
      if (
        dirty &&
        !(await confirm('Your edits have not been saved.', {
          title: 'Discard changes?',
          confirmLabel: 'Discard',
          danger: true
        }))
      ) {
        return
      }
      onBack()
    })()
  }, [dirty, confirm, onBack])
  // Escape leaves the way Back does; inside a field it stays the field's.
  useEscapeToClose(back, true, { deferToMenus: true })
  const frame = { onBack: back, dirty, onDirty: setDirty }

  if (target.kind === 'skill') {
    const listed = controller.localSkills.find((s) => s.skillPath === target.skillPath)
    return (
      <SkillEditor
        key={target.skillPath}
        {...frame}
        skillPath={target.skillPath}
        // A skill created a moment ago may not be listed yet; never show the absolute path.
        relativePath={listed?.relativePath ?? target.skillPath.replace(/\\/g, '/').split('/').slice(-2).join('/')}
        workspacePath={controller.workspacePath}
        onSaved={(skillPath) => {
          if (skillPath !== target.skillPath) onRetarget({ kind: 'skill', skillPath })
        }}
      />
    )
  }
  if (target.kind === 'user-rule') {
    const rules = settings.userRules ?? []
    const rule = rules.find((r) => r.id === target.ruleId)
    if (!rule) {
      return (
        <EditorFrame title="Rule" onBack={onBack}>
          <p role="alert" className="text-xs text-danger">
            This rule no longer exists.
          </p>
        </EditorFrame>
      )
    }
    return (
      <UserRuleEditor
        key={rule.id}
        {...frame}
        rule={rule}
        onSave={async (next) => {
          const res = await onUpdate({ userRules: rules.map((r) => (r.id === next.id ? next : r)) })
          if (!res.ok) pushToast(res.error, 'error')
          else pushToast(`Saved ${next.name}.`, 'success')
          return res.ok
        }}
      />
    )
  }
  const workspacePath = controller.workspacePath
  if (!workspacePath) {
    return (
      <EditorFrame title={target.path} onBack={onBack}>
        <p className="text-xs text-muted">Open the workspace this rule belongs to, to edit it.</p>
      </EditorFrame>
    )
  }
  return (
    <ProjectRuleEditor
      key={target.path}
      {...frame}
      path={target.path}
      workspacePath={workspacePath}
      onSaved={() => void controller.loadProjectRules()}
    />
  )
}

type FrameProps = {
  onBack: () => void
  dirty: boolean
  onDirty: (dirty: boolean) => void
}

function EditorFrame({
  title,
  path,
  onBack,
  dirty = false,
  save,
  children
}: {
  title: string
  path?: string
  onBack: () => void
  dirty?: boolean
  save?: { pending: boolean; disabled: boolean; onSave: () => void }
  children: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-extension-editor>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <IconButton icon="arrowLeft" label="Back to extensions" size="sm" tone="muted" onClick={onBack} />
        <h2 className="min-w-0 truncate text-sm font-medium text-fg-strong">{title}</h2>
        {path ? <span className="min-w-0 truncate font-mono text-caption text-tertiary">{path}</span> : null}
        <span className="flex-1" />
        {dirty ? <span className="shrink-0 text-xs text-muted">Unsaved changes</span> : null}
        {save ? (
          <Button
            size="xs"
            variant="primary"
            pending={save.pending}
            disabled={save.disabled || !dirty}
            onClick={save.onSave}
          >
            Save
          </Button>
        ) : null}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="flex max-w-[800px] flex-col gap-6 py-5 pl-10 pr-5">{children}</div>
      </div>
    </div>
  )
}

function Section({ label, trailing, children }: { label: string; trailing?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex min-h-7 items-center gap-2">
        <h3 className={SECTION_LABEL}>{label}</h3>
        <span className="flex-1" />
        {trailing}
      </div>
      {children}
    </section>
  )
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="truncate text-muted">{children}</span>
}

function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="text-xs text-muted">
      Loading {what}…
    </p>
  )
}

/** Source or preview of a markdown body — the part of every skill and rule the agent reads. */
function MarkdownBody({
  path,
  value,
  disabled,
  onChange,
  footer
}: {
  path: string
  value: string
  disabled: boolean
  onChange: (next: string) => void
  footer?: ReactNode
}) {
  const [mode, setMode] = useState<'source' | 'preview'>('source')
  const [cursor, setCursor] = useState(0)
  const [selections, setSelections] = useState([{ from: 0, to: 0 }])
  return (
    <Section
      label="Body"
      trailing={
        <Segmented
          label="Body view"
          value={mode}
          items={[
            { id: 'source', label: 'Source' },
            { id: 'preview', label: 'Preview' }
          ]}
          onChange={setMode}
        />
      }
    >
      {mode === 'source' ? (
        <div className="flex h-[420px] overflow-hidden rounded-md border border-border bg-bg">
          <TextCodeEditor
            path={path}
            value={value}
            cursor={cursor}
            selections={selections}
            wordWrap
            onChange={(next) => {
              if (disabled) return false
              onChange(next)
              return true
            }}
            onMetaChange={(meta) => {
              setCursor(meta.cursor)
              setSelections(meta.selections)
            }}
          />
        </div>
      ) : (
        <div className="scroll-thin h-[420px] overflow-auto rounded-md border border-border bg-bg px-4 py-3">
          {value.trim() ? (
            <MarkdownContent content={value} className="text-sm" />
          ) : (
            <p className="text-xs text-muted">Nothing to preview yet.</p>
          )}
        </div>
      )}
      {footer}
    </Section>
  )
}

/* ─── Skills ─────────────────────────────────────────────────────────── */

function SkillEditor({
  skillPath,
  relativePath,
  workspacePath,
  onSaved,
  onBack,
  dirty,
  onDirty
}: FrameProps & {
  skillPath: string
  relativePath: string
  workspacePath: string | null
  onSaved: (skillPath: string) => void
}) {
  const [loaded, setLoaded] = useState<SkillsReadLocalResult | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [license, setLicense] = useState('')
  const [compatibility, setCompatibility] = useState('')
  const [allowedTools, setAllowedTools] = useState('')
  const [visibleOptional, setVisibleOptional] = useState<Set<OptionalSkillKey>>(new Set())
  const [metadata, setMetadata] = useState<Array<{ key: string; value: string }>>([])
  const [body, setBody] = useState('')
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const { prompt, dialog: promptDialog } = usePrompt()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.vyotiq.skillsReadLocal({ workspacePath, skillPath })
      if (cancelled) return
      if (!res.ok) {
        setLoadError(res.error)
        return
      }
      const data = res.data
      setName(data.name)
      setDescription(data.description)
      setLicense(data.license ?? '')
      setCompatibility(data.compatibility ?? '')
      setAllowedTools(data.allowedTools ?? '')
      const optional = new Set<OptionalSkillKey>()
      if (data.license) optional.add('license')
      if (data.compatibility) optional.add('compatibility')
      if (data.allowedTools) optional.add('allowed-tools')
      setVisibleOptional(optional)
      setMetadata(data.metadata ? Object.entries(data.metadata).map(([key, value]) => ({ key, value })) : [])
      setBody(data.body)
      setLoaded(data)
      onDirty(false)
    })()
    return () => {
      cancelled = true
    }
  }, [skillPath, workspacePath, onDirty])

  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T): void => {
      set(value)
      onDirty(true)
    }

  const save = async (): Promise<void> => {
    const metadataRecord: Record<string, string> = {}
    for (const entry of metadata) {
      const key = entry.key.trim()
      if (key) metadataRecord[key] = entry.value
    }
    const fm: SkillFrontmatter = {
      name: name.trim(),
      description: description.trim(),
      ...(visibleOptional.has('license') && license.trim() ? { license: license.trim() } : {}),
      ...(visibleOptional.has('compatibility') && compatibility.trim()
        ? { compatibility: compatibility.trim() }
        : {}),
      ...(visibleOptional.has('allowed-tools') && allowedTools.trim()
        ? { 'allowed-tools': allowedTools.trim() }
        : {}),
      ...(Object.keys(metadataRecord).length > 0 ? { metadata: metadataRecord } : {})
    }
    setSaving(true)
    try {
      const res = await window.vyotiq.skillsWriteLocal({
        workspacePath,
        skillPath,
        content: serializeSkillMarkdown(fm, body)
      })
      if (!res.ok) {
        pushToast(res.error, 'error')
        return
      }
      onDirty(false)
      pushToast(`Saved ${res.data.relativePath}.`, 'success')
      onSaved(res.data.skillPath)
    } finally {
      setSaving(false)
    }
  }

  const addMetadata = async (): Promise<void> => {
    const key = await prompt('Metadata key', '')
    if (key == null) return
    const trimmed = key.trim()
    if (!trimmed) {
      pushToast('Metadata key cannot be empty.', 'error')
      return
    }
    setMetadata((prev) => [...prev, { key: trimmed, value: '' }])
    onDirty(true)
  }

  const hiddenOptional = OPTIONAL_KEYS.filter((key) => !visibleOptional.has(key))
  const optionalFields: Record<OptionalSkillKey, { value: string; set: (v: string) => void; label: string }> = {
    license: { value: license, set: setLicense, label: 'Skill license' },
    compatibility: { value: compatibility, set: setCompatibility, label: 'Skill compatibility' },
    'allowed-tools': { value: allowedTools, set: setAllowedTools, label: 'Skill allowed-tools' }
  }
  const locked = saving || !loaded

  return (
    <EditorFrame
      title={loaded?.name || 'Skill'}
      path={relativePath}
      onBack={onBack}
      dirty={dirty}
      // A file that did not load has nothing to save — writing the empty fields would wipe it.
      save={loadError ? undefined : { pending: saving, disabled: locked || !name.trim(), onSave: () => void save() }}
    >
      {promptDialog}
      {loadError ? (
        <p role="alert" className="text-xs text-danger">
          {loadError}
        </p>
      ) : !loaded ? (
        <Loading what="skill" />
      ) : (
        <>
          <Section
            label="Properties"
            trailing={
              <ActionMenu
                aria-label="Add skill property"
                open={addMenuOpen}
                onOpenChange={setAddMenuOpen}
                placement="down"
                align="end"
                items={[
                  ...hiddenOptional.map((key) => ({
                    id: key,
                    label: key,
                    onSelect: () => setVisibleOptional((prev) => new Set(prev).add(key))
                  })),
                  { id: 'metadata', label: 'metadata…', onSelect: () => void addMetadata() }
                ]}
                trigger={(props) => (
                  <Button
                    ref={props.ref}
                    size="xs"
                    variant="ghost"
                    icon="plus"
                    disabled={locked}
                    aria-expanded={props['aria-expanded']}
                    aria-controls={props['aria-controls']}
                    aria-haspopup={props['aria-haspopup']}
                    onClick={props.onClick}
                  >
                    Add property
                  </Button>
                )}
              />
            }
          >
            <div className={FIELD_GRID}>
              <FieldLabel>name</FieldLabel>
              <Input
                size="sm"
                aria-label="Skill name"
                value={name}
                disabled={locked}
                onChange={(e) => edit(setName)(e.target.value)}
              />
              <FieldLabel>description</FieldLabel>
              <Input
                size="sm"
                aria-label="Skill description"
                value={description}
                disabled={locked}
                onChange={(e) => edit(setDescription)(e.target.value)}
              />
              {OPTIONAL_KEYS.filter((key) => visibleOptional.has(key)).map((key) => (
                <OptionalRow
                  key={key}
                  name={key}
                  label={optionalFields[key].label}
                  value={optionalFields[key].value}
                  disabled={locked}
                  onChange={edit(optionalFields[key].set)}
                />
              ))}
              {metadata.map((entry, index) => (
                <OptionalRow
                  key={`${entry.key}-${index}`}
                  name={`metadata.${entry.key}`}
                  label={`Skill metadata ${entry.key}`}
                  value={entry.value}
                  disabled={locked}
                  onChange={(value) => {
                    setMetadata((prev) => prev.map((row, i) => (i === index ? { ...row, value } : row)))
                    onDirty(true)
                  }}
                />
              ))}
            </div>
          </Section>
          <MarkdownBody path={relativePath} value={body} disabled={locked} onChange={edit(setBody)} />
        </>
      )}
    </EditorFrame>
  )
}

function OptionalRow({
  name,
  label,
  value,
  disabled,
  onChange
}: {
  name: string
  label: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <>
      <FieldLabel>{name}</FieldLabel>
      <Input size="sm" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </>
  )
}

/* ─── Rules ──────────────────────────────────────────────────────────── */

function UserRuleEditor({
  rule,
  onSave,
  onBack,
  dirty,
  onDirty
}: FrameProps & {
  rule: UserRule
  onSave: (next: UserRule) => Promise<boolean>
}) {
  const [name, setName] = useState(rule.name)
  const [body, setBody] = useState(rule.body)
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const ok = await onSave({
        ...rule,
        name: name.trim().slice(0, USER_RULE_NAME_MAX),
        body: body.slice(0, USER_RULE_BODY_MAX)
      })
      if (ok) onDirty(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <EditorFrame
      title={rule.name}
      onBack={onBack}
      dirty={dirty}
      save={{ pending: saving, disabled: saving || !name.trim(), onSave: () => void save() }}
    >
      <Section label="Properties">
        <div className={FIELD_GRID}>
          <FieldLabel>name</FieldLabel>
          <Input
            size="sm"
            aria-label="User rule name"
            maxLength={USER_RULE_NAME_MAX}
            value={name}
            disabled={saving}
            onChange={(e) => {
              setName(e.target.value)
              onDirty(true)
            }}
          />
        </div>
      </Section>
      <MarkdownBody
        path={`${rule.name}.md`}
        value={body}
        disabled={saving}
        onChange={(next) => {
          setBody(next.slice(0, USER_RULE_BODY_MAX))
          onDirty(true)
        }}
        footer={
          <p className="mt-1.5 text-right font-mono text-caption text-tertiary tnum">
            {body.length}/{USER_RULE_BODY_MAX}
          </p>
        }
      />
    </EditorFrame>
  )
}

type FileVersion = { size: number; mtimeMs: number; sha256: string }

function ProjectRuleEditor({
  path,
  workspacePath,
  onSaved,
  onBack,
  dirty,
  onDirty
}: FrameProps & {
  path: string
  workspacePath: string
  onSaved: () => void
}) {
  const rootFile = isRootRulePath(path)
  const [loaded, setLoaded] = useState(false)
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
  const [expectedVersion, setExpectedVersion] = useState<FileVersion | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.vyotiq.workspaceFileRead({ workspacePath, path })
      if (cancelled) return
      if (!res.ok) {
        setLoadError(res.error)
        return
      }
      if (res.data.kind !== 'text') {
        setLoadError('This rule file is not text and cannot be edited here.')
        return
      }
      if (rootFile) {
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
      setLoaded(true)
      onDirty(false)
    })()
    return () => {
      cancelled = true
    }
  }, [path, workspacePath, rootFile, onDirty])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const content = rootFile
        ? body
        : serializeRuleEditor({ alwaysApply, hadAlwaysApplyKey, description, body, frontmatterLines })
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
        pushToast(res.error, 'error')
        return
      }
      setExpectedVersion(res.data.version)
      onDirty(false)
      pushToast(`Saved ${path}.`, 'success')
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  const locked = saving || !loaded
  return (
    <EditorFrame
      title={path.split('/').pop() || path}
      path={path}
      onBack={onBack}
      dirty={dirty}
      save={loadError ? undefined : { pending: saving, disabled: locked, onSave: () => void save() }}
    >
      {loadError ? (
        <p role="alert" className="text-xs text-danger">
          {loadError}
        </p>
      ) : !loaded ? (
        <Loading what="rule" />
      ) : (
        <>
          {rootFile ? (
            <p className="text-xs text-muted">Root instruction files are always applied.</p>
          ) : (
            <Section label="Properties">
              <div className={FIELD_GRID}>
                <FieldLabel>alwaysApply</FieldLabel>
                <div className="flex min-w-0 items-center gap-2">
                  <Switch
                    checked={alwaysApply}
                    disabled={locked}
                    label="Always apply"
                    onCheckedChange={(next) => {
                      setAlwaysApply(next)
                      onDirty(true)
                    }}
                  />
                  <span className="text-caption text-tertiary">
                    {alwaysApply ? 'Added to every chat.' : 'Added when it matches or is @-mentioned.'}
                  </span>
                </div>
                <FieldLabel>description</FieldLabel>
                <Input
                  size="sm"
                  aria-label="Rule description"
                  value={description}
                  disabled={locked}
                  onChange={(e) => {
                    setDescription(e.target.value)
                    onDirty(true)
                  }}
                />
              </div>
            </Section>
          )}
          <MarkdownBody
            path={path}
            value={body}
            disabled={locked}
            onChange={(next) => {
              setBody(next)
              onDirty(true)
            }}
          />
        </>
      )}
    </EditorFrame>
  )
}
