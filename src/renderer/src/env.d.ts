/// <reference types="vite/client" />

import type { VyotiqApi } from '@shared/vyotiqApi'

interface ImportMetaEnv {
  readonly DEV: boolean
  readonly PROD: boolean
  readonly VITE_SENTRY_DSN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare global {
  interface Window {
    vyotiq: VyotiqApi
  }
}

export {}
