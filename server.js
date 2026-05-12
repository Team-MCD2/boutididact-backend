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
const saasRouter = require('./routes/saas');

const app = express();

// ---- CORS ----
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || config.corsOrigins.includes('*')) return cb(null, true);
      if (config.corsOrigins.includes(origin)) return cb(null, true);
      if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
      // Autoriser les domaines vercel.app
      if (origin.endsWith('.vercel.app')) return cb(null, true);
      return cb(new Error(`CORS refusé : ${origin}`));
    },
    credentials: false,
  })
);

app.use(express.json({ limit: '10mb' }));

// ---- Multi-tenant Auth Middleware ----
app.use((req, res, next) => {
  const account = req.headers['x-hiboutik-account'];
  const user = req.headers['x-hiboutik-user'];
  const apiKey = req.headers['x-hiboutik-api-key'];
  const storeId = req.headers['x-hiboutik-store-id'];
  const vendorId = req.headers['x-hiboutik-vendor-id'];

  if (account && user && apiKey) {
    req.hiboutikAuth = { 
      account, 
      user, 
      apiKey,
      storeId: storeId || config.hiboutik.storeId,
      vendorId: vendorId || config.hiboutik.vendorId
    };
  }

  // Shop Mentions Overrides
  req.shopOverrides = {
    name: req.headers['x-shop-name'],
    address: req.headers['x-shop-address'],
    siret: req.headers['x-shop-siret'],
    tva: req.headers['x-shop-tva'],
  };

  // Printer Overrides
  const pIp = req.headers['x-printer-ip'];
  const pPort = req.headers['x-printer-port'];
  if (pIp) {
    req.printerAuth = { ip: pIp, port: pPort || '9100' };
  }

  next();
});

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
app.use('/api/saas', saasRouter);

// 404
app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.url }));

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
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
}

module.exports = app;
