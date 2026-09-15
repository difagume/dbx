// @vitest-environment happy-dom

import { createApp, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateVqbSql } from "@/lib/vqb/sql";
import type { VqbDatabaseType, VqbQueryModel } from "@/lib/vqb/model";
import { vqbStorageKey } from "@/lib/vqb/storage";
import type { VqbSchemaTable } from "../vqbFlowMapper";
import VqbCanvas from "../VqbCanvas.vue";

vi.mock("@vue-flow/core", () => ({
  VueFlow: { props: ["nodes", "edges"], template: "<div><slot /></div>" },
}));

vi.mock("@vue-flow/background", () => ({
  Background: { template: "<div />" },
}));

vi.mock("../../diagram/TableNode.vue", () => ({
  default: { template: "<div />" },
}));

vi.mock("../../diagram/RelationshipEdge.vue", () => ({
  default: { template: "<div />" },
}));

vi.mock("@/lib/diagram/explainPlan", () => ({
  supportsExplainPlan: (databaseType?: string) => databaseType === "postgres" || databaseType === "mysql",
}));

const createTab = vi.fn();
const executeTabSql = vi.fn();

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({ createTab, executeTabSql }),
}));

const SCHEMA: VqbSchemaTable[] = [
  {
    name: "users",
    columns: [{ name: "id", isPrimaryKey: true }, { name: "name" }],
    foreignKeys: [],
  },
  {
    name: "orders",
    columns: [{ name: "id", isPrimaryKey: true }, { name: "user_id" }, { name: "total" }],
    foreignKeys: [{ column: "user_id", refTable: "users", refColumn: "id" }],
  },
];

function validModel(): VqbQueryModel {
  return {
    tables: [{ name: "users", alias: "t1" }],
    columns: [{ table: "users", name: "id" }],
    joins: [],
    where: [],
    orderBy: [],
  };
}

const mountedApps: Array<ReturnType<typeof createApp>> = [];

async function mountCanvas(initial: VqbQueryModel, scope: { connectionId?: string; database?: string; schema?: string; databaseType?: VqbDatabaseType } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const model = ref<VqbQueryModel>(initial);
  const app = createApp({
    components: { VqbCanvas },
    setup() {
      return { model, schema: SCHEMA, scope };
    },
    template: '<VqbCanvas v-model="model" :schema-tables="schema" :connection-id="scope.connectionId" :database="scope.database" :schema="scope.schema" :database-type="scope.databaseType" />',
  });
  app.mount(host);
  mountedApps.push(app);
  await nextTick();
  return { host, model };
}

function click(host: HTMLElement, testid: string): void {
  const button = host.querySelector(`[data-testid="${testid}"]`);
  if (!(button instanceof HTMLElement)) throw new Error(`Missing element: ${testid}`);
  button.click();
}

function previewText(host: HTMLElement): string | null {
  return host.querySelector('[data-testid="vqb-preview-sql"]')?.textContent ?? null;
}

const storage = new Map<string, string>();

beforeEach(() => {
  vi.useFakeTimers();
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => storage.clear(),
    key: () => null,
    length: 0,
  });
  createTab.mockReset().mockReturnValue("tab-1");
  executeTabSql.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
  storage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("VqbCanvas preview and persist (VQB-7…VQB-9)", () => {
  it("shows live text preview that refreshes on model edit with no backend call (VQB-7)", async () => {
    const { host, model } = await mountCanvas(validModel(), { connectionId: "conn-a", database: "shop", schema: "public" });

    const expected = generateVqbSql(model.value, { databaseType: "postgres", identifierQuote: '"' });
    expect(previewText(host)).toBe(expected);

    click(host, "vqb-column-users.name");
    await nextTick();
    expect(previewText(host)).toBe(generateVqbSql(model.value, { databaseType: "postgres", identifierQuote: '"' }));
    expect(previewText(host)).toContain('"name"');
    expect(createTab).not.toHaveBeenCalled();
  });

  it("shows plain-text preview for SQLite with a fallback note and no plan error (VQB-9)", async () => {
    const { host } = await mountCanvas(validModel(), { connectionId: "conn-a", database: "shop", databaseType: "sqlite" });

    expect(previewText(host)).toContain("SELECT");
    expect(host.querySelector('[data-testid="vqb-preview-text-fallback"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="vqb-preview-errors"]')).toBeNull();
  });

  it("blocks run on validator errors and surfaces the validator message (VQB-7)", async () => {
    const { host } = await mountCanvas({ tables: [{ name: "users", alias: "t1" }], columns: [], joins: [], where: [], orderBy: [] }, { connectionId: "conn-a", database: "shop", schema: "public" });

    const run = host.querySelector('[data-testid="vqb-run"]');
    expect(run instanceof HTMLButtonElement && run.disabled).toBe(true);
    expect(host.querySelector('[data-testid="vqb-run-blocked-hint"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="vqb-preview-errors"]')?.textContent).toContain("Select at least one column");

    click(host, "vqb-run");
    await nextTick();
    expect(createTab).not.toHaveBeenCalled();
    expect(executeTabSql).not.toHaveBeenCalled();
  });

  it("hands the exact preview text to the QueryEditor via createTab (VQB-7)", async () => {
    const { host, model } = await mountCanvas(validModel(), { connectionId: "conn-a", database: "shop", schema: "public" });
    const sql = previewText(host);
    expect(sql).toBeTruthy();

    click(host, "vqb-open-in-editor");
    await nextTick();
    expect(createTab).toHaveBeenCalledWith("conn-a", "shop", "Visual query", "query", "public", sql, undefined, { forceNew: true });
    expect(model.value.tables).toHaveLength(1);
  });

  it("runs the preview through createTab plus executeTabSql (VQB-7)", async () => {
    const { host } = await mountCanvas(validModel(), { connectionId: "conn-a", database: "shop", schema: "public" });
    const sql = previewText(host);

    click(host, "vqb-run");
    await nextTick();
    expect(createTab).toHaveBeenCalledTimes(1);
    expect(executeTabSql).toHaveBeenCalledWith("tab-1", sql);
  });

  it("debounces draft saves per scope and restores on return with key isolation (VQB-4, VQB-8)", async () => {
    const scope = { connectionId: "conn-a", database: "shop", schema: "public" };
    const { host, model } = await mountCanvas({ tables: [{ name: "users", alias: "t1" }], columns: [], joins: [], where: [], orderBy: [] }, scope);

    click(host, "vqb-column-users.id");
    await nextTick();
    expect(globalThis.localStorage?.getItem(vqbStorageKey("conn-a", "shop", "public"))).toBeNull();

    await vi.advanceTimersByTimeAsync(400);
    const saved = globalThis.localStorage?.getItem(vqbStorageKey("conn-a", "shop", "public"));
    expect(saved).toContain('"users"');
    expect(globalThis.localStorage?.getItem(vqbStorageKey("conn-b", "shop", "public"))).toBeNull();

    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.replaceChildren();

    const restored = await mountCanvas({ tables: [], columns: [], joins: [], where: [], orderBy: [] }, scope);
    await vi.advanceTimersByTimeAsync(0);
    expect(restored.model.value.columns).toEqual(model.value.columns);

    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.replaceChildren();

    const other = await mountCanvas({ tables: [], columns: [], joins: [], where: [], orderBy: [] }, { connectionId: "conn-b", database: "shop", schema: "public" });
    expect(other.model.value.columns).toEqual([]);
  });
});
