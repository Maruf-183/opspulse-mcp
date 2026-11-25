import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { createDatabaseConnector, MAX_ROWS, redact, whereClause, type SqlClient } from "./database";

const pg = new PGlite();

/** PGlite speaks the Postgres protocol in-process; wrap it as the connector's SqlClient. */
function client(db: Pick<PGlite, "query"> & { transaction?: PGlite["transaction"] }): SqlClient {
  return {
    engine: "postgres",
    query: async (sql, params = []) => (await db.query(sql, params)).rows as Record<string, unknown>[],
    transaction: async (fn) => (db.transaction ? db.transaction((tx) => fn(client(tx))) : fn(client(db))),
    close: async () => undefined,
  };
}

const connector = createDatabaseConnector({ engine: "postgres", tables: [], readOnly: false }, "postgres://unused", [], async () => client(pg));
const action = async (name: string) => (await connector.listActions()).find((a) => a.name === name)!;
const ctx = { requestId: "t" };
const run = async (name: string, input: Record<string, unknown>) => connector.execute(await action(name), input, ctx);

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE leads (id SERIAL PRIMARY KEY, name TEXT, email TEXT, status TEXT, password_hash TEXT);
    INSERT INTO leads (name, email, status, password_hash) VALUES
      ('Rahim', 'rahim@example.com', 'new', 'x'), ('Nusrat', 'nusrat@example.com', 'new', 'y'), ('Tanvir', 'tanvir@example.com', 'won', 'z');
    CREATE TABLE notes (body TEXT);
    CREATE TABLE bulk (id SERIAL PRIMARY KEY, flag BOOLEAN DEFAULT false);
    INSERT INTO bulk (flag) SELECT false FROM generate_series(1, ${MAX_ROWS + 5});
  `);
});

describe("database connector", () => {
  it("offers safe default rules", async () => {
    const tiers = Object.fromEntries((await connector.listActions()).map((a) => [a.name, a.tier]));
    expect(tiers).toMatchObject({ list_tables: "auto", read_rows: "auto", insert_row: "ask", update_rows: "ask", delete_rows: "never" });
  });

  it("lists tables without secret columns", async () => {
    const { result } = await run("list_tables", {});
    const leads = (result as Array<{ table: string; columns: string[] }>).find((t) => t.table === "leads");
    expect(leads?.columns).toEqual(["id", "name", "email", "status"]);
  });

  it("reads with filters, masks contacts and never returns secrets", async () => {
    const { result } = await run("read_rows", { table: "leads", where: { status: "new" }, order_by: "id" });
    const rows = result as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Rahim", email: "ra***@example.com" });
    expect(rows[0]).not.toHaveProperty("password_hash");
    expect((await run("count_rows", { table: "leads", where: { status: ["new", "won"] } })).result).toMatchObject({ count: 3 });
  });

  it("rejects unknown tables and columns instead of building SQL from them", async () => {
    await expect(run("read_rows", { table: "leads; DROP TABLE leads" })).rejects.toThrow(/Unknown table/);
    await expect(run("read_rows", { table: "leads", where: { "status = 'x' OR 1=1 --": 1 } })).rejects.toThrow(/Unknown column/);
    await expect(run("read_rows", { table: "leads", order_by: "id; DROP TABLE leads" })).rejects.toThrow(/Unknown column/);
  });

  it("previews, changes and undoes an update", async () => {
    const update = await action("update_rows");
    const input = { table: "leads", where: { name: "Rahim" }, set: { status: "in_progress" } };
    const preview = await connector.preview!(update, input, ctx);
    expect(preview.changes[0]).toMatchObject({ before: "new", after: "in_progress" });

    const done = await connector.execute(update, input, ctx);
    expect(done.result).toMatchObject({ affected: 1 });
    expect((await pg.query("SELECT status FROM leads WHERE name = 'Rahim'")).rows[0]).toMatchObject({ status: "in_progress" });
    expect(done.undoToken).not.toContain("Rahim"); // the undo snapshot is encrypted

    await connector.undo!(update, done.undoToken!, ctx);
    expect((await pg.query("SELECT status FROM leads WHERE name = 'Rahim'")).rows[0]).toMatchObject({ status: "new" });
  });

  it("inserts and undoes an insert", async () => {
    const insert = await action("insert_row");
    const done = await connector.execute(insert, { table: "leads", values: { name: "Karim", status: "new" } }, ctx);
    expect((await run("count_rows", { table: "leads" })).result).toMatchObject({ count: 4 });
    await connector.undo!(insert, done.undoToken!, ctx);
    expect((await run("count_rows", { table: "leads" })).result).toMatchObject({ count: 3 });
  });

  it("deletes and fully restores on undo", async () => {
    const del = await action("delete_rows");
    const done = await connector.execute(del, { table: "leads", where: { name: "Tanvir" } }, ctx);
    expect(done.result).toMatchObject({ deleted: 1 });
    await connector.undo!(del, done.undoToken!, ctx);
    expect((await pg.query("SELECT email, password_hash FROM leads WHERE name = 'Tanvir'")).rows[0]).toMatchObject({
      email: "tanvir@example.com",
      password_hash: "z",
    });
  });

  it("refuses unfiltered, oversized and key-less writes", async () => {
    await expect(run("update_rows", { table: "leads", where: {}, set: { status: "lost" } })).rejects.toThrow(/filter is required/);
    await expect(run("update_rows", { table: "bulk", where: { flag: false }, set: { flag: true } })).rejects.toThrow(/more than/);
    await expect(run("insert_row", { table: "notes", values: { body: "x" } })).rejects.toThrow(/no primary key/);
  });

  it("builds MySQL-style SQL with ? placeholders and backticks", () => {
    const sql = whereClause("mysql", { name: "t", columns: ["a", "b"], primaryKey: ["a"] }, { a: 1, b: [2, 3] });
    expect(sql).toEqual({ sql: "WHERE `a` = ? AND `b` IN (?, ?)", params: [1, 2, 3] });
  });

  it("redacts secrets and masks contact fields", () => {
    expect(redact({ api_key: "k", phone: "01712345678", note: "hi" })).toEqual({ phone: "017***78", note: "hi" });
  });
});
