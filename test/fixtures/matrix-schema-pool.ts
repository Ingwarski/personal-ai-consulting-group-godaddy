import { OwnerAuthPool } from "./owner-auth-pool.ts";

export class MatrixSchemaPool extends OwnerAuthPool {
  tables = new Set<string>();
  schemaStatements: string[] = [];
  creates: string[] = [];
  failCreateAt = -1;
  invalidInventory = false;
  override async execute(statement: string, values: readonly unknown[]): Promise<readonly [unknown, unknown]> {
    if (statement.includes("information_schema.TABLES")) {
      this.schemaStatements.push(statement);
      return [this.invalidInventory ? null : [...this.tables].map(tableName => ({ tableName, tableType: "BASE TABLE" })), []];
    }
    if (statement.includes("information_schema.COLUMNS")) {
      this.schemaStatements.push(statement);
      return [["state_namespace", "state_key"].map(columnName => ({ columnName, collationName: "utf8mb4_bin" })), []];
    }
    if (statement.startsWith("CREATE TABLE IF NOT EXISTS ")) {
      this.schemaStatements.push(statement);
      if (this.creates.length === this.failCreateAt) throw new Error("private-database-error");
      if (values.length !== 0) throw new Error("Unexpected values");
      this.creates.push(statement);
      this.tables.add(statement.split(" ")[5]!);
      return [{ affectedRows: 0 }, []];
    }
    return super.execute(statement, values);
  }
}
