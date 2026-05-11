/**
 * Routes Hiboutik exposées au frontend (lecture seule).
 *  - On normalise les payloads pour l'UI borne.
 *  - On ne ré-expose JAMAIS la clé API.
 */
const express = require('express');
const hiboutik = require('../services/hiboutik');
const config = require('../config/env');

const router = express.Router();

const normalizeProduct = (p) => ({
  id: p.product_id ?? p.id,
  name: p.product_model ?? p.product_name ?? p.name ?? `Produit #${p.product_id}`,
  price: Number(p.product_price ?? p.price ?? 0),
  // Hiboutik renvoie souvent product_price = TTC quand le compte est en TTC
  priceWithTax: Number(p.product_price_ttc ?? p.product_price ?? p.price ?? 0),
  taxRate: Number(p.product_vat ?? p.tax_rate ?? 0),
  categoryId: p.category_id ?? p.product_category ?? null,
  stock: Number(p.stock_available ?? 0),
  available:
    p.product_disable !== 1 &&
    p.product_arch !== 1 &&
    p.product_supplier_reference !== 'ARCHIVE',
  raw: undefined, // on ne renvoie pas tout au client
});

const normalizeCategory = (c) => ({
  id: c.category_id ?? c.id,
  name: c.category_name ?? c.name ?? `Catégorie #${c.category_id}`,
  parentId: c.parent_category_id ?? null,
});

router.get('/products', async (req, res) => {
  if (!hiboutik.isConfigured()) {
    return res.status(503).json({
      error: 'hiboutik_not_configured',
      message: 'Renseignez HIBOUTIK_ACCOUNT / HIBOUTIK_USER / HIBOUTIK_API_KEY dans le .env',
    });
  }
  try {
    const products = await hiboutik.getProducts();
    const list = products.map(normalizeProduct).filter((p) => p.available && p.id);
    res.json({ count: list.length, items: list });
  } catch (e) {
    console.error('[hiboutik/products]', e.response?.status, e.response?.data || e.message);
    res.status(502).json({
      error: 'hiboutik_unreachable',
      status: e.response?.status,
      message: e.message,
    });
  }
});

router.get('/categories', async (req, res) => {
  if (!hiboutik.isConfigured()) {
    return res.status(503).json({ error: 'hiboutik_not_configured' });
  }
  try {
    const cats = await hiboutik.getCategories();
    res.json({ count: cats.length, items: cats.map(normalizeCategory) });
  } catch (e) {
    console.error('[hiboutik/categories]', e.message);
    res.status(502).json({ error: 'hiboutik_unreachable', message: e.message });
  }
});

router.get('/bootstrap', async (req, res) => {
  if (!hiboutik.isConfigured()) {
    return res.status(503).json({ error: 'hiboutik_not_configured' });
  }
  try {
    const [stores, users, paymentTypes] = await Promise.all([
      hiboutik.getStores(),
      hiboutik.getUsers(),
      hiboutik.getPaymentTypes(config.hiboutik.storeId).catch(() => []),
    ]);
    res.json({
      stores,
      users, // Hiboutik utilise /users (et non /vendors)
      vendors: users, // alias
      paymentTypes,
      defaults: {
        storeId: config.hiboutik.storeId,
        vendorId: config.hiboutik.vendorId,
        customerId: config.hiboutik.defaultCustomerId,
        paymentCard: config.hiboutik.paymentCard,
        paymentCash: config.hiboutik.paymentCash,
      },
    });
  } catch (e) {
    res.status(502).json({ error: 'hiboutik_unreachable', message: e.message });
  }
});

/** Codes paiement actifs sur le store : ['CB', 'ESP', 'CHE', 'TR', ...] */
router.get('/payment_types', async (req, res) => {
  if (!hiboutik.isConfigured()) return res.status(503).json({ error: 'hiboutik_not_configured' });
  try {
    const list = await hiboutik.getPaymentTypes(config.hiboutik.storeId);
    res.json({ items: list });
  } catch (e) {
    res.status(502).json({ error: 'hiboutik_unreachable', message: e.message });
  }
});

/**
 * Proxy image produit. Renvoie 204 si Hiboutik n'a aucune image pour ce produit
 * (le frontend affichera alors l'emoji de fallback).
 *  Cache 1h côté navigateur pour éviter de re-frapper Hiboutik à chaque render.
 */
router.get('/products/:id/image', async (req, res) => {
  if (!hiboutik.isConfigured()) return res.status(503).end();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).end();
  try {
    const img = await hiboutik.getProductImageBinary(id);
    if (!img) {
      res.set('Cache-Control', 'public, max-age=300');
      return res.status(204).end();
    }
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('Content-Type', img.contentType);
    return res.send(img.buffer);
  } catch (e) {
    console.warn(`[hiboutik/image/${id}]`, e.response?.status, e.message);
    return res.status(502).end();
  }
});

module.exports = router;
