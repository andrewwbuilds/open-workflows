export function generateId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}_${random}`
}

export function nowIso(): string {
  return new Date().toISOString()
}
