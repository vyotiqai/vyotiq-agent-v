/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatMessageSchema } from '@shared/ipc'
import { messagesToUiItems } from '@shared/transcript'
import { buildRecordModel } from '@renderer/features/task/recordModel'
import { Brief } from '@renderer/features/task/record/Brief'

/**
 * A brief Structure wrote keeps the words it replaced: on the stored message,
 * through the transcript, into the record — where they are one click away
 * under the brief the agent worked from.
 */

afterEach(cleanup)

const brief = 'Audit the app.\n\n## Deliverable\n- A report in `docs/`'

describe('a structured brief in the record', () => {
  it('survives the message schema and the transcript', () => {
    const parsed = ChatMessageSchema.parse({ role: 'user', content: brief, structuredFrom: 'audit the whole app' })
    expect(parsed.structuredFrom).toBe('audit the whole app')
    const [item] = messagesToUiItems([parsed])
    expect(item).toMatchObject({ kind: 'message', role: 'user', content: brief, structuredFrom: 'audit the whole app' })
  })

  it('shows the brief, with what you wrote behind a toggle', () => {
    const [run] = buildRecordModel(
      [{ kind: 'message', id: 'user-0', role: 'user', content: brief, structuredFrom: 'audit the whole app' }],
      { running: false }
    ).runs
    expect(run!.structuredFrom).toBe('audit the whole app')
    const { container } = render(<Brief run={run!} />)
    expect(container.textContent).toContain('Audit the app.')
    expect(container.textContent).not.toContain('audit the whole app')
    fireEvent.click(screen.getByRole('button', { name: 'Structured from what you wrote' }))
    expect(container.querySelector('[data-brief-structured-from]')!.textContent).toContain('audit the whole app')
    fireEvent.click(screen.getByRole('button', { name: 'Hide what you wrote' }))
    expect(container.textContent).not.toContain('audit the whole app')
  })

  it('says nothing for a brief you wrote yourself', () => {
    const [run] = buildRecordModel([{ kind: 'message', id: 'user-0', role: 'user', content: 'Fix it' }], { running: false }).runs
    const { container } = render(<Brief run={run!} />)
    expect(container.querySelector('[data-brief-structured-from]')).toBeNull()
  })
})
