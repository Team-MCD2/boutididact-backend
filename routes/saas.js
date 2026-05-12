const express = require('express');
const Stripe = require('stripe');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config/env');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 465,
  secure: process.env.SMTP_PORT == 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const router = express.Router();
const PREMIUM_FILE = path.join(__dirname, '../../.premium_status');

// Helper pour savoir si on est premium
const isPremium = (req) => {
  // Sur Vercel (Sans DB), on considère premium si le client envoie ses propres clés Hiboutik
  // OU si le fichier local existe (legacy/dev)
  const hasLocalFile = fs.existsSync(PREMIUM_FILE);
  const hasClientKeys = req?.hiboutikAuth?.account && req?.hiboutikAuth?.apiKey;
  return hasLocalFile || !!hasClientKeys;
};

// ---- STATUS ----
router.get('/status', (req, res) => {
  res.json({ isPremium: isPremium(req) });
});

// ---- STRIPE ----
router.post('/stripe-checkout', async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(501).json({ error: 'stripe_not_configured', message: 'Clé Stripe manquante sur le serveur.' });
  }

  const { boutiqueName, boutiqueEmail, boutiquePassword } = req.body;
  if (!boutiqueEmail) return res.status(400).json({ error: 'missing_email' });

  const stripe = new Stripe(stripeKey);
  try {
    // 1. Vérifier par Email
    const existingCustomers = await stripe.customers.list({ email: boutiqueEmail, limit: 1 });
    if (existingCustomers.data.length > 0) {
      return res.status(400).json({ 
        error: 'email_already_exists', 
        message: 'Cet email est déjà associé à un compte BOUTIDIDACT. Veuillez utiliser la connexion ou un autre email.' 
      });
    }

    // 2. Vérifier par Nom de boutique (via recherche dans les métadonnées)
    if (boutiqueName) {
      const boutiqueSearch = await stripe.customers.search({
        query: `metadata['boutiqueName']:'${boutiqueName}'`,
        limit: 1
      });
      if (boutiqueSearch.data.length > 0) {
        return res.status(400).json({ 
          error: 'boutique_already_exists', 
          message: `Le nom de boutique "${boutiqueName}" est déjà utilisé. Veuillez en choisir un autre.` 
        });
      }
    }

    const origin = req.headers.origin || `http://localhost:${config.port}`;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: boutiqueEmail, // Pré-remplir l'email
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: 'Abonnement BOUTIDIDACT - Caisse Enregistreuse',
              description: `Activation pour : ${boutiqueName || 'Nouvelle Boutique'}`,
            },
            unit_amount: 4999,
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ],
      metadata: {
        boutiqueName: boutiqueName || '',
        boutiqueEmail: boutiqueEmail || '',
        boutiquePassword: boutiquePassword || '',
      },
      mode: 'subscription',
      success_url: `${origin}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}?payment=cancelled`,
    });
    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---- IA MENU EXTRACTION ----
router.post('/extract-menu', async (req, res) => {
  // Sécurité Serveur : Vérifier l'abonnement
  if (!isPremium(req)) {
    return res.status(403).json({ error: 'premium_required', message: 'Cette fonctionnalité nécessite un abonnement actif.' });
  }

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
          {
            inline_data: {
              mime_type: mimeType,
              data: imageBase64.split(',')[1] || imageBase64
            }
          }
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

// ---- VERIFY SUBSCRIPTION ----
router.get('/verify-subscription', async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(501).json({ error: 'stripe_not_configured' });

  const stripe = new Stripe(stripeKey);
  const { session_id } = req.query;

  if (!session_id) {
    return res.status(400).json({ error: 'missing_session_id' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status === 'paid') {
      // Activer le mode premium sur le serveur
      fs.writeFileSync(PREMIUM_FILE, JSON.stringify({
        activatedAt: new Date().toISOString(),
        customer: session.customer,
        subscription: session.subscription,
        boutique: session.metadata
      }));

      // 1. Envoyer l'email de notification à l'admin
      if (process.env.ADMIN_EMAIL_RECEIVER && process.env.SMTP_USER) {
        const adminMailOptions = {
          from: `"BOUTIDIDACT System" <${process.env.SMTP_USER}>`,
          to: process.env.ADMIN_EMAIL_RECEIVER,
          subject: '🔔 NOUVEAU CLIENT BOUTIDIDACT',
          text: `Un nouveau client vient de payer son abonnement !\n\n` +
                `Nom Boutique : ${session.metadata.boutiqueName}\n` +
                `Email Boutique : ${session.metadata.boutiqueEmail}\n` +
                `Veuillez générer ses accès Hiboutik et lui envoyer par mail.`,
        };
        transporter.sendMail(adminMailOptions).catch(e => console.error('Erreur envoi mail notification admin:', e));
      }

      // 2. Envoyer l'email de bienvenue au client
      if (session.metadata.boutiqueEmail && process.env.SMTP_USER) {
        const clientMailOptions = {
          from: `"BOUTIDIDACT Team" <${process.env.SMTP_USER}>`,
          to: session.metadata.boutiqueEmail,
          subject: '🚀 Bienvenue chez BOUTIDIDACT !',
          html: `
            <div style="font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
              <h2 style="color: #4f46e5;">Bienvenue, ${session.metadata.boutiqueName} !</h2>
              <p>Votre abonnement a été activé avec succès. Nous sommes ravis de vous compter parmi nous.</p>
              <p><strong>Prochaines étapes :</strong></p>
              <ol>
                <li>Nos équipes préparent vos accès API Hiboutik personnalisés.</li>
                <li>Vous recevrez un second e-mail d'ici quelques heures avec vos identifiants de connexion.</li>
                <li>Une fois reçus, rendez-vous dans l'onglet <strong>Paramètres</strong> de votre borne pour les configurer.</li>
              </ol>
              <p>À très vite,<br>L'équipe BOUTIDIDACT</p>
            </div>
          `,
        };
        transporter.sendMail(clientMailOptions).catch(e => console.error('Erreur envoi mail bienvenue client:', e));
      }
      
      res.json({ status: 'premium', customer: session.customer });
    } else {
      res.json({ status: 'unpaid' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;


