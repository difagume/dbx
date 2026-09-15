// @vitest-environment happy-dom

import { createApp, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateVqbModel } from "@/lib/vqb/validate";
import type { VqbQueryModel } from "@/lib/vqb/model";
import { suggestVqbJoin, vqbToFlowEdges, vqbToFlowNodes, type VqbSchemaTable } from "../vqbFlowMapper";
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
  { name: "products", columns: [{ name: "id", isPrimaryKey: true }], foreignKeys: [] },
];

function emptyModel(): VqbQueryModel {
  return { tables: [], columns: [], joins: [], where: [], orderBy: [] };
}

const mountedApps: Array<ReturnType<typeof createApp>> = [];

async function mountCanvas(initial: VqbQueryModel) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const model = ref<VqbQueryModel>(initial);
  const app = createApp({
    components: { VqbCanvas },
    setup() {
      return { model, schema: SCHEMA };
    },
    template: '<VqbCanvas v-model="model" :schema-tables="schema" />',
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

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
});

describe("VqbCanvas", () => {
  it("adds two FK-related tables with a suggested INNER join (VQB-5)", async () => {
    const { host, model } = await mountCanvas(emptyModel());

    click(host, "vqb-add-users");
    await nextTick();
    click(host, "vqb-add-orders");

    await vi.waitFor(() => expect(model.value.tables).toHaveLength(2));
    expect(model.value.joins).toHaveLength(1);
    expect(model.value.joins[0].kind).toBe("INNER");
    expect(model.value.joins[0].left).toEqual({ table: "orders", column: "user_id" });
    expect(model.value.joins[0].right).toEqual({ table: "users", column: "id" });
  });

  it("offers only INNER in the join-type picker (VQB-6)", async () => {
    const { host } = await mountCanvas(emptyModel());

    click(host, "vqb-add-users");
    await nextTick();
    click(host, "vqb-add-orders");

    await vi.waitFor(() => expect(host.querySelector('[data-testid="vqb-join-kind-0"]')).not.toBeNull());
    const select = host.querySelector('[data-testid="vqb-join-kind-0"]');
    expect(select?.querySelectorAll("option")).toHaveLength(1);
    expect(select?.querySelector("option")?.value).toBe("INNER");
  });

  it("removing a table cascades its columns and joins, keeping the query valid (VQB-5)", async () => {
    const { host, model } = await mountCanvas({
      tables: [
        { name: "users", alias: "t1" },
        { name: "orders", alias: "t2" },
      ],
      columns: [
        { table: "users", name: "id" },
        { table: "orders", name: "total" },
      ],
      joins: [{ left: { table: "orders", column: "user_id" }, right: { table: "users", column: "id" }, kind: "INNER" }],
      where: [],
      orderBy: [{ table: "orders", column: "total", dir: "DESC" }],
      limit: 10,
    });

    click(host, "vqb-remove-orders");
    await nextTick();

    expect(model.value.tables.map((table) => table.name)).toEqual(["users"]);
    expect(model.value.columns).toEqual([{ table: "users", name: "id" }]);
    expect(model.value.joins).toEqual([]);
    expect(model.value.orderBy).toEqual([]);
    expect(validateVqbModel(model.value).ok).toBe(true);
  });

  it("column, alias, ORDER BY, and LIMIT pickers update the model (VQB-6)", async () => {
    const { host, model } = await mountCanvas({ tables: [{ name: "users", alias: "t1" }], columns: [], joins: [], where: [], orderBy: [] });

    click(host, "vqb-column-users.name");
    await nextTick();
    expect(model.value.columns).toContainEqual({ table: "users", name: "name" });

    const aliasInput = host.querySelector('[data-testid="vqb-alias-users.name"]');
    if (!(aliasInput instanceof HTMLInputElement)) throw new Error("Missing alias input");
    aliasInput.value = "username";
    aliasInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(model.value.columns).toContainEqual({ table: "users", name: "name", alias: "username" });

    const orderSelect = host.querySelector('[data-testid="vqb-order-column"]');
    if (!(orderSelect instanceof HTMLSelectElement)) throw new Error("Missing order select");
    orderSelect.value = "users.name";
    orderSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    click(host, "vqb-order-add");
    await nextTick();
    expect(model.value.orderBy).toEqual([{ table: "users", column: "name", dir: "ASC" }]);

    const limitInput = host.querySelector('[data-testid="vqb-limit"]');
    if (!(limitInput instanceof HTMLInputElement)) throw new Error("Missing limit input");
    limitInput.value = "25";
    limitInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(model.value.limit).toBe(25);
  });
});

describe("vqbFlowMapper", () => {
  it("maps canvas tables to table nodes and INNER joins to relationship edges", () => {
    const model: VqbQueryModel = {
      tables: [
        { name: "users", alias: "t1" },
        { name: "orders", alias: "t2" },
      ],
      columns: [],
      joins: [{ left: { table: "orders", column: "user_id" }, right: { table: "users", column: "id" }, kind: "INNER" }],
      where: [],
      orderBy: [],
    };
    const schemaByName = new Map(SCHEMA.map((table) => [table.name, table]));

    const nodes = vqbToFlowNodes(model, schemaByName);
    expect(nodes.map((node) => [node.id, node.type])).toEqual([
      ["users", "table"],
      ["orders", "table"],
    ]);

    const edges = vqbToFlowEdges(model);
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe("relationship");
    expect(edges[0].data?.relationship.kind).toBe("foreign-key");

    expect(suggestVqbJoin(["users"], SCHEMA[1], schemaByName)?.kind).toBe("INNER");
    expect(suggestVqbJoin(["users"], SCHEMA[2], schemaByName)).toBeNull();
  });
});
