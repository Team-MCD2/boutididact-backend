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

// Recherche d'une boutique par nom (insensible à la casse)
async function findShopByName(stripe, boutiqueName) {
  if (!boutiqueName) return null;
  const lower = boutiqueName.toLowerCase().replace(/'/g, "\\'");
  try {
    const res = await stripe.customers.search({
      query: `metadata['boutiqueNameLower']:'${lower}'`,
      limit: 1,
    });
    return res.data[0] || null;
  } catch (e) {
    console.error('[saas] findShopByName:', e.message);
    return null;
  }
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
      // 1) Mail admin (avec mot de passe choisi)
      if (process.env.ADMIN_EMAIL_RECEIVER) {
        transporter.sendMail({
          from: `"BOUTIDIDACT System" <${process.env.SMTP_USER}>`,
          to: process.env.ADMIN_EMAIL_RECEIVER,
          subject: '🔔 NOUVEAU CLIENT BOUTIDIDACT',
          text: `Un nouveau client vient de payer son abonnement.\n\n` +
                `Nom Boutique : ${meta.boutiqueName}\n` +
                `Email Boutique : ${meta.boutiqueEmail}\n` +
                `Mot de passe choisi : ${meta.boutiquePassword}\n\n` +
                `→ Créez son compte Hiboutik et envoyez-lui ses identifiants par e-mail.`,
        }).catch(e => console.error('[saas] mail admin:', e.message));
      }

      // 2) Mail client
      transporter.sendMail({
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
      }).catch(e => console.error('[saas] mail client:', e.message));
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

  const { shopName, password } = req.body || {};
  if (!shopName || !password) {
    return res.status(400).json({ error: 'missing_credentials', message: 'Nom de boutique et mot de passe requis.' });
  }

  try {
    const customer = await findShopByName(stripe, shopName);
    if (!customer || !customer.metadata || customer.metadata.boutiquePassword !== password) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Nom de boutique ou mot de passe invalide.' });
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
    if (transporter && process.env.ADMIN_EMAIL_RECEIVER) {
      transporter.sendMail({
        from: `"BOUTIDIDACT System" <${process.env.SMTP_USER}>`,
        to: process.env.ADMIN_EMAIL_RECEIVER,
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
// IA MENU EXTRACTION
// ============================================================
router.post('/extract-menu', async (req, res) => {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    return res.status(501).json({ error: 'gemini_not_configured', message: 'Clé Gemini manquante sur le serveur.' });
  }

  try {
    const { imageBase64, mimeType } = req.body;
    if (!imageBase64 || !mimeType) return res.status(400).json({ error: 'missing_data' });

    const prompt = `Voici une photo d'un menu de restaurant.
    Extrais tous les plats, boissons, et menus avec leurs prix.
    Renvoie UNIQUEMENT le résultat STRICTEMENT au format JSON. Ne mets aucun texte avant ou après.
    Le format attendu est un tableau d'objets avec ces clés exactes :
    "name" (nom du produit), "price" (prix en nombre, ex: 12.5), "category" (catégorie du produit), "desc" (description).`;

    const axios = require('axios');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiKey.trim()}`;
    const payload = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: imageBase64.split(',')[1] || imageBase64 } }
        ]
      }]
    };
    const response = await axios.post(url, payload);
    const text = response.data.candidates[0].content.parts[0].text;
    const cleanedText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const products = JSON.parse(cleanedText);
    res.json({ products });
  } catch (error) {
    console.error('Erreur Gemini Detail:', error.response?.data || error.message);
    const apiError = error.response?.data?.error;
    res.status(500).json({
      error: 'internal_error',
      message: apiError ? `${apiError.status}: ${apiError.message}` : error.message
    });
  }
});

module.exports = router;
