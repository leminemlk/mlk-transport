# 🚖 MLK Transport — Bot WhatsApp Nouakchott

Transport à la demande via WhatsApp. Un seul numéro pour les clients ET les chauffeurs.

---

## 🚀 Déploiement en 3 étapes

### Étape 1 — Whapi.Cloud

1. Créer un compte sur **https://whapi.cloud**
2. Créer un **canal** → scanner le QR code avec votre WhatsApp
3. Copier votre **Token API**
4. Dans les paramètres du canal → configurer le **Webhook** :
   - URL : `https://votre-app.railway.app/webhook`
   - Activer : Messages entrants

### Étape 2 — Railway

1. Créer un compte sur **https://railway.app**
2. Nouveau projet → **Deploy from GitHub** (uploader le dossier)
3. Dans les variables d'environnement ajouter :
   - `WHAPI_TOKEN` = votre token Whapi.Cloud
4. Railway déploie automatiquement et vous donne une URL

### Étape 3 — Tester

Envoyez "Bonjour" à votre numéro WhatsApp → le bot répond !

---

## 📱 Utilisation

### Côté Client (ultra simple)
| Action | Réponse bot |
|--------|-------------|
| N'importe quel message | Menu d'accueil |
| 📍 Position GPS | Recherche un chauffeur |
| "favoris" | Gérer Maison / Bureau |
| "annuler" | Annuler la demande |

### Côté Chauffeur
| Commande | Action |
|----------|--------|
| "chauffeur" | S'inscrire (1ère fois) |
| 📍 Position GPS | Passer en ligne |
| "1" | Accepter une course |
| "2" | Refuser une course |
| "fin" | Terminer la course |
| "pause" | Se mettre hors ligne |
| "statut" | Voir son abonnement |

### Dashboard Admin
Accessible sur : `https://votre-app.railway.app`

---

## 💰 Modèle économique
- **3 mois gratuits** pour chaque nouveau chauffeur
- Ensuite : **500 MRU/semaine**
- Paiement validé manuellement depuis le dashboard

---

## 🔧 Lancer en local

```bash
npm install
cp .env.example .env
# Remplir .env avec votre token Whapi
npm start
```

Pour tester le webhook en local, utiliser **ngrok** :
```bash
ngrok http 3000
# Copier l'URL ngrok → configurer dans Whapi.Cloud
```
