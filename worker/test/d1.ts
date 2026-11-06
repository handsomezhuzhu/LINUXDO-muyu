import { Database } from "bun:sqlite";
import type { D1Database, D1PreparedStatement, D1Result, D1Value } from "../src/types";

export class BunD1Statement implements D1PreparedStatement {
  constructor(
    readonly database: BunD1Database,
    readonly sql: string,
    readonly params: D1Value[] = [],
  ) {}

  bind(...values: D1Value[]): D1PreparedStatement {
    return new BunD1Statement(this.database, this.sql, values);
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return Promise.resolve(this.execute() as D1Result<T>);
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    return Promise.resolve((this.execute().results[0] as T | undefined) ?? null);
  }

  run(): Promise<D1Result> {
    return Promise.resolve(this.execute());
  }

  execute(): D1Result {
    const statement = this.database.sqlite.query(this.sql);
    if (/^\s*(?:SELECT|WITH)\b/i.test(this.sql)) {
      const results = statement.all(...this.params) as Record<string, unknown>[];
      return { results, success: true, meta: {} };
    }
    statement.run(...this.params);
    return { results: [], success: true, meta: {} };
  }
}

/** A deliberately small D1 facade backed by the same SQLite migration and SQL. */
export class BunD1Database implements D1Database {
  constructor(readonly sqlite: Database) {}

  prepare(sql: string): D1PreparedStatement {
    return new BunD1Statement(this, sql);
  }

  batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const transaction = this.sqlite.transaction((batchStatements: BunD1Statement[]) => {
      return batchStatements.map((statement) => statement.execute());
    });
    // bun:sqlite transactions are synchronous, so no statement can escape the
    // transaction through a timer or another microtask. Any throw rolls back.
    return Promise.resolve(transaction(statements as BunD1Statement[]));
  }
}

export async function createTestDatabase(): Promise<BunD1Database> {
  const sqlite = new Database(":memory:", { strict: true });
  const migration = await Bun.file(new URL("../migrations/0001_init.sql", import.meta.url)).text();
  sqlite.exec(migration);
  return new BunD1Database(sqlite);
}
