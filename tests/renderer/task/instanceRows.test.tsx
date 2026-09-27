/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import type { AgentInstanceUiState } from '@shared/utils/agentInstance'
import { WorkList } from '@renderer/features/task/record/WorkItems'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'
import type { WorkItem } from '@renderer/features/task/recordModel'

afterEach(cleanup)

const RUN_ID = '5e8249bc-1111-2222-3333-444455556666'
const SHORT_ID = '5e8249bc'

type ToolItem = Extract<UiItem, { kind: 'tool' }>

function instanceItem(status: 'running' | 'done' | 'fail', content?: string): ToolItem {
  return {
    kind: 'tool',
    id: 'call-1',
    tool: {
      id: 'call-1',
      name: 'await_agent_instance',
      summary: SHORT_ID,
      status,
      content,
      argsPreview: JSON.stringify({ run_id: RUN_ID })
    }
  }
}

function renderRow(
  item: ToolItem,
  value: { agentInstances?: Record<string, AgentInstanceUiState>; onOpenAgentInstance?: (runId: string) => void } = {}
): void {
  const work: WorkItem[] = [{ kind: 'instance', id: 'instance-1', tool: item }]
  render(
    <RunSessionProvider value={{ workspacePath: '/ws', runId: 'parent', ...value }}>
      <WorkList items={work} />
    </RunSessionProvider>
  )
}

describe('instance row against the child phase', () => {
  it('reads a failed await as finished when the child itself reached done', () => {
    renderRow(instanceItem('fail', `Timed out waiting for Agent V Instance id; ${RUN_ID} after 900000 ms. Child is still running.`), {
      agentInstances: { [RUN_ID]: { instanceRunId: RUN_ID, phase: 'done', summary: 'Audited the swap.' } }
    })
    expect(screen.getByText(`Instance finished ${SHORT_ID}`)).toBeTruthy()
    expect(screen.getByText('Finished, but the await did not return.')).toBeTruthy()
    expect(screen.queryByText(new RegExp(`^Failed ${SHORT_ID}`))).toBeNull()
  })

  it('names an errored child and its reason, without the protocol label', () => {
    renderRow(instanceItem('fail', `Agent V Instance id; ${RUN_ID}\nphase: error\n\nThe swap test never passed.`), {
      agentInstances: { [RUN_ID]: { instanceRunId: RUN_ID, phase: 'error', summary: 'The swap test never passed.' } }
    })
    expect(screen.getByText(`Instance failed ${SHORT_ID}`)).toBeTruthy()
    expect(screen.getByText('The swap test never passed.')).toBeTruthy()
    expect(screen.queryByText(/Agent V Instance id;/)).toBeNull()
  })

  it('falls back to the call content when the child reported no summary', () => {
    renderRow(instanceItem('fail', `Agent V Instance id; ${RUN_ID}\nrun_id is not an inline instance spawned by this parent run`), {
      agentInstances: { [RUN_ID]: { instanceRunId: RUN_ID, phase: 'error' } }
    })
    expect(screen.getByText('run_id is not an inline instance spawned by this parent run')).toBeTruthy()
    expect(screen.queryByText(/Agent V Instance id;/)).toBeNull()
  })

  it('says a child was cancelled when it was', () => {
    renderRow(instanceItem('fail', `Agent V Instance id; ${RUN_ID}\nphase: cancelled`), {
      agentInstances: { [RUN_ID]: { instanceRunId: RUN_ID, phase: 'cancelled', summary: 'Stopped after the first file.' } }
    })
    expect(screen.getByText(`Instance cancelled ${SHORT_ID}`)).toBeTruthy()
    expect(screen.getByText('Stopped after the first file.')).toBeTruthy()
  })

  it('leaves a call whose child has not settled to the tool verb and its own line', () => {
    renderRow(instanceItem('fail', `Agent V Instance id; ${RUN_ID}\nphase: started`), {
      agentInstances: { [RUN_ID]: { instanceRunId: RUN_ID, phase: 'started' } }
    })
    expect(screen.getByText(`Failed ${SHORT_ID}`)).toBeTruthy()
    expect(screen.getByText('phase: started')).toBeTruthy()
  })
})

describe('instance row controls', () => {
  it('names Open after the instance it opens, and passes the run id', () => {
    const onOpenAgentInstance = vi.fn()
    renderRow(instanceItem('done', `Agent V Instance id; ${RUN_ID}\nphase: done`), {
      agentInstances: { [RUN_ID]: { instanceRunId: RUN_ID, phase: 'done' } },
      onOpenAgentInstance
    })
    fireEvent.click(screen.getByRole('button', { name: `Open instance ${SHORT_ID}` }))
    expect(onOpenAgentInstance).toHaveBeenCalledWith(RUN_ID)
  })

  it('offers no Open action without a run to open', () => {
    renderRow(instanceItem('running'))
    expect(screen.queryByRole('button', { name: /^Open instance/ })).toBeNull()
  })
})

describe('thought Show all control', () => {
  it('exposes its expanded state, and flips it with the text', () => {
    const text = 'First line of the reasoning.\nSecond line of the reasoning.'
    const message: Extract<UiItem, { kind: 'message' }> = {
      kind: 'message',
      id: 'm1',
      role: 'assistant',
      content: '',
      thinking: text
    }
    const work: WorkItem[] = [{ kind: 'thought', id: 'thought-1', item: message, text, streaming: false }]
    render(<WorkList items={work} />)
    const showAll = screen.getByRole('button', { name: 'Show all' })
    expect(showAll.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(showAll)
    const showLess = screen.getByRole('button', { name: 'Show less' })
    expect(showLess.getAttribute('aria-expanded')).toBe('true')
  })
})
