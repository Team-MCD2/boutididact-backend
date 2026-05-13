const express = require('express');
const Stripe = require('stripe');
const config = require('../config/env');
const nodemailer = require('nodemailer');

const router = express.Router();

// ============================================================
// Persistance : Stripe Customer metadata (compatible Vercel).
//   - boutiqueName  (case sensitive, recherchable via Search API)
//   - boutiqueNameLower (lowercase pour recherche insensible à la casse)
//   - boutiquePassword
//   - paidAt
// Aucun fichier sur disque -> fonctionne en serverless.
// ============================================================

const getStripe = () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
};

const buildTransporter = () => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 465,
    secure: process.env.SMTP_PORT == 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
};
const transporter = buildTransporter();

// Recherche d'une boutique par nom (insensible à la casse).
// Stripe Search est éventuellement consistant : on retry une fois si vide.
async function findShopByName(stripe, boutiqueName) {
  if (!boutiqueName) return null;
  const lower = boutiqueName.toLowerCase().replace(/'/g, "\\'");
  const query = `metadata['boutiqueNameLower']:'${lower}'`;

  const trySearch = async () => {
    try {
      const res = await stripe.customers.search({ query, limit: 1 });
      return res.data[0] || null;
    } catch (e) {
      console.error('[saas] findShopByName error:', e.message);
      return null;
    }
  };

  let found = await trySearch();
  if (found) return found;

  // Retry rapide (consistance éventuelle de l'index Stripe Search)
  await new Promise(r => setTimeout(r, 600));
  found = await trySearch();
  if (found) return found;

  return null;
}

async function findShopByEmail(stripe, email) {
  if (!email) return null;
  try {
    const res = await stripe.customers.list({ email, limit: 1 });
    return res.data[0] || null;
  } catch (e) {
    console.error('[saas] findShopByEmail:', e.message);
    return null;
  }
}

// ============================================================
// REGISTER (Stripe Checkout)
// ============================================================
router.post('/stripe-checkout', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(501).json({ error: 'stripe_not_configured', message: 'Clé Stripe manquante sur le serveur.' });
  }

  const { boutiqueName, boutiqueEmail, boutiquePassword } = req.body || {};
  if (!boutiqueName || !boutiqueEmail || !boutiquePassword) {
    return res.status(400).json({ error: 'missing_fields', message: 'Nom, email et mot de passe requis.' });
  }

  try {
    // Unicité par email (consistent)
    const existingByEmail = await findShopByEmail(stripe, boutiqueEmail);
    if (existingByEmail) {
      return res.status(409).json({
        error: 'email_already_exists',
        message: 'Cet email est déjà associé à une boutique. Veuillez vous connecter.',
      });
    }

    // Unicité par nom (eventually consistent ~ 1 min)
    const existingByName = await findShopByName(stripe, boutiqueName);
    if (existingByName) {
      return res.status(409).json({
        error: 'shop_already_exists',
        message: `Le nom de boutique "${boutiqueName}" est déjà utilisé. Choisissez-en un autre ou connectez-vous.`,
      });
    }

    const origin = req.headers.origin || `http://localhost:${config.port}`;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: boutiqueEmail,
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Abonnement BOUTIDIDACT - Caisse Enregistreuse',
            description: `Activation pour : ${boutiqueName}`,
          },
          unit_amount: 4999,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      // Le checkout crée automatiquement un Customer en mode subscription.
      // On propage les métadonnées vers la session ET la subscription.
      metadata: {
        boutiqueName,
        boutiqueNameLower: boutiqueName.toLowerCase(),
        boutiqueEmail,
        boutiquePassword,
      },
      subscription_data: {
        metadata: {
          boutiqueName,
          boutiqueNameLower: boutiqueName.toLowerCase(),
          boutiqueEmail,
          boutiquePassword,
        },
      },
      mode: 'subscription',
      success_url: `${origin}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}?payment=cancelled`,
    });
    res.json({ url: session.url });
  } catch (error) {
    console.error('[saas] stripe-checkout:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// VERIFY SUBSCRIPTION : retour Stripe -> persiste metadata sur Customer + envoi e-mails
// ============================================================
router.get('/verify-subscription', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(501).json({ error: 'stripe_not_configured' });

  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'missing_session_id' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.json({ status: 'unpaid' });
    }

    const meta = session.metadata || {};
    const customerId = session.customer;

    // Persistance des metadata sur le Customer (source de vérité pour /login)
    let alreadyHandled = false;
    if (customerId) {
      const existing = await stripe.customers.retrieve(customerId);
      alreadyHandled = Boolean(existing.metadata?.paidAt);
      await stripe.customers.update(customerId, {
        metadata: {
          ...(existing.metadata || {}),
          boutiqueName: meta.boutiqueName || '',
          boutiqueNameLower: (meta.boutiqueName || '').toLowerCase(),
          boutiqueEmail: meta.boutiqueEmail || '',
          boutiquePassword: meta.boutiquePassword || '',
          paidAt: existing.metadata?.paidAt || new Date().toISOString(),
        },
      });
    }

    if (!alreadyHandled && transporter) {
      const mails = [];
      // 1) Mail admin (avec mot de passe choisi)
      // ADMIN_EMAIL_RECEIVER supporte plusieurs adresses séparées par des virgules
      // ex: admin1@mail.com,admin2@mail.com
      if (process.env.ADMIN_EMAIL_RECEIVER) {
        const adminRecipients = process.env.ADMIN_EMAIL_RECEIVER;
        mails.push(transporter.sendMail({
          from: `"BOUTIDIDACT System" <${process.env.SMTP_USER}>`,
          to: adminRecipients,
          subject: '🔔 NOUVEAU CLIENT BOUTIDIDACT',
          text: `Un nouveau client vient de payer son abonnement.\n\n` +
                `Nom Boutique : ${meta.boutiqueName}\n` +
                `Email Boutique : ${meta.boutiqueEmail}\n` +
                `Mot de passe choisi : ${meta.boutiquePassword}\n\n` +
                `→ Créez son compte Hiboutik et envoyez-lui ses identifiants par e-mail.`,
        }).then(() => console.log('[saas] mail admin envoyé à:', adminRecipients)).catch(e => console.error('[saas] mail admin:', e.message)));
      }

      // 2) Mail client
      mails.push(transporter.sendMail({
        from: `"BOUTIDIDACT Team" <${process.env.SMTP_USER}>`,
        to: meta.boutiqueEmail,
        subject: '🚀 Bienvenue chez BOUTIDIDACT !',
        html: `
          <div style="font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
            <h2 style="color: #4f46e5;">Bienvenue, ${meta.boutiqueName} !</h2>
            <p>Votre abonnement est activé. Vous recevrez très prochainement un second e-mail contenant vos identifiants Hiboutik à renseigner dans la borne pour activer votre boutique.</p>
            <p>Pour vous connecter à votre borne, utilisez le <strong>nom de boutique</strong> et le <strong>mot de passe</strong> choisis lors de l'inscription.</p>
            <p>L'équipe BOUTIDIDACT</p>
          </div>`,
      }).then(() => console.log('[saas] mail client envoyé')).catch(e => console.error('[saas] mail client:', e.message)));

      // IMPORTANT : on attend la fin des envois avant de répondre,
      // sinon la lambda Vercel gèle et coupe la connexion SMTP.
      await Promise.allSettled(mails);
    }

    res.json({
      status: 'paid',
      shop: { name: meta.boutiqueName || '', email: meta.boutiqueEmail || '' },
    });
  } catch (error) {
    console.error('[saas] verify-subscription:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// LOGIN : nom de boutique + mot de passe (vérifié contre metadata Stripe)
// ============================================================
router.post('/login', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(501).json({ error: 'stripe_not_configured', message: 'Service indisponible.' });
  }

  const { shopName, password } = req.body || {};
  if (!shopName || !password) {
    return res.status(400).json({ error: 'missing_credentials', message: 'Nom de boutique et mot de passe requis.' });
  }

  try {
    const customer = await findShopByName(stripe, shopName);
    if (!customer || !customer.metadata) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Nom de boutique ou mot de passe invalide.' });
    }
    if (customer.metadata.boutiquePassword !== password) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Nom de boutique ou mot de passe invalide.' });
    }
    if (!customer.metadata.paidAt) {
      return res.status(403).json({ error: 'unpaid', message: 'Abonnement non activé.' });
    }

    res.json({
      ok: true,
      shop: {
        name: customer.metadata.boutiqueName,
        email: customer.metadata.boutiqueEmail || customer.email || '',
      },
    });
  } catch (error) {
    console.error('[saas] login:', error.message);
    res.status(500).json({ error: 'internal_error', message: error.message });
  }
});

// ============================================================
// DELETE ACCOUNT : supprime la boutique (annule abonnement + delete Customer)
// ============================================================
router.post('/delete-account', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(501).json({ error: 'stripe_not_configured', message: 'Service indisponible.' });
  }

  const { shopName, email } = req.body || {};
  if (!shopName || !email) {
    return res.status(400).json({ error: 'missing_fields', message: 'Nom de boutique et email associés requis.' });
  }

  try {
    const customer = await findShopByName(stripe, shopName);
    const linkedEmail = (customer?.metadata?.boutiqueEmail || customer?.email || '').toLowerCase();
    if (!customer || linkedEmail !== email.trim().toLowerCase()) {
      return res.status(404).json({ error: 'not_found', message: 'Aucune boutique ne correspond à ce nom et cet email.' });
    }

    // 1) Annuler toutes les souscriptions actives du customer
    try {
      const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 10 });
      for (const sub of subs.data) {
        if (['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(sub.status)) {
          await stripe.subscriptions.cancel(sub.id).catch(e => console.error('[saas] cancel sub:', e.message));
        }
      }
    } catch (e) {
      console.error('[saas] list subs:', e.message);
    }

    // 2) Supprimer le Customer Stripe (élimine définitivement la "boutique")
    const customerEmail = customer.metadata.boutiqueEmail || customer.email || '';
    const boutiqueName = customer.metadata.boutiqueName || shopName;
    await stripe.customers.del(customer.id);

    // 3) Notifier admin
    // ADMIN_EMAIL_RECEIVER supporte plusieurs adresses séparées par des virgules
    if (transporter && process.env.ADMIN_EMAIL_RECEIVER) {
      const adminRecipients = process.env.ADMIN_EMAIL_RECEIVER;
      await transporter.sendMail({
        from: `"BOUTIDIDACT System" <${process.env.SMTP_USER}>`,
        to: adminRecipients,
        subject: '🗑️ SUPPRESSION COMPTE BOUTIDIDACT',
        text: `Une boutique vient d'être supprimée.\n\n` +
              `Nom Boutique : ${boutiqueName}\n` +
              `Email : ${customerEmail}\n\n` +
              `→ Pensez à supprimer le compte Hiboutik associé.`,
      }).catch(e => console.error('[saas] mail admin delete:', e.message));
    }

    res.json({ ok: true, message: 'Boutique supprimée.' });
  } catch (error) {
    console.error('[saas] delete-account:', error.message);
    res.status(500).json({ error: 'internal_error', message: error.message });
  }
});

// ============================================================
// IA MENU EXTRACTION (Gemini -> fallback Groq Llama Vision)
// ============================================================
const axios = require('axios');

const EXTRACT_PROMPT = `Voici une photo d'un menu de restaurant.
Extrais tous les plats, boissons, et menus avec leurs prix.
Renvoie UNIQUEMENT le résultat STRICTEMENT au format JSON. Ne mets aucun texte avant ou après.
Le format attendu est un tableau d'objets avec ces clés exactes :
"name" (nom du produit), "price" (prix en nombre, ex: 12.5), "category" (catégorie du produit), "desc" (description courte), "composition" (liste des ingrédients/composants séparés par des virgules, ex: "Salade, Tomate, Oignon, Steak, Fromage"). Si la composition n'est pas visible, mets une chaîne vide.`;

const parseProductsJson = (text) => {
  const cleaned = String(text || '')
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .trim();
  // Tente d'extraire le bloc JSON si du texte parasite subsiste
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  const slice = (start >= 0 && end > start) ? cleaned.slice(start, end + 1) : cleaned;
  return JSON.parse(slice);
};

async function extractWithGemini({ imageBase64, mimeType }) {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('Clé Gemini absente.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
  const payload = {
    contents: [{
      parts: [
        { text: EXTRACT_PROMPT },
        { inline_data: { mime_type: mimeType, data: imageBase64.split(',')[1] || imageBase64 } },
      ],
    }],
  };
  const { data } = await axios.post(url, payload, { timeout: 25_000 });
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return parseProductsJson(text);
}

async function extractWithGroq({ imageBase64, mimeType }) {
  const key = (process.env.GROQ_API_KEY || '').trim();
  if (!key) throw new Error('Clé Groq absente.');
  const dataUrl = imageBase64.startsWith('data:')
    ? imageBase64
    : `data:${mimeType};base64,${imageBase64}`;
  const payload = {
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: EXTRACT_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  };
  const { data } = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    payload,
    { timeout: 25_000, headers: { Authorization: `Bearer ${key}` } },
  );
  let text = data?.choices?.[0]?.message?.content || '';
  try {
    return parseProductsJson(text);
  } catch {
    // Groq peut emballer le tableau dans un objet ({ "products": [...] }) à cause de response_format json_object
    const obj = JSON.parse(text);
    if (Array.isArray(obj)) return obj;
    for (const v of Object.values(obj || {})) {
      if (Array.isArray(v)) return v;
    }
    throw new Error('Réponse Groq sans tableau JSON exploitable.');
  }
}

router.post('/extract-menu', async (req, res) => {
  const { imageBase64, mimeType } = req.body || {};
  if (!imageBase64 || !mimeType) {
    return res.status(400).json({ error: 'missing_data', message: 'Image manquante.' });
  }

  const errors = [];
  for (const provider of [
    { name: 'gemini', fn: extractWithGemini },
    { name: 'groq', fn: extractWithGroq },
  ]) {
    try {
      const products = await provider.fn({ imageBase64, mimeType });
      if (!Array.isArray(products)) throw new Error('Réponse non-tableau.');
      return res.json({ products, provider: provider.name });
    } catch (e) {
      const detail = e.response?.data?.error?.message || e.response?.data?.error || e.message;
      console.error(`[extract-menu] ${provider.name} KO:`, detail);
      errors.push(`${provider.name}: ${detail}`);
    }
  }

  res.status(502).json({
    error: 'all_providers_failed',
    message: `Aucun fournisseur IA n'a répondu. (${errors.join(' | ')})`,
  });
});

module.exports = router;
