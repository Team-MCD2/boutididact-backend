/**
 * /api/health : état détaillé du BFF (Hiboutik + imprimante).
 *  Utilisé par la borne pour afficher un voyant "Système OK".
 */
const express = require('express');
const hiboutik = require('../services/hiboutik');
const printer = require('../services/printer');
const config = require('../config/env');

const router = express.Router();

router.get('/', async (req, res) => {
  const [hiboutikStatus, rawPrinterOnline] = await Promise.all([
    hiboutik.ping(req.hiboutikAuth),
    printer.checkOnline(req.printerAuth),
  ]);

  // Si on est sur Vercel (Cloud) et qu'on a un nom de boutique, 
  // on considère l'imprimante "OK (Relais)" sans tester l'IP locale.
  const isVercel = !!process.env.VERCEL;
  const isRelay = isVercel && req.shopOverrides?.name;
  const printerOnline = isRelay ? true : rawPrinterOnline;

  const ok = hiboutikStatus.ok && printerOnline;

  res.status(ok ? 200 : 207).json({
    ok,
    timestamp: new Date().toISOString(),
    hiboutik: {
      configured: hiboutik.isConfigured(req.hiboutikAuth),
      reachable: hiboutikStatus.ok,
      reason: hiboutikStatus.reason ?? null,
      account: req.hiboutikAuth?.account || config.hiboutik.account || null,
    },
    printer: {
      ip: req.printerAuth?.ip || config.printer.ip,
      port: req.printerAuth?.port || config.printer.port,
      online: printerOnline,
    },
    shop: {
      name: req.shopOverrides?.name || config.shop.name,
      siret: req.shopOverrides?.siret || config.shop.siret || null,
    },
    fallback: { offlineAllowed: config.allowOfflineFallback },
  });
});

module.exports = router;
