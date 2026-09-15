import type { Edge, Node } from "@vue-flow/core";
import { CARD_WIDTH, tableCardHeight } from "@/lib/diagram/diagram-constants";
import type { DiagramRelationship, DiagramTable } from "@/lib/diagram/erDiagram";
import type { ColumnInfo, ForeignKeyInfo } from "@/types/database";
import type { VqbJoin, VqbQueryModel } from "@/lib/vqb/model";

/** Minimal schema view the canvas needs: table names, columns, and FK links. */
export interface VqbSchemaColumn {
  name: string;
  dataType?: string;
  isPrimaryKey?: boolean;
}

export interface VqbSchemaTable {
  name: string;
  columns: VqbSchemaColumn[];
  foreignKeys: { column: string; refTable: string; refColumn: string }[];
}

/** The only join kind the MVP canvas can create (VQB-6). */
export const VQB_JOIN_KIND = "INNER" as const;

/** Next table alias (`t1..tn`) avoiding collisions with existing aliases. */
export function nextVqbAlias(model: VqbQueryModel): string {
  const taken = new Set(model.tables.map((table) => table.alias));
  let index = model.tables.length + 1;
  while (taken.has(`t${index}`)) index += 1;
  return `t${index}`;
}

function toColumnInfo(column: VqbSchemaColumn): ColumnInfo {
  return {
    name: column.name,
    data_type: column.dataType ?? "text",
    is_nullable: true,
    column_default: null,
    is_primary_key: column.isPrimaryKey ?? false,
    extra: null,
  };
}

function toForeignKeyInfo(tableName: string, fk: VqbSchemaTable["foreignKeys"][number], index: number): ForeignKeyInfo {
  return {
    name: `vqb:${tableName}:${fk.column}:${index}`,
    column: fk.column,
    ref_table: fk.refTable,
    ref_column: fk.refColumn,
  };
}

/** Synthesize the `DiagramTable` shape `TableNode.vue` renders from VQB schema info. */
export function buildVqbDiagramTable(schema: VqbSchemaTable): DiagramTable {
  return {
    name: schema.name,
    columns: schema.columns.map(toColumnInfo),
    foreignKeys: schema.foreignKeys.map((fk, index) => toForeignKeyInfo(schema.name, fk, index)),
    origin: "live",
  };
}

/**
 * Minimal VQB mapper reusing only `TableNode.vue` data contracts.
 * Positions are a deterministic grid fallback; `VqbCanvas` refines them
 * with `computeLayoutWithLayers` after drops.
 */
export function vqbToFlowNodes(model: VqbQueryModel, schemaByName: Map<string, VqbSchemaTable>): Node<{ table: DiagramTable }>[] {
  return model.tables.map((table, index) => {
    const schema = schemaByName.get(table.name);
    const diagramTable = schema ? buildVqbDiagramTable(schema) : { name: table.name, columns: [], foreignKeys: [], origin: "live" as const };
    const row = Math.floor(index / 3);
    const col = index % 3;
    return {
      id: table.name,
      type: "table",
      position: {
        x: col * (CARD_WIDTH + 80),
        y: row * (tableCardHeight(diagramTable.columns.length) + 60),
      },
      data: { table: diagramTable },
    };
  });
}

function vqbJoinId(join: VqbJoin): string {
  return ["vqb", join.left.table, join.left.column, join.right.table, join.right.column].join(":");
}

export function vqbJoinToRelationship(join: VqbJoin): DiagramRelationship {
  return {
    id: vqbJoinId(join),
    name: vqbJoinId(join),
    kind: "foreign-key",
    sourceTable: join.left.table,
    sourceColumn: join.left.column,
    targetTable: join.right.table,
    targetColumn: join.right.column,
    sourceCardinality: "N",
    targetCardinality: "1",
  };
}

/** Minimal edge mapper reusing only the `RelationshipEdge.vue` data contract. */
export function vqbToFlowEdges(model: VqbQueryModel): Edge<{ relationship: DiagramRelationship }>[] {
  return model.joins.map((join) => ({
    id: vqbJoinId(join),
    type: "relationship",
    source: join.left.table,
    target: join.right.table,
    data: { relationship: vqbJoinToRelationship(join) },
  }));
}

/**
 * Suggest an INNER join between an added table and the tables already on
 * canvas, following FK links in either direction. Returns null when the
 * tables are unrelated (canvas keeps the table without edges).
 */
export function suggestVqbJoin(canvasTables: string[], added: VqbSchemaTable, schemaByName: Map<string, VqbSchemaTable>): VqbJoin | null {
  const onCanvas = new Set(canvasTables);
  for (const fk of added.foreignKeys) {
    if (onCanvas.has(fk.refTable)) {
      return { left: { table: added.name, column: fk.column }, right: { table: fk.refTable, column: fk.refColumn }, kind: VQB_JOIN_KIND };
    }
  }
  for (const name of canvasTables) {
    const candidate = schemaByName.get(name);
    for (const fk of candidate?.foreignKeys ?? []) {
      if (fk.refTable === added.name) {
        return { left: { table: name, column: fk.column }, right: { table: added.name, column: fk.refColumn }, kind: VQB_JOIN_KIND };
      }
    }
  }
  return null;
}
