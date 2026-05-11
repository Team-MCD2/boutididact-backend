/**
 * BOUTIDIDACT — Backend-for-Frontend
 *  Pont sécurisé entre la borne tactile (frontend React) et :
 *    - l'API Hiboutik (HTTPS, Basic Auth)
 *    - l'imprimante ESC/POS (TCP/9100)
 *
 *  Endpoints :
 *    GET  /api/health
 *    GET  /api/hiboutik/products
 *    GET  /api/hiboutik/categories
 *    GET  /api/hiboutik/bootstrap
 *    POST /api/checkout
 *    POST /api/print          (legacy / test imprimante)
 */
const express = require('express');
const cors = require('cors');

const config = require('./config/env');
const healthRouter = require('./routes/health');
const hiboutikRouter = require('./routes/hiboutik');
const checkoutRouter = require('./routes/checkout');
const printRouter = require('./routes/print');

const app = express();

// ---- CORS ----
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // requêtes serveur-à-serveur
      if (config.corsOrigins.includes(origin)) return cb(null, true);
      // En dev on tolère localhost
      if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
      return cb(new Error(`CORS refusé : ${origin}`));
    },
    credentials: false,
  })
);

app.use(express.json({ limit: '256kb' }));

// ---- Logger minimal ----
app.use((req, _res, next) => {
  const t = new Date().toISOString();
  console.log(`[${t}] ${req.method} ${req.url}`);
  next();
});

// ---- Routes ----
app.use('/api/health', healthRouter);
app.use('/api/hiboutik', hiboutikRouter);
app.use('/api/checkout', checkoutRouter);
app.use('/api/print', printRouter);

// 404
app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.url }));

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

app.listen(config.port, () => {
  console.log('================================================');
  console.log(' BOUTIDIDACT BFF');
  console.log(`  - port               : ${config.port}`);
  console.log(`  - Hiboutik configuré : ${config.hiboutik.isConfigured ? 'oui' : 'NON'}`);
  if (config.hiboutik.isConfigured) {
    console.log(`  - Hiboutik compte    : ${config.hiboutik.account}`);
    console.log(`  - Store / Vendor     : ${config.hiboutik.storeId} / ${config.hiboutik.vendorId}`);
  }
  console.log(`  - Imprimante         : ${config.printer.ip}:${config.printer.port} (${config.printer.type})`);
  console.log(`  - Fallback offline   : ${config.allowOfflineFallback ? 'oui' : 'non'}`);
  console.log('================================================');
});
