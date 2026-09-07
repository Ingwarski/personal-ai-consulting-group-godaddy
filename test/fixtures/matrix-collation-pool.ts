import { OwnerAuthPool } from "./owner-auth-pool.ts";
import type { MySqlConnection } from "../../src/godaddy/mysql-storage.ts";

export class MatrixCollationPool extends OwnerAuthPool {
  collation = "utf8mb4_unicode_ci";
  charset = "utf8mb4";
  roundTripValid = true;
  caseValid = true;
  loseKey = false;
  failAlter = false;
  failRestore = false;
  alters: string[] = [];
  queries: string[] = [];
  restored = false;
  destroyed = false;
  migrationReleased = false;
  schemaQuery(statement: string, values: readonly unknown[]): readonly [unknown, unknown] | undefined {
    if (statement.includes("AS charset")) return [["state_namespace", "state_key"].map((name, index) => ({
      name, type: index === 0 ? "varchar(64)" : "varchar(191)", charset: this.charset,
      collation: this.collation, nullable: "NO", defaultValue: null, extra: "", comment: ""
    })), []];
    if (statement.includes("AS roundTripHex")) return [[{
      roundTripHex: this.roundTripValid ? Buffer.from(String(values[0]), "utf8").toString("hex").toUpperCase() : "BAD",
      sameCase: 1, differentCase: this.caseValid ? 0 : 1
    }], []];
    if (statement.includes("AS keyHash")) return [this.loseKey && this.alters.length > 0 ? [] : [{ keyHash: "a".repeat(64) }], []];
    if (statement.includes("AS lockWait")) return [[{ lockWait: 31536000 }], []];
    if (statement === "SET SESSION lock_wait_timeout = 10") return [[], []];
    if (statement === "SET SESSION lock_wait_timeout = ?") {
      if (this.failRestore) throw new Error("private restore error");
      this.restored = values[0] === 31536000; return [[], []];
    }
    if (statement.startsWith("ALTER TABLE personal_consultant_state")) {
      if (this.failAlter) throw new Error("private alter error");
      this.alters.push(statement); this.collation = "utf8mb4_bin"; return [{ affectedRows: 0 }, []];
    }
    return undefined;
  }
  override async execute(statement: string, values: readonly unknown[]): Promise<readonly [unknown, unknown]> {
    const result = this.schemaQuery(statement, values);
    if (result !== undefined) { this.queries.push(statement); return result; }
    return super.execute(statement, values);
  }
  override async getConnection(): Promise<MySqlConnection> {
    const connection = await super.getConnection(); let migration = false;
    return { ...connection,
      execute: async (statement, values) => {
        const result = this.schemaQuery(statement, values);
        if (result !== undefined) { migration = true; this.queries.push(statement); return result; }
        return connection.execute(statement, values);
      },
      destroy: () => { this.destroyed = true; },
      release: () => { if (migration) this.migrationReleased = true; connection.release(); }
    };
  }
}
