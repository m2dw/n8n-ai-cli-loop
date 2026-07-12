import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const DEFAULT_DB_PATH = join(
  homedir(),
  ".config",
  "n8n-ai-cli-loop",
  "dev_loop.db",
);

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS context_records (
  context_id  TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

export class SqliteContextStore {
  readonly #db: Database.Database;

  constructor(dbPath?: string) {
    const resolved = dbPath ?? DEFAULT_DB_PATH;
    mkdirSync(join(resolved, ".."), { recursive: true });
    this.#db = new Database(resolved);
    this.#db.exec(SCHEMA);
  }

  upsert(contextId: string, sessionId: string): void {
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO context_records (context_id, session_id) VALUES (?, ?)",
      )
      .run(contextId, sessionId);
  }

  getSessionId(contextId: string): string | undefined {
    const row = this.#db
      .prepare("SELECT session_id FROM context_records WHERE context_id = ?")
      .get(contextId) as { session_id: string } | undefined;
    return row?.session_id;
  }

  close(): void {
    this.#db.close();
  }
}
