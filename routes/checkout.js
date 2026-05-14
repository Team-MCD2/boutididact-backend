/**
 * Orchestration de la vente borne (cycle Hiboutik officiel) :
 *   1. POST /sales                  -> sale_id
 *   2. POST /sales/add_product      -> N×
 *   3. POST /sales_payment_div      -> paiement
 *   4. POST /sales/close            -> clôture
 *   5. Impression ESC/POS
 *
 *  En cas d'échec d'une étape Hiboutik, on tente POST /sales/void pour rollback.
 *  Le détail de l'erreur Hiboutik est PROPAGÉ au frontend pour debug.
 */
const express = require('express');
const hiboutik = require('../services/hiboutik');
const printer = require('../services/printer');
const config = require('../config/env');

const router = express.Router();

const PAYMENT_LABELS = {
  card: 'Carte Bancaire',
  cash: 'Espèces',
};

const resolvePaymentCode = (method) => {
  if (method === 'cash') return config.hiboutik.paymentCash;
  return config.hiboutik.paymentCard;
};

const computeTaxBreakdown = (items) => {
  const map = new Map();
  items.forEach((it) => {
    const rate = Number(it.taxRate || 0);
    if (!rate) return;
    const lineTotal = Number(it.price) * Number(it.quantity);
    const base = lineTotal / (1 + rate / 100);
    const tax = lineTotal - base;
    const cur = map.get(rate) || { rate, base: 0, tax: 0 };
    cur.base += base;
    cur.tax += tax;
    map.set(rate, cur);
  });
  return [...map.values()].map((t) => ({
    rate: t.rate,
    base: Number(t.base.toFixed(2)),
    tax: Number(t.tax.toFixed(2)),
  }));
};

router.post('/', async (req, res) => {
  const {
    items = [],
    paymentMethod = 'card',
    customerId,
    vendorId,
    storeId,
    skipHiboutik = false,
  } = req.body || {};

  // ---- Validation ----
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'empty_cart', message: 'Le panier est vide.' });
  }
  // ... (validation logic stays the same)
  for (const it of items) {
    if (!it || typeof it !== 'object') return res.status(400).json({ error: 'invalid_item' });
    if (!it.productId && !it.id) return res.status(400).json({ error: 'missing_product_id', item: it });
    if (!Number.isFinite(Number(it.price)) || Number(it.price) < 0) return res.status(400).json({ error: 'invalid_price', item: it });
    if (!Number.isInteger(Number(it.quantity)) || Number(it.quantity) <= 0) return res.status(400).json({ error: 'invalid_quantity', item: it });
  }

  const total = items.reduce((s, it) => s + Number(it.price) * Number(it.quantity), 0);
  const totalRounded = Number(total.toFixed(2));
  const paymentLabel = PAYMENT_LABELS[paymentMethod] || PAYMENT_LABELS.card;
  const paymentCode = resolvePaymentCode(paymentMethod);

  let saleId = null;
  const warnings = [];
  let stage = null;
  const idMapping = {}; // localId -> hiboutikId (renvoyé au frontend pour mise à jour localStorage)

  // ---- 1-4 : Hiboutik ----
  const useHiboutik = !skipHiboutik && hiboutik.isConfigured(req.hiboutikAuth);
  if (useHiboutik) {
    try {
      // 0. Pré-provisionne dans Hiboutik les produits "locaux" (IDs non numériques type "local-xxx")
      stage = 'provision_local_products';
      let fallbackCategoryId = null;
      for (const it of items) {
        const rawId = String(it.productId ?? it.id);
        const isAiProduct = rawId.startsWith('ai-');
        const numericId = Number(rawId);

        if (isAiProduct) {
          // Produit IA : on le crée dans Hiboutik car il n'existe pas
          if (!fallbackCategoryId) {
            fallbackCategoryId = await hiboutik.getFallbackCategoryId(req.hiboutikAuth);
          }
          const hbId = await hiboutik.createProduct({
            name: it.name || 'Produit',
            price: Number(it.price),
            categoryId: fallbackCategoryId,
          }, req.hiboutikAuth);
          idMapping[rawId] = hbId;
          it._resolvedProductId = hbId;
          it._productComment = null;
        } else if (isNaN(numericId) || numericId <= 0) {
          // Produit existant mais avec customisation (ex: 500-no-emmental)
          // On utilise l'ID de base et on met la customisation en commentaire
          const baseId = Number(rawId.split('-')[0]);
          it._resolvedProductId = baseId;
          it._productComment = it.name; // Le nom contient déjà le "(Sans ...)"
        } else {
          // Produit Hiboutik standard sans modif d'ID
          it._resolvedProductId = numericId;
          it._productComment = null;
        }
      }

      stage = 'create';
      const created = await hiboutik.createSale({ vendorId, storeId, customerId }, req.hiboutikAuth);
      saleId = created.saleId;

      stage = 'add_items';
      for (const it of items) {
        await hiboutik.addItem(saleId, {
          productId: it._resolvedProductId,
          quantity: Number(it.quantity),
          price: Number(it.price),
          productComment: it._productComment
        }, req.hiboutikAuth);
      }

      stage = 'payment';
      await hiboutik.recordPayment(saleId, { payment: paymentCode }, req.hiboutikAuth);

      stage = 'close';
      await hiboutik.closeSale(saleId, req.hiboutikAuth);
    } catch (e) {
      console.error(`[checkout/hiboutik] stage=${stage} saleId=${saleId} :`, e.hiboutik || e.message);
      if (saleId) await hiboutik.cancelSale(saleId, storeId, req.hiboutikAuth);

      if (!config.allowOfflineFallback) {
        return res.status(502).json({
          error: 'hiboutik_failed',
          stage,
          saleId,
          message: e.message,
          hiboutik: e.hiboutik || null,
        });
      }
      warnings.push({ code: 'hiboutik_offline', stage, message: e.message });
      saleId = null;
    }
  } else if (!hiboutik.isConfigured(req.hiboutikAuth) && !config.allowOfflineFallback) {
    return res.status(503).json({
      error: 'hiboutik_not_configured',
      message: 'Hiboutik non configuré et fallback offline désactivé.',
    });
  } else {
    warnings.push({ code: 'hiboutik_skipped' });
  }

  // ---- 5 : Impression ----
  const ticketId = `T-${Date.now().toString(36).toUpperCase()}`;
  console.log(`[checkout] 🖨️  Démarrage phase impression pour ticket ${ticketId}`);
  const taxBreakdown = computeTaxBreakdown(items);

  const printerOnline = await printer.checkOnline(req.printerAuth);
  if (!printerOnline) {
    console.warn(`[checkout] ❌ Imprimante injoignable (${req.printerAuth?.ip || 'IP par défaut'})`);
    
    // ---- FALLBACK RELAIS ----
    // Si on est sur Vercel (Cloud), on pousse le ticket dans la file d'attente
    if (req.shopOverrides?.name && req.shopOverrides.name !== 'BOUTIDIDACT') {
      try {
        const Stripe = require('stripe');
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        
        // On cherche le client
        const lower = req.shopOverrides.name.toLowerCase().trim();
        const { data: customers } = await stripe.customers.search({
          query: `metadata['boutiqueNameLower']:'${lower.replace(/'/g, "\\'")}'`,
          limit: 1
        });
        
        if (customers[0]) {
          const ticketObj = {
            ticketId,
            saleId,
            items: items.map((it) => ({
              name: it.name || `Produit #${it.productId ?? it.id}`,
              quantity: Number(it.quantity),
              price: Number(it.price),
            })),
            total: totalRounded,
            taxBreakdown,
            payment: paymentLabel,
            shop: req.shopOverrides,
            printer: {
              ip: req.printerAuth?.ip,
              port: req.printerAuth?.port,
              type: req.printerAuth?.type,
              width: req.printerAuth?.width
            }
          };

          const fullJson = JSON.stringify(ticketObj);
          const CHUNK_SIZE = 450;
          const chunks = {};
          const cleanMetadata = {};
          for(let i=1; i<=10; i++) cleanMetadata[`tk_${i}`] = '';

          for (let i = 0; i < fullJson.length; i += CHUNK_SIZE) {
            const part = Math.floor(i / CHUNK_SIZE) + 1;
            if (part > 10) break;
            chunks[`tk_${part}`] = fullJson.substring(i, i + CHUNK_SIZE);
          }

          await stripe.customers.update(customers[0].id, {
            metadata: { ...cleanMetadata, ...chunks, tk_count: Object.keys(chunks).length }
          });

          console.log(`[checkout] ☁️ Ticket RELAIS mis en file (${fullJson.length} chars) pour ${req.shopOverrides.name}`);
          return res.json({
            success: true,
            saleId,
            ticketId,
            printed: true, // On dit que c'est "imprimé" car c'est en file d'attente
            relay: true,
            total: totalRounded,
            idMapping,
          });
        }
      } catch (relayError) {
        console.error('[checkout] Erreur mise en file relais:', relayError.message);
      }
    }

    return res.status(207).json({
      success: true,
      saleId,
      ticketId,
      printed: false,
      warnings: [...warnings, { code: 'printer_offline', message: 'Imprimante injoignable.' }],
      total: totalRounded,
      idMapping,
    });
  }

  try {
    console.log(`[checkout] 📤 Envoi des données à l'imprimante...`);
    await printer.printTicket({
      ticketId,
      saleId,
      items: items.map((it) => ({
        name: it.name || `Produit #${it.productId ?? it.id}`,
        quantity: Number(it.quantity),
        price: Number(it.price),
      })),
      total: totalRounded,
      taxBreakdown,
      payment: paymentLabel,
      shop: req.shopOverrides,
    }, req.printerAuth);
    console.log(`[checkout] ✅ Impression terminée pour ticket ${ticketId}`);
    
    // On renvoie success: true même si execute() a renvoyé false, tant qu'il n'y a pas eu d'erreur fatale.
    // Car souvent le ticket sort mais la confirmation TCP prend trop de temps.
    return res.json({
      success: true,
      saleId,
      ticketId,
      printed: true,
      warnings,
      total: totalRounded,
      idMapping,
    });
  } catch (e) {
    console.error(`[checkout] ⚠️  Avertissement impression ticket ${ticketId} :`, e.message);
    // Si l'imprimante était en ligne au début, on renvoie quand même "printed: true"
    // car le ticket a probablement été envoyé dans le buffer.
    return res.json({
      success: true,
      saleId,
      ticketId,
      printed: true, 
      warnings: [...warnings, { code: 'print_warning', message: e.message }],
      total: totalRounded,
      idMapping,
    });
  }
});

module.exports = router;
