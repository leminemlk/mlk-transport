require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const DB = require('./db');
const { sendText } = require('./whapi');
const { handleClient } = require('./handlers/client');
const { handleDriver } = require('./handlers/driver');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ─── ANTI-SPAM / DÉDUPLICATION ───────────────────────────────
const recentMsgs = new Map();
function isDuplicate(msgId) {
  if (!msgId) return false;
  if (recentMsgs.has(msgId)) return true;
  recentMsgs.set(msgId, Date.now());
  if (recentMsgs.size > 500) {
    const old = Date.now() - 10000;
    for (const [k, v] of recentMsgs) { if (v < old) recentMsgs.delete(k); }
  }
  return false;
}

// ─── ANTI-SPAM PAR NUMÉRO ────────────────────────────────────
const lastMsg = new Map();
function isSpam(phone) {
  const now = Date.now();
  const last = lastMsg.get(phone) || 0;
  if (now - last < 1500) return true;
  lastMsg.set(phone, now);
  return false;
}

// ─── WEBHOOK ─────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const messages = req.body?.messages || [];

  for (const msg of messages) {
    if (msg.from_me) continue;
    if (isDuplicate(msg.id)) continue;

    try {
      const phone = msg.from.replace('@s.whatsapp.net', '').replace(/\D/g, '');
      if (!phone || phone.length < 8) continue;
      if (isSpam(phone)) continue;

      const text = (msg.text?.body || '').trim().toLowerCase();
      const { getState, setState, clearState } = require('./queue');
      const { state, data } = getState(phone);

      // ── Inscription chauffeur ─────────────────────────────
      if (text === 'chauffeur' || text === 'سائق') {
        const existing = await DB.drivers.get(phone);
        if (existing && existing.reg_step === 'done') {
          await sendText(phone, `✅ أنت مسجل بالفعل | Déjà inscrit, ${existing.name} !`);
          continue;
        }
        setState(phone, 'reg_name');
        await sendText(phone,
          `🚖 *تسجيل سائق | Inscription Chauffeur*\n\n` +
          `*1⃣* ما اسمك الكامل ؟\nQuel est votre prénom et nom ?`
        );
        continue;
      }

      // ── Étapes inscription ────────────────────────────────
      if (state === 'reg_name' && msg.text?.body) {
        const name = msg.text.body.trim();
        if (name.length < 2) { await sendText(phone, '⚠️ الاسم قصير جداً | Nom trop court.'); continue; }
        await DB.pool.query(
          `INSERT INTO drivers (phone, name, reg_step, validated) VALUES ($1,$2,'pending',0)
           ON CONFLICT (phone) DO UPDATE SET name=$2, reg_step='pending', validated=0`,
          [phone, name]
        );
        setState(phone, 'reg_photo_ext', { name });
        await sendText(phone,
          `✅ شكراً ${name} !\n\n` +
          `*2⃣* أرسل صورة *خارجية* للسيارة مع اللوحة 🚗\n` +
          `Envoyez une photo *extérieure* avec la plaque.`
        );
        continue;
      }

      if (state === 'reg_photo_ext') {
        if (msg.type !== 'image') {
          await sendText(phone, '⚠️ أرسل صورة من فضلك | Envoyez une photo SVP 📷');
          continue;
        }
        const photoUrl = msg.image?.link || msg.image?.id || '';
        setState(phone, 'reg_photo_int', { ...data, photo_ext: photoUrl });
        await sendText(phone,
          `✅ تم استلام الصورة الخارجية !\n\n` +
          `*3⃣* أرسل صورة *داخلية* للسيارة 🪑\n` +
          `Envoyez une photo *intérieure*.`
        );
        continue;
      }

      if (state === 'reg_photo_int') {
        if (msg.type !== 'image') {
          await sendText(phone, '⚠️ أرسل صورة من فضلك | Envoyez une photo SVP 📷');
          continue;
        }
        const photoUrl = msg.image?.link || msg.image?.id || '';
        setState(phone, 'reg_clim', { ...data, photo_int: photoUrl });
        await sendText(phone,
          `✅ تم استلام الصورة الداخلية !\n\n` +
          `*4⃣* هل سيارتك مكيفة ؟ | Climatisation ?\n\n` +
          `*1* → نعم ❄️ | Oui\n*2* → لا 🌡 | Non`
        );
        continue;
      }

      if (state === 'reg_clim') {
        if (text !== '1' && text !== '2') {
          await sendText(phone, '⚠️ اضغط *1* للنعم أو *2* للا | Tapez *1* Oui ou *2* Non');
          continue;
        }
        const clim = text === '1';
        await DB.pool.query(
          `UPDATE drivers SET photo_ext=$1, photo_int=$2, clim=$3, reg_step='done' WHERE phone=$4`,
          [data.photo_ext || null, data.photo_int || null, clim, phone]
        );
        clearState(phone);
        await sendText(phone,
          `🎉 *تم التسجيل !* | *Inscription envoyée !*\n\n` +
          `⏳ في انتظار موافقة الإدارة\n` +
          `En attente de validation MK TAXI.\n\n` +
          `🎁 3 أشهر مجانية عند الموافقة !\n3 mois gratuits à l'approbation !`
        );
        console.log(`[NEW DRIVER] ${phone} — ${data.name}`);
        continue;
      }

      // ── Routage client / chauffeur ────────────────────────
      const driver = await DB.drivers.get(phone);
      if (driver) {
        if (!driver.validated) {
          await sendText(phone,
            `⏳ طلبك قيد المراجعة | Dossier en cours d'examen.\n` +
            `ستتلقى إشعاراً | Vous serez notifié.`
          );
          continue;
        }
        await handleDriver(msg, driver);
      } else {
        await handleClient(msg, phone);
      }

    } catch (err) {
      console.error('[WEBHOOK ERR]', err.message);
    }
  }
});

// ─── API DRIVERS ──────────────────────────────────────────────
app.get('/api/drivers', async (req, res) => {
  try {
    const drivers = await DB.drivers.getAll();
    const now = new Date();
    res.json(drivers.map(d => ({
      ...d,
      hasTrial: !!(d.trial_until && new Date(d.trial_until) > now),
      hasSub: !!(d.subscription_end && new Date(d.subscription_end) > now),
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/drivers/upsert', async (req, res) => {
  try {
    const { phone, name, clim, days, validated } = req.body;
    if (!phone || !name) return res.status(400).json({ error: 'phone et name requis' });
    await DB.pool.query(
      `INSERT INTO drivers (phone, name, clim, validated, reg_step)
       VALUES ($1,$2,$3,$4,'done')
       ON CONFLICT (phone) DO UPDATE SET name=$2, clim=$3, validated=$4`,
      [phone.replace(/\D/g,''), name.trim(), !!clim, validated ? 1 : 0]
    );
    if (days > 0) await DB.drivers.renewSubscription(phone);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/drivers/:phone/validate', async (req, res) => {
  try {
    await DB.pool.query(`UPDATE drivers SET validated=1 WHERE phone=$1`, [req.params.phone]);
    await sendText(req.params.phone,
      `✅ *تمت الموافقة !* | *Approuvé !*\n\n` +
      `🎁 3 أشهر مجانية !\n3 mois gratuits !\n\n` +
      `افتح الرابط للبدء\nOuvrez ce lien pour commencer`
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/drivers/:phone/block', async (req, res) => {
  try {
    await DB.drivers.block(req.params.phone);
    await sendText(req.params.phone, '⛔ تم تعليق حسابك | Compte suspendu.');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/drivers/:phone/unblock', async (req, res) => {
  try {
    await DB.drivers.unblock(req.params.phone);
    await sendText(req.params.phone, '✅ تم تفعيل حسابك | Compte réactivé !');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/drivers/:phone/pay', async (req, res) => {
  try {
    const phone = req.params.phone;
    await DB.drivers.renewSubscription(phone);
    await DB.payments.create(phone, DB.getWeekLabel());
    await sendText(phone, `✅ *تم الدفع !*\n💰 500 MRU — ${DB.getWeekLabel()}\nشكراً ! 🙏`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/drivers/:phone', async (req, res) => {
  try {
    await DB.pool.query('DELETE FROM drivers WHERE phone=$1', [req.params.phone]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── API CLIENTS ──────────────────────────────────────────────
app.get('/api/clients', async (req, res) => {
  try {
    const r = await DB.pool.query('SELECT * FROM clients ORDER BY created_at DESC LIMIT 200');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:phone', async (req, res) => {
  try {
    await DB.pool.query('DELETE FROM clients WHERE phone=$1', [req.params.phone]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── API RIDES & STATS ────────────────────────────────────────
app.get('/api/rides', async (req, res) => {
  try { res.json(await DB.rides.getActive()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/queue', async (req, res) => {
  try { res.json(await DB.queue.getAll()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const [rides, driversAll, online] = await Promise.all([
      DB.rides.getStats(), DB.drivers.getAll(), DB.drivers.getOnline()
    ]);
    res.json({ rides, drivers: { total: driversAll.length, online: online.length } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/broadcast', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message requis' });
    const drivers = (await DB.drivers.getAll()).filter(d => d.active && d.validated);
    for (const d of drivers) {
      await sendText(d.phone, `📢 *MK TAXI :*\n\n${message}`);
      await new Promise(r => setTimeout(r, 300)); // éviter rate limit
    }
    res.json({ sent: drivers.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── API CHAUFFEUR ────────────────────────────────────────────
app.post('/api/driver/location', async (req, res) => {
  try {
    const { phone, lat, lng } = req.body;
    if (!phone || !lat || !lng) return res.status(400).json({ error: 'Données manquantes' });
    await DB.drivers.setOnlineWithLocation(lat, lng, phone);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/driver/:phone/status', async (req, res) => {
  try {
    const driver = await DB.drivers.get(req.params.phone);
    if (!driver) return res.status(404).json({ error: 'Introuvable' });
    const { pendingOffers } = require('./queue');
    const offer = pendingOffers.get(req.params.phone);
    const [todayRides, activeRide] = await Promise.all([
      DB.rides.todayByDriver(req.params.phone),
      DB.rides.getActiveByDriver(req.params.phone)
    ]);
    res.json({
      driver, todayRides, hasActiveRide: !!activeRide,
      pendingOffer: offer ? {
        rideId: offer.rideId,
        dist: DB.distance(driver.lat, driver.lng, offer.clientLat, offer.clientLng).toFixed(1),
        eta: DB.estimateMinutes(DB.distance(driver.lat, driver.lng, offer.clientLat, offer.clientLng))
      } : null
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/driver/:phone/offline', async (req, res) => {
  try {
    await DB.drivers.setStatus('offline', req.params.phone);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/driver/:phone/finish', async (req, res) => {
  try {
    const phone = req.params.phone;
    const myRide = await DB.rides.getActiveByDriver(phone);
    if (myRide) {
      await DB.rides.complete(myRide.id);
      await DB.drivers.setStatus('online', phone);
      const { processQueue } = require('./queue');
      await processQueue(await DB.drivers.get(phone));
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/driver/respond', async (req, res) => {
  try {
    const { phone, response } = req.body;
    const { acceptRide, refuseRide } = require('./queue');
    if (response === 'accept') await acceptRide(phone);
    else await refuseRide(phone);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── API CLIENT LOCATE ────────────────────────────────────────
app.post('/api/locate', async (req, res) => {
  try {
    const { phone, lat, lng } = req.body;
    if (!phone || !lat || !lng) return res.status(400).json({ error: 'Données manquantes' });
    await DB.clients.upsert(phone);
    const rideId = await DB.rides.create(phone, lat, lng);
    const { findDriver } = require('./queue');
    res.json({ ok: true });
    await sendText(phone, `🔍 جاري البحث عن سائق...\nRecherche d'un chauffeur...`);
    await findDriver(phone, lat, lng, rideId);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── CRON ────────────────────────────────────────────────────
// Rappel abonnement chaque dimanche
cron.schedule('0 9 * * 0', async () => {
  const expiring = await DB.drivers.getExpiring();
  for (const d of expiring) {
    await sendText(d.phone, `⚠️ *تجديد الاشتراك | Rappel*\n💰 500 MRU/semaine`);
    await new Promise(r => setTimeout(r, 500));
  }
});

// Mettre hors ligne les chauffeurs inactifs depuis 2h
cron.schedule('0 * * * *', async () => {
  try {
    const r = await DB.pool.query(`
      UPDATE drivers SET status='offline'
      WHERE status='online' AND last_seen < NOW() - INTERVAL '2 hours'
      RETURNING phone
    `);
    if (r.rows.length > 0)
      console.log(`[CRON] ${r.rows.length} chauffeur(s) mis hors ligne`);
  } catch(e) { console.error('[CRON ERR]', e.message); }
});

// Nettoyer les anciennes courses (>24h) et queue abandonnée
cron.schedule('0 3 * * *', async () => {
  try {
    await DB.pool.query(`
      UPDATE rides SET status='cancelled'
      WHERE status='searching' AND created_at < NOW() - INTERVAL '2 hours'
    `);
    await DB.pool.query(`
      DELETE FROM queue WHERE created_at < NOW() - INTERVAL '2 hours'
    `);
  } catch(e) { console.error('[CRON ERR]', e.message); }
});

// ─── HEALTHCHECK ─────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ─── DÉMARRAGE ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
DB.init().then(async () => {
  await DB.migrate();
  app.listen(PORT, () => {
    console.log(`\n🚖 MK TAXI — Port ${PORT}`);
    console.log(`📊 Dashboard : http://localhost:${PORT}`);
    console.log(`🔗 Webhook   : http://localhost:${PORT}/webhook\n`);
  });
}).catch(err => { console.error('❌ DB Error:', err); process.exit(1); });
