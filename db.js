const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10, min: 2, idleTimeoutMillis: 30000
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS drivers (
      id               SERIAL PRIMARY KEY,
      phone            TEXT UNIQUE NOT NULL,
      name             TEXT NOT NULL,
      status           TEXT DEFAULT 'offline',
      lat              REAL, lng REAL,
      last_seen        TIMESTAMPTZ,
      trial_until      TIMESTAMPTZ DEFAULT NOW() + INTERVAL '3 months',
      subscription_end TIMESTAMPTZ,
      active           INTEGER DEFAULT 1,
      validated        INTEGER DEFAULT 0,
      clim             BOOLEAN DEFAULT false,
      photo_ext        TEXT,
      photo_int        TEXT,
      reg_step         TEXT DEFAULT 'done',
      token            TEXT UNIQUE,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS clients (
      id         SERIAL PRIMARY KEY,
      phone      TEXT UNIQUE NOT NULL,
      name       TEXT,
      token      TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS rides (
      id           SERIAL PRIMARY KEY,
      client_phone TEXT NOT NULL,
      driver_phone TEXT,
      client_lat   REAL NOT NULL,
      client_lng   REAL NOT NULL,
      zone         TEXT,
      status       TEXT DEFAULT 'searching',
      offered_at        TIMESTAMPTZ,
      assigned_at       TIMESTAMPTZ,
      completed_at      TIMESTAMPTZ,
      met_at            TIMESTAMPTZ,
      near_since        TIMESTAMPTZ,
      separated_since   TIMESTAMPTZ,
      confidence_score  INTEGER DEFAULT 0,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS queue (
      id           SERIAL PRIMARY KEY,
      client_phone TEXT UNIQUE NOT NULL,
      client_lat   REAL NOT NULL,
      client_lng   REAL NOT NULL,
      position     INTEGER DEFAULT 0,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS client_selections (
      client_phone TEXT PRIMARY KEY,
      ride_id      INTEGER,
      drivers_json TEXT,
      lat          REAL, lng REAL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS payments (
      id           SERIAL PRIMARY KEY,
      driver_phone TEXT NOT NULL,
      amount       INTEGER DEFAULT 500,
      week_label   TEXT,
      paid         INTEGER DEFAULT 0,
      paid_at      TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS blacklist (
      id           SERIAL PRIMARY KEY,
      phone        TEXT UNIQUE NOT NULL,
      reason       TEXT,
      auto         INTEGER DEFAULT 0,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gps_snapshots (
      id          SERIAL PRIMARY KEY,
      phone       TEXT NOT NULL,
      role        TEXT NOT NULL,
      lat         REAL NOT NULL,
      lng         REAL NOT NULL,
      speed       REAL,
      bearing     REAL,
      recorded_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ride_history (
      id           SERIAL PRIMARY KEY,
      ride_id      INTEGER,
      client_phone TEXT,
      client_name  TEXT,
      driver_phone TEXT,
      driver_name  TEXT,
      distance_km  REAL,
      duration_min INTEGER,
      zone         TEXT,
      status       TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    INSERT INTO settings (key, value) VALUES
      ('price','500'),('trial','90'),('radius','5'),('timeout','60')
    ON CONFLICT DO NOTHING;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status);
    CREATE INDEX IF NOT EXISTS idx_drivers_validated ON drivers(validated);
    CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
    CREATE INDEX IF NOT EXISTS idx_rides_client ON rides(client_phone);
    CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_phone);
    CREATE INDEX IF NOT EXISTS idx_history_driver ON ride_history(driver_phone);
    CREATE INDEX IF NOT EXISTS idx_history_client ON ride_history(client_phone);
    CREATE INDEX IF NOT EXISTS idx_gps_phone ON gps_snapshots(phone, recorded_at DESC);
  `);
  console.log('✅ DB initialisée');
}

async function migrate() {
  const cols = [
    `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS clim      BOOLEAN DEFAULT false`,
    `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS photo_ext TEXT`,
    `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS photo_int TEXT`,
    `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS validated INTEGER DEFAULT 0`,
    `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS reg_step  TEXT DEFAULT 'done'`,
    `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS token     TEXT`,
    `ALTER TABLE clients ADD COLUMN IF NOT EXISTS token     TEXT`,
    `ALTER TABLE rides   ADD COLUMN IF NOT EXISTS zone      TEXT`,
    `ALTER TABLE rides   ADD COLUMN IF NOT EXISTS offered_at TIMESTAMPTZ`,
    `ALTER TABLE rides   ADD COLUMN IF NOT EXISTS met_at    TIMESTAMPTZ`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_token ON drivers(token)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_token ON clients(token)`,
    `ALTER TABLE rides ADD COLUMN IF NOT EXISTS near_since TIMESTAMPTZ`,
    `ALTER TABLE rides ADD COLUMN IF NOT EXISTS separated_since TIMESTAMPTZ`,
    `ALTER TABLE rides ADD COLUMN IF NOT EXISTS confidence_score INTEGER DEFAULT 0`,
  ];
  for (const sql of cols) {
    try { await pool.query(sql); } catch(e) {}
  }
  console.log('✅ Migrations OK');
}

async function getRadius() {
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key='radius'`);
    return parseFloat(r.rows[0]?.value || '5');
  } catch(e) { return 5; }
}

async function getTimeout() {
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key='timeout'`);
    return parseInt(r.rows[0]?.value || '60');
  } catch(e) { return 60; }
}

// ─── TOKENS ─────────────────────────────────────────────────
async function getOrCreateDriverToken(phone) {
  const r = await pool.query('SELECT token FROM drivers WHERE phone=$1', [phone]);
  if (r.rows[0]?.token) return r.rows[0].token;
  const token = uuidv4();
  await pool.query('UPDATE drivers SET token=$1 WHERE phone=$2', [token, phone]);
  return token;
}

async function getDriverByToken(token) {
  const r = await pool.query('SELECT * FROM drivers WHERE token=$1', [token]);
  return r.rows[0] || null;
}

async function getOrCreateClientToken(phone) {
  const r = await pool.query('SELECT token FROM clients WHERE phone=$1', [phone]);
  if (r.rows[0]?.token) return r.rows[0].token;
  const token = uuidv4();
  await pool.query('UPDATE clients SET token=$1 WHERE phone=$2', [token, phone]);
  return token;
}

async function getClientByToken(token) {
  const r = await pool.query('SELECT * FROM clients WHERE token=$1', [token]);
  return r.rows[0] || null;
}

// ─── DRIVERS ─────────────────────────────────────────────────
const drivers = {
  get: async (phone) => {
    const r = await pool.query('SELECT * FROM drivers WHERE phone=$1', [phone]);
    return r.rows[0] || null;
  },
  getAll: async () => {
    const r = await pool.query('SELECT * FROM drivers ORDER BY name');
    return r.rows;
  },
  getOnline: async () => {
    const r = await pool.query(`
      SELECT * FROM drivers
      WHERE status IN ('online','busy') AND active=1 AND validated=1
      AND lat IS NOT NULL AND lng IS NOT NULL
      AND (trial_until > NOW() OR subscription_end > NOW())
    `);
    return r.rows;
  },
  getAvailable: async () => {
    const r = await pool.query(`
      SELECT * FROM drivers
      WHERE status='online' AND active=1 AND validated=1
      AND lat IS NOT NULL AND lng IS NOT NULL
      AND (trial_until > NOW() OR subscription_end > NOW())
    `);
    return r.rows;
  },
  setStatus: async (status, phone) => {
    await pool.query(`UPDATE drivers SET status=$1, last_seen=NOW() WHERE phone=$2`, [status, phone]);
  },
  setOnlineWithLocation: async (lat, lng, phone) => {
    await pool.query(
      `UPDATE drivers SET status='online', lat=$1, lng=$2, last_seen=NOW() WHERE phone=$3`,
      [lat, lng, phone]
    );
  },
  block:   async (phone) => pool.query(`UPDATE drivers SET active=0 WHERE phone=$1`, [phone]),
  unblock: async (phone) => pool.query(`UPDATE drivers SET active=1 WHERE phone=$1`, [phone]),
  renewSubscription: async (phone) => {
    await pool.query(`
      UPDATE drivers SET subscription_end = CASE
        WHEN subscription_end > NOW() THEN subscription_end + INTERVAL '7 days'
        ELSE NOW() + INTERVAL '7 days'
      END WHERE phone=$1`, [phone]);
  },
  getExpiring: async () => {
    const r = await pool.query(`
      SELECT * FROM drivers WHERE active=1 AND trial_until < NOW()
      AND (subscription_end IS NULL OR subscription_end < NOW() + INTERVAL '3 days')
    `);
    return r.rows;
  }
};

// ─── CLIENTS ─────────────────────────────────────────────────
const clients = {
  upsert: async (phone, name = null) => {
    if (name) {
      await pool.query(
        `INSERT INTO clients (phone, name, token) VALUES ($1, $2, $3)
         ON CONFLICT (phone) DO UPDATE SET name=COALESCE($2, clients.name)`,
        [phone, name, uuidv4()]
      );
    } else {
      await pool.query(
        `INSERT INTO clients (phone, token) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [phone, uuidv4()]
      );
    }
  },
  getAll: async () => {
    const r = await pool.query('SELECT * FROM clients ORDER BY created_at DESC');
    return r.rows;
  }
};

// ─── RIDES ───────────────────────────────────────────────────
const rides = {
  create: async (clientPhone, lat, lng, zone = null) => {
    const r = await pool.query(
      `INSERT INTO rides (client_phone, client_lat, client_lng, zone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [clientPhone, lat, lng, zone]
    );
    return r.rows[0].id;
  },
  assign: async (driverPhone, rideId) => {
    await pool.query(
      `UPDATE rides SET driver_phone=$1, status='assigned', assigned_at=NOW() WHERE id=$2`,
      [driverPhone, rideId]
    );
  },
  complete: async (rideId) => {
    const r = await pool.query(`SELECT * FROM rides WHERE id=$1`, [rideId]);
    if (r.rows[0]) {
      const ride = r.rows[0];
      const dur = ride.assigned_at
        ? Math.floor((Date.now() - new Date(ride.assigned_at)) / 60000) : null;
      await pool.query(
        `INSERT INTO ride_history (ride_id, client_phone, driver_phone, zone, status, created_at, completed_at, duration_min)
         VALUES ($1,$2,$3,$4,'completed',$5,NOW(),$6)`,
        [ride.id, ride.client_phone, ride.driver_phone, ride.zone, ride.created_at, dur]
      ).catch(()=>{});
    }
    await pool.query(
      `UPDATE rides SET status='completed', completed_at=NOW() WHERE id=$1`, [rideId]
    );
  },
  getActive: async () => {
    const r = await pool.query(`
      SELECT r.*, c.name AS client_name, d.name AS driver_name
      FROM rides r
      LEFT JOIN clients c ON c.phone=r.client_phone
      LEFT JOIN drivers d ON d.phone=r.driver_phone
      WHERE r.status NOT IN ('completed','cancelled')
      ORDER BY r.created_at DESC LIMIT 50
    `);
    return r.rows;
  },
  getStats: async () => {
    const r = await pool.query(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN DATE(created_at)=CURRENT_DATE THEN 1 ELSE 0 END) AS today,
        SUM(CASE WHEN status IN ('searching','offered') THEN 1 ELSE 0 END) AS waiting
      FROM rides
    `);
    return r.rows[0];
  },
  getActiveByDriver: async (phone) => {
    const r = await pool.query(
      `SELECT r.*, c.name AS client_name
       FROM rides r LEFT JOIN clients c ON c.phone=r.client_phone
       WHERE r.driver_phone=$1 AND r.status='assigned' LIMIT 1`, [phone]
    );
    return r.rows[0] || null;
  },
  todayByDriver: async (phone) => {
    const r = await pool.query(
      `SELECT COUNT(*) AS n FROM ride_history
       WHERE driver_phone=$1 AND DATE(created_at)=CURRENT_DATE AND status='completed'`, [phone]
    );
    return parseInt(r.rows[0]?.n || 0);
  },
  getHistory: async () => {
    const r = await pool.query(`
      SELECT rh.*, d.name AS driver_name, c.name AS client_name
      FROM ride_history rh
      LEFT JOIN drivers d ON d.phone=rh.driver_phone
      LEFT JOIN clients c ON c.phone=rh.client_phone
      ORDER BY rh.created_at DESC LIMIT 100
    `);
    return r.rows;
  },
  getHistoryByDriver: async (phone, days=30) => {
    const r = await pool.query(
      `SELECT * FROM ride_history WHERE driver_phone=$1
       AND created_at > NOW() - ($2 * INTERVAL '1 day')
       ORDER BY created_at DESC`, [phone, days]
    );
    return r.rows;
  }
};

// ─── QUEUE ───────────────────────────────────────────────────
const queue = {
  add: async (phone, lat, lng) => {
    const pos = await pool.query(`SELECT COALESCE(MAX(position),0)+1 AS p FROM queue`);
    await pool.query(
      `INSERT INTO queue (client_phone, client_lat, client_lng, position)
       VALUES ($1,$2,$3,$4) ON CONFLICT (client_phone) DO UPDATE SET client_lat=$2, client_lng=$3`,
      [phone, lat, lng, pos.rows[0].p]
    );
  },
  remove: async (phone) => pool.query(`DELETE FROM queue WHERE client_phone=$1`, [phone]),
  getAll: async () => {
    const r = await pool.query(`SELECT * FROM queue ORDER BY position ASC`);
    return r.rows;
  },
  getPosition: async (phone) => {
    const r = await pool.query(`SELECT position FROM queue WHERE client_phone=$1`, [phone]);
    return r.rows[0]?.position || 1;
  }
};

// ─── CLIENT SELECTIONS ───────────────────────────────────────
const clientSelections = {
  set: async (phone, rideId, driversList, lat, lng) => {
    await pool.query(
      `INSERT INTO client_selections (client_phone, ride_id, drivers_json, lat, lng)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (client_phone) DO UPDATE SET ride_id=$2, drivers_json=$3, lat=$4, lng=$5, created_at=NOW()`,
      [phone, rideId, JSON.stringify(driversList), lat, lng]
    );
  },
  get: async (phone) => {
    const r = await pool.query('SELECT * FROM client_selections WHERE client_phone=$1', [phone]);
    if (!r.rows[0]) return null;
    return { ...r.rows[0], drivers: JSON.parse(r.rows[0].drivers_json || '[]') };
  },
  delete: async (phone) => pool.query('DELETE FROM client_selections WHERE client_phone=$1', [phone])
};

// ─── BLACKLIST ───────────────────────────────────────────────
const blacklist = {
  check: async (phone) => {
    const r = await pool.query('SELECT id FROM blacklist WHERE phone=$1', [phone]);
    return r.rows.length > 0;
  },
  add: async (phone, reason='', auto=0) => {
    await pool.query(
      `INSERT INTO blacklist (phone,reason,auto) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [phone, reason, auto]
    );
  },
  remove: async (phone) => pool.query('DELETE FROM blacklist WHERE phone=$1', [phone]),
  getAll: async () => {
    const r = await pool.query('SELECT * FROM blacklist ORDER BY created_at DESC');
    return r.rows;
  }
};

// ─── PAYMENTS ────────────────────────────────────────────────
const payments = {
  create: async (phone, weekLabel) => {
    await pool.query(
      `INSERT INTO payments (driver_phone, week_label) VALUES ($1,$2)`, [phone, weekLabel]
    );
  },
  getAll: async () => {
    const r = await pool.query(`SELECT * FROM payments ORDER BY created_at DESC`);
    return r.rows;
  }
};

// ─── HELPERS ─────────────────────────────────────────────────
function distance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function estimateMinutes(distKm) { return Math.max(2, Math.round(distKm*2)); }

async function findNearestDrivers(clientLat, clientLng, maxKm=5) {
  const online = await drivers.getAvailable();
  return online
    .map(d => ({ ...d, dist: distance(clientLat, clientLng, d.lat, d.lng) }))
    .filter(d => d.dist <= maxKm)
    .sort((a,b) => a.dist - b.dist);
}

function getWeekLabel() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now-start)/86400000 + start.getDay()+1)/7);
  return `${now.getFullYear()}-W${String(week).padStart(2,'0')}`;
}

module.exports = {
  pool, init, migrate, getRadius, getTimeout,
  getOrCreateDriverToken, getDriverByToken,
  getOrCreateClientToken, getClientByToken,
  drivers, clients, rides, queue, clientSelections, blacklist, payments,
  distance, estimateMinutes, findNearestDrivers, getWeekLabel
};
