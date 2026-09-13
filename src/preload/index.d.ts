import type { VyotiqApi } from './index'

declare global {
  interface Window {
    vyotiq: VyotiqApi
  }
}

export {}
