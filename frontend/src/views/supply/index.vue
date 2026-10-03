<template>
  <section class="page" data-module="supply">
    <header class="page-head">
      <div>
        <h2>物资储备管理</h2>
        <p class="page-desc">维护防火物资，围绕物资编号、物资名称、物资类别、规格型号做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火物资</button>
        <button class="btn" type="button" @click="exportRows">导出物资储备清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!actionsFor(row).length" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无物资储备数据，可先登记防火物资</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条物资储备记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <template v-if="drawerOpen && drawerRow">
      <div class="drawer-backdrop" @click="closeDrawer" />
      <aside class="drawer">
        <header class="drawer-head">
          <h3 class="drawer-title">确认补充 · {{ drawerRow['物资编号'] }}</h3>
          <button class="link" type="button" @click="closeDrawer">关闭</button>
        </header>
        <div class="drawer-body">
          <div class="drawer-field">
            <span>物资名称</span>
            <strong>{{ drawerRow['物资名称'] }}</strong>
          </div>
          <div class="drawer-field">
            <span>储备林场</span>
            <strong>{{ drawerRow['储备林场'] }}</strong>
          </div>
          <div class="drawer-field">
            <span>补充前储备量</span>
            <strong>{{ drawerBefore }}</strong>
          </div>
          <div class="drawer-field">
            <span>计划补充量</span>
            <strong>{{ drawerRow['计划补充量'] ?? '—' }}</strong>
          </div>
          <label class="drawer-field">
            <span>实际补充量</span>
            <input v-model="quantity" type="number" min="1" step="1" placeholder="录入实际到货数量" />
          </label>
          <div class="drawer-field">
            <span>补充后储备量</span>
            <strong>{{ drawerAfter }}</strong>
          </div>
          <p class="drawer-hint">
            确认后补充前后数值一起落库；若现场盘点已被其他林场变更，会提示冲突且不改动任何数据。
          </p>
          <p v-if="drawerError" class="drawer-error">{{ drawerError }}</p>
        </div>
        <footer class="drawer-foot">
          <button v-if="drawerError" class="btn" type="button" @click="refreshDrawer">重新读取</button>
          <button class="btn ghost" type="button" @click="closeDrawer">取消</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="confirmDrawer">
            {{ submitting ? '提交中…' : '确认补充' }}
          </button>
        </footer>
      </aside>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runActionLocked as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('supply')
const columns = ["物资编号", "物资名称", "物资类别", "规格型号", "储备林场", "预警储备量", "实际储备量", "物资状态"]
const statuses = ["充足", "偏低", "需补充", "已过期"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => [
  { label: '物资种类', value: rows.value.length },
  {
    label: '需补充种类',
    value: rows.value.filter((row) => row.status === '偏低' || row.status === '需补充').length,
  },
  { label: '过期种类', value: rows.value.filter((row) => row.status === '已过期').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 处理抽屉：确认补充在这里核对补充前后数值并录入实际补充量。
const drawerOpen = ref(false)
const drawerRow = ref<EntryRow | null>(null)
const drawerError = ref('')
const quantity = ref('')
const submitting = ref(false)

const drawerBefore = computed(() => {
  const row = drawerRow.value
  if (!row) {
    return 0
  }
  const before = Number(row['补充前储备量'] ?? row['实际储备量'])
  return Number.isFinite(before) ? before : 0
})
const drawerAfter = computed(() => {
  const amount = Number(quantity.value)
  return drawerBefore.value + (Number.isFinite(amount) ? amount : 0)
})

function actionsFor(row: EntryRow): string[] {
  switch (String(row.status)) {
    case '偏低':
      return ['发起补充', '标记过期']
    case '需补充':
      return ['确认补充', '标记过期']
    case '充足':
      return ['标记过期']
    default:
      return []
  }
}

async function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '确认补充') {
    openDrawer(row)
    return
  }
  const result = await applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openDrawer(row: EntryRow) {
  drawerRow.value = { ...row }
  quantity.value = String(row['计划补充量'] ?? '')
  drawerError.value = ''
  drawerOpen.value = true
}

function closeDrawer() {
  drawerOpen.value = false
  drawerRow.value = null
  drawerError.value = ''
}

async function confirmDrawer() {
  const row = drawerRow.value
  if (!row || submitting.value) {
    return
  }
  submitting.value = true
  drawerError.value = ''
  try {
    const result = await applyAction(meta.key, Number(row.id), '确认补充', {
      quantity: quantity.value,
      expectedVersion: Number(row.version ?? 0),
    })
    if (!result.ok) {
      // 确认失败：储备量与待办都没动，留在抽屉里改正数量或重新读取后可接着重试。
      drawerError.value = result.message
      return
    }
    closeDrawer()
    reload()
  } finally {
    submitting.value = false
  }
}

function refreshDrawer() {
  const row = drawerRow.value
  if (!row) {
    return
  }
  const fresh = listEntries(meta.key).items.find((item) => Number(item.id) === Number(row.id))
  if (!fresh || String(fresh.status) !== '需补充') {
    closeDrawer()
    errorMessage.value = '该补充任务已被其他林场处理，列表已刷新'
    reload()
    return
  }
  drawerRow.value = { ...fresh }
  quantity.value = String(fresh['计划补充量'] ?? quantity.value)
  drawerError.value = ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '防火物资登记入口尚未接入审批流'
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '物资储备列表读取失败'
  }
}

onMounted(reload)
</script>
