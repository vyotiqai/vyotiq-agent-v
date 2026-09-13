/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  AwaitAgentInstanceBody,
  SpawnAgentInstanceBody
} from '@renderer/features/chat/toolUi/bodies/AgentInstanceBody'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'

describe('SpawnAgentInstanceBody', () => {
  it('renders a compact plain-text goal and open action', () => {
    render(
      <RunSessionProvider
        value={{
          workspacePath: '/ws',
          runId: 'parent',
          agentInstances: {
            child1: {
              instanceRunId: 'child1',
              phase: 'started',
              goal: '**Fix auth**'
            }
          },
          onOpenAgentInstance: () => {}
        }}
      >
        <SpawnAgentInstanceBody
          tool={{
            id: 'tc1',
            name: 'spawn_agent_instance',
            summary: 'spawn',
            status: 'done',
            content: 'Agent V Instance id; child1\nrun_id: child1'
          }}
        />
      </RunSessionProvider>
    )
    const goal = screen.getByText('Fix auth')
    expect(goal.className).toContain('line-clamp-2')
    expect(screen.queryByText('Agent V Instance id; child1')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open instance child1' })).toBeTruthy()
  })

  it('shows scope and settled summary without duplicating phase chrome', () => {
    render(
      <RunSessionProvider
        value={{
          workspacePath: '/ws',
          runId: 'parent',
          agentInstances: {
            child1: {
              instanceRunId: 'child1',
              phase: 'done',
              goal: '**Fix auth**',
              pathScope: ['src/main/agent/'],
              summary: 'Auth gated.'
            }
          },
          onOpenAgentInstance: () => {}
        }}
      >
        <SpawnAgentInstanceBody
          tool={{
            id: 'tc1',
            name: 'spawn_agent_instance',
            summary: 'spawn',
            status: 'done',
            content: 'Agent V Instance id; child1\nrun_id: child1'
          }}
        />
      </RunSessionProvider>
    )
    expect(screen.queryByText('done')).toBeNull()
    expect(screen.getByText(/Scope: src\/main\/agent\//)).toBeTruthy()
    expect(screen.getByText('Auth gated.')).toBeTruthy()
  })
})

describe('AwaitAgentInstanceBody', () => {
  it('shows only additional instance details and the open action', () => {
    render(
      <RunSessionProvider
        value={{
          workspacePath: '/ws',
          runId: 'parent',
          agentInstances: {
            '584c0a1c-434a-4ddf-85c5-a05bb80fd696': {
              instanceRunId: '584c0a1c-434a-4ddf-85c5-a05bb80fd696',
              phase: 'started',
              goal: 'Audit src/agent',
              pathScope: ['src/agent/']
            }
          },
          onOpenAgentInstance: () => {}
        }}
      >
        <AwaitAgentInstanceBody
          tool={{
            id: 'tc2',
            name: 'await_agent_instance',
            summary: '584c0a1c',
            status: 'running',
            argsPreview: JSON.stringify({ run_id: '584c0a1c-434a-4ddf-85c5-a05bb80fd696' })
          }}
        />
      </RunSessionProvider>
    )
    expect(screen.queryByText('Instance 584c0a1c')).toBeNull()
    expect(screen.queryByText('awaiting')).toBeNull()
    expect(screen.getByText('Audit src/agent')).toBeTruthy()
    expect(screen.getByText(/Scope: src\/agent\//)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open instance 584c0a1c' })).toBeTruthy()
  })

  it('hides the protocol label from settled instance output', () => {
    render(
      <RunSessionProvider
        value={{
          workspacePath: '/ws',
          runId: 'parent',
          onOpenAgentInstance: () => {}
        }}
      >
        <AwaitAgentInstanceBody
          tool={{
            id: 'tc3',
            name: 'await_agent_instance',
            summary: '584c0a1c',
            status: 'done',
            content:
              'Agent V Instance id; 584c0a1c-434a-4ddf-85c5-a05bb80fd696\nphase: done\n\nAudit complete.'
          }}
        />
      </RunSessionProvider>
    )
    expect(screen.queryByText(/Agent V Instance id;/)).toBeNull()
    expect(screen.getByText(/phase: done/)).toBeTruthy()
    expect(screen.getByText(/Audit complete/)).toBeTruthy()
  })
})
