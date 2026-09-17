export class ReplayValue<T> {
  private readonly listeners = new Set<(value: T) => void>()

  constructor(private value: T) {}

  publish(value: T): void {
    this.value = value
    for (const listener of this.listeners) listener(value)
  }

  subscribe(listener: (value: T) => void): () => void {
    listener(this.value)
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
