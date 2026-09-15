import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import type { VqbQueryModel } from "./model";
import { validateVqbModel } from "./validate";

const STORAGE_PREFIX = "dbx:vqb:draft:v1";

function sanitizeScopePart(value: string): string {
  const cleaned = value.trim().replaceAll(":", "_");
  return cleaned.length > 0 ? cleaned : "_";
}

/** Scoped draft key. The `vqb` kind segment never collides with existing draft keys. */
export function vqbStorageKey(connectionId: string, database: string, schema: string): string {
  return [STORAGE_PREFIX, sanitizeScopePart(connectionId), sanitizeScopePart(database), sanitizeScopePart(schema)].join(":");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Returns a deep-cloned valid model, or undefined when the payload fails validation. */
export function sanitizeVqbModel(value: unknown): VqbQueryModel | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = {
    tables: Array.isArray(value.tables) ? value.tables.filter(isRecord).map((t) => ({ name: String(t.name ?? ""), alias: String(t.alias ?? "") })) : [],
    columns: Array.isArray(value.columns) ? value.columns.filter(isRecord).map((c) => ({ table: String(c.table ?? ""), name: String(c.name ?? ""), ...(typeof c.alias === "string" && c.alias ? { alias: c.alias } : {}) })) : [],
    joins: Array.isArray(value.joins)
      ? value.joins.filter(isRecord).map((j) => ({
          left: { table: String((j.left as Record<string, unknown>)?.table ?? ""), column: String((j.left as Record<string, unknown>)?.column ?? "") },
          right: { table: String((j.right as Record<string, unknown>)?.table ?? ""), column: String((j.right as Record<string, unknown>)?.column ?? "") },
          kind: (j as { kind?: unknown }).kind,
        }))
      : [],
    where: Array.isArray(value.where) ? value.where.filter(isRecord).map((r) => ({ id: String(r.id ?? ""), column: String(r.column ?? ""), op: r.op, value: String(r.value ?? ""), conjunction: r.conjunction === "OR" ? "OR" : "AND", ...(r.disabled === true ? { disabled: true } : {}) })) : [],
    orderBy: Array.isArray(value.orderBy) ? value.orderBy.filter(isRecord).map((o) => ({ table: String(o.table ?? ""), column: String(o.column ?? ""), dir: o.dir })) : [],
    ...(Number.isInteger(value.limit) ? { limit: value.limit as number } : {}),
  };
  const validation = validateVqbModel(candidate as VqbQueryModel);
  if (!validation.ok) return undefined;
  return candidate as VqbQueryModel;
}

export function saveVqbDraft(model: VqbQueryModel, connectionId: string, database: string, schema: string): boolean {
  if (!connectionId || !database || !validateVqbModel(model).ok) return false;
  return safeLocalStorageSet(vqbStorageKey(connectionId, database, schema), JSON.stringify(model));
}

export function loadVqbDraft(connectionId: string, database: string, schema: string): VqbQueryModel | undefined {
  if (!connectionId || !database) return undefined;
  const raw = safeLocalStorageGet(vqbStorageKey(connectionId, database, schema));
  if (!raw) return undefined;
  try {
    return sanitizeVqbModel(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

export function clearVqbDraft(connectionId: string, database: string, schema: string): void {
  if (!connectionId || !database) return;
  safeLocalStorageRemove(vqbStorageKey(connectionId, database, schema));
}
