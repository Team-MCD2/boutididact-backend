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
  const lower = boutiqueName.toLowerCase().trim();
  const query = `metadata['boutiqueNameLower']:'${lower.replace(/'/g, "\\'")}'`;

  console.log(`[saas] Recherche boutique: "${boutiqueName}"`);

  const trySearch = async () => {
    try {
      const res = await stripe.customers.search({ query, limit: 1 });
      if (res.data && res.data.length > 0) {
        const potentialCustomer = res.data[0];
        // VÉRIFICATION CRUCIALE : L'index search de Stripe peut être obsolète.
        // On vérifie si le client existe vraiment et n'est pas supprimé.
        try {
          const realCustomer = await stripe.customers.retrieve(potentialCustomer.id);
          if (realCustomer && !realCustomer.deleted) {
            console.log(`[saas] Boutique validée: ${realCustomer.id}`);
            return realCustomer;
          }
        } catch (e) {
          console.warn(`[saas] Client fantôme détecté (${potentialCustomer.id}), on ignore.`);
        }
      }
      return null;
    } catch (e) {
      console.error('[saas] findShopByName error:', e.message);
      return null;
    }
  };

  let found = await trySearch();
  if (found) return found;

  console.log(`[saas] Non trouvé, retry dans 1s...`);
  await new Promise(r => setTimeout(r, 1000));
  found = await trySearch();
  
  return found;
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

  const { boutiqueName, boutiqueEmail, boutiquePassword, boutiquePhone, boutiqueSiret, boutiqueTva, boutiqueCity } = req.body || {};
  if (!boutiqueName || !boutiqueEmail || !boutiquePassword) {
    return res.status(400).json({ error: 'missing_fields', message: 'Nom, email et mot de passe requis.' });
  }

  try {
    // Unicité par email (consistent)
    const existingByEmail = await findShopByEmail(stripe, boutiqueEmail);
    if (existingByEmail) {
      // PROCÉDURE DE SECOURS : Si le client existe mais n'a pas de nom de boutique (metadata vide)
      // Cela arrive si la redirection post-paiement a échoué (bug 404 précédent).
      if (!existingByEmail.metadata?.boutiqueName) {
        console.log(`[saas] Client trouvé sans metadata pour ${boutiqueEmail}. Restauration...`);
        await stripe.customers.update(existingByEmail.id, {
          metadata: {
            boutiqueName,
            boutiqueNameLower: boutiqueName.toLowerCase(),
            boutiqueEmail,
            boutiquePassword,
            paidAt: new Date().toISOString() // On assume payé si le client existe (à vérifier via subs si besoin)
          }
        });
        return res.json({ 
          message: "Votre compte a été récupéré et mis à jour ! Vous pouvez maintenant vous connecter.",
          redirect: "/login" 
        });
      }

      console.log(`[saas] Création refusée: email déjà utilisé (${boutiqueEmail})`);
      return res.status(409).json({
        error: 'email_already_exists',
        message: 'Cet email est déjà associé à une boutique. Veuillez vous connecter.',
      });
    }

    // Unicité par nom (eventually consistent ~ 1 min)
    const existingByName = await findShopByName(stripe, boutiqueName);
    if (existingByName) {
      console.log(`[saas] Création refusée: nom déjà utilisé (${boutiqueName})`);
      return res.status(409).json({
        error: 'shop_already_exists',
        message: `Le nom de boutique "${boutiqueName}" est déjà utilisé. Choisissez-en un autre ou connectez-vous.`,
      });
    }

    const origin = req.headers.origin || `http://localhost:${config.port}`;
    console.log(`[saas] Création session Stripe pour ${boutiqueName} (Origin: ${origin})...`);
    
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
      metadata: {
        boutiqueName,
        boutiqueNameLower: boutiqueName.toLowerCase(),
        boutiqueEmail,
        boutiquePassword,
        boutiquePhone: boutiquePhone || '',
        boutiqueSiret: boutiqueSiret || '',
        boutiqueTva: boutiqueTva || '',
        boutiqueCity: boutiqueCity || '',
      },
      subscription_data: {
        metadata: {
          boutiqueName,
          boutiqueNameLower: boutiqueName.toLowerCase(),
          boutiqueEmail,
          boutiquePassword,
          boutiquePhone: boutiquePhone || '',
          boutiqueSiret: boutiqueSiret || '',
          boutiqueTva: boutiqueTva || '',
          boutiqueCity: boutiqueCity || '',
        },
      },
      mode: 'subscription',
      success_url: `${origin}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}?payment=cancelled`,
    });
    res.json({ url: session.url });
  } catch (error) {
    console.error('[saas] ERREUR STRIPE CHECKOUT:', error.message);
    res.status(500).json({ 
      error: 'stripe_error', 
      message: `Erreur Stripe : ${error.message}` 
    });
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
          boutiquePhone: meta.boutiquePhone || existing.metadata?.boutiquePhone || '',
          boutiqueSiret: meta.boutiqueSiret || existing.metadata?.boutiqueSiret || '',
          boutiqueTva: meta.boutiqueTva || existing.metadata?.boutiqueTva || '',
          boutiqueCity: meta.boutiqueCity || existing.metadata?.boutiqueCity || '',
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
                `→ Créez son compte Boutididact et envoyez-lui ses identifiants par e-mail.`,
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
            <p>Votre abonnement est activé. Vous recevrez très prochainement un second e-mail contenant vos identifiants Boutididact à renseigner dans la borne pour activer votre boutique.</p>
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
// CHECK SHOP : Vérifie si la boutique existe (utilisé par le relais)
// ============================================================
router.get('/check-shop', async (req, res) => {
  const stripe = getStripe();
  const { shopName } = req.query;
  if (!stripe || !shopName) return res.status(400).json({ ok: false });

  try {
    const shop = await findShopByName(stripe, shopName);
    if (shop && shop.metadata?.paidAt) {
      return res.json({ ok: true, name: shop.metadata.boutiqueName });
    }
    res.status(404).json({ ok: false, message: 'Boutique non trouvée ou non activée.' });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
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
    if (!customer) {
      console.log(`[saas] Login échoué: Boutique "${shopName}" introuvable dans Stripe.`);
      return res.status(401).json({ error: 'invalid_credentials', message: 'Nom de boutique inconnu ou abonnement non finalisé.' });
    }
    
    if (!customer.metadata || customer.metadata.boutiquePassword !== password) {
      console.log(`[saas] Login échoué: Mot de passe incorrect pour "${shopName}".`);
      return res.status(401).json({ error: 'invalid_credentials', message: 'Nom de boutique ou mot de passe invalide.' });
    }
    
    if (!customer.metadata.paidAt) {
      console.log(`[saas] Login échoué: Boutique "${shopName}" trouvée mais non payée.`);
      return res.status(403).json({ error: 'unpaid', message: 'Votre abonnement n\'est pas encore actif. Veuillez finaliser le paiement.' });
    }

    res.json({
      ok: true,
      shop: {
        id: customer.id,
        name: customer.metadata.boutiqueName,
        email: customer.metadata.boutiqueEmail || customer.email || '',
        city: customer.metadata.boutiqueCity || '',
        siret: customer.metadata.boutiqueSiret || '',
        tva: customer.metadata.boutiqueTva || '',
        settings: customer.metadata.shopSettings ? JSON.parse(customer.metadata.shopSettings) : null
      },
    });
  } catch (error) {
    console.error('[saas] login error:', error.message);
    res.status(500).json({ error: 'internal_error', message: `Erreur serveur : ${error.message}` });
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

  const { shopName, email, password } = req.body || {};
  if (!shopName || !email || !password) {
    return res.status(400).json({ error: 'missing_fields', message: 'Nom de boutique, email et mot de passe requis.' });
  }

  try {
    const customer = await findShopByName(stripe, shopName);
    const linkedEmail = (customer?.metadata?.boutiqueEmail || customer?.email || '').toLowerCase();
    if (!customer || linkedEmail !== email.trim().toLowerCase()) {
      return res.status(404).json({ error: 'not_found', message: 'Aucune boutique ne correspond à ce nom et cet email.' });
    }

    // Vérification du mot de passe
    if (!customer.metadata || customer.metadata.boutiquePassword !== password) {
      return res.status(401).json({ error: 'invalid_password', message: 'Mot de passe incorrect.' });
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
              `→ Pensez à supprimer le compte Boutididact associé.`,
      }).catch(e => console.error('[saas] mail admin delete:', e.message));
    }

    res.json({ ok: true, message: 'Boutique supprimée.' });
  } catch (error) {
    console.error('[saas] delete-account error:', error.message);
    res.status(500).json({ 
      error: 'internal_error', 
      message: `Erreur lors de la suppression : ${error.message}` 
    });
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

// ============================================================
// SETTINGS PERSISTENCE
// ============================================================

router.post('/save-settings', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(501).json({ error: 'stripe_not_configured' });

  const { shopId, shopName, settings } = req.body || {};
  if (!(shopId || shopName) || !settings) return res.status(400).json({ error: 'missing_data' });

  try {
    const customer = shopId ? await stripe.customers.retrieve(shopId) : await findShopByName(stripe, shopName);
    if (!customer || customer.deleted) return res.status(404).json({ error: 'shop_not_found' });

    await stripe.customers.update(customer.id, {
      metadata: {
        shopSettings: JSON.stringify(settings)
      }
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('[saas] save-settings:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/get-settings', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(501).json({ error: 'stripe_not_configured' });

  const { shopId, shopName } = req.query;
  if (!shopId && !shopName) return res.status(400).json({ error: 'missing_identifier' });

  try {
    const customer = shopId ? await stripe.customers.retrieve(shopId) : await findShopByName(stripe, shopName);
    if (!customer || customer.deleted) return res.status(404).json({ error: 'shop_not_found' });

    const settings = customer.metadata?.shopSettings ? JSON.parse(customer.metadata.shopSettings) : null;
    res.json({ ok: true, settings });
  } catch (e) {
    console.error('[saas] get-settings:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// RELAY MODE : Impression sans Ngrok (via file d'attente Stripe)
// ============================================================

// La tablette pousse le ticket ici
router.post('/push-ticket', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(501).json({ error: 'stripe_not_configured' });

  const { shopName, ticketData } = req.body || {};
  if (!shopName || !ticketData) return res.status(400).json({ error: 'missing_data' });

  try {
    const customer = await findShopByName(stripe, shopName);
    if (!customer) return res.status(404).json({ error: 'shop_not_found' });

    const fullJson = JSON.stringify(ticketData);
    const CHUNK_SIZE = 450; // On garde une marge sous les 500
    const chunks = {};
    
    // On nettoie les anciens morceaux d'abord
    const cleanMetadata = {};
    for(let i=1; i<=10; i++) cleanMetadata[`tk_${i}`] = '';
    
    // On découpe le nouveau ticket
    for (let i = 0; i < fullJson.length; i += CHUNK_SIZE) {
      const part = Math.floor(i / CHUNK_SIZE) + 1;
      if (part > 10) break; // Sécurité : max 10 morceaux (~4.5KB)
      chunks[`tk_${part}`] = fullJson.substring(i, i + CHUNK_SIZE);
    }

    await stripe.customers.update(customer.id, {
      metadata: { ...cleanMetadata, ...chunks, tk_count: Object.keys(chunks).length }
    });

    console.log(`[saas] Ticket mis en file d'attente pour ${shopName} (${fullJson.length} chars)`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[saas] push-ticket error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Le .exe vient chercher le ticket ici
router.get('/poll-ticket', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(501).json({ error: 'stripe_not_configured' });

  const { shopName } = req.query;
  if (!shopName) return res.status(400).json({ error: 'missing_shopName' });

  try {
    const customer = await findShopByName(stripe, shopName);
    if (!customer) return res.status(404).json({ error: 'shop_not_found' });

    const count = parseInt(customer.metadata?.tk_count || '0');
    if (count === 0) return res.json({ ticket: null });

    // Reconstitution du JSON
    let fullJson = '';
    for (let i = 1; i <= count; i++) {
      fullJson += (customer.metadata[`tk_${i}`] || '');
    }

    // On vide la file d'attente immédiatement
    const cleanMetadata = { tk_count: '0' };
    for(let i=1; i<=10; i++) cleanMetadata[`tk_${i}`] = '';
    await stripe.customers.update(customer.id, { metadata: cleanMetadata });

    res.json({ ticket: JSON.parse(fullJson) });
  } catch (e) {
    console.error('[saas] poll-ticket error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// ADMIN : Envoi des identifiants au client
// ============================================================
router.post('/send-setup-email', async (req, res) => {
  const { password, to, shopName, hiboutikAccount, hiboutikUser, hiboutikApiKey } = req.body || {};
  
  if (password !== config.adminPassword) {
    return res.status(401).json({ error: 'invalid_password', message: 'Mot de passe administrateur incorrect.' });
  }

  if (!to || !shopName || !hiboutikAccount || !hiboutikUser || !hiboutikApiKey) {
    return res.status(400).json({ error: 'missing_fields', message: 'Tous les champs sont requis.' });
  }

  if (!transporter) {
    return res.status(503).json({ error: 'email_not_configured', message: 'Service e-mail non configuré sur le serveur.' });
  }

  try {
    await transporter.sendMail({
      from: `"BOUTIDIDACT Support" <${process.env.SMTP_USER}>`,
      to,
      subject: `🗝️ Vos identifiants BOUTIDIDACT pour ${shopName}`,
      html: `
        <div style="font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
          <h2 style="color: #4f46e5;">Bonjour ${shopName},</h2>
          <p>Voici les identifiants à renseigner dans les <strong>Paramètres</strong> de votre borne Boutididact pour activer la synchronisation avec votre catalogue :</p>
          
          <div style="background: #f9fafb; padding: 15px; border-radius: 8px; border: 1px solid #e5e7eb; margin: 20px 0;">
            <p style="margin: 5px 0;"><strong>Compte :</strong> ${hiboutikAccount}</p>
            <p style="margin: 5px 0;"><strong>Utilisateur API :</strong> ${hiboutikUser}</p>
            <p style="margin: 5px 0;"><strong>Clé API :</strong> ${hiboutikApiKey}</p>
          </div>

          <p>Une fois ces informations saisies, n'oubliez pas de cliquer sur <strong>Enregistrer</strong>. Votre borne sera alors opérationnelle.</p>
          <p>L'équipe BOUTIDIDACT</p>
        </div>`,
    });

    res.json({ ok: true, message: 'E-mail envoyé avec succès.' });
  } catch (error) {
    console.error('[saas] send-setup-email:', error.message);
    res.status(500).json({ error: 'email_error', message: `Erreur lors de l'envoi : ${error.message}` });
  }
});

// ============================================================
// SUPER ADMIN : Liste et gestion des boutiques
// ============================================================

router.get('/list-shops', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(501).json({ error: 'stripe_not_configured' });

  const { password } = req.query;
  if (password !== config.adminPassword) {
    return res.status(401).json({ error: 'invalid_password', message: 'Mot de passe administrateur incorrect.' });
  }

  try {
    // Récupère tous les clients Stripe qui ont un boutiqueName
    const allCustomers = [];
    let hasMore = true;
    let startingAfter = undefined;
    
    while (hasMore) {
      const params = { limit: 100 };
      if (startingAfter) params.starting_after = startingAfter;
      const batch = await stripe.customers.list(params);
      
      for (const c of batch.data) {
        if (c.metadata?.boutiqueName) {
          allCustomers.push({
            id: c.id,
            name: c.metadata.boutiqueName,
            email: c.metadata.boutiqueEmail || c.email || '',
            phone: c.metadata.boutiquePhone || '',
            paidAt: c.metadata.paidAt || null,
            createdAt: new Date(c.created * 1000).toISOString(),
            notes: c.metadata.adminNotes || '',
            address: c.metadata.boutiqueAddress || '',
            city: c.metadata.boutiqueCity || '',
            siret: c.metadata.boutiqueSiret || '',
            tva: c.metadata.boutiqueTva || '',
          });
        }
      }
      
      hasMore = batch.has_more;
      if (batch.data.length > 0) startingAfter = batch.data[batch.data.length - 1].id;
    }

    console.log(`[saas] list-shops: ${allCustomers.length} boutiques trouvées`);
    res.json({ ok: true, shops: allCustomers });
  } catch (e) {
    console.error('[saas] list-shops:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/update-shop', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(501).json({ error: 'stripe_not_configured' });

  const { password, shopId, updates } = req.body || {};
  if (password !== config.adminPassword) {
    return res.status(401).json({ error: 'invalid_password' });
  }
  if (!shopId || !updates) {
    return res.status(400).json({ error: 'missing_data' });
  }

  try {
    const customer = await stripe.customers.retrieve(shopId);
    if (!customer || customer.deleted) return res.status(404).json({ error: 'shop_not_found' });

    const metadataUpdates = {};
    if (updates.phone !== undefined) metadataUpdates.boutiquePhone = updates.phone;
    if (updates.email !== undefined) metadataUpdates.boutiqueEmail = updates.email;
    if (updates.address !== undefined) metadataUpdates.boutiqueAddress = updates.address;
    if (updates.city !== undefined) metadataUpdates.boutiqueCity = updates.city;
    if (updates.siret !== undefined) metadataUpdates.boutiqueSiret = updates.siret;
    if (updates.tva !== undefined) metadataUpdates.boutiqueTva = updates.tva;
    if (updates.notes !== undefined) metadataUpdates.adminNotes = updates.notes;

    await stripe.customers.update(shopId, { metadata: metadataUpdates });

    console.log(`[saas] update-shop: ${customer.metadata.boutiqueName} mis à jour`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[saas] update-shop:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// CATALOG PERSISTENCE (Cloud sync for AI-imported catalog)
// ============================================================

router.post('/save-catalog', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(501).json({ error: 'stripe_not_configured' });

  const { shopId, shopName, products, categories, supplements } = req.body || {};
  if (!shopId && !shopName) return res.status(400).json({ error: 'missing_identifier' });

  try {
    const customer = shopId ? await stripe.customers.retrieve(shopId) : await findShopByName(stripe, shopName);
    if (!customer || customer.deleted) return res.status(404).json({ error: 'shop_not_found' });

    const catalogJson = JSON.stringify({ 
      products: products || [], 
      categories: categories || [],
      supplements: supplements || [] 
    });
    const CHUNK_SIZE = 450;
    const chunks = {};
    const cleanMetadata = {};
    for (let i = 1; i <= 20; i++) cleanMetadata[`cat_${i}`] = '';

    for (let i = 0; i < catalogJson.length; i += CHUNK_SIZE) {
      const part = Math.floor(i / CHUNK_SIZE) + 1;
      if (part > 20) break;
      chunks[`cat_${part}`] = catalogJson.substring(i, i + CHUNK_SIZE);
    }

    await stripe.customers.update(customer.id, {
      metadata: { ...cleanMetadata, ...chunks, cat_count: String(Object.keys(chunks).length) }
    });

    console.log(`[saas] Catalogue sauvegardé pour ${shopName} (${catalogJson.length} chars, ${Object.keys(chunks).length} chunks)`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[saas] save-catalog:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/get-catalog', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(501).json({ error: 'stripe_not_configured' });

  const { shopId, shopName } = req.query;
  if (!shopId && !shopName) return res.status(400).json({ error: 'missing_identifier' });

  try {
    const customer = shopId ? await stripe.customers.retrieve(shopId) : await findShopByName(stripe, shopName);
    if (!customer || customer.deleted) return res.status(404).json({ error: 'shop_not_found' });

    const count = parseInt(customer.metadata?.cat_count || '0');
    if (count === 0) return res.json({ products: [], categories: [] });

    let fullJson = '';
    for (let i = 1; i <= count; i++) {
      fullJson += (customer.metadata[`cat_${i}`] || '');
    }

    const catalog = JSON.parse(fullJson);
    console.log(`[saas] Catalogue récupéré pour ${shopName} (${(catalog.products || []).length} produits, ${(catalog.supplements || []).length} suppléments)`);
    res.json({ 
      products: catalog.products || [], 
      categories: catalog.categories || [],
      supplements: catalog.supplements || []
    });
  } catch (e) {
    console.error('[saas] get-catalog:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
