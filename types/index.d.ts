export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Snapshot = {
  context: { percent?: number }
  rateLimits: readonly Limit[]
  cost?: { usd: number }
  model?: string
  effort?: string
}

declare module 'claude-code' {
  interface PluginState {
    'usage-line': { snapshot: Snapshot | null; isEnabled: boolean; effort: string | null }
  }
}
