/** React error #185 — nested setState / useEffect update loops. */

export function isReactMaxUpdateDepth(message: string): boolean {
  if (!message) return false
  if (/maximum update depth exceeded/i.test(message)) return true
  // React 18/19 minified: "Minified React error #185" (and older "Minified React error #185").
  if (/minified react error #185\b/i.test(message)) return true
  if (/react error #185\b/i.test(message)) return true
  return false
}

export function errorMessageFromUnknown(err: unknown): string {
  if (err == null) return ''
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  if (typeof err === 'object') {
    const o = err as { message?: unknown; error?: unknown; value?: unknown; reason?: unknown }
    if (typeof o.message === 'string') return o.message
    if (o.error != null) return errorMessageFromUnknown(o.error)
    if (o.value != null) return errorMessageFromUnknown(o.value)
    if (o.reason != null) return errorMessageFromUnknown(o.reason)
  }
  return String(err)
}

export function componentStackFromUnknown(err: unknown, depth = 0): string | undefined {
  if (depth > 4 || err == null || typeof err !== 'object') return undefined
  const o = err as {
    componentStack?: unknown
    error?: unknown
    value?: unknown
    reason?: unknown
    cause?: unknown
  }
  if (typeof o.componentStack === 'string' && o.componentStack.length > 0) {
    return o.componentStack
  }
  for (const nested of [o.error, o.value, o.reason, o.cause]) {
    const stack = componentStackFromUnknown(nested, depth + 1)
    if (stack) return stack
  }
  return undefined
}
