import type { NovaApi } from '../core/types'

declare global {
  interface Window {
    nova: NovaApi & {
      win: {
        minimize(): Promise<void>
        toggleMaximize(): Promise<void>
        close(): Promise<void>
      }
    }
  }
}

export {}
