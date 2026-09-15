import type { VqbQueryModel, VqbWhereOp } from "./model";

export class VqbValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.length > 0 ? errors[0] : "Invalid visual query model");
    this.name = "VqbValidationError";
    this.errors = [...errors];
  }
}

export interface VqbValidationResult {
  ok: boolean;
  errors: string[];
}

const WHERE_OPS: ReadonlySet<string> = new Set(["=", "<>", ">", "<", ">=", "<=", "LIKE", "IN", "IS NULL", "IS NOT NULL"]);
const SUBQUERY_PATTERN = /\(\s*select\b/i;
const CTE_PATTERN = /\bwith\s+[a-z_][a-z0-9_]*\s+as\s*\(/i;
const HAVING_PATTERN = /\bhaving\b/i;
const FUNCTION_CALL_PATTERN = /[a-z_][a-z0-9_]*\s*\(/i;

function tableNames(model: VqbQueryModel): Set<string> {
  return new Set(model.tables.map((table) => table.name));
}

function checkBoundaryFragment(value: string, errors: string[]): void {
  if (SUBQUERY_PATTERN.test(value)) errors.push(`Subqueries are out of MVP scope: "${value.slice(0, 48)}"`);
  else if (CTE_PATTERN.test(value)) errors.push(`CTEs (WITH … AS) are out of MVP scope: "${value.slice(0, 48)}"`);
  else if (HAVING_PATTERN.test(value)) errors.push(`HAVING is out of MVP scope: "${value.slice(0, 48)}"`);
}

function checkFunctionCall(value: string, op: VqbWhereOp, errors: string[]): void {
  if (op !== "IN" && FUNCTION_CALL_PATTERN.test(value)) errors.push(`Advanced functions are out of MVP scope: "${value.slice(0, 48)}"`);
}

/** Validates a VQB model. Structural problems and MVP-boundary constructs are reported as errors naming the construct. */
export function validateVqbModel(model: VqbQueryModel): VqbValidationResult {
  const errors: string[] = [];
  if (!model || typeof model !== "object" || !Array.isArray(model.tables) || !Array.isArray(model.columns)) return { ok: false, errors: ["Visual query model must define tables and columns"] };
  const known = tableNames(model);
  if (model.columns.length === 0) errors.push("Select at least one column");
  for (const table of model.tables) {
    if (!table.name) errors.push("Table name must not be empty");
    else checkBoundaryFragment(table.name, errors);
    if (!table.alias) errors.push(`Alias must not be empty for table "${table.name}"`);
  }
  for (const column of model.columns ?? []) {
    if (!column.name) errors.push("Column name must not be empty");
    else checkBoundaryFragment(column.name, errors);
    if (!known.has(column.table)) errors.push(`Unknown table reference "${column.table}" in SELECT columns`);
  }
  for (const join of model.joins ?? []) {
    const kind = (join as { kind?: unknown }).kind;
    if (kind !== "INNER") errors.push(`Only INNER joins are in MVP (got "${String(kind)}")`);
    if (!known.has(join.left?.table) || !known.has(join.right?.table)) errors.push(`Unknown table reference "${join.left?.table} → ${join.right?.table}" in join`);
    if (!join.left?.column || !join.right?.column) errors.push("Join columns must not be empty");
  }
  for (const rule of model.where ?? []) {
    if (!WHERE_OPS.has(rule.op)) {
      errors.push(`Unsupported WHERE operator "${String((rule as { op?: unknown }).op)}" — MVP supports =, <>, >, <, >=, <=, LIKE, IN, IS NULL, IS NOT NULL`);
      continue;
    }
    if (rule.column.includes(".")) {
      const table = rule.column.slice(0, rule.column.lastIndexOf("."));
      if (!known.has(table)) errors.push(`Unknown table reference "${table}" in WHERE rule "${rule.id}"`);
    } else if (!rule.column) errors.push(`Column must not be empty in WHERE rule "${rule.id}"`);
    if (rule.op !== "IS NULL" && rule.op !== "IS NOT NULL") {
      checkBoundaryFragment(rule.value, errors);
      checkFunctionCall(rule.value, rule.op, errors);
    }
  }
  for (const order of model.orderBy ?? []) {
    if (!known.has(order.table)) errors.push(`Unknown table reference "${order.table}" in ORDER BY`);
    if (order.dir !== "ASC" && order.dir !== "DESC") errors.push(`ORDER BY direction must be ASC or DESC (got "${String((order as { dir?: unknown }).dir)}")`);
  }
  if (model.limit !== undefined && (!Number.isInteger(model.limit) || model.limit <= 0)) errors.push(`LIMIT must be a positive integer (got "${String(model.limit)}")`);
  return { ok: errors.length === 0, errors };
}
