import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** An in-memory database with the migrations in order, up to and including `last`. */
export function migratedDatabase(last?: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).sort()) {
    if (last && name > last) break;
    database.exec(migration(name));
  }
  return database;
}

export function migration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

/** A D1 binding over node:sqlite. D1 runs a batch as one transaction; so does this. */
export function sqliteD1(database: DatabaseSync): D1Database {
  const unused = () => {
    throw new Error("Unused");
  };
  return {
    prepare: (query) => statement(database, query),
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      database.exec("BEGIN");
      try {
        const results: D1Result<T>[] = [];
        for (const prepared of statements) results.push(await prepared.all<T>());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    exec: unused,
    withSession: unused,
    dump: unused,
  };
}

function statement(database: DatabaseSync, query: string, values: SQLInputValue[] = []): D1PreparedStatement {
  const result = <T>(results: T[], changes: number): D1Result<T> => ({
    success: true,
    results,
    meta: {
      changes,
      duration: 0,
      last_row_id: 0,
      changed_db: changes > 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
    },
  });
  return {
    bind: (...input) =>
      statement(
        database,
        query,
        input.map((value) => {
          if (value === null || typeof value === "string" || typeof value === "number") return value;
          throw new Error("Invalid binding");
        }),
      ),
    async first<T>(column?: string): Promise<T | null> {
      const row = database.prepare(query).get(...values);
      return row ? JSON.parse(JSON.stringify(column ? row[column] : row)) : null;
    },
    async all<T>(): Promise<D1Result<T>> {
      return result(JSON.parse(JSON.stringify(database.prepare(query).all(...values))), 0);
    },
    async run<T>(): Promise<D1Result<T>> {
      return result<T>([], Number(database.prepare(query).run(...values).changes));
    },
    raw() {
      throw new Error("Unused raw");
    },
  };
}
