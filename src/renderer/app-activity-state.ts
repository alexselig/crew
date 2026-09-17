export function applyAppActivity(
  next: boolean,
  synchronize: readonly ((active: boolean) => void)[],
  publish: (active: boolean) => void
): void {
  for (const sync of synchronize) sync(next)
  publish(next)
}
