/**
 * Database connector: connect any Postgres or MySQL database with no code.
 *
 * Safety model
 * - The AI never writes SQL. It picks a table, equality filters and values;
 *   every identifier is checked against the live schema and every value is a
 *   bound parameter, so injection is impossible by construction.
 * - Secret-looking columns (password, token, …) are never returned; contact
 *   columns (email, phone) are masked.
 * - Writes are capped (MAX_ROWS) and run in a transaction keyed by primary
 *   key. The previous values are kept (encrypted) so any write can be undone.
 * - Default rules: reading runs automatically, inserts/updates ask first,
 *   deletes are never allowed until the owner changes the rule.
 */
import { decryptSecret, encryptSecret } from "../hashing";
import { actionDefSchema, type ActionDef, type Connector, type Preview } from "../types";
import { ConnectorError } from "./http";

export const MAX_ROWS = 50;
const READ_LIMIT = 100;

export type Engine = "postgres" | "mysql";
type Row = Record<string, unknown>;

/** The tiny surface each driver implements; makes the logic testable without a server. */
export interface SqlClient {
  engine: Engine;
  query(sql: string, params?: unknown[]): Promise<Row[]>;
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

export async function openClient(engine: Engine, url: string): Promise<SqlClient> {
  if (engine === "postgres") {
    const { Client } = await import("pg");
    const needsTls = /sslmode=(require|verify)/.test(url) || /neon\.tech|supabase|amazonaws/.test(url);
    const client = new Client({ connectionString: url, ssl: needsTls ? { rejectUnauthorized: false } : undefined, statement_timeout: 10_000 });
    await client.connect();
    const wrap = (): SqlClient => ({
      engine,
      query: async (sql, params = []) => (await client.query(sql, params)).rows as Row[],
      transaction: async (fn) => {
        await client.query("BEGIN");
        try {
          const out = await fn(wrap());
          await client.query("COMMIT");
          return out;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      },
      close: () => client.end(),
    });
    return wrap();
  }
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection({ uri: url, connectTimeout: 10_000, dateStrings: true });
  const wrap = (): SqlClient => ({
    engine,
    query: async (sql, params = []) => {
      const [rows] = await conn.query(sql, params);
      return (Array.isArray(rows) ? rows : [rows]) as Row[];
    },
    transaction: async (fn) => {
      await conn.beginTransaction();
      try {
        const out = await fn(wrap());
        await conn.commit();
        return out;
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    },
    close: () => conn.end(),
  });
  return wrap();
}

// ---------------------------------------------------------------------------
// Dialect + schema
// ---------------------------------------------------------------------------

const quote = (engine: Engine, name: string) => (engine === "postgres" ? `"${name.replace(/"/g, '""')}"` : `\`${name.replace(/`/g, "``")}\``);
const placeholder = (engine: Engine, i: number) => (engine === "postgres" ? `$${i}` : "?");

export type TableInfo = { name: string; columns: string[]; primaryKey: string[] };

export async function introspect(db: SqlClient): Promise<TableInfo[]> {
  const columns =
    db.engine === "postgres"
      ? await db.query(
          `SELECT table_name AS t, column_name AS c FROM information_schema.columns
           WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`,
        )
      : await db.query(
          `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.columns
           WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        );
  const keys =
    db.engine === "postgres"
      ? await db.query(
          `SELECT kcu.table_name AS t, kcu.column_name AS c FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = current_schema() ORDER BY kcu.ordinal_position`,
        )
      : await db.query(
          `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.key_column_usage
           WHERE CONSTRAINT_NAME = 'PRIMARY' AND TABLE_SCHEMA = DATABASE() ORDER BY ORDINAL_POSITION`,
        );
  const tables = new Map<string, TableInfo>();
  for (const { t, c } of columns as Array<{ t: string; c: string }>) {
    const table = tables.get(t) ?? { name: t, columns: [], primaryKey: [] };
    table.columns.push(c);
    tables.set(t, table);
  }
  for (const { t, c } of keys as Array<{ t: string; c: string }>) tables.get(t)?.primaryKey.push(c);
  return [...tables.values()];
}

const SECRET_COLUMN = /pass(word)?|secret|token|api_?key|hash|salt|otp|pin_?code/i;
const CONTACT_COLUMN = /e_?mail|phone|mobile/i;

export function redact(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (SECRET_COLUMN.test(key)) continue;
    if (CONTACT_COLUMN.test(key) && typeof value === "string" && value.length > 4) {
      out[key] = value.includes("@") ? `${value.slice(0, 2)}***@${value.split("@")[1]}` : `${value.slice(0, 3)}***${value.slice(-2)}`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Safe query building
// ---------------------------------------------------------------------------

type Where = Record<string, unknown>;

function requireTable(schema: TableInfo[], name: unknown, allowed?: string[]): TableInfo {
  const table = schema.find((t) => t.name === name);
  if (!table || (allowed?.length && !allowed.includes(table.name))) {
    throw new ConnectorError(`Unknown table "${String(name)}". Use list_tables to see what exists.`);
  }
  return table;
}

function requireColumns(table: TableInfo, cols: string[]) {
  const bad = cols.filter((c) => !table.columns.includes(c));
  if (bad.length) throw new ConnectorError(`Unknown column(s) in ${table.name}: ${bad.join(", ")}`);
}

/** Equality filters only: `{col: value}`, `{col: [a, b]}` (IN) or `{col: null}` (IS NULL). */
export function whereClause(engine: Engine, table: TableInfo, where: Where, start = 1) {
  const cols = Object.keys(where);
  requireColumns(table, cols);
  const params: unknown[] = [];
  const parts = cols.map((col) => {
    const value = where[col];
    const q = quote(engine, col);
    if (value === null) return `${q} IS NULL`;
    if (Array.isArray(value)) {
      if (value.length === 0) return "1 = 0";
      return `${q} IN (${value.map((v) => (params.push(v), placeholder(engine, start + params.length - 1))).join(", ")})`;
    }
    params.push(value);
    return `${q} = ${placeholder(engine, start + params.length - 1)}`;
  });
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

const asWhere = (value: unknown): Where => (value && typeof value === "object" && !Array.isArray(value) ? (value as Where) : {});

async function selectRows(db: SqlClient, table: TableInfo, where: Where, limit: number, lock = false) {
  const w = whereClause(db.engine, table, where);
  const params = [...w.params, limit];
  return db.query(
    `SELECT * FROM ${quote(db.engine, table.name)} ${w.sql} LIMIT ${placeholder(db.engine, params.length)}${lock ? " FOR UPDATE" : ""}`,
    params,
  );
}

const pkOf = (table: TableInfo, row: Row): Where => Object.fromEntries(table.primaryKey.map((k) => [k, row[k]]));

function requireKey(table: TableInfo) {
  if (!table.primaryKey.length) throw new ConnectorError(`Table ${table.name} has no primary key, so changes to it can't be undone safely.`);
}

const label = (table: TableInfo, row: Row) => `${table.name} ${table.primaryKey.map((k) => `${k}=${String(row[k])}`).join(", ")}`;
const show = (v: unknown): string | null =>
  v === null || v === undefined ? null : (typeof v === "object" ? JSON.stringify(v) : String(v)).slice(0, 120);

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const where = { type: "object", description: "Equality filters, e.g. {\"status\": \"new\"} or {\"id\": [1, 2]}", additionalProperties: true };
const tableProp = { type: "string", description: "Table name from list_tables" };

export function databaseActions(readOnly: boolean): ActionDef[] {
  const defs = [
    { name: "list_tables", title: "See the tables", description: "List tables and their columns.", tier: "auto", summary: "Look at the database tables", input: { type: "object", properties: {} } },
    {
      name: "read_rows",
      title: "Read records",
      description: "Read up to 100 records from a table, optionally filtered. Private fields are hidden.",
      tier: "auto",
      summary: "Read records from {table}",
      input: {
        type: "object",
        required: ["table"],
        properties: { table: tableProp, where, limit: { type: "integer", minimum: 1, maximum: READ_LIMIT }, order_by: { type: "string" }, descending: { type: "boolean" } },
      },
    },
    {
      name: "count_rows",
      title: "Count records",
      description: "Count records in a table, optionally filtered.",
      tier: "auto",
      summary: "Count records in {table}",
      input: { type: "object", required: ["table"], properties: { table: tableProp, where } },
    },
    ...(readOnly
      ? []
      : [
          {
            name: "insert_row",
            title: "Add a record",
            description: "Add one new record to a table.",
            tier: "ask",
            undo: true,
            preview: true,
            summary: "Add a record to {table}",
            input: { type: "object", required: ["table", "values"], properties: { table: tableProp, values: { type: "object", additionalProperties: true } } },
          },
          {
            name: "update_rows",
            title: "Change records",
            description: `Change matching records (at most ${MAX_ROWS} at once).`,
            tier: "ask",
            undo: true,
            preview: true,
            summary: "Change records in {table}",
            input: {
              type: "object",
              required: ["table", "where", "set"],
              properties: { table: tableProp, where, set: { type: "object", additionalProperties: true, description: "Columns and their new values" } },
            },
          },
          {
            name: "delete_rows",
            title: "Delete records",
            description: `Delete matching records (at most ${MAX_ROWS} at once).`,
            tier: "never",
            undo: true,
            preview: true,
            summary: "Delete records from {table}",
            input: { type: "object", required: ["table", "where"], properties: { table: tableProp, where } },
          },
        ]),
  ];
  return defs.map((d) => actionDefSchema.parse(d));
}

type UndoToken =
  | { op: "insert"; table: string; key: Where }
  | { op: "update"; table: string; rows: Array<{ key: Where; previous: Row }> }
  | { op: "delete"; table: string; rows: Row[] };

export function createDatabaseConnector(
  config: { engine: Engine; tables?: string[]; readOnly?: boolean },
  connectionUrl: string,
  overrides: ActionDef[] = [],
  open: (engine: Engine, url: string) => Promise<SqlClient> = openClient,
): Connector {
  const byName = new Map(overrides.map((a) => [a.name, a]));
  const actions = databaseActions(Boolean(config.readOnly)).map((a) => {
    const o = byName.get(a.name);
    return o ? { ...a, title: o.title, description: o.description || a.description, tier: o.tier, escalate: o.escalate } : a;
  });

  async function withDb<T>(fn: (db: SqlClient, schema: TableInfo[]) => Promise<T>): Promise<T> {
    let db: SqlClient | undefined;
    try {
      db = await open(config.engine, connectionUrl);
      return await fn(db, await introspect(db));
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const message = (error as Error)?.message ?? "Database error";
      throw new ConnectorError(`The database refused this: ${message.replace(/postgres(ql)?:\/\/\S+|mysql:\/\/\S+/g, "[connection]").slice(0, 180)}`);
    } finally {
      await db?.close().catch(() => undefined);
    }
  }

  return {
    async listActions() {
      return actions;
    },

    async preview(action, input) {
      return withDb(async (db, schema): Promise<Preview> => {
        const table = requireTable(schema, input.table, config.tables);
        if (action.name === "insert_row") {
          const values = asWhere(input.values);
          requireColumns(table, Object.keys(values));
          return {
            changes: Object.entries(values).map(([k, v]) => ({ label: `New ${table.name} · ${k}`, before: null, after: show(SECRET_COLUMN.test(k) ? "••••" : v) })),
            warnings: [],
          };
        }
        const filter = asWhere(input.where);
        const rows = await selectRows(db, table, filter, MAX_ROWS + 1);
        const warnings = rows.length > MAX_ROWS ? [`This matches more than ${MAX_ROWS} records, so it will be refused. Narrow the filter.`] : [];
        if (rows.length === 0) warnings.push("No records match, so nothing would change.");
        if (action.name === "delete_rows") {
          return { changes: rows.slice(0, 10).map((r) => ({ label: label(table, r), before: "exists", after: null })), warnings: [`${rows.length} record(s) will be deleted.`, ...warnings] };
        }
        const set = asWhere(input.set);
        requireColumns(table, Object.keys(set));
        const changes = rows.slice(0, 10).flatMap((r) =>
          Object.entries(set).map(([k, v]) => ({ label: `${label(table, r)} · ${k}`, before: show(SECRET_COLUMN.test(k) ? "••••" : r[k]), after: show(SECRET_COLUMN.test(k) ? "••••" : v) })),
        );
        if (rows.length > 10) warnings.unshift(`${rows.length} records will change; the first 10 are shown.`);
        return { changes, warnings };
      });
    },

    async execute(action, input) {
      return withDb(async (db, schema) => {
        if (action.name === "list_tables") {
          const visible = schema.filter((t) => !config.tables?.length || config.tables.includes(t.name));
          return { result: visible.map((t) => ({ table: t.name, columns: t.columns.filter((c) => !SECRET_COLUMN.test(c)) })) };
        }
        const table = requireTable(schema, input.table, config.tables);
        const filter = asWhere(input.where);

        if (action.name === "read_rows") {
          const limit = Math.min(Math.max(Number(input.limit) || 20, 1), READ_LIMIT);
          const w = whereClause(db.engine, table, filter);
          let order = "";
          if (typeof input.order_by === "string") {
            requireColumns(table, [input.order_by]);
            order = ` ORDER BY ${quote(db.engine, input.order_by)} ${input.descending ? "DESC" : "ASC"}`;
          }
          const params = [...w.params, limit];
          const rows = await db.query(`SELECT * FROM ${quote(db.engine, table.name)} ${w.sql}${order} LIMIT ${placeholder(db.engine, params.length)}`, params);
          return { result: rows.map(redact) };
        }
        if (action.name === "count_rows") {
          const w = whereClause(db.engine, table, filter);
          const [row] = await db.query(`SELECT COUNT(*) AS n FROM ${quote(db.engine, table.name)} ${w.sql}`, w.params);
          return { result: { table: table.name, count: Number(row?.n ?? 0) } };
        }

        requireKey(table);

        if (action.name === "insert_row") {
          const values = asWhere(input.values);
          const cols = Object.keys(values);
          if (!cols.length) throw new ConnectorError("Give at least one value.");
          requireColumns(table, cols);
          const sql = `INSERT INTO ${quote(db.engine, table.name)} (${cols.map((c) => quote(db.engine, c)).join(", ")}) VALUES (${cols.map((_, i) => placeholder(db.engine, i + 1)).join(", ")})`;
          let key: Where;
          if (db.engine === "postgres") {
            const [row] = await db.query(`${sql} RETURNING ${table.primaryKey.map((k) => quote(db.engine, k)).join(", ")}`, Object.values(values));
            key = pkOf(table, row ?? {});
          } else {
            const [res] = await db.query(sql, Object.values(values));
            const insertId = (res as { insertId?: number })?.insertId;
            key = table.primaryKey.length === 1 && insertId && values[table.primaryKey[0]!] === undefined ? { [table.primaryKey[0]!]: insertId } : pkOf(table, values);
          }
          return { result: { inserted: key }, undoToken: encryptSecret(JSON.stringify({ op: "insert", table: table.name, key } satisfies UndoToken)) };
        }

        if (!Object.keys(filter).length) throw new ConnectorError("A filter is required for changes and deletes.");

        return db.transaction(async (tx) => {
          const rows = await selectRows(tx, table, filter, MAX_ROWS + 1, true);
          if (rows.length > MAX_ROWS) throw new ConnectorError(`This matches more than ${MAX_ROWS} records. Narrow the filter.`);
          if (rows.length === 0) return { result: { affected: 0 } };

          if (action.name === "update_rows") {
            const set = asWhere(input.set);
            const cols = Object.keys(set);
            if (!cols.length) throw new ConnectorError("Say which columns to change.");
            requireColumns(table, cols);
            for (const row of rows) {
              const w = whereClause(tx.engine, table, pkOf(table, row), cols.length + 1);
              await tx.query(
                `UPDATE ${quote(tx.engine, table.name)} SET ${cols.map((c, i) => `${quote(tx.engine, c)} = ${placeholder(tx.engine, i + 1)}`).join(", ")} ${w.sql}`,
                [...Object.values(set), ...w.params],
              );
            }
            const undo: UndoToken = {
              op: "update",
              table: table.name,
              rows: rows.map((r) => ({ key: pkOf(table, r), previous: Object.fromEntries(cols.map((c) => [c, r[c]])) })),
            };
            return { result: { affected: rows.length }, undoToken: encryptSecret(JSON.stringify(undo)) };
          }

          if (action.name === "delete_rows") {
            for (const row of rows) {
              const w = whereClause(tx.engine, table, pkOf(table, row));
              await tx.query(`DELETE FROM ${quote(tx.engine, table.name)} ${w.sql}`, w.params);
            }
            return { result: { deleted: rows.length }, undoToken: encryptSecret(JSON.stringify({ op: "delete", table: table.name, rows } satisfies UndoToken)) };
          }
          throw new ConnectorError(`Unknown action ${action.name}`);
        });
      });
    },

    async undo(_action, token) {
      const undo = JSON.parse(decryptSecret(token)) as UndoToken;
      await withDb(async (db, schema) => {
        const table = requireTable(schema, undo.table);
        await db.transaction(async (tx) => {
          if (undo.op === "insert") {
            const w = whereClause(tx.engine, table, undo.key);
            await tx.query(`DELETE FROM ${quote(tx.engine, table.name)} ${w.sql}`, w.params);
          } else if (undo.op === "update") {
            for (const { key, previous } of undo.rows) {
              const cols = Object.keys(previous);
              const w = whereClause(tx.engine, table, key, cols.length + 1);
              await tx.query(
                `UPDATE ${quote(tx.engine, table.name)} SET ${cols.map((c, i) => `${quote(tx.engine, c)} = ${placeholder(tx.engine, i + 1)}`).join(", ")} ${w.sql}`,
                [...Object.values(previous), ...w.params],
              );
            }
          } else {
            for (const row of undo.rows) {
              const cols = Object.keys(row);
              await tx.query(
                `INSERT INTO ${quote(tx.engine, table.name)} (${cols.map((c) => quote(tx.engine, c)).join(", ")}) VALUES (${cols.map((_, i) => placeholder(tx.engine, i + 1)).join(", ")})`,
                Object.values(row),
              );
            }
          }
        });
      });
    },
  };
}
