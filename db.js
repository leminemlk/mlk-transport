// ============================================================
// BASE DE DONNÉES PostgreSQL - MLK Transport
// Persistante sur Railway via DATABASE_URL
// ============================================================
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── INITIALISATION DES TABLES ───────────────────────────────

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS drivers (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'offline',
      lat REAL, lng REAL,
      last_seen TIMESTAMPTZ,
      trial_until TIMESTAMPTZ DEFAULT NOW() + INTERVAL '3 months',
      subscription_end TIMESTAMPTZ,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      name TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rides (
      id SERIAL PRIMARY KEY,
      client_phone TEXT NOT NULL,
      driver_phone TEXT,
      client_lat REAL NOT NULL,
      client_lng REAL NOT NULL,
      status TEXT DEFAULT 'searching',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      assigned_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS queue (
      id SERIAL PRIMARY KEY,
      client_phone TEXT UNIQUE NOT NULL,
      client_lat REAL NOT NULL,
      client_lng REAL NOT NULL,
      position INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      driver_phone TEXT NOT NULL,
      amount INTEGER DEFAULT 500,
      week_label TEXT,
      paid INTEGER DEFAULT 0,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS blacklist (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      reason TEXT,
      auto INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS client_selections (
      client_phone TEXT PRIMARY KEY,
      ride_id      INTEGER,
      drivers_json TEXT,
      lat          REAL,
      lng          REAL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  await pool.query(`
    INSERT INTO settings (key, value) VALUES
      ('price',   '500'),
      ('trial',   '90'),
      ('radius',  '5'),
      ('timeout', '60')
    ON CONFLICT DO NOTHING
  `);
  console.log('✅ Base de données PostgreSQL initialisée');
}

// ─── DRIVERS ─────────────────────────────────────────────────

const drivers = {
  get: async (phone) => {
    const r = await pool.query('SELECT * FROM drivers WHERE phone = $1', [phone]);
    return r.rows[0] || null;
  },
  getAll: async () => {
    const r = await pool.query('SELECT * FROM drivers ORDER BY name');
    return r.rows;
  },
  getOnline: async () => {
    const r = await pool.query(`
      SELECT * FROM drivers WHERE status = 'online' AND active = 1
      AND (trial_until > NOW() OR subscription_end > NOW())
    `);
    return r.rows;
  },
  getAvailable: async () => {
    const r = await pool.query(`
      SELECT * FROM drivers
      WHERE status = 'online' AND active = 1 AND validated = 1
      AND lat IS NOT NULL AND lng IS NOT NULL
      AND (trial_until > NOW() OR subscription_end > NOW())
      ORDER BY last_seen DESC
    `);
    return r.rows;
  },
  insert: async (phone, name) => {
    await pool.query(
      `INSERT INTO drivers (phone, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [phone, name]
    );
  },
  setStatus: async (status, phone) => {
    await pool.query(
      `UPDATE drivers SET status = $1, last_seen = NOW() WHERE phone = $2`,
      [status, phone]
    );
  },
  setOnlineWithLocation: async (lat, lng, phone) => {
    await pool.query(
      `UPDATE drivers SET status = 'online', lat = $1, lng = $2, last_seen = NOW() WHERE phone = $3`,
      [lat, lng, phone]
    );
  },
  block: async (phone) => {
    await pool.query(`UPDATE drivers SET active = 0 WHERE phone = $1`, [phone]);
  },
  unblock: async (phone) => {
    await pool.query(`UPDATE drivers SET active = 1 WHERE phone = $1`, [phone]);
  },
  renewSubscription: async (phone) => {
    await pool.query(`
      UPDATE drivers SET subscription_end = COALESCE(
        CASE WHEN subscription_end > NOW()
          THEN subscription_end + INTERVAL '7 days'
          ELSE NOW() + INTERVAL '7 days'
        END,
        NOW() + INTERVAL '7 days'
      ) WHERE phone = $1
    `, [phone]);
  },
  getExpiring: async () => {
    const r = await pool.query(`
      SELECT * FROM drivers WHERE active = 1
      AND trial_until < NOW()
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
        `INSERT INTO clients (phone, name) VALUES ($1, $2)
         ON CONFLICT (phone) DO UPDATE SET name=$2 WHERE clients.name IS NULL`,
        [phone, name]
      );
    } else {
      await pool.query(
        `INSERT INTO clients (phone) VALUES ($1) ON CONFLICT DO NOTHING`, [phone]
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
      `INSERT INTO rides (client_phone, client_lat, client_lng, zone) VALUES ($1, $2, $3, $4) RETURNING id`,
      [clientPhone, lat, lng, zone]
    );
    return r.rows[0].id;
  },
  assign: async (driverPhone, rideId) => {
    await pool.query(
      `UPDATE rides SET driver_phone = $1, status = 'assigned', assigned_at = NOW() WHERE id = $2`,
      [driverPhone, rideId]
    );
  },
  complete: async (rideId) => {
    await pool.query(
      `UPDATE rides SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [rideId]
    );
  },
  getActive: async () => {
    const r = await pool.query(
      `SELECT * FROM rides WHERE status NOT IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 50`
    );
    return r.rows;
  },
  getStats: async () => {
    const r = await pool.query(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN DATE(created_at)=CURRENT_DATE THEN 1 ELSE 0 END) as today
      FROM rides
    `);
    return r.rows[0];
  },
  getActiveByDriver: async (phone) => {
    const r = await pool.query(
      `SELECT r.*, c.name AS client_name
       FROM rides r LEFT JOIN clients c ON c.phone=r.client_phone
       WHERE r.driver_phone=$1 AND r.status='assigned' LIMIT 1`,
      [phone]
    );
    return r.rows[0] || null;
  },
  todayByDriver: async (phone) => {
    const r = await pool.query(
      `SELECT COUNT(*) as n FROM rides WHERE driver_phone = $1 AND DATE(created_at) = CURRENT_DATE`,
      [phone]
    );
    return parseInt(r.rows[0].n);
  }
};

// ─── QUEUE ───────────────────────────────────────────────────

const queue = {
  add: async (phone, lat, lng) => {
    const pos = await pool.query(`SELECT COALESCE(MAX(position),0)+1 as p FROM queue`);
    await pool.query(
      `INSERT INTO queue (client_phone, client_lat, client_lng, position)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (client_phone) DO UPDATE SET client_lat=$2, client_lng=$3`,
      [phone, lat, lng, pos.rows[0].p]
    );
  },
  remove: async (phone) => {
    await pool.query(`DELETE FROM queue WHERE client_phone = $1`, [phone]);
  },
  getAll: async () => {
    const r = await pool.query(`SELECT * FROM queue ORDER BY position ASC`);
    return r.rows;
  },
  getPosition: async (phone) => {
    const r = await pool.query(`SELECT position FROM queue WHERE client_phone = $1`, [phone]);
    return r.rows[0]?.position || 1;
  }
};

// ─── PAYMENTS ────────────────────────────────────────────────

const payments = {
  create: async (phone, weekLabel) => {
    await pool.query(
      `INSERT INTO payments (driver_phone, week_label) VALUES ($1, $2)`,
      [phone, weekLabel]
    );
  },
  markPaid: async (id) => {
    await pool.query(
      `UPDATE payments SET paid = 1, paid_at = NOW() WHERE id = $1`,
      [id]
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
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
    Math.sin(dLng/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function estimateMinutes(distKm) {
  return Math.max(2, Math.round(distKm * 2));
}

async function findNearestDrivers(clientLat, clientLng, maxKm = 5) {
  const online = await drivers.getOnline();
  return online
    .filter(d => d.lat && d.lng)
    .map(d => ({ ...d, dist: distance(clientLat, clientLng, d.lat, d.lng) }))
    .filter(d => d.dist <= maxKm)
    .sort((a, b) => a.dist - b.dist);
}

function getWeekLabel() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now - start) / 86400000 + start.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${String(week).padStart(2,'0')}`;
}

async function getRadius() {
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key='radius'`);
    return parseFloat(r.rows[0]?.value || '5');
  } catch(e) { return 5; }
}

const clientSelections = {
  set: async (phone, rideId, drivers, lat, lng) => {
    await pool.query(
      `INSERT INTO client_selections (client_phone, ride_id, drivers_json, lat, lng)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (client_phone) DO UPDATE SET ride_id=$2, drivers_json=$3, lat=$4, lng=$5, created_at=NOW()`,
      [phone, rideId, JSON.stringify(drivers), lat, lng]
    );
  },
  get: async (phone) => {
    const r = await pool.query('SELECT * FROM client_selections WHERE client_phone=$1', [phone]);
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return { rideId: row.ride_id, drivers: JSON.parse(row.drivers_json || '[]'), lat: row.lat, lng: row.lng };
  },
  delete: async (phone) => {
    await pool.query('DELETE FROM client_selections WHERE client_phone=$1', [phone]);
  },
  getAll: async () => {
    const r = await pool.query('SELECT * FROM client_selections ORDER BY created_at ASC');
    return r.rows.map(row => ({ ...row, drivers: JSON.parse(row.drivers_json || '[]') }));
  }
};

module.exports = {
  pool, init, getRadius, clientSelections,
  drivers, clients, rides, queue, payments,
  distance, estimateMinutes, findNearestDrivers, getWeekLabel,
  blacklist: {
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
    remove: async (phone) => {
      await pool.query('DELETE FROM blacklist WHERE phone=$1', [phone]);
    },
    getAll: async () => {
      const r = await pool.query('SELECT * FROM blacklist ORDER BY created_at DESC');
      return r.rows;
    }
  }
};

// Ajouter colonnes chauffeur (migration)
async function migrate() {
  const cols = [
    `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS clim      BOOLEAN DEFAULT false`,
    `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS photo_ext TEXT`,
    `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS photo_int TEXT`,
    `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS validated INTEGER DEFAULT 0`,
    `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS reg_step  TEXT DEFAULT 'done'`,
    `ALTER TABLE rides   ADD COLUMN IF NOT EXISTS zone       TEXT`,
    `ALTER TABLE rides   ADD COLUMN IF NOT EXISTS offered_at TIMESTAMPTZ`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  ];
  for (const sql of cols) {
    try { await pool.query(sql); } catch(e) {}
  }
  console.log('✅ Migrations OK');
}

module.exports.migrate = migrate;
