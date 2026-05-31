/**
 * sql.ts — Read-only escape hatch for ad-hoc SQL against the live Waypoint database.
 *
 * Opens `~/.waypoint/waypoint.db` read-only and prints results as NDJSON (one
 * JSON object per row). Pass `--format=table` for a human-readable column dump.
 *
 * This is the paved path for "I need a query the HTTP API doesn't expose."
 * Whenever you reach for this script, also add a one-line entry to
 * `docs/agent-api-gaps.md` so we can promote popular shapes into real endpoints.
 * See `docs/agent-api.md` for the full convention.
 *
 * **Writes go through the HTTP API, never this script.** That is intentional:
 * the API enforces invariants and (going forward) emits audit-log entries so
 * mutations can be reverted. Direct SQL writes bypass both. If you need a write
 * the API doesn't expose, add the endpoint instead of reaching for sqlite3.
 *
 * Usage:
 *   bun run sql --schema                          # list all tables
 *   bun run sql --schema files                    # show one table's schema
 *   bun run sql -c "SELECT id, label FROM disks"  # inline SQL
 *   bun run sql < query.sql                       # SQL from stdin
 *   bun run sql -c "..." --format=table           # human-readable output
 *
 * Flags:
 *   --schema [TABLE]   List tables, or show CREATE statements for one table.
 *   -c, --sql SQL      Inline SQL string. If omitted, SQL is read from stdin.
 *   --format=ndjson    Default. One JSON row per line.
 *   --format=table     Aligned-column human-readable output.
 *   --db PATH          Override DB path (default: ~/.waypoint/waypoint.db).
 *
 * The script never enforces a row limit. If you want a head, add LIMIT to
 * your SQL.
 */
import { Database } from "bun:sqlite";
import path from "path";
import os from "os";

interface Args {
  schema: boolean;
  schemaTable: string | null;
  sql: string | null;
  format: "ndjson" | "table";
  dbPath: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    schema: false,
    schemaTable: null,
    sql: null,
    format: "ndjson",
    dbPath: path.join(os.homedir(), ".waypoint", "waypoint.db"),
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--schema") {
      args.schema = true;
      // Optional table name follows
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        args.schemaTable = next;
        i++;
      }
    } else if (a === "-c" || a === "--sql") {
      args.sql = argv[++i] ?? null;
    } else if (a.startsWith("--format=")) {
      const v = a.slice("--format=".length);
      if (v !== "ndjson" && v !== "table") {
        die(`unknown --format: ${v}`);
      }
      args.format = v;
    } else if (a === "--db") {
      args.dbPath = argv[++i] ?? args.dbPath;
    } else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      die(`unknown arg: ${a}`);
    }
  }

  return args;
}

function die(msg: string): never {
  process.stderr.write(`sql: ${msg}\n`);
  process.exit(2);
}

function printHelp(): void {
  process.stderr.write(
    [
      "Usage (read-only; writes go through the HTTP API):",
      '  bun run sql --schema                          # list tables',
      '  bun run sql --schema TABLE                    # CREATE for one table',
      '  bun run sql -c "SELECT ..."                   # inline SQL',
      "  bun run sql < query.sql                       # stdin SQL",
      "",
      "Flags:",
      "  --schema [TABLE]   list tables or one table's CREATE",
      "  -c, --sql SQL      inline SQL",
      "  --format=ndjson    default; one JSON row per line",
      "  --format=table     human-readable aligned columns",
      "  --db PATH          override DB path",
      "",
    ].join("\n")
  );
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  // Bun supports `for await` over process.stdin
  for await (const chunk of process.stdin as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function openDb(dbPath: string): Database {
  // Always read-only. Writes go through the HTTP API.
  return new Database(dbPath, { readonly: true, create: false });
}

function printSchema(db: Database, table: string | null): void {
  if (table) {
    const rows = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE (name = ? OR tbl_name = ?)
         ORDER BY type, name`
      )
      .all(table, table) as Array<{ type: string; name: string; sql: string | null }>;
    if (rows.length === 0) {
      die(`no such table: ${table}`);
    }
    for (const r of rows) {
      if (r.sql) {
        process.stdout.write(`-- ${r.type} ${r.name}\n${r.sql};\n\n`);
      }
    }
    return;
  }

  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type IN ('table', 'view')
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all() as Array<{ name: string }>;

  for (const t of tables) {
    process.stdout.write(`${t.name}\n`);
  }
}

function runSql(db: Database, sql: string, format: "ndjson" | "table"): void {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    die("no SQL provided (use -c or stdin)");
  }

  // Read-only DB + this code path only runs prepare().all(). Attempts to run
  // non-query SQL (INSERT/UPDATE/DELETE/etc.) error out at sqlite layer with
  // "attempt to write a readonly database", which we surface as-is.
  const rows = db.prepare(trimmed).all() as Array<Record<string, unknown>>;
  if (format === "ndjson") {
    for (const r of rows) {
      process.stdout.write(JSON.stringify(r) + "\n");
    }
  } else {
    printTable(rows);
  }
  process.stderr.write(`-- ${rows.length} row(s)\n`);
}

function printTable(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    process.stdout.write("(no rows)\n");
    return;
  }
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) => c.length);
  const cells = rows.map((r) =>
    cols.map((c, i) => {
      const v = r[c];
      const s = v === null || v === undefined ? "" : String(v);
      if (s.length > widths[i]) widths[i] = s.length;
      return s;
    })
  );

  const header = cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  const sep = cols.map((_c, i) => "-".repeat(widths[i])).join("  ");
  process.stdout.write(header + "\n" + sep + "\n");
  for (const row of cells) {
    process.stdout.write(row.map((s, i) => s.padEnd(widths[i])).join("  ") + "\n");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const db = openDb(args.dbPath);

  if (args.schema) {
    printSchema(db, args.schemaTable);
    db.close();
    return;
  }

  let sql = args.sql;
  if (sql === null) {
    if (process.stdin.isTTY) {
      die("no SQL provided. Pass -c \"...\" or pipe SQL on stdin. See --help.");
    }
    sql = await readStdin();
  }

  runSql(db, sql, args.format);
  db.close();
}

main().catch((err) => {
  process.stderr.write(`sql: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
