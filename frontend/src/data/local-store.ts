import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import { normalizeRow } from './state'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalize(records: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const normalized: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(records)) {
    const meta = MODULE_BY_KEY.get(key)
    normalized[key] = meta ? rows.map((row) => normalizeRow(meta, row)) : rows
  }
  return normalized
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = normalize(clone(SEED_ROWS))
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 种子里新增的模块也要带上，并对历史数据统一做一次待办 / 异常归一。
    return normalize({ ...clone(SEED_ROWS), ...parsed })
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

function persist(next: Record<string, EntryRow[]>): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  persist({ ...allRows(), [key]: rows })
}

// 原子地改一条模块数据：回调拿到当前数组快照，返回新数组后整体落盘，
// 读写之间不穿插别的写入，供补库工作流的「只扣增一次」依赖。
export function mutateRows(
  key: string,
  mutate: (rows: EntryRow[]) => EntryRow[],
): EntryRow[] {
  const meta = MODULE_BY_KEY.get(key)
  const current = listRows(key)
  const changed = mutate(current)
  const normalized = meta ? changed.map((row) => normalizeRow(meta, row)) : changed
  persist({ ...allRows(), [key]: normalized })
  return normalized
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// 主要给测试用：丢掉内存缓存，下次读取重新走播种 / 读盘逻辑。
export function resetCache(): void {
  cache = null
}

export function storageKey(): string {
  return STORAGE_KEY
}
