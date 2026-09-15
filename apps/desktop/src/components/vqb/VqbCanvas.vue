<script setup lang="ts">
import { computed, markRaw, onMounted, onUnmounted, ref, toRaw, watch } from "vue";
import { VueFlow, type EdgeTypesObject, type NodeTypesObject } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import "@vue-flow/core/dist/style.css";
import { computeLayoutWithLayers } from "@/lib/diagram/elk-layout";
import { supportsExplainPlan } from "@/lib/diagram/explainPlan";
import type { DiagramEdge, DiagramNode } from "@/types/diagram";
import type { VqbDatabaseType, VqbDialect, VqbOrderBy, VqbQueryModel } from "@/lib/vqb/model";
import { generateVqbSql } from "@/lib/vqb/sql";
import { validateVqbModel } from "@/lib/vqb/validate";
import { loadVqbDraft, saveVqbDraft } from "@/lib/vqb/storage";
import { useQueryStore } from "@/stores/queryStore";
import TableNode from "../diagram/TableNode.vue";
import RelationshipEdge from "../diagram/RelationshipEdge.vue";
import VqbPreview from "./VqbPreview.vue";
import { VQB_JOIN_KIND, nextVqbAlias, suggestVqbJoin, vqbToFlowEdges, vqbToFlowNodes, type VqbSchemaTable } from "./vqbFlowMapper";

const DRAFT_DEBOUNCE_MS = 300;

const props = defineProps<{
  modelValue: VqbQueryModel;
  schemaTables?: VqbSchemaTable[];
  connectionId?: string;
  database?: string;
  schema?: string;
  databaseType?: VqbDatabaseType;
  identifierQuote?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", model: VqbQueryModel): void;
}>();

const nodeTypes = { table: markRaw(TableNode) } as NodeTypesObject;
const edgeTypes = { relationship: markRaw(RelationshipEdge) } as EdgeTypesObject;

const schemaByName = computed(() => new Map((props.schemaTables ?? []).map((table) => [table.name, table])));
const flowNodes = ref<ReturnType<typeof vqbToFlowNodes>>(vqbToFlowNodes(props.modelValue, schemaByName.value));
const flowEdges = ref<ReturnType<typeof vqbToFlowEdges>>(vqbToFlowEdges(props.modelValue));
const orderDraft = ref({ columnKey: "", dir: "ASC" as VqbOrderBy["dir"] });

const orderCandidates = computed(() => props.modelValue.tables.flatMap((table) => (schemaByName.value.get(table.name)?.columns ?? []).map((column) => ({ key: `${table.name}.${column.name}`, table: table.name, column: column.name }))));

/** Live sync preview: pure computed from the model, zero backend roundtrips. */
const vqbDialect = computed<VqbDialect>(() => {
  const databaseType = props.databaseType ?? "postgres";
  return { databaseType, identifierQuote: props.identifierQuote ?? (databaseType === "mysql" ? "`" : '"') };
});
const vqbValidation = computed(() => validateVqbModel(props.modelValue));
const previewSql = computed<string | null>(() => {
  try {
    return generateVqbSql(props.modelValue, vqbDialect.value);
  } catch {
    return null;
  }
});
const planSupported = computed(() => supportsExplainPlan(vqbDialect.value.databaseType));

function hasDraftScope(): boolean {
  return !!props.connectionId && !!props.database;
}

let draftTimer: ReturnType<typeof setTimeout> | undefined;
function flushDraftSave(): void {
  if (!hasDraftScope()) return;
  saveVqbDraft(toRaw(props.modelValue), props.connectionId ?? "", props.database ?? "", props.schema ?? "");
}
function scheduleDraftSave(): void {
  if (!hasDraftScope()) return;
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraftSave, DRAFT_DEBOUNCE_MS);
}

onMounted(() => {
  if (!hasDraftScope()) return;
  const draft = loadVqbDraft(props.connectionId ?? "", props.database ?? "", props.schema ?? "");
  if (draft && props.modelValue.tables.length === 0 && props.modelValue.columns.length === 0) {
    emit("update:modelValue", draft);
  }
});
onUnmounted(() => {
  if (draftTimer) clearTimeout(draftTimer);
});
watch(() => props.modelValue, scheduleDraftSave, { deep: true });

function openInEditor(): void {
  const sql = previewSql.value;
  if (!sql || vqbValidation.value.errors.length > 0 || !hasDraftScope()) return;
  useQueryStore().createTab(props.connectionId ?? "", props.database ?? "", "Visual query", "query", props.schema, sql, undefined, { forceNew: true });
}

async function runPreview(): Promise<void> {
  const sql = previewSql.value;
  if (!sql || vqbValidation.value.errors.length > 0 || !hasDraftScope()) return;
  const store = useQueryStore();
  const tabId = store.createTab(props.connectionId ?? "", props.database ?? "", "Visual query", "query", props.schema, sql, undefined, { forceNew: true });
  await store.executeTabSql(tabId, sql);
}

const paletteTables = computed(() => {
  const onCanvas = new Set(props.modelValue.tables.map((table) => table.name));
  return (props.schemaTables ?? []).filter((table) => !onCanvas.has(table.name));
});

function updateModel(mutator: (draft: VqbQueryModel) => void): void {
  const draft = structuredClone(toRaw(props.modelValue));
  mutator(draft);
  emit("update:modelValue", draft);
}

/** Rebuild flow state from the model, keeping current node positions. */
function syncFlow(): void {
  const positions: Record<string, { x: number; y: number }> = {};
  for (const node of flowNodes.value) positions[node.id] = { ...node.position };
  const next = vqbToFlowNodes(props.modelValue, schemaByName.value);
  for (const node of next) {
    const kept = positions[node.id];
    if (kept) node.position = kept;
  }
  flowNodes.value = next;
  flowEdges.value = vqbToFlowEdges(props.modelValue);
}

async function relayout(): Promise<void> {
  const nodes: DiagramNode[] = [];
  for (const node of flowNodes.value) {
    nodes.push({ id: node.id, type: "table", position: { ...node.position }, data: { table: node.data!.table } });
  }
  const edges: DiagramEdge[] = [];
  for (const edge of flowEdges.value) {
    edges.push({ id: edge.id, source: edge.source, target: edge.target, data: { relationship: edge.data!.relationship } });
  }
  try {
    const result = await computeLayoutWithLayers(nodes, edges, [], { direction: "LR" });
    const positions = new Map(result.nodes.map((node) => [node.id, node.position]));
    for (const node of flowNodes.value) {
      const next = positions.get(node.id);
      if (next) node.position = { ...next };
    }
  } catch {
    // Grid fallback from the mapper already positions every node.
  }
}

function addTable(name: string): void {
  if (props.modelValue.tables.some((table) => table.name === name)) return;
  const schema = schemaByName.value.get(name);
  updateModel((draft) => {
    draft.tables.push({ name, alias: nextVqbAlias(draft) });
    if (schema) {
      const join = suggestVqbJoin(
        draft.tables.filter((table) => table.name !== name).map((table) => table.name),
        schema,
        schemaByName.value,
      );
      if (join) draft.joins.push(join);
    }
  });
  syncFlow();
  void relayout();
}

function removeTable(name: string): void {
  updateModel((draft) => {
    draft.tables = draft.tables.filter((table) => table.name !== name);
    draft.columns = draft.columns.filter((column) => column.table !== name);
    draft.joins = draft.joins.filter((join) => join.left.table !== name && join.right.table !== name);
    draft.orderBy = draft.orderBy.filter((order) => order.table !== name);
  });
  syncFlow();
}

function toggleColumn(table: string, column: string, selected: boolean): void {
  updateModel((draft) => {
    if (selected && !draft.columns.some((entry) => entry.table === table && entry.name === column)) {
      draft.columns.push({ table, name: column });
    } else if (!selected) {
      draft.columns = draft.columns.filter((entry) => !(entry.table === table && entry.name === column));
    }
  });
}

function setColumnAlias(table: string, column: string, alias: string): void {
  updateModel((draft) => {
    const entry = draft.columns.find((item) => item.table === table && item.name === column);
    if (!entry) return;
    const trimmed = alias.trim();
    if (trimmed) entry.alias = trimmed;
    else delete entry.alias;
  });
}

function addOrderBy(): void {
  const candidate = orderCandidates.value.find((entry) => entry.key === orderDraft.value.columnKey);
  if (!candidate) return;
  updateModel((draft) => {
    if (draft.orderBy.some((order) => order.table === candidate.table && order.column === candidate.column)) return;
    draft.orderBy.push({ table: candidate.table, column: candidate.column, dir: orderDraft.value.dir });
  });
  orderDraft.value.columnKey = "";
}

function removeOrderBy(index: number): void {
  updateModel((draft) => {
    draft.orderBy.splice(index, 1);
  });
}

function setLimit(raw: string): void {
  updateModel((draft) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      delete draft.limit;
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isInteger(parsed) && parsed > 0) draft.limit = parsed;
  });
}

function onPaletteDragStart(event: DragEvent, name: string): void {
  event.dataTransfer?.setData("text/vqb-table", name);
}

function onCanvasDrop(event: DragEvent): void {
  const name = event.dataTransfer?.getData("text/vqb-table");
  if (name) addTable(name);
}

watch(() => props.modelValue, syncFlow, { deep: true });

defineExpose({ addTable, removeTable, toggleColumn, setColumnAlias, addOrderBy, removeOrderBy, setLimit, relayout, openInEditor, runPreview, flushDraftSave });
</script>

<template>
  <div class="vqb-canvas flex h-full gap-3" data-testid="vqb-canvas">
    <aside class="w-52 shrink-0 overflow-y-auto rounded-md border p-2" aria-label="Table palette">
      <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tables</h3>
      <ul class="space-y-1">
        <li v-for="table in paletteTables" :key="table.name" draggable="true" @dragstart="onPaletteDragStart($event, table.name)" :data-testid="`vqb-palette-${table.name}`" class="flex items-center justify-between gap-1 rounded border px-2 py-1 text-sm">
          <span class="truncate font-mono">{{ table.name }}</span>
          <button type="button" class="rounded border px-1.5 text-xs" :data-testid="`vqb-add-${table.name}`" @click="addTable(table.name)">Add</button>
        </li>
      </ul>
      <p v-if="paletteTables.length === 0" class="text-xs text-muted-foreground">All schema tables are on the canvas.</p>
    </aside>

    <div class="min-h-80 flex-1 rounded-md border" @dragover.prevent @drop="onCanvasDrop" data-testid="vqb-flow-dropzone">
      <VueFlow v-model:nodes="flowNodes" v-model:edges="flowEdges" :node-types="nodeTypes" :edge-types="edgeTypes" :min-zoom="0.2" :max-zoom="2">
        <Background />
      </VueFlow>
    </div>

    <aside class="w-72 shrink-0 space-y-4 overflow-y-auto rounded-md border p-2" aria-label="Query pickers">
      <section v-for="table in props.modelValue.tables" :key="table.name" :data-testid="`vqb-table-${table.name}`">
        <div class="mb-1 flex items-center justify-between">
          <h4 class="truncate font-mono text-sm font-semibold">{{ table.name }}</h4>
          <button type="button" class="rounded border px-1.5 text-xs" :data-testid="`vqb-remove-${table.name}`" @click="removeTable(table.name)">Remove</button>
        </div>
        <ul class="space-y-1">
          <li v-for="column in schemaByName.get(table.name)?.columns ?? []" :key="column.name" class="flex items-center gap-1 text-sm">
            <input type="checkbox" :checked="props.modelValue.columns.some((entry) => entry.table === table.name && entry.name === column.name)" :data-testid="`vqb-column-${table.name}.${column.name}`" @change="toggleColumn(table.name, column.name, ($event.target as HTMLInputElement).checked)" />
            <span class="font-mono">{{ column.name }}</span>
            <input
              type="text"
              placeholder="alias"
              class="w-20 rounded border px-1 text-xs"
              :value="props.modelValue.columns.find((entry) => entry.table === table.name && entry.name === column.name)?.alias ?? ''"
              :data-testid="`vqb-alias-${table.name}.${column.name}`"
              @input="setColumnAlias(table.name, column.name, ($event.target as HTMLInputElement).value)"
            />
          </li>
        </ul>
      </section>

      <section aria-label="Joins">
        <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Joins</h3>
        <ul class="space-y-1">
          <li v-for="(join, index) in props.modelValue.joins" :key="`${join.left.table}.${join.left.column}-${join.right.table}.${join.right.column}`" class="flex items-center gap-1 text-xs">
            <span class="truncate font-mono">{{ join.left.table }}.{{ join.left.column }} = {{ join.right.table }}.{{ join.right.column }}</span>
            <select :value="join.kind" :data-testid="`vqb-join-kind-${index}`" aria-label="Join type">
              <option :value="VQB_JOIN_KIND">{{ VQB_JOIN_KIND }}</option>
            </select>
          </li>
        </ul>
        <p v-if="props.modelValue.joins.length === 0" class="text-xs text-muted-foreground">No joins yet — drop a related table.</p>
      </section>

      <section aria-label="Ordering and limit">
        <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Order &amp; limit</h3>
        <div class="flex gap-1">
          <select v-model="orderDraft.columnKey" class="min-w-0 flex-1 rounded border px-1 text-xs" data-testid="vqb-order-column">
            <option value="">Column…</option>
            <option v-for="candidate in orderCandidates" :key="candidate.key" :value="candidate.key">{{ candidate.key }}</option>
          </select>
          <select v-model="orderDraft.dir" class="rounded border px-1 text-xs" data-testid="vqb-order-dir">
            <option value="ASC">ASC</option>
            <option value="DESC">DESC</option>
          </select>
          <button type="button" class="rounded border px-1.5 text-xs" data-testid="vqb-order-add" @click="addOrderBy">Add</button>
        </div>
        <ul class="mt-1 space-y-1">
          <li v-for="(order, index) in props.modelValue.orderBy" :key="`${order.table}.${order.column}`" class="flex items-center justify-between text-xs">
            <span class="font-mono">{{ order.table }}.{{ order.column }} {{ order.dir }}</span>
            <button type="button" class="rounded border px-1.5" :data-testid="`vqb-order-remove-${index}`" @click="removeOrderBy(index)">Remove</button>
          </li>
        </ul>
        <label class="mt-2 flex items-center gap-1 text-xs">
          Limit
          <input type="number" min="1" class="w-20 rounded border px-1" :value="props.modelValue.limit ?? ''" data-testid="vqb-limit" @input="setLimit(($event.target as HTMLInputElement).value)" />
        </label>
      </section>

      <VqbPreview :sql="previewSql" :errors="vqbValidation.errors" :database-type="vqbDialect.databaseType" :plan-supported="planSupported" @open-in-editor="openInEditor" @run="runPreview" />
    </aside>
  </div>
</template>
