/** Visual Query Builder (MVP) query model. Frontend-pure types; no backend imports. */

export type VqbDatabaseType = "postgres" | "mysql" | "sqlite";

export interface VqbDialect {
  databaseType: VqbDatabaseType;
  identifierQuote: string;
}

export interface VqbTableRef {
  name: string;
  alias: string;
}

export interface VqbColumnRef {
  table: string;
  name: string;
  alias?: string;
}

export interface VqbJoinEndpoint {
  table: string;
  column: string;
}

export interface VqbJoin {
  left: VqbJoinEndpoint;
  right: VqbJoinEndpoint;
  kind: "INNER";
}

export type VqbWhereOp = "=" | "<>" | ">" | "<" | ">=" | "<=" | "LIKE" | "IN" | "IS NULL" | "IS NOT NULL";

export interface VqbWhereRule {
  id: string;
  column: string;
  op: VqbWhereOp;
  value: string;
  conjunction: "AND" | "OR";
  disabled?: boolean;
}

export interface VqbOrderBy {
  table: string;
  column: string;
  dir: "ASC" | "DESC";
}

export interface VqbQueryModel {
  tables: VqbTableRef[];
  columns: VqbColumnRef[];
  joins: VqbJoin[];
  where: VqbWhereRule[];
  orderBy: VqbOrderBy[];
  limit?: number;
}
