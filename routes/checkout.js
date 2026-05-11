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
  for (const it of items) {
    if (!it || typeof it !== 'object') {
      return res.status(400).json({ error: 'invalid_item' });
    }
    if (!it.productId && !it.id) {
      return res.status(400).json({ error: 'missing_product_id', item: it });
    }
    if (!Number.isFinite(Number(it.price)) || Number(it.price) < 0) {
      return res.status(400).json({ error: 'invalid_price', item: it });
    }
    if (!Number.isInteger(Number(it.quantity)) || Number(it.quantity) <= 0) {
      return res.status(400).json({ error: 'invalid_quantity', item: it });
    }
  }

  const total = items.reduce((s, it) => s + Number(it.price) * Number(it.quantity), 0);
  const totalRounded = Number(total.toFixed(2));
  const paymentLabel = PAYMENT_LABELS[paymentMethod] || PAYMENT_LABELS.card;
  const paymentCode = resolvePaymentCode(paymentMethod);

  let saleId = null;
  const warnings = [];
  let stage = null;

  // ---- 1-4 : Hiboutik ----
  const useHiboutik = !skipHiboutik && hiboutik.isConfigured();
  if (useHiboutik) {
    try {
      // 1. Création
      stage = 'create';
      const created = await hiboutik.createSale({ vendorId, storeId, customerId });
      saleId = created.saleId;

      // 2. Ajout des items
      stage = 'add_items';
      for (const it of items) {
        // Hiboutik ajoute par "quantity" mais addItem ajoute UN appel par produit
        // (ESC les lignes seront groupées par product_id automatiquement côté Hiboutik).
        await hiboutik.addItem(saleId, {
          productId: Number(it.productId ?? it.id),
          quantity: Number(it.quantity),
        });
      }

      // 3. Paiement (PUT sale_attribute=payment)
      stage = 'payment';
      await hiboutik.recordPayment(saleId, { payment: paymentCode });

      // 4. Clôture
      stage = 'close';
      await hiboutik.closeSale(saleId);
    } catch (e) {
      console.error(
        `[checkout/hiboutik] stage=${stage} saleId=${saleId} :`,
        e.hiboutik || e.message
      );
      // rollback best-effort
      if (saleId) await hiboutik.cancelSale(saleId);

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
  } else if (!hiboutik.isConfigured() && !config.allowOfflineFallback) {
    return res.status(503).json({
      error: 'hiboutik_not_configured',
      message: 'Hiboutik non configuré et fallback offline désactivé.',
    });
  } else {
    warnings.push({ code: 'hiboutik_skipped' });
  }

  // ---- 5 : Impression ----
  const ticketId = `T-${Date.now().toString(36).toUpperCase()}`;
  const taxBreakdown = computeTaxBreakdown(items);

  const printerOnline = await printer.checkOnline();
  if (!printerOnline) {
    return res.status(207).json({
      success: true,
      saleId,
      ticketId,
      printed: false,
      warnings: [...warnings, { code: 'printer_offline', message: 'Imprimante injoignable.' }],
      total: totalRounded,
    });
  }

  try {
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
    });
  } catch (e) {
    console.error('[checkout/print]', e.message);
    return res.status(207).json({
      success: true,
      saleId,
      ticketId,
      printed: false,
      warnings: [...warnings, { code: 'print_failed', message: e.message }],
      total: totalRounded,
    });
  }

  res.json({
    success: true,
    saleId,
    ticketId,
    printed: true,
    warnings,
    total: totalRounded,
  });
});

module.exports = router;
