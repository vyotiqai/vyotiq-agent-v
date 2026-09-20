import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodToJsonSchema } from '@main/agent/schemas/zodToJsonSchema'
import { AGENT_TOOLS } from '@main/agent/schemas/tools'
import { toCompactionJsonSchema } from '@main/agent/schemas/compaction'

describe('zodToJsonSchema', () => {
  it('preserves description on .optional().describe()', () => {
    const schema = z.object({
      startLine: z.number().int().min(1).optional().describe('Prefer line range')
    })
    const json = zodToJsonSchema(schema) as {
      properties: { startLine: { type: string; description?: string; minimum?: number } }
    }
    expect(json.properties.startLine.description).toBe('Prefer line range')
    expect(json.properties.startLine.type).toBe('integer')
    expect(json.properties.startLine.minimum).toBe(1)
    expect(json.required).toBeUndefined()
  })

  it('preserves description on .describe().optional()', () => {
    const schema = z.object({
      maxResults: z.number().describe('Max hits (default 40)').optional()
    })
    const json = zodToJsonSchema(schema) as {
      properties: { maxResults: { description?: string } }
    }
    expect(json.properties.maxResults.description).toBe('Max hits (default 40)')
  })

  it('emits ZodEnum as string enum with description', () => {
    const schema = z.object({
      status: z
        .enum(['pending', 'in_progress', 'completed', 'cancelled'])
        .describe('Task status')
    })
    const json = zodToJsonSchema(schema) as {
      properties: { status: { type: string; enum: string[]; description?: string } }
      required: string[]
    }
    expect(json.properties.status).toEqual({
      type: 'string',
      enum: ['pending', 'in_progress', 'completed', 'cancelled'],
      description: 'Task status'
    })
    expect(json.required).toEqual(['status'])
  })

  it('emits nested object properties and minItems on arrays', () => {
    const schema = z.object({
      edits: z
        .array(
          z.object({
            path: z.string().describe('File path')
          })
        )
        .min(1)
        .describe('Atomic edits')
    })
    const json = zodToJsonSchema(schema) as {
      properties: {
        edits: {
          type: string
          description?: string
          minItems?: number
          items: { properties: { path: { description?: string } } }
        }
      }
    }
    expect(json.properties.edits.description).toBe('Atomic edits')
    expect(json.properties.edits.minItems).toBe(1)
    expect(json.properties.edits.items.properties.path.description).toBe('File path')
  })

  it('emits required:[] for empty objects (OpenAI strict)', () => {
    const json = zodToJsonSchema(z.object({})) as { required?: string[] }
    expect(json.required).toEqual([])
  })

  it('emits uuid format and string min/maxLength from Zod checks', () => {
    const schema = z.object({
      session_id: z.string().uuid().describe('Session UUID').optional(),
      pattern: z.string().min(1).max(200).describe('Pattern')
    })
    const json = zodToJsonSchema(schema) as {
      properties: {
        session_id: { type: string; format?: string; description?: string }
        pattern: { type: string; minLength?: number; maxLength?: number }
      }
    }
    expect(json.properties.session_id.format).toBe('uuid')
    expect(json.properties.session_id.description).toBe('Session UUID')
    expect(json.properties.pattern.minLength).toBe(1)
    expect(json.properties.pattern.maxLength).toBe(200)
  })

  it('emits ZodRecord as an open object with a typed value schema', () => {
    const schema = z.object({
      arguments: z
        .record(z.string(), z.string())
        .describe('Prompt argument values')
        .optional()
    })
    const json = zodToJsonSchema(schema) as {
      properties: {
        arguments: {
          type: string
          additionalProperties: { type: string }
          description?: string
        }
      }
      required?: string[]
    }
    // Before this, a record erased to `{}`: no type and no description, so the
    // model saw nothing at all for the argument.
    expect(json.properties.arguments).toEqual({
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Prompt argument values'
    })
    expect(json.required).toBeUndefined()
  })

  it('throws on an unsupported nested type instead of erasing it to {}', () => {
    const schema = z.object({ mode: z.union([z.literal('a'), z.literal('b')]) })
    expect(() => zodToJsonSchema(schema)).toThrow(/ZodUnion.*\(root\)\.mode/)
  })
})

describe('shipped schemas', () => {
  /** Every `{}` in a tool schema is an argument the model gets no guidance for. */
  function emptyPaths(node: unknown, path: string, out: string[]): void {
    if (!node || typeof node !== 'object') return
    const o = node as Record<string, unknown>
    if (Object.keys(o).length === 0) {
      out.push(path)
      return
    }
    const props = o.properties as Record<string, unknown> | undefined
    if (props) for (const [k, v] of Object.entries(props)) emptyPaths(v, `${path}.${k}`, out)
    if (o.items) emptyPaths(o.items, `${path}[]`, out)
    if (o.additionalProperties && typeof o.additionalProperties === 'object') {
      emptyPaths(o.additionalProperties, `${path}.*`, out)
    }
  }

  it('converts every builtin tool and the compaction schema with nothing erased', () => {
    const empties: string[] = []
    for (const tool of AGENT_TOOLS) emptyPaths(tool.parameters, tool.name, empties)
    emptyPaths(toCompactionJsonSchema(), 'compaction', empties)
    expect(empties).toEqual([])
    // Non-vacuous: the registry really was walked.
    expect(AGENT_TOOLS.length).toBeGreaterThan(50)
  })
})
