/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { SetupPage } from '@renderer/features/setup/SetupPage'
import type { SetupProviderSettings } from '@renderer/features/setup/setupModel'

const OLLAMA: SetupProviderSettings = {
  provider: 'ollama',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  customOpenAiBaseUrl: DEFAULT_SETTINGS.customOpenAiBaseUrl,
  customProviders: []
}

const listModels = vi.fn()
const pathForFile = vi.fn()

beforeEach(() => {
  listModels.mockReset()
  pathForFile.mockReset()
  listModels.mockResolvedValue({ ok: true, data: { models: [] } })
  window.vyotiq = { listModels, pathForFile } as unknown as typeof window.vyotiq
})

afterEach(cleanup)

type Props = Parameters<typeof SetupPage>[0]

function renderSetup(overrides: Partial<Props> = {}) {
  const props: Props = {
    settings: OLLAMA,
    secrets: {},
    workspace: null,
    recents: [],
    approvalMode: 'mutating',
    mcpProtection: true,
    onChangeProvider: vi.fn(),
    onChooseFolder: vi.fn(async () => null),
    onOpenPath: vi.fn(async () => null),
    onStart: vi.fn(async () => {}),
    ...overrides
  }
  render(<SetupPage {...props} />)
  return props
}

function step(n: number): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-setup-step="${n}"]`)!
}

describe('SetupPage', () => {
  it('reads as the mockup: three steps, then the first task', async () => {
    renderSetup()
    expect(screen.getByRole('heading', { level: 1, name: 'Set up Agent V' })).toBeTruthy()
    expect(
      screen.getByText('Three things, then hand it its first task. Everything here can change later in Settings.')
    ).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Connect a model provider',
      'Open a workspace',
      'Decide what needs your OK'
    ])
    expect(step(2).textContent).toContain('The folder the agent works in. Its file tools stay inside it.')
    expect(step(3).textContent).toContain('You can change this per workspace.')
    await waitFor(() => expect(step(1).dataset.state).toBe('done'))
  })

  it('asks the provider itself before calling it connected', async () => {
    let answer: (value: unknown) => void = () => {}
    listModels.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    renderSetup()

    expect(listModels).toHaveBeenCalledWith({ provider: 'ollama', forceRefresh: true })
    expect(step(1).dataset.state).toBe('current')
    expect(step(1).textContent).toContain('Ollama · checking http://127.0.0.1:11434…')
    expect(screen.getByText('Checking Ollama…')).toBeTruthy()

    await act(async () => answer({ ok: true, data: { models: [] } }))
    expect(step(1).dataset.state).toBe('done')
    expect(step(1).textContent).toContain('Ollama · no key needed · http://127.0.0.1:11434')
  })

  it('a provider that does not answer says why, and is asked again on request', async () => {
    listModels.mockResolvedValue({
      ok: true,
      data: {
        models: [],
        warning:
          'Cannot reach Ollama at http://127.0.0.1:11434 (fetch failed). Start the Ollama app, or save an Ollama API key in Settings → Providers to use Ollama Cloud automatically. Showing seed defaults (not live models).'
      }
    })
    const props = renderSetup({ workspace: '/ws' })

    await waitFor(() => expect(step(1).textContent).toContain('Ollama · not connected'))
    expect(document.querySelector('[data-setup-provider-reason]')?.textContent).toBe(
      'Cannot reach Ollama at http://127.0.0.1:11434 (fetch failed). Start the Ollama app, or save an Ollama API key in Settings → Providers to use Ollama Cloud automatically.'
    )
    expect((screen.getByRole('button', { name: /Start your first task/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Connect a provider first')).toBeTruthy()

    listModels.mockResolvedValue({ ok: true, data: { models: [] } })
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(step(1).dataset.state).toBe('done'))
    expect(listModels).toHaveBeenCalledTimes(2)
    expect(listModels).toHaveBeenLastCalledWith({ provider: 'ollama', forceRefresh: true })

    fireEvent.click(screen.getByRole('button', { name: 'Change the model provider' }))
    expect(props.onChangeProvider).toHaveBeenCalledTimes(1)
  })

  it('a provider without its key sends you to add one, and asks nothing yet', () => {
    const props = renderSetup({ settings: { ...OLLAMA, provider: 'openai' } })
    expect(step(1).textContent).toContain('OpenAI · needs an API key')
    expect(listModels).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Add a key or choose a provider/ }))
    expect(props.onChangeProvider).toHaveBeenCalledTimes(1)
  })

  it('a saved key is the encrypted one on this device', async () => {
    renderSetup({ settings: { ...OLLAMA, provider: 'openai' }, secrets: { openai: true } })
    await waitFor(() => expect(step(1).textContent).toContain('OpenAI · key saved, encrypted on this device'))
    expect(listModels).toHaveBeenCalledWith({ provider: 'openai', forceRefresh: true })
  })

  it('opens a folder from the picker, a recent row or a drop, and says when one fails', async () => {
    const onChooseFolder = vi.fn(async () => 'Folder not found')
    const onOpenPath = vi.fn(async () => null)
    renderSetup({ recents: ['C:\\Users\\me\\proj'], onChooseFolder, onOpenPath })

    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder…' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Folder not found')

    const recent = screen.getByRole('button', { name: /proj/ })
    expect(recent.className).toContain('focus-visible:vy-focus-ring')
    fireEvent.click(recent)
    expect(onOpenPath).toHaveBeenCalledWith('C:\\Users\\me\\proj')
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

    const zone = document.querySelector<HTMLElement>('[data-setup-drop]')!
    const folder = new File([], 'dropped')
    pathForFile.mockReturnValue('C:\\Users\\me\\dropped')
    const drop = createEvent.drop(zone)
    Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [folder] } })
    fireEvent(zone, drop)
    expect(pathForFile).toHaveBeenCalledWith(folder)
    expect(onOpenPath).toHaveBeenLastCalledWith('C:\\Users\\me\\dropped')

    pathForFile.mockReturnValue('')
    const blank = createEvent.drop(zone)
    Object.defineProperty(blank, 'dataTransfer', { value: { types: ['Files'], files: [folder] } })
    fireEvent(zone, blank)
    expect((await screen.findByRole('alert')).textContent).toBe('That can’t be opened as a folder.')
  })

  it('starts once a provider answered and a workspace is open, with the mode chosen', async () => {
    const onStart = vi.fn(async () => {})
    renderSetup({ workspace: 'C:\\work\\site', onStart })

    expect(step(2).dataset.state).toBe('done')
    expect(step(2).textContent).toContain('C:\\work\\site')
    const start = screen.getByRole('button', { name: /Start your first task/ }) as HTMLButtonElement
    await waitFor(() => expect(start.disabled).toBe(false))
    expect(step(3).dataset.state).toBe('current')
    expect(screen.getByText('Starts in site')).toBeTruthy()

    const recommended = screen.getByRole('radio', { name: /Edits and commands/ })
    expect(recommended.getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(recommended, { key: 'End' })
    expect(screen.getByRole('radio', { name: /Unattended/ }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(start)
    expect(onStart).toHaveBeenCalledWith('C:\\work\\site', 'off')
  })

  it('numbers its steps on the type scale — caption, not the keycap size', () => {
    renderSetup()
    const number = step(2).querySelector('span[aria-hidden="true"]')!
    expect(number.textContent).toBe('2')
    expect(number.classList.contains('text-caption')).toBe(true)
    expect(number.classList.contains('text-2xs')).toBe(false)
  })
})
