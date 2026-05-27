require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const DB = require('./db');
const { sendText } = require('./whapi');
const { handleClient } = require('./handlers/client');
const { handleDriver } = require('./handlers/driver');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ─── WEBHOOK ─────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const messages = req.body?.messages || [];

  for (const msg of messages) {
    if (msg.from_me) continue;
    try {
      const phone = msg.from.replace('@s.whatsapp.net', '');
      const text = (msg.text?.body || '').trim().toLowerCase();

      // Inscription chauffeur
      if (text === 'chauffeur' || text === 'inscription') {
        const existing = await DB.drivers.get(phone);
        if (existing) {
          await sendText(phone, `✅ Vous êtes déjà enregistré comme chauffeur, ${existing.name} !`);
          continue;
        }
        const { setState } = require('./queue');
        setState(phone, 'registering_name');
        await sendText(phone,
          `🚖 *Inscription Chauffeur MLK Transport*\n\n` +
          `👤 Quel est votre *prénom et nom* ?`
        );
        continue;
      }

      // Finaliser inscription
      const { getState, clearState } = require('./queue');
      const { state } = getState(phone);

      if (state === 'registering_name' && msg.text?.body) {
        const name = msg.text.body.trim();
        await DB.drivers.insert(phone, name);
        clearState(phone);
        await sendText(phone,
          `✅ *Inscription réussie !*\n\n` +
          `🎉 Bienvenue *${name}* !\n` +
          `🎁 *3 mois gratuits* offerts.\n` +
          `Ensuite : 500 MRU/semaine.\n\n` +
          `📍 Envoyez votre position pour commencer !`
        );
        continue;
      }

      // Routage client / chauffeur
      const driver = await DB.drivers.get(phone);
      if (driver) {
        await handleDriver(msg, driver);
      } else {
        await handleClient(msg, phone);
      }

    } catch (err) {
      console.error('[WEBHOOK] Erreur:', err.message);
    }
  }
});

// ─── API ADMIN ───────────────────────────────────────────────

app.get('/api/drivers', async (req, res) => {
  const drivers = await DB.drivers.getAll();
  const now = new Date();
  res.json(drivers.map(d => ({
    ...d,
    hasTrial: d.trial_until && new Date(d.trial_until) > now,
    hasSub: d.subscription_end && new Date(d.subscription_end) > now,
  })));
});

app.post('/api/drivers/:phone/block', async (req, res) => {
  await DB.drivers.block(req.params.phone);
  await sendText(req.params.phone, '⛔ Votre accès MLK Transport a été suspendu.');
  res.json({ ok: true });
});

app.post('/api/drivers/:phone/unblock', async (req, res) => {
  await DB.drivers.unblock(req.params.phone);
  await sendText(req.params.phone, '✅ Votre accès MLK Transport a été réactivé !');
  res.json({ ok: true });
});

app.post('/api/drivers/:phone/pay', async (req, res) => {
  const phone = req.params.phone;
  await DB.drivers.renewSubscription(phone);
  const weekLabel = DB.getWeekLabel();
  await DB.payments.create(phone, weekLabel);
  await sendText(phone,
    `✅ *Paiement reçu !*\n\n💰 500 MRU — Semaine ${weekLabel}\nMerci ! 🙏`
  );
  res.json({ ok: true });
});

app.get('/api/rides', async (req, res) => {
  res.json(await DB.rides.getActive());
});

app.get('/api/queue', async (req, res) => {
  res.json(await DB.queue.getAll());
});

app.get('/api/stats', async (req, res) => {
  const rides = await DB.rides.getStats();
  const driversAll = await DB.drivers.getAll();
  const online = await DB.drivers.getOnline();
  res.json({
    rides,
    drivers: {
      total: driversAll.length,
      online: online.length,
      active: driversAll.filter(d => d.active).length
    }
  });
});

app.post('/api/broadcast', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message requis' });
  const drivers = await DB.drivers.getAll();
  const active = drivers.filter(d => d.active);
  for (const d of active) {
    await sendText(d.phone, `📢 *MLK Transport :*\n\n${message}`);
  }
  res.json({ sent: active.length });
});

// ─── API CHAUFFEUR (GPS) ──────────────────────────────────────

app.post('/api/driver/location', async (req, res) => {
  const { phone, lat, lng } = req.body;
  if (!phone || !lat || !lng) return res.status(400).json({ error: 'Données manquantes' });
  await DB.drivers.setOnlineWithLocation(lat, lng, phone);
  res.json({ ok: true });
});

app.get('/api/driver/:phone/status', async (req, res) => {
  const driver = await DB.drivers.get(req.params.phone);
  if (!driver) return res.status(404).json({ error: 'Chauffeur introuvable' });
  const { pendingOffers } = require('./queue');
  const offer = pendingOffers.get(req.params.phone);
  const todayRides = await DB.rides.todayByDriver(req.params.phone);
  res.json({
    driver,
    todayRides,
    pendingOffer: offer ? {
      rideId: offer.rideId,
      dist: DB.distance(driver.lat, driver.lng, offer.clientLat, offer.clientLng).toFixed(1),
      eta: DB.estimateMinutes(DB.distance(driver.lat, driver.lng, offer.clientLat, offer.clientLng))
    } : null
  });
});

app.post('/api/driver/:phone/offline', async (req, res) => {
  await DB.drivers.setStatus('offline', req.params.phone);
  res.json({ ok: true });
});

app.post('/api/driver/respond', async (req, res) => {
  const { phone, response } = req.body;
  const { acceptRide, refuseRide } = require('./queue');
  if (response === 'accept') await acceptRide(phone);
  else await refuseRide(phone);
  res.json({ ok: true });
});

// ─── API LOCALISATION CLIENT ──────────────────────────────────

app.post('/api/locate', async (req, res) => {
  const { phone, lat, lng } = req.body;
  if (!phone || !lat || !lng) return res.status(400).json({ error: 'Données manquantes' });
  try {
    await DB.clients.upsert(phone);
    const rideId = await DB.rides.create(phone, lat, lng);
    const { findDriver } = require('./queue');
    res.json({ ok: true });
    await sendText(phone, `🔍 Recherche d'un chauffeur...\nVeuillez patienter.`);
    await findDriver(phone, lat, lng, rideId);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── CRON ────────────────────────────────────────────────────

cron.schedule('0 9 * * 0', async () => {
  const expiring = await DB.drivers.getExpiring();
  for (const d of expiring) {
    await sendText(d.phone,
      `⚠️ *Rappel abonnement MLK Transport*\n\n` +
      `Votre abonnement expire bientôt !\n` +
      `💰 Tarif : *500 MRU/semaine*`
    );
  }
});

// ─── DÉMARRAGE ───────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

DB.init().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚖 MLK Transport démarré sur le port ${PORT}`);
    console.log(`📊 Dashboard : http://localhost:${PORT}`);
    console.log(`🔗 Webhook   : http://localhost:${PORT}/webhook\n`);
  });
}).catch(err => {
  console.error('❌ Erreur DB:', err);
  process.exit(1);
});
