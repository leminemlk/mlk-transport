require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const DB = require('./db');
const { sendText } = require('./whapi');
const { handleClient } = require('./handlers/client');
const { handleDriver } = require('./handlers/driver');

const app = express();
app.use(express.json());

// ─── SÉCURITÉ DASHBOARD ──────────────────────────────────────

const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'mlk2024';

// Servir les fichiers statiques avec protection pour index.html et dashboard
app.use('/chauffeur.html', express.static('public'));
app.use('/locate.html', express.static('public'));
app.use('/sw.js', express.static('public'));
app.use('/manifest.json', express.static('public'));

// Dashboard protégé par mot de passe
app.get('/', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) {
    res.set('WWW-Authenticate', 'Basic realm="MLK Transport Admin"');
    return res.status(401).send('Accès refusé | Access Denied');
  }
  const b64 = auth.split(' ')[1];
  const [user, pass] = Buffer.from(b64, 'base64').toString().split(':');
  if (pass !== ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="MLK Transport Admin"');
    return res.status(401).send('Mot de passe incorrect | Wrong password');
  }
  res.sendFile('index.html', { root: 'public' });
});

app.get('/dashboard.html', (req, res) => res.redirect('/'));

// ─── WEBHOOK ─────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const messages = req.body?.messages || [];

  for (const msg of messages) {
    if (msg.from_me) continue;
    try {
      const phone = msg.from.replace('@s.whatsapp.net', '');
      const text = (msg.text?.body || '').trim().toLowerCase();
      const { getState, setState, clearState } = require('./queue');
      const { state, data } = getState(phone);

      // ── Inscription chauffeur ─────────────────────────────
      if (text === 'chauffeur' || text === 'inscription' || text === 'سائق') {
        const existing = await DB.drivers.get(phone);
        if (existing && existing.reg_step === 'done') {
          await sendText(phone, `✅ أنت مسجل بالفعل | Vous êtes déjà inscrit, ${existing.name} !`);
          continue;
        }
        setState(phone, 'reg_name');
        await sendText(phone,
          `🚖 *تسجيل سائق | Inscription Chauffeur*\n\n` +
          `مرحباً ! للتسجيل أجب على الأسئلة التالية :\n` +
          `Bienvenue ! Répondez aux questions suivantes :\n\n` +
          `1️⃣ ما اسمك الكامل ؟\nQuel est votre prénom et nom ?`
        );
        continue;
      }

      // ── Étapes d'inscription ──────────────────────────────
      if (state === 'reg_name' && msg.text?.body) {
        const name = msg.text.body.trim();
        // Créer le chauffeur avec reg_step en cours
        await pool_insert_driver(phone, name);
        setState(phone, 'reg_photo_ext', { name });
        await sendText(phone,
          `✅ شكراً ${name} !\n\n` +
          `2️⃣ أرسل صورة *خارجية* للسيارة مع لوحة الأرقام 🚗\n` +
          `Envoyez une photo *extérieure* du véhicule avec la plaque d'immatriculation.`
        );
        continue;
      }

      if (state === 'reg_photo_ext' && msg.type === 'image') {
        const photoUrl = msg.image?.link || msg.image?.id || 'photo_ext';
        setState(phone, 'reg_photo_int', { ...data, photo_ext: photoUrl });
        await sendText(phone,
          `✅ صورة خارجية مستلمة !\n\n` +
          `3️⃣ أرسل صورة *داخلية* للسيارة 🪑\n` +
          `Envoyez une photo *intérieure* du véhicule.`
        );
        continue;
      }

      if (state === 'reg_photo_int' && msg.type === 'image') {
        const photoUrl = msg.image?.link || msg.image?.id || 'photo_int';
        setState(phone, 'reg_clim', { ...data, photo_int: photoUrl });
        await sendText(phone,
          `✅ صورة داخلية مستلمة !\n\n` +
          `4️⃣ هل سيارتك مكيفة ؟ | Votre véhicule a-t-il la climatisation ?\n\n` +
          `✅ *نعم | Oui*\n❌ *لا | Non*`
        );
        continue;
      }

      if (state === 'reg_clim') {
        const clim = text === 'نعم' || text === 'oui' || text === '1' || text === 'yes';
        await finish_registration(phone, data, clim);
        clearState(phone);
        await sendText(phone,
          `🎉 *تم التسجيل بنجاح !*\n` +
          `*Inscription envoyée !*\n\n` +
          `⏳ سيتم مراجعة طلبك من إدارة MLK Transport.\n` +
          `Votre dossier sera examiné par MLK Transport.\n\n` +
          `🎁 ستحصل على 3 أشهر مجانية عند الموافقة.\n` +
          `3 mois gratuits à l'approbation.`
        );
        // Notifier admin
        console.log(`[INSCRIPTION] Nouveau chauffeur en attente: ${phone} - ${data.name}`);
        continue;
      }

      // ── Routage client / chauffeur ────────────────────────
      const driver = await DB.drivers.get(phone);
      if (driver) {
        if (driver.validated !== 1) {
          await sendText(phone,
            `⏳ طلبك قيد المراجعة | Votre dossier est en cours d'examen.\n\n` +
            `ستتلقى إشعاراً عند الموافقة.\n` +
            `Vous serez notifié à l'approbation.`
          );
          continue;
        }
        await handleDriver(msg, driver);
      } else {
        await handleClient(msg, phone);
      }

    } catch (err) {
      console.error('[WEBHOOK] Erreur:', err.message);
    }
  }
});

async function pool_insert_driver(phone, name) {
  await DB.pool.query(
    `INSERT INTO drivers (phone, name, reg_step, validated) 
     VALUES ($1, $2, 'pending', 0) 
     ON CONFLICT (phone) DO UPDATE SET name=$2, reg_step='pending', validated=0`,
    [phone, name]
  );
}

async function finish_registration(phone, data, clim) {
  await DB.pool.query(
    `UPDATE drivers SET photo_ext=$1, photo_int=$2, clim=$3, reg_step='done' WHERE phone=$4`,
    [data.photo_ext || null, data.photo_int || null, clim, phone]
  );
}

// ─── API ADMIN ───────────────────────────────────────────────

const apiAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Non autorisé' });
  const pass = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1];
  if (pass !== ADMIN_PASS) return res.status(401).json({ error: 'Mot de passe incorrect' });
  next();
};

app.get('/api/drivers', apiAuth, async (req, res) => {
  const drivers = await DB.drivers.getAll();
  const now = new Date();
  res.json(drivers.map(d => ({
    ...d,
    hasTrial: d.trial_until && new Date(d.trial_until) > now,
    hasSub: d.subscription_end && new Date(d.subscription_end) > now,
  })));
});

// Valider un chauffeur
app.post('/api/drivers/:phone/validate', apiAuth, async (req, res) => {
  await DB.pool.query(`UPDATE drivers SET validated=1 WHERE phone=$1`, [req.params.phone]);
  await sendText(req.params.phone,
    `✅ *تمت الموافقة على طلبك !*\n*Votre dossier a été approuvé !*\n\n` +
    `🎁 3 أشهر مجانية تبدأ الآن !\n3 mois gratuits offerts !\n\n` +
    `أرسل موقعك 📍 لبدء العمل\nEnvoyez votre position 📍 pour commencer !`
  );
  res.json({ ok: true });
});

app.post('/api/drivers/:phone/block', apiAuth, async (req, res) => {
  await DB.drivers.block(req.params.phone);
  await sendText(req.params.phone, '⛔ تم تعليق حسابك | Votre accès a été suspendu.');
  res.json({ ok: true });
});

app.post('/api/drivers/:phone/unblock', apiAuth, async (req, res) => {
  await DB.drivers.unblock(req.params.phone);
  await sendText(req.params.phone, '✅ تم تفعيل حسابك | Votre accès a été réactivé !');
  res.json({ ok: true });
});

app.post('/api/drivers/:phone/pay', apiAuth, async (req, res) => {
  const phone = req.params.phone;
  await DB.drivers.renewSubscription(phone);
  const weekLabel = DB.getWeekLabel();
  await DB.payments.create(phone, weekLabel);
  await sendText(phone, `✅ *تم استلام الدفع !*\n💰 500 MRU — ${weekLabel}\nشكراً ! 🙏`);
  res.json({ ok: true });
});

app.get('/api/rides', apiAuth, async (req, res) => res.json(await DB.rides.getActive()));
app.get('/api/queue', apiAuth, async (req, res) => res.json(await DB.queue.getAll()));

app.get('/api/stats', apiAuth, async (req, res) => {
  const rides = await DB.rides.getStats();
  const driversAll = await DB.drivers.getAll();
  const online = await DB.drivers.getOnline();
  res.json({ rides, drivers: { total: driversAll.length, online: online.length } });
});

app.post('/api/broadcast', apiAuth, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message requis' });
  const drivers = (await DB.drivers.getAll()).filter(d => d.active && d.validated);
  for (const d of drivers) await sendText(d.phone, `📢 *MLK Transport :*\n\n${message}`);
  res.json({ sent: drivers.length });
});

// ─── API CHAUFFEUR ────────────────────────────────────────────

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
  const activeRide = await DB.rides.getActiveByDriver(req.params.phone);
  res.json({
    driver, todayRides,
    hasActiveRide: !!activeRide,
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

app.post('/api/driver/:phone/finish', async (req, res) => {
  const phone = req.params.phone;
  const myRide = await DB.rides.getActiveByDriver(phone);
  if (myRide) {
    await DB.rides.complete(myRide.id);
    await DB.drivers.setStatus('online', phone);
    const driver = await DB.drivers.get(phone);
    const { processQueue } = require('./queue');
    await processQueue(driver);
  }
  res.json({ ok: true });
});

app.post('/api/driver/respond', async (req, res) => {
  const { phone, response } = req.body;
  const { acceptRide, refuseRide } = require('./queue');
  if (response === 'accept') await acceptRide(phone);
  else await refuseRide(phone);
  res.json({ ok: true });
});

// ─── API CLIENT ───────────────────────────────────────────────

app.post('/api/locate', async (req, res) => {
  const { phone, lat, lng } = req.body;
  if (!phone || !lat || !lng) return res.status(400).json({ error: 'Données manquantes' });
  try {
    await DB.clients.upsert(phone);
    const rideId = await DB.rides.create(phone, lat, lng);
    const { findDriver } = require('./queue');
    res.json({ ok: true });
    await sendText(phone, `🔍 جاري البحث عن سائق...\nRecherche d'un chauffeur...`);
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
      `⚠️ *تجديد الاشتراك | Rappel abonnement*\n\n` +
      `اشتراكك ينتهي قريباً !\n` +
      `💰 500 MRU/semaine`
    );
  }
});

cron.schedule('0 * * * *', async () => {
  await DB.pool.query(`
    UPDATE drivers SET status = 'offline'
    WHERE status = 'online' AND last_seen < NOW() - INTERVAL '2 hours'
  `);
});

// ─── DÉMARRAGE ───────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

DB.init().then(async () => {
  await DB.migrate();
  app.listen(PORT, () => {
    console.log(`\n🚖 MLK Transport démarré sur le port ${PORT}`);
    console.log(`📊 Dashboard : http://localhost:${PORT}`);
    console.log(`🔗 Webhook   : http://localhost:${PORT}/webhook\n`);
  });
}).catch(err => {
  console.error('❌ Erreur DB:', err);
  process.exit(1);
});
