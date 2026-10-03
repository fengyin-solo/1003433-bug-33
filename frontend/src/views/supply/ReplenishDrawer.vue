<template>
  <div v-if="open" class="drawer-mask" @click.self="emit('close')">
    <aside class="drawer" data-role="replenish-drawer">
      <header class="drawer-head">
        <div>
          <h3>物资补充处理</h3>
          <p class="drawer-sub">
            {{ row?.['物资编号'] }} · {{ row?.['物资名称'] }} · {{ row?.['储备林场'] }}
          </p>
        </div>
        <button class="btn ghost" type="button" @click="emit('close')">关闭</button>
      </header>

      <div v-if="row" class="drawer-body">
        <section class="drawer-section">
          <div class="kv-grid">
            <div><span>当前状态</span><strong>{{ row.status }}</strong></div>
            <div><span>实际储备量</span><strong>{{ row['实际储备量'] }} 件</strong></div>
            <div><span>预警储备量</span><strong>{{ row['预警储备量'] }} 件</strong></div>
            <div><span>过期日期</span><strong>{{ row['过期日期'] || '—' }}</strong></div>
          </div>
        </section>

        <div v-if="expired" class="drawer-alert error">
          物资已过有效期（{{ row['过期日期'] }}），按处理优先级第 1 位拦截：禁止补充，请先复检或换新。
        </div>

        <template v-else>
          <!-- 步骤条：任务中断后重开，仍停在原来的步骤 -->
          <ol v-if="active || finished" class="step-bar">
            <li
              v-for="item in steps"
              :key="item.no"
              :class="{
                done: (active ? active.step > item.no : true) || finished,
                active: active?.step === item.no,
              }"
            >
              <span>{{ item.no }}</span>{{ item.label }}
            </li>
          </ol>

          <!-- 第 1 步：发起补充（无在途任务、未查看归档时） -->
          <section v-if="!active && !finished" class="drawer-section">
            <h4>第 1 步 · 发起补充</h4>
            <p class="drawer-hint">
              实际储备量为 <strong>{{ qty(row['实际储备量']) }}</strong> 件，预警量
              <strong>{{ qty(row['预警储备量']) }}</strong> 件，发起后补充前数量立即定格。
            </p>
            <label class="drawer-field">
              <span>本次补充数量（件）</span>
              <input v-model="form.quantity" type="number" min="1" step="1" placeholder="大于 0 的整数" />
            </label>
            <label class="drawer-field">
              <span>经办林场</span>
              <input v-model="form.forest" placeholder="如：青峰林场" />
            </label>
            <label class="drawer-field">
              <span>经办人</span>
              <input v-model="form.operator" placeholder="经办人姓名" />
            </label>
            <div class="drawer-actions">
              <button class="btn primary" type="button" @click="onStart">发起补充</button>
            </div>
          </section>

          <!-- 在途任务：从原步骤接续 -->
          <template v-else-if="active">
            <section class="drawer-section">
              <h4>
                补充单 {{ active.id }}
                <span class="tag pending">第 {{ active.step }} 步进行中</span>
              </h4>
              <div class="kv-grid">
                <div><span>补充前数量（发起时定格）</span><strong>{{ active.beforeQty }} 件</strong></div>
                <div><span>计划补充</span><strong>{{ active.plannedQty }} 件</strong></div>
                <div><span>台账基准</span><strong>{{ active.ledgerQty }} 件</strong></div>
                <div><span>现场实盘</span><strong>{{ active.countedQty === null ? '未盘点' : active.countedQty + ' 件' }}</strong></div>
              </div>
            </section>

            <!-- 第 2 步：现场盘点 / 冲突裁决 -->
            <section v-if="active.step === 2" class="drawer-section">
              <h4>第 2 步 · 现场盘点</h4>
              <label class="drawer-field">
                <span>现场实盘数量（件）</span>
                <input v-model="form.counted" type="number" min="0" step="1" />
              </label>
              <label class="drawer-field">
                <span>盘点备注</span>
                <input v-model="form.note" placeholder="差异说明（可选）" />
              </label>
              <button class="btn primary" type="button" @click="onStocktake">提交盘点</button>

              <div v-if="active.conflict && !active.conflictResolved" class="drawer-alert warn">
                现场盘点冲突（处理优先级第 2 位）：实盘 {{ active.countedQty }} 件，台账 {{ active.ledgerQty }} 件。
                请先裁决再确认入帐。
                <div class="conflict-row">
                  <label><input v-model="form.resolution" type="radio" value="site" /> 以现场实盘为准（对齐台账）</label>
                  <label><input v-model="form.resolution" type="radio" value="ledger" /> 以台账为准（维持 {{ active.ledgerQty }} 件）</label>
                </div>
                <button class="btn" type="button" @click="onResolveConflict">按裁决继续</button>
              </div>
            </section>

            <!-- 第 3 步：确认入帐（失败可原地重试，库存不变、待办不丢） -->
            <section v-if="active.step === 3" class="drawer-section">
              <h4>第 3 步 · 确认入帐</h4>
              <div v-if="active.conflict" class="drawer-alert" :class="active.conflictResolved ? 'ok' : 'warn'">
                盘点冲突{{ active.conflictResolved ? '已裁决' : '未裁决' }}：
                <template v-if="active.conflictResolved">扣增基准 {{ active.ledgerQty }} 件</template>
                <template v-else>请返回第 2 步裁决</template>
              </div>
              <label class="drawer-field">
                <span>本次扣增数量（件，可修正后重试）</span>
                <input v-model="form.quantity" type="number" min="1" step="1" />
              </label>
              <div class="drawer-actions">
                <button class="btn primary" type="button" :disabled="active.conflict && !active.conflictResolved" @click="onConfirm">
                  确认补充入帐
                </button>
              </div>
            </section>

            <!-- 刚发起、尚未进入盘点（step=1） -->
            <section v-if="active.step === 1" class="drawer-section">
              <h4>下一步 · 现场盘点</h4>
              <button class="btn primary" type="button" @click="goStocktake">进入现场盘点</button>
            </section>

            <div v-if="resultMessage" class="drawer-alert" :class="lastOk ? 'ok' : 'error'">
              {{ resultMessage }}
            </div>

            <div class="drawer-actions right">
              <button class="btn ghost" type="button" @click="onCancel">终止补充（库存维持 {{ active.beforeQty }} 件）</button>
            </div>
          </template>

          <!-- 已完成归档：补充前后数量同时保留 -->
          <section v-else-if="archive" class="drawer-section">
            <div class="drawer-alert ok">
              补充单 {{ archive.id }} 已入帐：补充前 {{ archive.beforeQty }} 件 →
              补充后 <strong>{{ archive.afterQty }}</strong> 件（本次 +{{ archive.plannedQty }}）。
            </div>
            <button class="btn ghost" type="button" @click="archiveHidden = true">发起新一轮补充</button>
          </section>
        </template>

        <!-- 处理记录：补充前后数量与每一步都留痕，列表与抽屉同源 -->
        <section v-if="task && !(archiveHidden)" class="drawer-section history">
          <h4>处理记录</h4>
          <ul>
            <li v-for="(item, idx) in task.history" :key="idx">
              <span class="hist-time">{{ formatTime(item.at) }}</span>
              <span class="hist-step">第 {{ item.step }} 步</span>
              <span>{{ item.event }}</span>
            </li>
          </ul>
        </section>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'

import {
  cancelReplenish,
  confirmReplenish,
  enterStocktake,
  getLatestReplenishTask,
  startReplenish,
  submitStocktake,
} from '@/api/supply-workflow'
import { useSessionStore } from '@/stores/session'
import type { EntryRow, ReplenishWorkflow } from '@/data/types'

const props = defineProps<{ open: boolean; row: EntryRow | null }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'changed'): void
}>()

const session = useSessionStore()

const steps = [
  { no: 1, label: '发起补充' },
  { no: 2, label: '现场盘点' },
  { no: 3, label: '确认入帐' },
]

const task = ref<ReplenishWorkflow | null>(null)
const archiveHidden = ref(false)
const resultMessage = ref('')
const lastOk = ref(false)

const form = reactive({
  quantity: '',
  forest: '',
  operator: session.operator,
  counted: '',
  note: '',
  resolution: 'ledger' as 'site' | 'ledger',
})

// 在途任务用于接续操作；已归档任务仅展示补充前后数量与处理记录。
const active = computed(() => (task.value && !task.value.finished ? task.value : null))
const archive = computed(() => (task.value?.finished && !archiveHidden.value ? task.value : null))
const finished = computed(() => archive.value !== null)
const expired = computed(() => props.row?.status === '已过期')

function qty(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function formatTime(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString('zh-CN', { hour12: false })
}

function refreshTask() {
  if (!props.row) {
    task.value = null
    return
  }
  task.value = getLatestReplenishTask(Number(props.row.id)) ?? null
}

function show(ok: boolean, message: string, next?: ReplenishWorkflow | null) {
  lastOk.value = ok
  resultMessage.value = message
  if (next !== undefined) {
    task.value = next
  } else {
    refreshTask()
  }
  emit('changed')
}

watch(
  () => [props.open, props.row?.id] as const,
  ([isOpen]) => {
    resultMessage.value = ''
    archiveHidden.value = false
    if (isOpen && props.row) {
      refreshTask()
      const current = task.value
      form.quantity = current && !current.finished ? String(current.plannedQty) : ''
      form.forest = String(props.row['储备林场'] ?? '')
      form.operator = session.operator
      form.counted = current?.countedQty !== null && current?.countedQty !== undefined ? String(current.countedQty) : ''
      form.note = current?.conflictNote ?? ''
      form.resolution = 'ledger'
    }
  },
  { immediate: true },
)

function onStart() {
  if (!props.row) {
    return
  }
  const result = startReplenish({
    supplyId: Number(props.row.id),
    quantity: form.quantity,
    forest: form.forest,
    operator: form.operator,
  })
  if (result.ok) {
    form.quantity = String(result.workflow?.plannedQty ?? form.quantity)
  }
  show(result.ok, result.message, result.workflow ?? null)
}

function goStocktake() {
  if (!props.row) {
    return
  }
  // 进入第 2 步也要落盘：中断后重开仍从第 2 步接续，不会退回第 1 步。
  const result = enterStocktake(Number(props.row.id))
  show(result.ok, result.message, result.workflow ?? null)
}

function onStocktake() {
  if (!props.row) {
    return
  }
  const result = submitStocktake(Number(props.row.id), {
    counted: Number(form.counted),
    note: form.note,
    // 首次提交不带裁决；冲突后由下方按钮带裁决再次提交。
  })
  if (result.ok) {
    form.quantity = String(result.workflow?.plannedQty ?? form.quantity)
  }
  show(result.ok, result.message, result.workflow ?? null)
}

function onResolveConflict() {
  if (!props.row) {
    return
  }
  const result = submitStocktake(Number(props.row.id), {
    counted: Number(form.counted),
    note: form.note,
    resolveConflict: form.resolution,
  })
  show(result.ok, result.message, result.workflow ?? null)
}

function onConfirm() {
  if (!props.row) {
    return
  }
  // 失败时（越界、过期、冲突未裁决）工作流保证库存不动、任务仍停在第 3 步，
  // 这里原地重试即可，待办不会丢。
  const result = confirmReplenish(Number(props.row.id), form.quantity || undefined)
  show(result.ok, result.message, result.workflow ?? null)
}

function onCancel() {
  if (!props.row) {
    return
  }
  const result = cancelReplenish(Number(props.row.id))
  show(result.ok, result.message, null)
}
</script>
