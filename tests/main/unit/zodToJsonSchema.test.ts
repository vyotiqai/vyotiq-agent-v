import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodToJsonSchema } from '@main/agent/schemas/zodToJsonSchema'

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
})
