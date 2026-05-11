/**
 * Chargement et validation centralisés de la configuration.
 * Toutes les variables sensibles transitent UNIQUEMENT côté serveur.
 */
require('dotenv').config();

const required = (key) => {
  const v = process.env[key];
  if (!v || v.trim() === '') {
    console.warn(`[config] Variable manquante : ${key} (mode dégradé possible).`);
    return '';
  }
  return v.trim();
};

const optional = (key, def = '') => (process.env[key] ?? def).toString().trim();
const toBool = (v) => /^(1|true|yes|on)$/i.test(String(v).trim());
const toInt = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

const config = {
  port: toInt(process.env.PORT, 3001),
  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:5173,http://localhost:4173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  hiboutik: {
    account: required('HIBOUTIK_ACCOUNT'),
    user: required('HIBOUTIK_USER'),
    apiKey: required('HIBOUTIK_API_KEY'),
    storeId: toInt(process.env.HIBOUTIK_STORE_ID, 1),
    vendorId: toInt(process.env.HIBOUTIK_VENDOR_ID, 1),
    defaultCustomerId: toInt(process.env.HIBOUTIK_DEFAULT_CUSTOMER_ID, 0),
    paymentCard: optional('HIBOUTIK_PAYMENT_CARD', 'CB'),
    paymentCash: optional('HIBOUTIK_PAYMENT_CASH', 'ESP'),
  },

  printer: {
    ip: optional('PRINTER_IP', '192.168.1.100'),
    port: toInt(process.env.PRINTER_PORT, 9100),
    type: optional('PRINTER_TYPE', 'EPSON').toUpperCase(),
    width: toInt(process.env.PRINTER_WIDTH, 42),
    openDrawer: toBool(process.env.PRINTER_OPEN_DRAWER),
  },

  shop: {
    name: optional('SHOP_NAME', 'BOUTIDIDACT'),
    address: optional('SHOP_ADDRESS', ''),
    siret: optional('SHOP_SIRET', ''),
    tva: optional('SHOP_TVA', ''),
    footer: optional('SHOP_FOOTER', 'Merci de votre visite !'),
  },

  allowOfflineFallback: toBool(process.env.ALLOW_OFFLINE_FALLBACK),
};

config.hiboutik.isConfigured = Boolean(
  config.hiboutik.account && config.hiboutik.user && config.hiboutik.apiKey
);

config.hiboutik.baseURL = config.hiboutik.account
  ? `https://${config.hiboutik.account}.hiboutik.com/api`
  : '';

module.exports = config;
