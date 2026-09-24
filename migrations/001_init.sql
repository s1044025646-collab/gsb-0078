CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS shelters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS shelter_facilities (
  shelter_id INTEGER NOT NULL REFERENCES shelters(id),
  facility TEXT NOT NULL,
  PRIMARY KEY (shelter_id, facility)
);

CREATE TABLE IF NOT EXISTS shelter_capacity (
  shelter_id INTEGER NOT NULL REFERENCES shelters(id),
  bed_type TEXT NOT NULL,
  total INTEGER NOT NULL CHECK (total >= 0),
  occupied INTEGER NOT NULL DEFAULT 0 CHECK (occupied >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  PRIMARY KEY (shelter_id, bed_type),
  CHECK (occupied + reserved <= total)
);

CREATE TABLE IF NOT EXISTS capacity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shelter_id INTEGER NOT NULL,
  bed_type TEXT NOT NULL,
  delta_total INTEGER NOT NULL DEFAULT 0,
  delta_occupied INTEGER NOT NULL DEFAULT 0,
  delta_reserved INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS capacity_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shelter_id INTEGER NOT NULL,
  bed_type TEXT NOT NULL,
  total INTEGER NOT NULL,
  occupied INTEGER NOT NULL,
  reserved INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS households (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL CHECK (size > 0),
  needs_accessible INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS household_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id INTEGER NOT NULL REFERENCES households(id),
  member_code TEXT NOT NULL UNIQUE,
  needs TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id INTEGER NOT NULL REFERENCES households(id),
  shelter_id INTEGER NOT NULL REFERENCES shelters(id),
  bed_type TEXT NOT NULL,
  beds INTEGER NOT NULL CHECK (beds > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','checked_in','expired','cancelled')),
  expires_at TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reservation_active_household
  ON reservations(household_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS stays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id INTEGER NOT NULL REFERENCES households(id),
  shelter_id INTEGER NOT NULL REFERENCES shelters(id),
  bed_type TEXT NOT NULL,
  beds INTEGER NOT NULL CHECK (beds > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','departed')),
  checked_in_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  departed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_stay_active_household
  ON stays(household_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS stay_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL,
  household_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('check_in','transfer_out','transfer_in','depart')),
  from_shelter_id INTEGER,
  to_shelter_id INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '份',
  category TEXT NOT NULL DEFAULT 'supply' CHECK (category IN ('meal','supply'))
);

CREATE TABLE IF NOT EXISTS inventory_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shelter_id INTEGER NOT NULL REFERENCES shelters(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty_initial INTEGER NOT NULL CHECK (qty_initial >= 0),
  qty_remaining INTEGER NOT NULL CHECK (qty_remaining >= 0),
  source TEXT NOT NULL,
  batch_key TEXT UNIQUE,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS distributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shelter_id INTEGER NOT NULL REFERENCES shelters(id),
  household_id INTEGER NOT NULL REFERENCES households(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','reversed')),
  idempotency_key TEXT UNIQUE,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS distribution_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  distribution_id INTEGER NOT NULL REFERENCES distributions(id),
  type TEXT NOT NULL CHECK (type IN ('issue','reversal')),
  qty INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS offline_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','duplicate','conflict')),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_key TEXT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
