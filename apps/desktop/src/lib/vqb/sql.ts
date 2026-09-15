import type { VqbDialect, VqbQueryModel, VqbWhereRule } from "./model";
import { validateVqbModel, VqbValidationError } from "./validate";

const NUMERIC_LITERAL = /^-?\d+(\.\d+)?$/;

function resolveQuote(dialect: VqbDialect): string {
  if (dialect.identifierQuote) return dialect.identifierQuote;
  return dialect.databaseType === "mysql" ? "`" : '"';
}

function quoteIdentifier(name: string, quote: string): string {
  return `${quote}${name.replaceAll(quote, quote + quote)}${quote}`;
}

function escapeLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function renderLiteral(value: string): string {
  return NUMERIC_LITERAL.test(value.trim()) ? value.trim() : escapeLiteral(value);
}

function aliasFor(table: string, aliasByTable: Map<string, string>, fallback: string): string {
  return aliasByTable.get(table) ?? fallback;
}

/** Resolves a WHERE column ("table.column" or bare) to an aliased reference. Bare names use the first table. */
function resolveWhereColumn(column: string, aliasByTable: Map<string, string>, firstAlias: string, quote: string): string {
  const dot = column.lastIndexOf(".");
  if (dot > 0) return `${aliasFor(column.slice(0, dot), aliasByTable, firstAlias)}.${quoteIdentifier(column.slice(dot + 1), quote)}`;
  return `${firstAlias}.${quoteIdentifier(column, quote)}`;
}

function renderWhereRule(rule: VqbWhereRule, ref: string): string {
  switch (rule.op) {
    case "IS NULL":
    case "IS NOT NULL":
      return `${ref} ${rule.op}`;
    case "IN": {
      const items = rule.value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map(renderLiteral);
      return `${ref} IN (${items.join(", ")})`;
    }
    case "LIKE":
      return `${ref} LIKE ${escapeLiteral(rule.value)}`;
    default:
      return `${ref} ${rule.op} ${renderLiteral(rule.value)}`;
  }
}

/**
 * Generates executable SELECT SQL for postgres/mysql/sqlite. Pure and sync —
 * dialect comes from `{ databaseType, identifierQuote }`, never from a backend
 * roundtrip. Throws {@link VqbValidationError} when the model is invalid.
 */
export function generateVqbSql(model: VqbQueryModel, dialect: VqbDialect): string {
  const validation = validateVqbModel(model);
  if (!validation.ok) throw new VqbValidationError(validation.errors);
  const quote = resolveQuote(dialect);
  const aliasByTable = new Map<string, string>();
  model.tables.forEach((table, index) => aliasByTable.set(table.name, `t${index + 1}`));
  const firstAlias = aliasByTable.get(model.tables[0]?.name ?? "") ?? "t1";
  const selectList = model.columns.map((column) => {
    const ref = `${aliasFor(column.table, aliasByTable, firstAlias)}.${quoteIdentifier(column.name, quote)}`;
    return column.alias ? `${ref} AS ${quoteIdentifier(column.alias, quote)}` : ref;
  });
  let sql = `SELECT ${selectList.join(", ")} FROM ${quoteIdentifier(model.tables[0]?.name ?? "", quote)} AS ${firstAlias}`;
  for (const join of model.joins) {
    const rightAlias = aliasFor(join.right.table, aliasByTable, firstAlias);
    sql += ` INNER JOIN ${quoteIdentifier(join.right.table, quote)} AS ${rightAlias} ON ${aliasFor(join.left.table, aliasByTable, firstAlias)}.${quoteIdentifier(join.left.column, quote)} = ${rightAlias}.${quoteIdentifier(join.right.column, quote)}`;
  }
  const activeRules = model.where.filter((rule) => rule.disabled !== true);
  if (activeRules.length > 0) {
    const [head, ...tail] = activeRules;
    let where = renderWhereRule(head, resolveWhereColumn(head.column, aliasByTable, firstAlias, quote));
    for (const rule of tail) where = `(${where}) ${rule.conjunction} (${renderWhereRule(rule, resolveWhereColumn(rule.column, aliasByTable, firstAlias, quote))})`;
    sql += ` WHERE ${where}`;
  }
  if (model.orderBy.length > 0) sql += ` ORDER BY ${model.orderBy.map((order) => `${aliasFor(order.table, aliasByTable, firstAlias)}.${quoteIdentifier(order.column, quote)} ${order.dir}`).join(", ")}`;
  if (model.limit !== undefined) sql += ` LIMIT ${model.limit}`;
  return `${sql};`;
}
