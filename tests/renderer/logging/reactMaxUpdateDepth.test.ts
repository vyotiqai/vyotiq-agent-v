import { describe, expect, it } from 'vitest'
import {
  componentStackFromUnknown,
  errorMessageFromUnknown,
  isReactMaxUpdateDepth
} from '@renderer/logging/reactMaxUpdateDepth'

describe('isReactMaxUpdateDepth', () => {
  it('matches minified React 19 #185', () => {
    expect(
      isReactMaxUpdateDepth(
        'Minified React error #185; visit https://react.dev/errors/185 for the full message'
      )
    ).toBe(true)
  })

  it('matches the development maximum-update-depth message', () => {
    expect(
      isReactMaxUpdateDepth(
        'Maximum update depth exceeded. This can happen when a component repeatedly calls setState inside componentWillUpdate or componentDidUpdate.'
      )
    ).toBe(true)
  })

  it('ignores unrelated errors', () => {
    expect(isReactMaxUpdateDepth('Minified React error #310')).toBe(false)
    expect(isReactMaxUpdateDepth('boom')).toBe(false)
  })
})

describe('componentStackFromUnknown', () => {
  it('reads nested componentStack on a rejection reason', () => {
    const reason = {
      message: 'Minified React error #185',
      error: { componentStack: '\n    at ToolCard\n    at MessageList' }
    }
    expect(componentStackFromUnknown(reason)).toContain('ToolCard')
    expect(errorMessageFromUnknown(reason)).toContain('#185')
  })
})
