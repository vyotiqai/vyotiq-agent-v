import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logger } from '@shared/logger'
import { isReactMaxUpdateDepth } from '@renderer/logging/reactMaxUpdateDepth'
import { shouldLogErrorSignature } from '@renderer/logging/errorLogRateLimiter'
import { handleStaleChunkFailure, rearmStaleChunkReload, reloadWindow } from './staleChunk'
import { Button } from './ui'

type Props = {
  children: ReactNode
  /** Optional heading when this boundary catches an error. */
  title?: string
  /** When this value changes, a caught error is cleared so children can remount cleanly. */
  resetKey?: string | number
}

type State = {
  error: Error | null
  /** A stale-chunk reload is scheduled — show a calm notice, not the crash UI. */
  reloading: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reloading: false }

  static getDerivedStateFromError(error: Error): State {
    return { error, reloading: false }
  }

  componentDidUpdate(prevProps: Props): void {
    if (this.state.error && !this.state.reloading && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // A rebuild replaced out/ under the running window. It logs its own record
    // either way: a rebuild is not a crash, and must not reach logger.fatal —
    // main turns that into a crash-history snippet and Sentry ships it as a
    // renderer crash.
    const stale = handleStaleChunkFailure(error)
    if (stale === 'reloading') {
      this.setState({ reloading: true })
      return
    }
    if (stale === 'exhausted') return
    const is185 = isReactMaxUpdateDepth(error.message)
    const code = is185 ? 'REACT_185' : 'RENDERER_CRASH'
    // A render loop throws repeatedly — log one record per signature window or
    // the renderer→main log bridge floods the main process (OOM amplifier).
    const decision = shouldLogErrorSignature(`${code}\u0000${error.message}`)
    if (!decision.log) return
    logger.fatal(is185 ? 'React maximum update depth (#185)' : 'Renderer crash', {
      scope: 'renderer',
      code,
      ...(decision.suppressed > 0 ? { suppressedRepeats: decision.suppressed } : {}),
      componentStack: info.componentStack?.slice(0, is185 ? 4000 : 500),
      err: error
    })
  }

  private reload = (): void => {
    rearmStaleChunkReload()
    reloadWindow()
  }

  private openLogs = (): void => {
    void window.vyotiq?.openLogsDir?.()
  }

  private tryAgain = (): void => {
    this.setState({ error: null, reloading: false })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

    if (this.state.reloading) {
      return (
        <div
          className="flex h-full flex-col items-center justify-center gap-2 bg-bg px-6 text-center text-fg"
          role="status"
        >
          <p className="m-0 text-sm leading-snug text-secondary">
            A new build replaced this one — reloading the window.
          </p>
        </div>
      )
    }

    const title = this.props.title ?? 'Something went wrong'

    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-4 bg-bg px-6 text-center text-fg"
        role="alert"
      >
        <h1 className="m-0 text-title tracking-[-0.02em] text-fg-strong">{title}</h1>
        <p className="m-0 max-w-md text-sm leading-snug text-secondary">
          The UI hit an unexpected error. You can try again, reload the window, or open the local
          logs folder for details. Chat contents and API keys are not included in crash reports.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="subtle" onClick={this.tryAgain}>
            Try again
          </Button>
          <Button variant="subtle" onClick={this.reload}>
            Reload
          </Button>
          <Button variant="subtle" onClick={this.openLogs}>
            Open logs
          </Button>
        </div>
      </div>
    )
  }
}
