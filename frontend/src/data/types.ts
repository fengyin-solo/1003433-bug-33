/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

// 物资补充工作流：拆成 3 个可接续的步骤，每一步落盘，中断后从 step 指示的步骤继续。
export type ReplenishStep = 1 | 2 | 3

// 现场盘点结果（第 2 步）：counted 为现场实盘数；与台账不一致时 resolveConflict
// 决定以哪边为准（ignore 保留差异，以台账数量继续）。
export type StocktakeInput = {
  counted: number
  note?: string
  resolveConflict?: 'site' | 'ledger' | 'ignore'
}

export type ReplenishWorkflow = {
  id: number
  supplyId: number
  forest: string
  operator: string
  step: ReplenishStep
  // 补充前数量在发起时（第 1 步）就定格，后续任何重试都不允许改写。
  beforeQty: number
  warnQty: number
  plannedQty: number
  // 现场实盘与台账实际储备量的快照：列表与处理抽屉读同一份。
  ledgerQty: number
  countedQty: number | null
  // 第 3 步真正扣增：applied 一旦置位，重复确认直接短路，保证只扣增一次。
  applied: boolean
  conflict: boolean
  conflictResolved: boolean
  conflictNote: string
  expireDate: string
  failReason: string
  createdAt: string
  updatedAt: string
  // 补充成功后定格补充后数量，与 beforeQty 一起长期保存（补充前后同时保存）。
  afterQty: number | null
  finished: boolean
  history: { at: string; step: ReplenishStep; event: string; qty?: number }[]
}

export type ReplenishResult = {
  ok: boolean
  message: string
  workflow?: ReplenishWorkflow
  row?: EntryRow
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
