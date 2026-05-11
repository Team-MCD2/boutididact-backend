/**
 * /api/print : route legacy d'impression directe (utile pour tester l'imprimante).
 *  Le flux nominal de la borne passe par /api/checkout.
 */
const express = require('express');
const printer = require('../services/printer');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { items = [], total, paiement, ticketId, printerIp } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'empty_items' });
    }

    const online = await printer.checkOnline(printerIp);
    if (!online) {
      return res.status(503).json({ error: "L'imprimante est hors ligne ou injoignable." });
    }

    await printer.printTicket({
      ticketId: ticketId || `T-${Date.now().toString(36).toUpperCase()}`,
      items,
      total,
      payment: paiement || 'Espèces',
      printerIp,
    });

    res.json({ success: true });
  } catch (e) {
    console.error('[print]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
