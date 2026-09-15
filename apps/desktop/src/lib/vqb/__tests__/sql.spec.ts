import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VqbDialect, VqbQueryModel } from "../model";
import { generateVqbSql } from "../sql";
import { clearVqbDraft, loadVqbDraft, saveVqbDraft, vqbStorageKey } from "../storage";
import { validateVqbModel, VqbValidationError } from "../validate";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

const PG: VqbDialect = { databaseType: "postgres", identifierQuote: '"' };
const MYSQL: VqbDialect = { databaseType: "mysql", identifierQuote: "`" };
const SQLITE: VqbDialect = { databaseType: "sqlite", identifierQuote: '"' };

function singleTableModel(): VqbQueryModel {
  return { tables: [{ name: "users", alias: "u" }], columns: [{ table: "users", name: "id" }], joins: [], where: [], orderBy: [] };
}

function joinedModel(): VqbQueryModel {
  return {
    tables: [
      { name: "users", alias: "u" },
      { name: "orders", alias: "o" },
    ],
    columns: [
      { table: "users", name: "id" },
      { table: "orders", name: "total", alias: "revenue" },
    ],
    joins: [{ left: { table: "users", column: "id" }, right: { table: "orders", column: "user_id" }, kind: "INNER" }],
    where: [{ id: "w1", column: "orders.total", op: ">", value: "100", conjunction: "AND" }],
    orderBy: [{ table: "orders", column: "total", dir: "DESC" }],
    limit: 10,
  };
}

describe("generateVqbSql", () => {
  it("generates a minimal single-table select (VQB-1)", () => {
    expect(generateVqbSql(singleTableModel(), PG)).toBe('SELECT t1."id" FROM "users" AS t1;');
  });
  it("quotes identifiers per dialect (VQB-2)", () => {
    const model: VqbQueryModel = { ...singleTableModel(), tables: [{ name: "order", alias: "o" }], columns: [{ table: "order", name: "select" }] };
    expect(generateVqbSql(model, PG)).toBe('SELECT t1."select" FROM "order" AS t1;');
    expect(generateVqbSql(model, MYSQL)).toBe("SELECT t1.`select` FROM `order` AS t1;");
    expect(generateVqbSql(model, SQLITE)).toBe('SELECT t1."select" FROM "order" AS t1;');
  });
  it("doubles embedded quote chars", () => {
    const model: VqbQueryModel = { ...singleTableModel(), tables: [{ name: 'we"ird', alias: "w" }], columns: [{ table: 'we"ird', name: 'a"b' }] };
    expect(generateVqbSql(model, PG)).toBe('SELECT t1."a""b" FROM "we""ird" AS t1;');
  });
  it("renders INNER JOIN … ON plus WHERE/ORDER/LIMIT (VQB-2)", () => {
    expect(generateVqbSql(joinedModel(), PG)).toBe('SELECT t1."id", t2."total" AS "revenue" FROM "users" AS t1 INNER JOIN "orders" AS t2 ON t1."id" = t2."user_id" WHERE t2."total" > 100 ORDER BY t2."total" DESC LIMIT 10;');
  });
  it("escapes single quotes in string literals and renders IN lists", () => {
    const model: VqbQueryModel = {
      ...singleTableModel(),
      where: [
        { id: "w1", column: "name", op: "=", value: "o'brien", conjunction: "AND" },
        { id: "w2", column: "id", op: "IN", value: "1, 2", conjunction: "OR" },
      ],
    };
    expect(generateVqbSql(model, PG)).toContain(`t1."name" = 'o''brien'`);
    expect(generateVqbSql(model, PG)).toContain(`t1."id" IN (1, 2)`);
  });
  it("renders IS NULL without a literal", () => {
    const model: VqbQueryModel = { ...singleTableModel(), where: [{ id: "w1", column: "name", op: "IS NULL", value: "", conjunction: "AND" }] };
    expect(generateVqbSql(model, PG)).toContain(`t1."name" IS NULL`);
  });
  it("skips disabled rules", () => {
    const model: VqbQueryModel = { ...singleTableModel(), where: [{ id: "w1", column: "name", op: "=", value: "x", conjunction: "AND", disabled: true }] };
    expect(generateVqbSql(model, PG)).not.toContain("WHERE");
  });
});

describe("validateVqbModel", () => {
  it("rejects an empty select (VQB-1)", () => {
    expect(validateVqbModel({ ...singleTableModel(), columns: [] }).errors.join(" ")).toMatch(/at least one column/i);
  });
  it("rejects non-INNER joins by name (VQB-3)", () => {
    const model = joinedModel();
    (model.joins[0] as { kind: unknown }).kind = "LEFT";
    expect(validateVqbModel(model).errors.join(" ")).toMatch(/INNER/);
  });
  it("rejects subqueries and unknown table references (VQB-3)", () => {
    const subquery: VqbQueryModel = { ...singleTableModel(), where: [{ id: "w1", column: "id", op: "IN", value: "(SELECT id FROM admins)", conjunction: "AND" }] };
    expect(validateVqbModel(subquery).errors.join(" ")).toMatch(/[Ss]ubquer/);
    expect(validateVqbModel({ ...singleTableModel(), columns: [{ table: "ghost", name: "id" }] }).errors.join(" ")).toMatch(/[Uu]nknown table/);
  });
  it("generateVqbSql throws VqbValidationError on invalid models", () => {
    expect(() => generateVqbSql({ ...singleTableModel(), columns: [] }, PG)).toThrowError(VqbValidationError);
  });
});

describe("vqb storage", () => {
  it("round-trips a valid model deep-equal (VQB-4)", () => {
    const model = joinedModel();
    expect(saveVqbDraft(model, "conn-a", "shop", "public")).toBe(true);
    expect(loadVqbDraft("conn-a", "shop", "public")).toEqual(model);
    clearVqbDraft("conn-a", "shop", "public");
    expect(loadVqbDraft("conn-a", "shop", "public")).toBeUndefined();
  });
  it("isolates keys per connection without touching other drafts (VQB-4)", () => {
    const keyA = vqbStorageKey("conn-a", "shop", "public");
    const keyB = vqbStorageKey("conn-b", "shop", "public");
    expect(keyA).toMatch(/^dbx:vqb:draft:v1:/);
    expect(keyA).not.toBe(keyB);
    const model = singleTableModel();
    expect(saveVqbDraft(model, "conn-a", "shop", "public")).toBe(true);
    expect(loadVqbDraft("conn-b", "shop", "public")).toBeUndefined();
    clearVqbDraft("conn-a", "shop", "public");
  });
});
