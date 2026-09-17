export class ReplayValue<T> {
  private readonly listeners = new Set<(value: T) => void>()

  constructor(private value: T) {}

  publish(value: T): void {
    this.value = value
    for (const listener of this.listeners) listener(value)
  }

  current(): T {
    return this.value
  }

  subscribe(listener: (value: T) => void): () => void {
    listener(this.value)
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export function initialAppActivity(args: readonly string[]): boolean {
  const value = args
    .find((arg) => arg.startsWith('--crew-app-active='))
    ?.slice('--crew-app-active='.length)
  return value !== '0'
}
