import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionPayload, ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 列表里的状态列（最后一个带「状态」的字段），流转时与 status 一起改，列表和流转结果才对得上。
function statusFieldOf(meta: ModuleMeta): string | null {
  for (let i = meta.fields.length - 1; i >= 0; i -= 1) {
    if (meta.fields[i].includes('状态')) {
      return meta.fields[i]
    }
  }
  return null
}

function toAmount(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

type SupplyVerdict =
  | { ok: true; abnormal: boolean; patch: Partial<EntryRow> }
  | { ok: false; message: string }

// 物资储备的流转校验与数值补丁。
// 校验优先级：过期异常 > 现场盘点冲突 > 越界数量。
// 过期物资直接关系安全，一票否决；盘点冲突说明处理抽屉里的快照已过期，
// 基于旧快照填的数量没有意义，所以冲突先于数量校验。
// 任何一步不通过都原样返回、不落库：实际储备量不变、待办不丢，修正后从原步骤重试即可。
function supplyTransition(row: EntryRow, action: string, payload?: ActionPayload): SupplyVerdict {
  const current = String(row.status)
  if (action === '发起补充') {
    if (current === '已过期') {
      return { ok: false, message: '防火物资已过期，先处理过期异常，不能发起补充' }
    }
    if (current !== '偏低') {
      return { ok: false, message: `只有库存「偏低」的防火物资需要发起补充，当前状态「${current}」` }
    }
    const before = toAmount(row['实际储备量'])
    const warning = toAmount(row['预警储备量'])
    if (before === null || warning === null) {
      return { ok: false, message: '储备量不是有效数字，先修正库存台账再发起补充' }
    }
    const planned = warning - before
    if (planned <= 0) {
      return { ok: false, message: `实际储备量 ${before} 未低于预警储备量 ${warning}，无需补充` }
    }
    // 在途补充任务随状态一起落库：中途关掉页面，回来仍是「需补充」，从确认步骤接续。
    return { ok: true, abnormal: false, patch: { 补充前储备量: before, 计划补充量: planned } }
  }
  if (action === '确认补充') {
    if (current === '已过期') {
      return { ok: false, message: '防火物资已过期，过期异常未处理前不能完成补充' }
    }
    if (current !== '需补充') {
      return { ok: false, message: `防火物资不在补充流程中（当前「${current}」），请先发起补充` }
    }
    if (payload?.expectedVersion !== undefined && Number(row.version) !== Number(payload.expectedVersion)) {
      return { ok: false, message: '现场盘点已变更，与处理抽屉里的快照对不上，请重新读取后再确认' }
    }
    const snapshot = toAmount(row['补充前储备量'])
    const actual = toAmount(row['实际储备量'])
    if (snapshot !== null && actual !== null && snapshot !== actual) {
      return { ok: false, message: `现场盘点冲突：台账实际储备量 ${actual} 与补充前快照 ${snapshot} 不一致，请重新盘点` }
    }
    const before = snapshot ?? actual
    if (before === null) {
      return { ok: false, message: '补充前储备量缺失，请重新发起补充' }
    }
    const quantity = toAmount(payload?.quantity)
    if (quantity === null || quantity <= 0) {
      return { ok: false, message: '补充数量越界：必须是大于 0 的数字，本次确认未改动任何数据' }
    }
    const after = before + quantity
    // 补充前后数值、状态、待办在同一个补丁里，随一次 saveRows 落账。
    return {
      ok: true,
      abnormal: false,
      patch: { 实际储备量: after, 补充前储备量: before, 补充后储备量: after, 实际补充量: quantity },
    }
  }
  if (action === '标记过期') {
    // 过期物资仍是待办：要处置，不能从待办里悄悄消失。
    return { ok: true, abnormal: true, patch: {} }
  }
  return { ok: true, abnormal: false, patch: {} }
}

export function runAction(key: string, id: number, action: string, payload?: ActionPayload): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  let patch: Partial<EntryRow> = {}
  let abnormal = NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))
  if (key === 'supply') {
    const verdict = supplyTransition(rows[index], action, payload)
    if (!verdict.ok) {
      // 校验失败：一行都不写，储备量与待办保持原样。
      return { ok: false, message: verdict.message }
    }
    patch = verdict.patch
    abnormal = verdict.abnormal
  }
  const statusField = statusFieldOf(meta)
  const updated: EntryRow = {
    ...rows[index],
    ...patch,
    status: target,
    pending: !meta.closedStatuses.includes(target),
    abnormal,
    version: Number(rows[index].version ?? 0) + 1,
  }
  if (statusField) {
    updated[statusField] = target
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 两个林场可能同时补库：有 Web Locks 就把「读-改-写」跨标签页串行化，
// 配合版本比对，同一笔扣增只会落一次；环境不支持时退化为直接执行。
type LockLike = { request<T>(name: string, callback: () => Promise<T>): Promise<T> }

export function runActionLocked(
  key: string,
  id: number,
  action: string,
  payload?: ActionPayload,
): Promise<ActionResult> {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockLike }).locks : undefined
  if (!locks) {
    return Promise.resolve(runAction(key, id, action, payload))
  }
  return locks.request(`forest-fire-patrol:${key}`, async () => runAction(key, id, action, payload))
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
