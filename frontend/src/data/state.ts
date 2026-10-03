import type { EntryRow, ModuleMeta } from './types'

// 待办（pending）与异常（abnormal）一律由「当前状态」派生：
// 之前用「目标状态是不是最后一个状态」反推，导致物资确认失败也丢待办、
// 种子数据里「充足」反而是待办。各模块哪些状态算待办在此集中登记。

const PENDING_STATUSES: Record<string, ReadonlySet<string>> = {
  patrol: new Set(['待执行', '执行中']),
  firewatch: new Set(['蓝色预警', '黄色预警', '橙色预警', '红色预警']),
  lookout: new Set(['临时关闭', '设备故障', '维修中']),
  firebreak: new Set(['需割草', '需补植']),
  fireteam: new Set(['已出动', '扑救中', '休整中']),
  equipment: new Set(['已领用', '待检修']),
  weather: new Set(['已录入', '已审核', '异常值']),
  firereport: new Set(['待核实', '已确认', '已出警']),
  drone: new Set(['待执行', '飞行中', '因故中止']),
  campaign: new Set(['待开展', '进行中']),
  checkpoint: new Set(['临时关闭', '升级检查', '等待换岗']),
  duty: new Set(['待确认', '值勤中', '已交接', '已调班']),
  supply: new Set(['偏低', '补充中', '需补充']),
  forestroad: new Set(['需维护', '正在施工']),
  firebelt: new Set(['有缺株', '需补植']),
  drill: new Set(['待筹备', '筹备中', '已实施', '已总结']),
  burnpermit: new Set(['待申请', '待审批']),
  treegrowth: new Set(['已录入', '已审核', '需复核']),
}

// 「天然异常」的状态：物资一旦「已过期」，无论经哪条路径都按异常处理。
// 其它模块的异常来自「撤销/作废」等负向动作，沿用动作写入的标记，不在此强推。
const ABNORMAL_STATUSES: Record<string, ReadonlySet<string>> = {
  supply: new Set(['已过期']),
}

export function isPending(meta: ModuleMeta, status: string): boolean {
  const set = PENDING_STATUSES[meta.key]
  // 没登记分类时沿用旧约定：走到最后一个状态就结案，否则仍是待办。
  return set ? set.has(status) : status !== meta.statuses[meta.statuses.length - 1]
}

export function isAbnormal(meta: ModuleMeta, status: string): boolean {
  return ABNORMAL_STATUSES[meta.key]?.has(status) ?? false
}

// 读盘 / 写入时统一重算 pending：历史 localStorage 数据不必手工迁移，
// 其它模块「消失 / 错乱的待办」在下次读取时即按状态恢复。
export function normalizeRow(meta: ModuleMeta, row: EntryRow): EntryRow {
  const status = String(row.status ?? '')
  const { pending: _pending, abnormal: oldAbnormal, ...business } = row
  return {
    ...business,
    status,
    pending: isPending(meta, status),
    abnormal: isAbnormal(meta, status) || (!ABNORMAL_STATUSES[meta.key] && Boolean(oldAbnormal)),
  }
}
