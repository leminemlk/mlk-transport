// ============================================================
// BASE DE DONNÉES SQLITE - MLK Transport
// ============================================================
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'mlk_transport.db'));

// Performances
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── CRÉATION DES TABLES ────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS drivers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    phone           TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL,
    status          TEXT DEFAULT 'offline',   -- offline | online | busy
    lat             REAL,
    lng             REAL,
    last_seen       DATETIME,
    trial_until     DATETIME,                 -- 3 mois gratuits
    subscription_end DATETIME,               -- fin abonnement payant
    active          INTEGER DEFAULT 1,        -- 1=actif, 0=bloqué
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS clients (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    phone      TEXT UNIQUE NOT NULL,
    name       TEXT,
    favorites  TEXT DEFAULT '{}',            -- JSON {maison:{lat,lng}, bureau:{lat,lng}}
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rides (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    client_phone TEXT NOT NULL,
    driver_phone TEXT,
    client_lat   REAL NOT NULL,
    client_lng   REAL NOT NULL,
    status       TEXT DEFAULT 'searching',   -- searching | assigned | completed | cancelled
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    assigned_at  DATETIME,
    completed_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS queue (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    client_phone TEXT UNIQUE NOT NULL,
    client_lat   REAL NOT NULL,
    client_lng   REAL NOT NULL,
    position     INTEGER DEFAULT 0,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_phone TEXT NOT NULL,
    amount       INTEGER DEFAULT 500,
    week_label   TEXT,                       -- ex: "2026-W21"
    paid         INTEGER DEFAULT 0,
    paid_at      DATETIME,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ─── DRIVERS ────────────────────────────────────────────────

const driverOps = {
  get: db.prepare('SELECT * FROM drivers WHERE phone = ?'),
  getAll: db.prepare('SELECT * FROM drivers ORDER BY name'),
  getOnline: db.prepare(`
    SELECT * FROM drivers 
    WHERE status = 'online' AND active = 1
    AND (trial_until > datetime('now') OR subscription_end > datetime('now'))
  `),
  insert: db.prepare(`
    INSERT INTO drivers (phone, name, trial_until)
    VALUES (?, ?, datetime('now', '+3 months'))
  `),
  setStatus: db.prepare(`UPDATE drivers SET status = ?, last_seen = datetime('now') WHERE phone = ?`),
  setLocation: db.prepare(`UPDATE drivers SET lat = ?, lng = ?, last_seen = datetime('now') WHERE phone = ?`),
  setOnlineWithLocation: db.prepare(`
    UPDATE drivers SET status = 'online', lat = ?, lng = ?, last_seen = datetime('now') WHERE phone = ?
  `),
  block: db.prepare(`UPDATE drivers SET active = 0 WHERE phone = ?`),
  unblock: db.prepare(`UPDATE drivers SET active = 1 WHERE phone = ?`),
  renewSubscription: db.prepare(`
    UPDATE drivers 
    SET subscription_end = COALESCE(
      CASE WHEN subscription_end > datetime('now') 
        THEN datetime(subscription_end, '+7 days')
        ELSE datetime('now', '+7 days')
      END,
      datetime('now', '+7 days')
    )
    WHERE phone = ?
  `),
  getExpiring: db.prepare(`
    SELECT * FROM drivers WHERE active = 1
    AND trial_until < datetime('now')
    AND (subscription_end IS NULL OR subscription_end < datetime('now', '+3 days'))
  `)
};

// ─── CLIENTS ────────────────────────────────────────────────

const clientOps = {
  get: db.prepare('SELECT * FROM clients WHERE phone = ?'),
  getAll: db.prepare('SELECT * FROM clients ORDER BY created_at DESC'),
  upsert: db.prepare(`
    INSERT INTO clients (phone) VALUES (?)
    ON CONFLICT(phone) DO NOTHING
  `),
  setName: db.prepare('UPDATE clients SET name = ? WHERE phone = ?'),
  saveFavorite: db.prepare(`
    UPDATE clients SET favorites = json_set(favorites, '$.' || ?, json(?)) WHERE phone = ?
  `),
  getFavorites: db.prepare('SELECT favorites FROM clients WHERE phone = ?')
};

// ─── RIDES ──────────────────────────────────────────────────

const rideOps = {
  create: db.prepare(`
    INSERT INTO rides (client_phone, client_lat, client_lng) VALUES (?, ?, ?)
  `),
  assign: db.prepare(`
    UPDATE rides SET driver_phone = ?, status = 'assigned', assigned_at = datetime('now')
    WHERE id = ?
  `),
  complete: db.prepare(`
    UPDATE rides SET status = 'completed', completed_at = datetime('now') WHERE id = ?
  `),
  cancel: db.prepare(`UPDATE rides SET status = 'cancelled' WHERE id = ?`),
  getActive: db.prepare(`SELECT * FROM rides WHERE status NOT IN ('completed','cancelled') ORDER BY created_at DESC`),
  getStats: db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN DATE(created_at)=DATE('now') THEN 1 ELSE 0 END) as today
    FROM rides
  `)
};

// ─── QUEUE ──────────────────────────────────────────────────

const queueOps = {
  add: db.prepare(`
    INSERT OR REPLACE INTO queue (client_phone, client_lat, client_lng, position)
    VALUES (?, ?, ?, (SELECT COALESCE(MAX(position),0)+1 FROM queue))
  `),
  remove: db.prepare('DELETE FROM queue WHERE client_phone = ?'),
  getAll: db.prepare('SELECT * FROM queue ORDER BY position ASC'),
  getPosition: db.prepare('SELECT position FROM queue WHERE client_phone = ?'),
  count: db.prepare('SELECT COUNT(*) as n FROM queue')
};

// ─── PAYMENTS ───────────────────────────────────────────────

const paymentOps = {
  create: db.prepare(`
    INSERT INTO payments (driver_phone, week_label)
    VALUES (?, ?)
  `),
  markPaid: db.prepare(`
    UPDATE payments SET paid = 1, paid_at = datetime('now') WHERE id = ?
  `),
  getAll: db.prepare('SELECT * FROM payments ORDER BY created_at DESC'),
  getByDriver: db.prepare('SELECT * FROM payments WHERE driver_phone = ? ORDER BY created_at DESC')
};

// ─── HELPERS ────────────────────────────────────────────────

function getWeekLabel() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now - start) / 86400000 + start.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Distance en km entre deux coordonnées (Haversine) */
function distance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/** Trouver les chauffeurs disponibles triés par distance */
function findNearestDrivers(clientLat, clientLng, maxKm = 5) {
  const online = driverOps.getOnline.all();
  return online
    .filter(d => d.lat && d.lng)
    .map(d => ({ ...d, dist: distance(clientLat, clientLng, d.lat, d.lng) }))
    .filter(d => d.dist <= maxKm)
    .sort((a, b) => a.dist - b.dist);
}

/** Estimation du temps d'arrivée (1 min par 500m en ville) */
function estimateMinutes(distKm) {
  return Math.max(2, Math.round(distKm * 2)); // ~30km/h en ville
}

module.exports = {
  db,
  drivers: driverOps,
  clients: clientOps,
  rides: rideOps,
  queue: queueOps,
  payments: paymentOps,
  findNearestDrivers,
  estimateMinutes,
  getWeekLabel,
  distance
};
