import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logger } from '@shared/logger'
import { isReactMaxUpdateDepth } from '@renderer/logging/reactMaxUpdateDepth'
import { shouldLogErrorSignature } from '@renderer/logging/errorLogRateLimiter'
import {
  isStaleChunkFailure,
  rearmStaleChunkReload,
  reloadWindow,
  takeStaleChunkReload
} from './staleChunk'
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
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prevProps: Props): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (isStaleChunkFailure(error) && takeStaleChunkReload()) {
      // A rebuild replaced out/ under the running window; the new build is
      // already on disk — one reload re-enters on the fresh entry chunk.
      logger.warn('Stale renderer chunk after rebuild — reloading window', {
        scope: 'renderer',
        code: 'STALE_CHUNK'
      })
      reloadWindow()
      return
    }
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
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

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
