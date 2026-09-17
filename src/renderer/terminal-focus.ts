interface FocusEngine {
  onFocus(cb: () => void): { dispose(): void }
}

export class TerminalFocusRegistry {
  private lastFocusedSessionId: string | null = null
  private readonly boundEngines = new WeakSet<FocusEngine>()

  bind(sessionId: string, engine: FocusEngine): void {
    if (this.boundEngines.has(engine)) return
    engine.onFocus(() => {
      this.lastFocusedSessionId = sessionId
    })
    this.boundEngines.add(engine)
  }

  isLastFocused(sessionId: string): boolean {
    return this.lastFocusedSessionId === sessionId
  }

  shouldRestore(sessionId: string, mounted: boolean, focusLostToBody: boolean): boolean {
    return this.isLastFocused(sessionId) && mounted && focusLostToBody
  }
}
