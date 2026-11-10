/** Small per-page-session cache for immutable release assets, never live/auth data. */
export function createResourceCache<T>(limit: number) {
  const entries = new Map<string, Promise<T>>()
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key)
    if (hit) {
      entries.delete(key)
      entries.set(key, hit)
      return hit
    }
    const pending = Promise.resolve().then(load).catch(error => {
      if (entries.get(key) === pending) entries.delete(key)
      throw error
    })
    entries.set(key, pending)
    while (entries.size > Math.max(1, limit)) entries.delete(entries.keys().next().value!)
    return pending
  }
}
