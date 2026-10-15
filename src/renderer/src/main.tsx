import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App'
import { ErrorBoundary } from '@renderer/lib/ErrorBoundary'
import { initRendererLogging } from './logging/init'
import { initRendererSentry } from './logging/sentry'
import { installRendererErrorHandlers, reportUncaughtRendererError } from './logging/handlers'
import './styles.css'

/**
 * The voice mini window (docs/voice-mode.md §26.5) loads this same bundle
 * with `#voice-mini`: it draws a mirror of the main window's session and
 * nothing else, so it skips the app's boot (logging, telemetry, settings are
 * the main window's, and their handlers refuse any other window anyway).
 */
async function bootVoiceMini(): Promise<void> {
  const { MiniVoiceApp } = await import('./features/voice/mini/MiniVoiceApp')
  document.title = 'Agent V voice'
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <MiniVoiceApp />
      </ErrorBoundary>
    </StrictMode>
  )
}

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
  // Awaited so a telemetry-on launch renders behind a live client, exactly as
  // the synchronous init did; a telemetry-off launch resolves at once.
  try {
    await initRendererSentry(telemetryEnabled)
  } catch (err) {
    console.warn('[boot] renderer Sentry init failed; continuing', err)
  }

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

if (window.location.hash === '#voice-mini') void bootVoiceMini()
else void boot()
