import type { ChatMessage } from '@shared/ipc'

/** Unique tokens planted in one transcript class each. */
export const CANARIES = {
  decision: 'CANARY_DECISION planted-choice-9f3a',
  writePath: 'src/auth/canary-write-7e91.ts',
  inspectPath: 'src/auth/canary-inspect-a4c2.ts',
  readBody: 'CANARY_READ_BODY secret-from-read-k3n7',
  term: 'CANARY_TERM secret-from-bash-w1p4',
  userProse: 'CANARY_USER_PROSE never-commit-secret-zeta',
  todo: 'CANARY_TODO open-todo-title-q8m2',
  doneWhen: 'CANARY_DONEWHEN login-must-use-jwt-p6d1',
  contractGoal: 'CANARY_GOAL rewrite-auth-to-jwt-m2c8'
} as const

export const PLANTED_CONTRACT = `## Goal

${CANARIES.contractGoal}

## Done when

- ${CANARIES.doneWhen}
`

function toolOk(id: string, name: string, content: string): ChatMessage {
  return { role: 'tool', content, toolCallId: id, toolName: name, ok: true }
}

function assistantCall(id: string, name: string, args: Record<string, unknown>): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }]
  }
}

/** Fold prefix with one canary per fact class. */
export function plantedFoldMessages(): ChatMessage[] {
  return [
    {
      role: 'user',
      content: `Rewrite auth. Do not mention ${CANARIES.userProse} in any log.`
    },
    assistantCall('r1', 'read', { path: CANARIES.inspectPath }),
    toolOk('r1', 'read', `export const inspect = 1\n// ${CANARIES.readBody}`),
    assistantCall('e1', 'edit', { path: CANARIES.writePath, contents: 'jwt' }),
    toolOk('e1', 'edit', 'ok'),
    assistantCall('t1', 'todo_write', { todos: [{ id: '1', content: CANARIES.todo, status: 'pending' }] }),
    toolOk('t1', 'todo_write', `0/1 complete\n[ ] (1) ${CANARIES.todo}`),
    assistantCall('sh1', 'terminal', { command: 'git status' }),
    toolOk('sh1', 'terminal', `On branch main\n${CANARIES.term}`),
    assistantCall('q1', 'ask_question', {}),
    toolOk('q1', 'ask_question', `User answered: ${CANARIES.decision}`)
  ]
}
