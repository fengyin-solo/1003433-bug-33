import { MODULES } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 各模块最后一个带「状态」的字段就是列表里的状态列，要和 status 保持一致。
function statusFieldOf(fields: string[]): string | null {
  for (let i = fields.length - 1; i >= 0; i -= 1) {
    if (fields[i].includes('状态')) {
      return fields[i]
    }
  }
  return null
}

// 历史数据修复：补版本号、按办结状态重算待办、把状态列对齐到 status。
// 旧逻辑把待办算反了（已完成仍是待办、已过期反而办结），读出来就纠正，
// 其它模块的物资待办跟着恢复，概览页的待处理数才回得来。
function migrateRows(rows: Record<string, EntryRow[]>): { rows: Record<string, EntryRow[]>; changed: boolean } {
  let changed = false
  for (const meta of MODULES) {
    const list = rows[meta.key]
    if (!Array.isArray(list)) {
      continue
    }
    const statusField = statusFieldOf(meta.fields)
    for (const row of list) {
      if (typeof row.version !== 'number' || !Number.isFinite(row.version)) {
        row.version = 1
        changed = true
      }
      const pending = !meta.closedStatuses.includes(String(row.status))
      if (row.pending !== pending) {
        row.pending = pending
        changed = true
      }
      if (statusField && row[statusField] !== row.status) {
        row[statusField] = row.status
        changed = true
      }
    }
  }
  return { rows, changed }
}

function persist(rows: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = migrateRows(clone(SEED_ROWS)).rows
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const { rows, changed } = migrateRows({ ...fallback, ...parsed })
    if (changed) {
      persist(rows)
    }
    return rows
  } catch {
    persist(fallback)
    return fallback
  }
}

// 每次读取都回源 localStorage：另一个标签页（另一个林场）的写入要立刻可见，
// 版本比对和现场盘点冲突检测才有意义；不再用内存缓存挡住别人的改动。
export function allRows(): Record<string, EntryRow[]> {
  return readStorage()
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  // 合并写：以最新持久化数据为底，只覆盖本模块，别的林场动过的其它模块不被冲掉。
  const next = { ...readStorage(), [key]: rows }
  persist(next)
}

export function resetRows(key: string): EntryRow[] {
  const { rows } = migrateRows({ [key]: clone(SEED_ROWS[key] ?? []) })
  const list = rows[key] ?? []
  saveRows(key, list)
  return list
}

export function storageKey(): string {
  return STORAGE_KEY
}
