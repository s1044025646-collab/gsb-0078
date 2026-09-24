import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS capacity_pools (
      site_id INTEGER NOT NULL REFERENCES sites(id),
      bed_type TEXT NOT NULL,
      accessible INTEGER NOT NULL CHECK (accessible IN (0,1)),
      capacity INTEGER NOT NULL CHECK (capacity >= 0),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (site_id, bed_type, accessible)
    );

    CREATE TABLE IF NOT EXISTS capacity_history (
      id INTEGER PRIMARY KEY,
      site_id INTEGER NOT NULL,
      bed_type TEXT NOT NULL,
      accessible INTEGER NOT NULL,
      capacity INTEGER NOT NULL,
      source TEXT NOT NULL,
      reason TEXT NOT NULL,
      batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS households (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL CHECK (size > 0),
      accessible_need INTEGER NOT NULL DEFAULT 0,
      checksum TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY,
      household_id INTEGER NOT NULL REFERENCES households(id),
      code TEXT NOT NULL UNIQUE,
      bed_type TEXT NOT NULL,
      accessible_required INTEGER NOT NULL CHECK (accessible_required IN (0,1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS placements (
      id INTEGER PRIMARY KEY,
      household_id INTEGER NOT NULL REFERENCES households(id),
      site_id INTEGER NOT NULL REFERENCES sites(id),
      status TEXT NOT NULL CHECK (status IN ('active','transferred','left')),
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY,
      placement_id INTEGER NOT NULL REFERENCES placements(id),
      member_id INTEGER NOT NULL REFERENCES members(id),
      site_id INTEGER NOT NULL REFERENCES sites(id),
      bed_type TEXT NOT NULL,
      accessible INTEGER NOT NULL,
      released_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_active_assignment_member
      ON assignments(member_id) WHERE released_at IS NULL;

    CREATE TABLE IF NOT EXISTS reservation_groups (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      household_id INTEGER NOT NULL REFERENCES households(id),
      site_id INTEGER NOT NULL REFERENCES sites(id),
      status TEXT NOT NULL CHECK (status IN ('active','consumed','expired','cancelled','reversed')),
      expires_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reservation_units (
      id INTEGER PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES reservation_groups(id) ON DELETE CASCADE,
      bed_type TEXT NOT NULL,
      accessible INTEGER NOT NULL,
      seats INTEGER NOT NULL CHECK (seats > 0),
      UNIQUE(group_id, bed_type, accessible)
    );

    CREATE TABLE IF NOT EXISTS inventory_batches (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      sku TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('meal','supply')),
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      unit TEXT NOT NULL,
      source TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS inventory_history (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES inventory_batches(id),
      delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      batch_import_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY,
      request_key TEXT NOT NULL UNIQUE,
      household_id INTEGER NOT NULL REFERENCES households(id),
      sku TEXT NOT NULL,
      requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
      issued_quantity INTEGER NOT NULL,
      unit TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('issued','shortage')),
      shortage INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS issue_items (
      id INTEGER PRIMARY KEY,
      issue_id INTEGER NOT NULL REFERENCES issues(id),
      batch_id INTEGER NOT NULL REFERENCES inventory_batches(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      UNIQUE(issue_id, batch_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      batch_id TEXT,
      reverses_event_id INTEGER REFERENCES events(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS batch_imports (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('applied','rejected','replayed')),
      conflicts TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      applied_at TEXT
    );
  `);
}
