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

    <!-- 在途补充待办：中断后从这里一键回到原步骤抽屉 -->
    <section v-if="activeTasks.length" class="task-strip">
      <header>
        <strong>在途补充待办（{{ activeTasks.length }}）</strong>
        <span class="muted-text">关闭页面或刷新后，仍可从原步骤接续</span>
      </header>
      <ul>
        <li v-for="task in activeTasks" :key="task.id">
          <button class="link" type="button" @click="openTask(task.supplyId)">
            补充单 {{ task.id }} · {{ nameOf(task.supplyId) }} · {{ task.forest }} ·
            第 {{ task.step }} 步 · 补充前 {{ task.beforeQty }} 件
            <template v-if="task.conflict && !task.conflictResolved">（盘点冲突待裁决）</template>
          </button>
        </li>
      </ul>
    </section>

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
          <td>
            {{ row.status }}
            <span v-if="activeMap.has(Number(row.id))" class="tag pending">补充中</span>
          </td>
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

    <ReplenishDrawer :open="drawerOpen" :row="drawerRow" @close="closeDrawer" @changed="reload" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listReplenishTasks, reconcileOrphanTasks } from '@/api/supply-workflow'
import type { EntryRow, ReplenishWorkflow } from '@/data/types'
import ReplenishDrawer from './ReplenishDrawer.vue'

const meta = moduleMeta('supply')
const columns = meta.fields
const statuses = ['充足', '偏低', '补充中', '需补充', '已过期']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['物资编号', '物资名称', '物资类别']

const drawerOpen = ref(false)
const drawerRow = ref<EntryRow | null>(null)
const activeTasks = ref<ReplenishWorkflow[]>([])

const activeMap = computed(() => new Map(activeTasks.value.map((task) => [task.supplyId, task])))

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 统计直接读列表数据，与表格同源，不再是写死的 0。
const stats = computed(() => [
  { label: '物资种类', value: rows.value.length },
  { label: '需补充种类', value: rows.value.filter((row) => ['偏低', '需补充', '补充中'].includes(String(row.status))).length },
  { label: '过期种类', value: rows.value.filter((row) => String(row.status) === '已过期').length },
])

function nameOf(supplyId: number): string {
  const row = rows.value.find((item) => Number(item.id) === supplyId)
  return String(row?.['物资名称'] ?? `物资 ${supplyId}`)
}

// 已过期：只能查看抽屉（提示禁止补充）与标记过期；在途：只进抽屉接续；
// 其余（含实际储备量为 0 的「需补充」）都能发起补充。
function actionsFor(row: EntryRow): string[] {
  const status = String(row.status)
  if (activeMap.value.has(Number(row.id))) {
    return ['继续补充']
  }
  if (status === '已过期') {
    return ['处理抽屉']
  }
  if (status === '充足') {
    return ['标记过期']
  }
  return ['发起补充', '标记过期']
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

function openDrawer(row: EntryRow) {
  drawerRow.value = row
  drawerOpen.value = true
}

function closeDrawer() {
  drawerOpen.value = false
  reload()
}

function openTask(supplyId: number) {
  const row = rows.value.find((item) => Number(item.id) === supplyId)
  if (row) {
    openDrawer(row)
  }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '发起补充' || action === '继续补充' || action === '处理抽屉') {
    openDrawer(row)
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    // 先收口「补充中」状态却没有在途任务的悬挂行，列表与任务条再一起读取，
    // 保证两者口径一致。
    reconcileOrphanTasks()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    activeTasks.value = listReplenishTasks()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '物资储备列表读取失败'
  }
}

onMounted(reload)
</script>
