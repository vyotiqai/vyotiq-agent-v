import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App'
import { ErrorBoundary } from '@renderer/lib/ErrorBoundary'
import { initRendererLogging } from './logging/init'
import { initRendererSentry } from './logging/sentry'
import { installRendererErrorHandlers, reportUncaughtRendererError } from './logging/handlers'
import './styles.css'

async function boot(): Promise<void> {
  try {
    await initRendererLogging()
  } catch (err) {
    console.warn('[boot] renderer logging init failed; continuing', err)
  }
  installRendererErrorHandlers()

  let telemetryEnabled = false
  try {
    const res = await window.vyotiq?.getSettings?.()
    if (res?.ok) telemetryEnabled = res.data.telemetryEnabled === true
  } catch {
    // ignore — logger still works locally
  }
  initRendererSentry(telemetryEnabled)

  createRoot(document.getElementById('root')!, {
    onUncaughtError: (error, errorInfo) => {
      reportUncaughtRendererError(error, errorInfo.componentStack)
    }
  }).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>
  )
}

void boot()
