import { listRows, mutateRows } from '@/data/local-store'
import { SEED_REPLENISH_TASKS } from '@/data/seed'
import type {
  EntryRow,
  ReplenishResult,
  ReplenishStep,
  ReplenishWorkflow,
  StocktakeInput,
} from '@/data/types'

// 物资补充是一条独立工作流（发起 → 现场盘点 → 确认入帐），不走通用动作流转：
// 通用流转只改状态、从不改数量，正是「补充成功数量却不变」「失败重试丢待办」的根源。

const SUPPLY_KEY = 'supply'
const TASK_STORAGE_KEY = 'forest-fire-patrol:replenish-tasks'

const ALLOWED_START_STATUSES = new Set(['偏低', '需补充', '补充中'])
const COUNT_TOLERANCE = 0.1
const MAX_QTY = 100000

function now(): string {
  return new Date().toISOString()
}

function toInt(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : Number.NaN
  }
  const text = String(value ?? '').trim()
  if (text === '') {
    return Number.NaN
  }
  return Number(text)
}

function isExpired(dateText: string, today = new Date()): boolean {
  if (!dateText) {
    return false
  }
  const expire = new Date(`${dateText}T00:00:00`)
  if (Number.isNaN(expire.getTime())) {
    return false
  }
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return expire.getTime() < day.getTime()
}

// 现场盘点冲突：差异超过台账量的 10% 才算冲突；台账为 0 时有 1 件差异即冲突，
// 正常清点零头不打断流程。
function detectConflict(ledger: number, counted: number): boolean {
  const diff = Math.abs(ledger - counted)
  if (diff === 0) {
    return false
  }
  if (ledger === 0) {
    return true
  }
  return diff > ledger * COUNT_TOLERANCE
}

// ---------- 任务持久化：与业务数据一样落在 localStorage，刷新 / 中断后仍可接续 ----------

// 浏览器用 localStorage；非浏览器环境（测试 / SSR）退到内存，逻辑保持一致。
const memoryStorage = new Map<string, string>()
function storageGet(key: string): string | null {
  const ls = (globalThis as { localStorage?: Pick<Storage, 'getItem'> }).localStorage
  if (ls) {
    return ls.getItem(key)
  }
  return memoryStorage.has(key) ? memoryStorage.get(key)! : null
}
function storageSet(key: string, value: string): void {
  const ls = (globalThis as { localStorage?: Pick<Storage, 'setItem'> }).localStorage
  if (ls) {
    ls.setItem(key, value)
  } else {
    memoryStorage.set(key, value)
  }
}

function supplyExists(supplyId: number): boolean {
  return listRows(SUPPLY_KEY).some((row) => Number(row.id) === supplyId)
}

function readTasks(): ReplenishWorkflow[] {
  const raw = storageGet(TASK_STORAGE_KEY)
  if (!raw) {
    // 首次打开：播种一条中断在第 2 步的示例任务，引用的物资行不存在则不种。
    const seeded = SEED_REPLENISH_TASKS.filter((task) => supplyExists(task.supplyId))
    if (seeded.length) {
      storageSet(TASK_STORAGE_KEY, JSON.stringify(seeded))
    }
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as ReplenishWorkflow[]
    if (!Array.isArray(parsed)) {
      return []
    }
    // 过滤掉引用已删除物资的孤儿任务。
    return parsed.filter((task) => supplyExists(task.supplyId))
  } catch {
    return []
  }
}

function writeTasks(tasks: ReplenishWorkflow[]): void {
  storageSet(TASK_STORAGE_KEY, JSON.stringify(tasks))
}

function saveTask(task: ReplenishWorkflow): ReplenishWorkflow {
  const tasks = readTasks()
  const index = tasks.findIndex((item) => item.id === task.id)
  task.updatedAt = now()
  if (index >= 0) {
    tasks[index] = task
  } else {
    tasks.push(task)
  }
  writeTasks(tasks)
  return task
}

// ---------- 查询 ----------

export function listReplenishTasks(): ReplenishWorkflow[] {
  return readTasks()
    .filter((task) => !task.finished)
    .sort((a, b) => a.id - b.id)
}

export function getReplenishTask(supplyId: number): ReplenishWorkflow | undefined {
  // find 可能先命中已归档的旧单，必须只在「未完成」任务里找，
  // 否则补充成功后再确认会误拿旧单重新扣增。
  return listReplenishTasks().find((task) => task.supplyId === supplyId)
}

// 含已归档任务：抽屉重开时仍要展示「补充前 / 补充后」数量与处理记录。
export function getLatestReplenishTask(supplyId: number): ReplenishWorkflow | undefined {
  return readTasks()
    .filter((task) => task.supplyId === supplyId)
    .sort((a, b) => b.id - a.id)[0]
}

// 第 1 步 → 第 2 步的推进也落盘：任务在任意环节被中断，重开都从原步骤接续。
export function enterStocktake(supplyId: number): ReplenishResult {
  const task = getReplenishTask(supplyId)
  const row = findRow(supplyId)
  if (!task) {
    return { ok: false, message: '该物资没有进行中的补充，请先发起补充', row }
  }
  if (task.applied) {
    return { ok: false, message: '该补充已入库', workflow: task, row }
  }
  if (task.step < 2) {
    task.step = 2
    task.history.push({ at: now(), step: 2, event: '进入现场盘点' })
    saveTask(task)
  }
  return { ok: true, message: '请录入现场实盘数量', workflow: task, row }
}

function findRow(supplyId: number): EntryRow | undefined {
  return listRows(SUPPLY_KEY).find((row) => Number(row.id) === supplyId)
}

// ---------- 第 1 步：发起补充 ----------
//
// 校验优先级（由高到低，命中即拦截）：
//   1. 过期异常：已过期物资禁止补充，须先复检 / 换新（过期了再补只会掩盖风险）。
//   2. 现场盘点冲突：已在途任务且盘点冲突未裁决的，先处理冲突再往下。
//   3. 越界数量：补充数量必须为非负整数，且不超过上限（数值本身的问题优先级最低）。

export type StartInput = {
  supplyId: number
  quantity: number | string
  forest: string
  operator: string
}

export function startReplenish(input: StartInput, today = new Date()): ReplenishResult {
  const row = findRow(input.supplyId)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${input.supplyId} 的防火物资` }
  }

  // 已存在在途任务：两个林场并发补同一物资时，只允许第一个发起，
  // 第二个拿到锁失败，不会产生第二笔扣增。
  const existing = getReplenishTask(input.supplyId)
  if (existing) {
    if (existing.applied) {
      return {
        ok: false,
        message: `该物资的补充（单号 ${existing.id}）已完成入库，请勿重复补充`,
        workflow: existing,
        row,
      }
    }
    return {
      ok: false,
      message: `该物资已有进行中的补充（单号 ${existing.id}，当前第 ${existing.step} 步），请从原步骤接续`,
      workflow: existing,
      row,
    }
  }

  const status = String(row.status)
  if (!ALLOWED_START_STATUSES.has(status)) {
    if (status === '已过期') {
      return { ok: false, message: '物资已过期，不能发起补充，请先复检或换新后再处理', row }
    }
    if (status === '充足') {
      return { ok: false, message: '物资储备充足，无需补充', row }
    }
    return { ok: false, message: `当前状态「${status}」不能发起补充`, row }
  }

  // 过期日期硬拦截（第 1 优先级）：即便状态没来得及标「已过期」，日期过了也拦住。
  const expireDate = String(row['过期日期'] ?? '')
  if (isExpired(expireDate, today)) {
    return { ok: false, message: '物资已过有效期，不能发起补充，请先复检或换新', row }
  }

  // 越界数量（第 3 优先级）。
  const quantity = toInt(input.quantity)
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { ok: false, message: '补充数量必须是大于 0 的整数', row }
  }
  if (quantity > MAX_QTY) {
    return { ok: false, message: `补充数量超出上限（${MAX_QTY}），请核对后重试`, row }
  }

  const beforeQty = toInt(row['实际储备量'])
  const warnQty = toInt(row['预警储备量'])

  // 在一次原子写入里建任务 + 置「补充中」：行即锁，后续并发发起都会被上面的在途检查挡住。
  const task: ReplenishWorkflow = {
    id: nextTaskId(),
    supplyId: input.supplyId,
    forest: input.forest.trim(),
    operator: input.operator.trim(),
    step: 1,
    beforeQty,
    warnQty,
    plannedQty: quantity,
    ledgerQty: beforeQty,
    countedQty: null,
    applied: false,
    conflict: false,
    conflictResolved: false,
    conflictNote: '',
    expireDate,
    failReason: '',
    createdAt: now(),
    updatedAt: now(),
    afterQty: null,
    finished: false,
    history: [{ at: now(), step: 1, event: `发起补充 ${quantity} 件，补充前库存 ${beforeQty} 件` }],
  }

  mutateRows(SUPPLY_KEY, (rows) =>
    rows.map((item) =>
      Number(item.id) === input.supplyId
        ? { ...item, status: '补充中', 储备林场: task.forest || String(item['储备林场'] ?? '') }
        : item,
    ),
  )
  saveTask(task)

  return {
    ok: true,
    message: `补充单 ${task.id} 已发起，补充前库存 ${beforeQty} 件，请进行现场盘点`,
    workflow: task,
    row: findRow(input.supplyId),
  }
}

// ---------- 第 2 步：现场盘点 ----------

export function submitStocktake(supplyId: number, input: StocktakeInput): ReplenishResult {
  const task = getReplenishTask(supplyId)
  const row = findRow(supplyId)
  if (!task) {
    return { ok: false, message: '该物资没有进行中的补充，请先发起补充', row }
  }
  if (task.applied) {
    return { ok: false, message: '该补充已入库，无需重复盘点', workflow: task, row }
  }

  const counted = toInt(input.counted)
  if (!Number.isInteger(counted) || counted < 0) {
    return { ok: false, message: '现场盘点数量必须是非负整数', workflow: task, row }
  }

  // 以补充前定格的台账数量做比对，不被中途任何写入污染。
  const conflict = detectConflict(task.ledgerQty, counted)
  const resolution = input.resolveConflict ?? 'ignore'

  // 有冲突且未裁决：停在第 2 步，待办保留，不允许进第 3 步。
  if (conflict && !['site', 'ledger'].includes(resolution)) {
    task.step = 2
    task.countedQty = counted
    task.conflict = true
    task.conflictResolved = false
    task.conflictNote = input.note ?? ''
    task.failReason = `现场盘点 ${counted} 件与台账 ${task.ledgerQty} 件不一致，请裁决后再确认`
    task.history.push({
      at: now(),
      step: 2,
      event: `盘点发现冲突：实盘 ${counted} 件 / 台账 ${task.ledgerQty} 件，等待裁决`,
    })
    saveTask(task)
    return { ok: false, message: task.failReason, workflow: task, row }
  }

  if (conflict) {
    task.conflict = true
    task.conflictResolved = true
    if (resolution === 'site') {
      // 以现场实盘为准：先把台账对齐实盘，再在实盘基础上扣增。
      task.ledgerQty = counted
    }
    task.conflictNote = input.note ?? task.conflictNote
    task.history.push({
      at: now(),
      step: 2,
      event:
        resolution === 'site'
          ? `冲突已按现场实盘裁决，台账对齐为 ${counted} 件`
          : `冲突已按台账裁决，维持 ${task.ledgerQty} 件`,
    })
  } else {
    task.conflict = false
    task.history.push({ at: now(), step: 2, event: `现场盘点 ${counted} 件，与台账一致` })
  }

  task.countedQty = counted
  task.failReason = ''
  task.step = 3
  task.history.push({ at: now(), step: 3, event: '盘点完成，等待确认入帐' })
  saveTask(task)

  return { ok: true, message: '现场盘点完成，请确认补充入帐', workflow: task, row }
}

// ---------- 第 3 步：确认入帐（只允许扣增一次） ----------
//
// 失败（越界数量等）时：库存不动、任务停在第 3 步、待办保留，可原地重试，
// 不会出现「数量不变、待办却没了」。

export function confirmReplenish(supplyId: number, quantity?: number | string): ReplenishResult {
  const task = getReplenishTask(supplyId)
  const row = findRow(supplyId)
  if (!task) {
    // 最近一单已完成：明确告知已入帐，不允许再次扣增（幂等短路，只扣增一次）。
    const latest = getLatestReplenishTask(supplyId)
    if (latest?.finished) {
      return {
        ok: false,
        message: `补充单 ${latest.id} 已入帐（${latest.beforeQty} → ${latest.afterQty} 件），无需重复确认`,
        workflow: latest,
        row,
      }
    }
    return { ok: false, message: '该物资没有进行中的补充，请先发起补充', row }
  }

  // 幂等闸门：同一补充单无论确认多少次，数量只扣增一次。
  if (task.applied) {
    return {
      ok: false,
      message: `补充单 ${task.id} 已入帐（${task.beforeQty} → ${task.afterQty} 件），无需重复确认`,
      workflow: task,
      row,
    }
  }

  if (task.step < 2) {
    return { ok: false, message: '请先完成现场盘点，再确认入帐', workflow: task, row }
  }
  if (task.conflict && !task.conflictResolved) {
    return { ok: false, message: task.failReason || '现场盘点冲突未裁决，请先处理冲突', workflow: task, row }
  }

  // 允许确认时修正本次补充数量（仍走越界校验，最低优先级）。
  let qty = task.plannedQty
  if (quantity !== undefined) {
    qty = toInt(quantity)
    if (!Number.isInteger(qty) || qty <= 0) {
      task.step = 3
      task.failReason = '补充数量必须是大于 0 的整数'
      task.history.push({ at: now(), step: 3, event: '确认失败：补充数量越界，库存未变，可重试' })
      saveTask(task)
      return { ok: false, message: task.failReason, workflow: task, row }
    }
    if (qty > MAX_QTY) {
      task.step = 3
      task.failReason = `补充数量超出上限（${MAX_QTY}）`
      saveTask(task)
      return { ok: false, message: task.failReason, workflow: task, row }
    }
    task.plannedQty = qty
  }

  // 过期复检（盘点与确认之间可能临期）：过期为最高优先级，直接拦下且不动库存。
  if (isExpired(task.expireDate)) {
    task.step = 3
    task.failReason = '物资已过有效期，补充终止，请先复检或换新'
    task.history.push({ at: now(), step: 3, event: '确认失败：物资已过期，库存未变' })
    saveTask(task)
    return { ok: false, message: task.failReason, workflow: task, row }
  }

  // 原子扣增：以任务定格的台账量为唯一基底。
  // 若冲突按「现场实盘」裁决（实盘低于台账），先把行内数量对齐实盘（盘点盘亏），
  // 再在对齐后的数量上扣增；不能用 max() 把盘亏补回来，否则同一次补充会多出货。
  const baseQty = task.ledgerQty
  const adjustLoss =
    task.conflict && task.conflictResolved && baseQty < task.beforeQty
      ? task.beforeQty - baseQty
      : 0
  let afterQty = 0
  let updatedRow: EntryRow | undefined
  mutateRows(SUPPLY_KEY, (rows) =>
    rows.map((item) => {
      if (Number(item.id) !== supplyId) {
        return item
      }
      afterQty = baseQty + qty
      const targetStatus = afterQty >= task.warnQty ? '充足' : '偏低'
      updatedRow = {
        ...item,
        实际储备量: afterQty,
        status: targetStatus,
        物资状态: afterQty > 0 ? '在库' : String(item['物资状态'] ?? '在库'),
      }
      return updatedRow
    }),
  )

  task.applied = true
  task.step = 3
  task.afterQty = afterQty
  task.finished = true
  task.failReason = ''
  if (adjustLoss > 0) {
    task.history.push({
      at: now(),
      step: 3,
      event: `按现场实盘核销盘亏 ${adjustLoss} 件（${task.beforeQty} → ${baseQty}）`,
    })
  }
  task.history.push({
    at: now(),
    step: 3,
    event: `确认入帐：补充前 ${task.beforeQty} 件，补充后 ${afterQty} 件（本次 +${qty}）`,
    qty: afterQty,
  })

  // 归档保存：补充前 / 后数量同时长期保留，列表与抽屉读的是同一条记录。
  const tasks = readTasks()
  const rest = tasks.filter((item) => item.id !== task.id)
  writeTasks([...rest, task])

  return {
    ok: true,
    message: `补充完成：补充前 ${task.beforeQty} 件，补充后 ${afterQty} 件（+${qty}）`,
    workflow: task,
    row: updatedRow,
  }
}

// ---------- 终止在途补充 ----------

export function cancelReplenish(supplyId: number): ReplenishResult {
  const task = readTasks().find((item) => item.supplyId === supplyId && !item.finished)
  const row = findRow(supplyId)
  if (!task) {
    return { ok: false, message: '该物资没有进行中的补充', row }
  }
  if (task.applied) {
    return { ok: false, message: '补充已入库，不能终止', workflow: task, row }
  }
  // 退回补充前状态：按定格的预警量判定「偏低 / 需补充」，库存一字未动。
  const revertStatus = task.beforeQty <= 0 ? '需补充' : task.beforeQty < task.warnQty ? '偏低' : '充足'
  mutateRows(SUPPLY_KEY, (rows) =>
    rows.map((item) =>
      Number(item.id) === supplyId ? { ...item, status: revertStatus } : item,
    ),
  )
  writeTasks(readTasks().filter((item) => item.id !== task.id))
  return {
    ok: true,
    message: `补充单 ${task.id} 已终止，库存维持 ${task.beforeQty} 件`,
    row: findRow(supplyId),
  }
}

// ---------- 标记过期 ----------

export function markExpired(supplyId: number, today = new Date()): ReplenishResult {
  const row = findRow(supplyId)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${supplyId} 的防火物资` }
  }
  if (String(row.status) === '已过期') {
    return { ok: false, message: '该物资已标记为过期', row }
  }
  // 在途补充不能直接标过期：先终止补充，避免锁悬挂。
  const task = getReplenishTask(supplyId)
  if (task && !task.applied) {
    return { ok: false, message: '该物资有进行中的补充，请先终止补充再标记过期', workflow: task, row }
  }

  mutateRows(SUPPLY_KEY, (rows) =>
    rows.map((item) =>
      Number(item.id) === supplyId ? { ...item, status: '已过期', 物资状态: '封存' } : item,
    ),
  )
  return { ok: true, message: '已标记为过期并封存', row: findRow(supplyId) }
}

function nextTaskId(): number {
  const ids = readTasks().map((task) => task.id)
  return ids.length ? Math.max(...ids) + 1 : 1
}

// 页面重新打开时：若物资行是「补充中」却没有在途任务（历史脏数据），
// 状态不可悬空，按数量回退到可发起状态。
export function reconcileOrphanTasks(): void {
  const activeSupplies = new Set(
    readTasks()
      .filter((task) => !task.finished)
      .map((task) => task.supplyId),
  )
  mutateRows(SUPPLY_KEY, (rows) =>
    rows.map((row) => {
      if (String(row.status) !== '补充中' || activeSupplies.has(Number(row.id))) {
        return row
      }
      const qty = toInt(row['实际储备量'])
      const warn = toInt(row['预警储备量'])
      return { ...row, status: qty <= 0 ? '需补充' : qty < warn ? '偏低' : '充足' }
    }),
  )
}

export { isExpired, detectConflict, TASK_STORAGE_KEY }
