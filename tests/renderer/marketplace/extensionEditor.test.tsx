/**
 * @vitest-environment jsdom
 */
import { useCallback, useState, type JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { MarketplaceView } from '@renderer/features/marketplace'
import { DEFAULT_SETTINGS, MAX_USER_RULES, type Settings, type UserRule } from '@shared/ipc'

const baseSettings: Settings = {
  ...DEFAULT_SETTINGS,
  marketplace: { registryUrl: '', remoteInstallAcked: true },
  mcpServers: []
}

const WORKSPACE = 'C:/tmp/project'
const HOUSE_STYLE_PATH = 'C:/Users/admin/.vyotiq/skills/house-style/SKILL.md'
const HOUSE_STYLE = {
  skillPath: HOUSE_STYLE_PATH,
  content:
    '---\nname: house-style\ndescription: Personal house style skill used across every workspace.\n---\n\n# House style\n',
  name: 'house-style',
  description: 'Personal house style skill used across every workspace.',
  body: '# House style\n'
}
const OPS_RULE =
  '---\nalwaysApply: true\ndescription: Never force-push main during a production incident.\n---\n\nNever force-push main.\n'

function ok<T>(data: T) {
  return { ok: true as const, data }
}

function textFile(path: string, content: string) {
  return ok({
    path,
    kind: 'text' as const,
    content,
    encoding: 'utf8' as const,
    eol: 'lf' as const,
    bom: false,
    size: content.length,
    version: { size: content.length, mtimeMs: 1, sha256: 'a'.repeat(64) },
    truncated: false
  })
}

type Bridge = Record<string, (...args: never[]) => unknown>
let bridge: Bridge

function installBridge(overrides: Bridge = {}): void {
  bridge = {
    marketplaceBrowse: vi.fn(async () => ok({ packages: [] })),
    marketplaceListInstalled: vi.fn(async () => ok({ schemaVersion: 1 as const, items: [] })),
    mcpStatus: vi.fn(async () => ok({ servers: [] })),
    skillsListLocal: vi.fn(async () =>
      ok({
        skills: [
          {
            id: 'skill:local:personal:house-style',
            name: 'house-style',
            description: HOUSE_STYLE.description,
            source: 'personal' as const,
            skillPath: HOUSE_STYLE_PATH,
            relativePath: '~/.vyotiq/skills/house-style/SKILL.md'
          }
        ]
      })
    ),
    skillsReadLocal: vi.fn(async ({ skillPath }: { skillPath: string }) =>
      skillPath === HOUSE_STYLE_PATH
        ? ok(HOUSE_STYLE)
        : ok({
            skillPath,
            content: '---\nname: release-notes\ndescription: \n---\n\n# Release notes\n',
            name: 'release-notes',
            description: '',
            body: '# Release notes\n'
          })
    ),
    skillsWriteLocal: vi.fn(async ({ skillPath }: { skillPath: string }) =>
      ok({ skillPath, relativePath: '~/.vyotiq/skills/house-style/SKILL.md', name: 'house-style' })
    ),
    skillsOpenLocal: vi.fn(async () => ok(true as const)),
    skillsDeleteLocal: vi.fn(async () => ok(true as const)),
    slashCommandsCreateSkill: vi.fn(async ({ scope }: { scope?: string }) =>
      ok({
        path:
          scope === 'personal'
            ? 'C:/Users/admin/.vyotiq/skills/release-notes/SKILL.md'
            : `${WORKSPACE}/.vyotiq/skills/release-notes/SKILL.md`,
        relativePath: scope === 'personal' ? '~/.vyotiq/skills/release-notes/SKILL.md' : '.vyotiq/skills/release-notes/SKILL.md',
        name: 'release-notes',
        source: scope === 'personal' ? ('personal' as const) : ('project' as const)
      })
    ),
    slashCommandsCreateRule: vi.fn(async () =>
      ok({ path: `${WORKSPACE}/.vyotiq/rules/release-notes.md`, relativePath: '.vyotiq/rules/release-notes.md' })
    ),
    workspaceListRules: vi.fn(async () =>
      ok({
        rules: [
          { path: '.vyotiq/rules/ops.md', description: 'Never force-push main during a production incident.', alwaysApply: true }
        ]
      })
    ),
    workspaceFileRead: vi.fn(async ({ path }: { path: string }) => textFile(path, OPS_RULE)),
    workspaceFileSave: vi.fn(async ({ path }: { path: string }) =>
      ok({ path, version: { size: 140, mtimeMs: 2, sha256: 'b'.repeat(64) }, size: 140 })
    ),
    onSkillsChanged: vi.fn(() => () => {}),
    ...overrides
  }
  window.vyotiq = bridge as unknown as typeof window.vyotiq
}

/** Settings that change when the view writes them, as they do in the app. */
function Harness({
  initial = baseSettings,
  onUpdate,
  ...props
}: Partial<Parameters<typeof MarketplaceView>[0]> & { initial?: Settings }): JSX.Element {
  const [settings, setSettings] = useState(initial)
  const update = useCallback(
    async (partial: Partial<Settings>) => {
      await onUpdate?.(partial)
      setSettings((prev) => ({ ...prev, ...partial }))
      return { ok: true as const }
    },
    [onUpdate]
  )
  return <MarketplaceView settings={settings} onUpdate={update} {...props} />
}

function chooseNew(menu: 'New skill' | 'New rule', item: string): void {
  fireEvent.click(screen.getByRole('button', { name: menu }))
  fireEvent.click(within(screen.getByRole('menu', { name: menu })).getByRole('menuitem', { name: item }))
}

async function answerPrompt(question: string, answer: string): Promise<void> {
  const dialog = await screen.findByRole('dialog', { name: question })
  fireEvent.change(within(dialog).getByLabelText('Prompt input'), { target: { value: answer } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }))
}

const saveButton = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement

beforeEach(() => {
  installBridge()
  Element.prototype.scrollIntoView = vi.fn()
  // CodeMirror measures text; jsdom has no layout.
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [] as unknown as DOMRectList
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Creating skills and rules', () => {
  it('creates a user skill from New skill and opens it', async () => {
    render(<Harness />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Skills/ }))
    chooseNew('New skill', 'User skill')
    await answerPrompt('New user skill name', 'release notes')
    await waitFor(() =>
      expect(bridge.slashCommandsCreateSkill).toHaveBeenCalledWith({
        workspacePath: null,
        title: 'release notes',
        scope: 'personal'
      })
    )
    const name = (await screen.findByRole('textbox', { name: 'Skill name' })) as HTMLInputElement
    expect(name.value).toBe('release-notes')
    expect(bridge.skillsReadLocal).toHaveBeenCalledWith({
      workspacePath: null,
      skillPath: 'C:/Users/admin/.vyotiq/skills/release-notes/SKILL.md'
    })
    // The list has not caught up yet; the header still never shows an absolute path.
    expect(screen.getByText('release-notes/SKILL.md')).toBeTruthy()
    expect(screen.queryByText(/C:\/Users\/admin/)).toBeNull()
  })

  it('keeps Workspace skill out of reach without a workspace, and says why', async () => {
    render(<Harness />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Skills/ }))
    fireEvent.click(screen.getByRole('button', { name: 'New skill' }))
    const item = screen.getByRole('menuitem', {
      name: 'Workspace skill',
      description: 'Unavailable: Open a workspace first.'
    }) as HTMLButtonElement
    expect(item.disabled).toBe(true)
    fireEvent.click(item)
    expect(screen.queryByRole('dialog', { name: 'New workspace skill name' })).toBeNull()
    expect(bridge.slashCommandsCreateSkill).not.toHaveBeenCalled()
  })

  it('creates a workspace skill in the open workspace', async () => {
    render(<Harness activeWorkspacePath={WORKSPACE} />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Skills/ }))
    chooseNew('New skill', 'Workspace skill')
    await answerPrompt('New workspace skill name', 'release notes')
    await waitFor(() =>
      expect(bridge.slashCommandsCreateSkill).toHaveBeenCalledWith({
        workspacePath: WORKSPACE,
        title: 'release notes',
        scope: 'project'
      })
    )
    expect(await screen.findByRole('textbox', { name: 'Skill name' })).toBeTruthy()
  })

  it('creates a user rule in settings and opens it', async () => {
    const onUpdate = vi.fn()
    render(<Harness onUpdate={onUpdate} />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Rules/ }))
    chooseNew('New rule', 'User rule')
    await answerPrompt('New user rule name', 'House style')
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith({
        userRules: [{ id: expect.any(String), name: 'House style', body: '', enabled: true }]
      })
    )
    const name = (await screen.findByRole('textbox', { name: 'User rule name' })) as HTMLInputElement
    expect(name.value).toBe('House style')
    // Nothing is unsaved yet, so there is nothing to save.
    expect(saveButton().disabled).toBe(true)
  })

  it('stops offering a user rule at the most there can be', async () => {
    const rules: UserRule[] = Array.from({ length: MAX_USER_RULES }, (_, i) => ({
      id: `rule-${i}`,
      name: `Rule ${i}`,
      body: 'x',
      enabled: true
    }))
    render(<Harness initial={{ ...baseSettings, userRules: rules }} />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Rules/ }))
    fireEvent.click(screen.getByRole('button', { name: 'New rule' }))
    const item = screen.getByRole('menuitem', {
      name: 'User rule',
      description: `Unavailable: ${MAX_USER_RULES} user rules is the most there can be.`
    }) as HTMLButtonElement
    expect(item.disabled).toBe(true)
  })

  it('creates a project rule in the workspace and opens it', async () => {
    render(<Harness activeWorkspacePath={WORKSPACE} />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Rules/ }))
    chooseNew('New rule', 'Project rule')
    await answerPrompt('New project rule name', 'release notes')
    await waitFor(() =>
      expect(bridge.slashCommandsCreateRule).toHaveBeenCalledWith({ workspacePath: WORKSPACE, title: 'release notes' })
    )
    await waitFor(() =>
      expect(bridge.workspaceFileRead).toHaveBeenCalledWith({ workspacePath: WORKSPACE, path: '.vyotiq/rules/release-notes.md' })
    )
    expect(await screen.findByRole('textbox', { name: 'Rule description' })).toBeTruthy()
    // The list is read again, so the new file shows once the editor closes.
    expect(bridge.workspaceListRules).toHaveBeenCalledTimes(2)
  })
})

describe('Opening the editor', () => {
  it('opens a skill named by another surface', async () => {
    const consumed = vi.fn()
    render(<Harness focusSkillPath={HOUSE_STYLE_PATH} onFocusSkillConsumed={consumed} />)
    const description = (await screen.findByRole('textbox', { name: 'Skill description' })) as HTMLInputElement
    expect(description.value).toBe(HOUSE_STYLE.description)
    expect(consumed).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('~/.vyotiq/skills/house-style/SKILL.md')).toBeTruthy()
  })

  it('opens a project rule named with backslashes', async () => {
    const consumed = vi.fn()
    render(
      <Harness activeWorkspacePath={WORKSPACE} focusRulePath={'.vyotiq\\rules\\ops.md'} onFocusRuleConsumed={consumed} />
    )
    const description = (await screen.findByRole('textbox', { name: 'Rule description' })) as HTMLInputElement
    expect(description.value).toBe('Never force-push main during a production incident.')
    expect(bridge.workspaceFileRead).toHaveBeenCalledWith({ workspacePath: WORKSPACE, path: '.vyotiq/rules/ops.md' })
    expect(screen.getByRole('switch', { name: 'Always apply' }).getAttribute('aria-checked')).toBe('true')
    expect(consumed).toHaveBeenCalledTimes(1)
  })

  it('opens a skill from its detail', async () => {
    render(<Harness />)
    await screen.findByRole('heading', { level: 2, name: /^Installed/ })
    const detail = screen.getByRole('complementary', { name: 'house-style details' })
    fireEvent.click(within(detail).getByRole('button', { name: 'Edit' }))
    expect(await screen.findByRole('textbox', { name: 'Skill description' })).toBeTruthy()
  })
})

describe('Saving', () => {
  it('writes an edited skill description through skillsWriteLocal', async () => {
    render(<Harness focusSkillPath={HOUSE_STYLE_PATH} />)
    const description = await screen.findByRole('textbox', { name: 'Skill description' })
    expect(saveButton().disabled).toBe(true)
    fireEvent.change(description, {
      target: { value: 'Updated house style skill for TypeScript modules in this product.' }
    })
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    fireEvent.click(saveButton())
    await waitFor(() => expect(bridge.skillsWriteLocal).toHaveBeenCalledTimes(1))
    const payload = vi.mocked(bridge.skillsWriteLocal).mock.calls[0]![0] as unknown as { content: string }
    expect(payload.content).toContain('description: Updated house style skill for TypeScript modules in this product.')
    expect(payload.content).toContain('# House style')
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull())
  })

  it('offers no Save for a skill file that did not load', async () => {
    installBridge({
      skillsReadLocal: vi.fn(async () => ({ ok: false as const, error: 'Path is not a local skill file' }))
    })
    render(<Harness focusSkillPath={HOUSE_STYLE_PATH} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Path is not a local skill file')
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('offers no Save for a project rule that did not load', async () => {
    installBridge({
      workspaceFileRead: vi.fn(async () => ({ ok: false as const, error: 'File not found' }))
    })
    render(<Harness activeWorkspacePath={WORKSPACE} focusRulePath=".vyotiq/rules/ops.md" />)
    expect((await screen.findByRole('alert')).textContent).toBe('File not found')
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('keeps a project rule’s globs when its description changes', async () => {
    const rule = [
      '---',
      'globs:',
      '  - "*.ts"',
      'alwaysApply: false',
      'description: TypeScript modules in this workspace',
      '---',
      '',
      'Prefer named exports.',
      ''
    ].join('\n')
    installBridge({
      workspaceListRules: vi.fn(async () =>
        ok({ rules: [{ path: '.cursor/rules/typescript.mdc', description: 'TypeScript modules in this workspace', alwaysApply: false }] })
      ),
      workspaceFileRead: vi.fn(async ({ path }: { path: string }) => textFile(path, rule))
    })
    render(<Harness activeWorkspacePath={WORKSPACE} focusRulePath=".cursor/rules/typescript.mdc" />)
    const description = await screen.findByRole('textbox', { name: 'Rule description' })
    fireEvent.change(description, { target: { value: 'TypeScript modules and their tests' } })
    fireEvent.click(saveButton())
    await waitFor(() => expect(bridge.workspaceFileSave).toHaveBeenCalledTimes(1))
    const payload = vi.mocked(bridge.workspaceFileSave).mock.calls[0]![0] as unknown as {
      content: string
      expectedVersion: unknown
    }
    expect(payload.content).toContain('globs:')
    expect(payload.content).toContain('  - "*.ts"')
    expect(payload.content).toContain('alwaysApply: false')
    expect(payload.content).toContain('description: "TypeScript modules and their tests"')
    expect(payload.content).toContain('Prefer named exports.')
    // The write is refused if the file changed since it was read.
    expect(payload.expectedVersion).toEqual({ size: rule.length, mtimeMs: 1, sha256: 'a'.repeat(64) })
  })

  it('saves an edited root instruction file without touching its leading --- block', async () => {
    const agents = ['---', 'name: workspace', '---', '', '# AGENTS.md', '', 'Follow the workspace instructions in this file.', ''].join('\n')
    installBridge({
      workspaceListRules: vi.fn(async () => ok({ rules: [{ path: 'AGENTS.md', alwaysApply: true }] })),
      workspaceFileRead: vi.fn(async ({ path }: { path: string }) => textFile(path, agents))
    })
    render(<Harness activeWorkspacePath={WORKSPACE} focusRulePath="AGENTS.md" />)
    expect(await screen.findByText('Root instruction files are always applied.')).toBeTruthy()
    // A root file has no properties of its own to edit; only its text.
    expect(screen.queryByRole('textbox', { name: 'Rule description' })).toBeNull()

    // The editor mounts after the notice above; on a slow runner it is not
    // there yet when the notice is (ubuntu-latest).
    const view = await waitFor(() => {
      const editor = document.querySelector<HTMLElement>('.cm-editor')
      const found = editor ? EditorView.findFromDOM(editor) : null
      expect(found).toBeTruthy()
      return found!
    })
    expect(view.state.doc.toString()).toBe(agents)
    view.dispatch({ changes: { from: view!.state.doc.length, insert: 'Run the tests before committing.\n' } })
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    fireEvent.click(saveButton())
    await waitFor(() => expect(bridge.workspaceFileSave).toHaveBeenCalledTimes(1))
    const payload = vi.mocked(bridge.workspaceFileSave).mock.calls[0]![0] as unknown as { content: string }
    expect(payload.content).toBe(`${agents}Run the tests before committing.\n`)
  })
})

describe('Leaving the editor', () => {
  it('asks before Back throws away unsaved edits', async () => {
    render(<Harness focusSkillPath={HOUSE_STYLE_PATH} />)
    fireEvent.change(await screen.findByRole('textbox', { name: 'Skill description' }), {
      target: { value: 'Something new' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Back to extensions' }))
    const ask = await screen.findByRole('dialog', { name: 'Discard changes?' })
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull())
    expect((screen.getByRole('textbox', { name: 'Skill description' }) as HTMLInputElement).value).toBe('Something new')

    fireEvent.click(screen.getByRole('button', { name: 'Back to extensions' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Discard changes?' })).getByRole('button', { name: 'Discard' }))
    expect(await screen.findByRole('tablist', { name: 'Extension kinds' })).toBeTruthy()
    expect(bridge.skillsWriteLocal).not.toHaveBeenCalled()
  })

  it('leaves without asking when nothing changed', async () => {
    render(<Harness focusSkillPath={HOUSE_STYLE_PATH} />)
    await screen.findByRole('textbox', { name: 'Skill description' })
    fireEvent.click(screen.getByRole('button', { name: 'Back to extensions' }))
    expect(await screen.findByRole('tablist', { name: 'Extension kinds' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull()
  })

  it('takes Escape to mean Back, not close Extensions', async () => {
    const onClose = vi.fn()
    render(<Harness focusSkillPath={HOUSE_STYLE_PATH} onClose={onClose} />)
    await screen.findByRole('textbox', { name: 'Skill description' })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(await screen.findByRole('tablist', { name: 'Extension kinds' })).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })
})
