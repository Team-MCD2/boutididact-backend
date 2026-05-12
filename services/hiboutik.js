/**
 * Client API Hiboutik (REST officiel).
 *  Doc OpenAPI : https://demoapi.hiboutik.com/docapi/yaml/
 *  Auth : HTTP Basic (e-mail Hiboutik + clé API)
 *
 *  Endpoints réels utilisés pour le cycle de vente :
 *    POST /sales                         -> création vente (body { vendor_id, store_id, customer_id, currency_code })
 *    POST /sales/add_product             -> ajout d'un produit  (body { sale_id, product_id, quantity, ... })
 *    POST /sales_payment_div             -> ajout d'un paiement (body { sale_id, payment_type, payment_amount })
 *    POST /sales/close                   -> clôture vente       (body { sale_id })
 *    POST /sales/void                    -> annulation vente    (body { sale_id, store_id })
 *    GET  /payment_types/{store_id}      -> codes paiement valides
 *    GET  /products_images/{product_id}  -> liste des images d'un produit (renvoie [] si aucune)
 */
const axios = require('axios');
const config = require('../config/env');

// Cache mémoire des size_id par product_id (reset via reload())
const sizeCache = new Map();

// Normalise une erreur Axios -> { status, message, data } pour propagation côté frontend.
const formatError = (e) => {
  const status = e?.response?.status || e?.code || 'network_error';
  const data = e?.response?.data;
  let message = e?.message || 'Erreur inconnue';
  if (data) {
    if (typeof data === 'string') {
      message = data;
    } else if (data.error_description) {
      message = data.error_description;
    } else if (data.message) {
      message = data.message;
    } else if (data.error) {
      message = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    } else {
      try { message = JSON.stringify(data); } catch { /* ignore */ }
    }
  }
  return { status, message, data };
};

const buildClient = (overrides = null) => {
  const account = overrides?.account || config.hiboutik.account;
  const user = overrides?.user || config.hiboutik.user;
  const apiKey = overrides?.apiKey || config.hiboutik.apiKey;
  const baseURL = account ? `https://${account}.hiboutik.com/api` : config.hiboutik.baseURL;

  if (!account || !user || !apiKey) return null;

  return axios.create({
    baseURL,
    timeout: 10_000,
    auth: {
      username: user,
      password: apiKey,
    },
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'BOUTIDIDACT-BFF/2.1',
    },
  });
};

/** Vérifie la disponibilité de l'API. */
const ping = async (auth = null) => {
  const client = buildClient(auth);
  if (!client) return { ok: false, reason: 'not_configured' };
  try {
    const { status } = await client.get('/stores', { timeout: 5_000 });
    return { ok: status >= 200 && status < 300 };
  } catch (e) {
    return { ok: false, reason: e.response?.status || e.code || 'network_error' };
  }
};

const getProducts = async (auth = null) => {
  const client = buildClient(auth);
  if (!client) throw new Error('Hiboutik non configuré');
  const { data } = await client.get('/products');
  return Array.isArray(data) ? data : [];
};

const getCategories = async (auth = null) => {
  const client = buildClient(auth);
  if (!client) throw new Error('Hiboutik non configuré');
  const { data } = await client.get('/categories');
  return Array.isArray(data) ? data : [];
};

const getStores = async (auth = null) => {
  const client = buildClient(auth);
  if (!client) throw new Error('Hiboutik non configuré');
  const { data } = await client.get('/stores');
  return Array.isArray(data) ? data : [];
};

const getUsers = async (auth = null) => {
  const client = buildClient(auth);
  if (!client) throw new Error('Hiboutik non configuré');
  const { data } = await client.get('/users');
  return Array.isArray(data) ? data : [];
};

const getPaymentTypes = async (storeId, auth = null) => {
  const client = buildClient(auth);
  if (!client) throw new Error('Hiboutik non configuré');
  const targetId = storeId || config.hiboutik.storeId;
  const { data } = await client.get(`/payment_types/${targetId}`);
  return Array.isArray(data) ? data : [];
};

const resolveSizeId = async (productId, auth = null) => {
  if (sizeCache.has(productId)) return sizeCache.get(productId);
  const client = buildClient(auth);
  if (!client) return 0;

  try {
    const { data: prodRaw } = await client.get(`/products/${productId}`);
    const product = Array.isArray(prodRaw) ? prodRaw[0] : prodRaw;
    const sizeType = Number(
      product?.product_size_type ?? product?.size_type ?? product?.size_type_id ?? 0
    ) || 0;

    if (!sizeType) {
      sizeCache.set(productId, 0);
      return 0;
    }

    const { data: sizesRaw } = await client.get(`/sizes/${sizeType}`);
    const list = Array.isArray(sizesRaw) ? sizesRaw : [];
    if (!list.length) {
      sizeCache.set(productId, 0);
      return 0;
    }

    const first = list[0] || {};
    const sizeId = Number(first.size_id ?? first.id ?? 0) || 0;
    sizeCache.set(productId, sizeId);
    return sizeId;
  } catch (e) {
    return 0;
  }
};

const getProductImages = async (productId, auth = null) => {
  const client = buildClient(auth);
  if (!client) throw new Error('Hiboutik non configuré');
  const { data } = await client.get(`/products_images/${productId}`);
  return Array.isArray(data) ? data : [];
};

const getProductImageBinary = async (productId, auth = null) => {
  const client = buildClient(auth);
  const images = await getProductImages(productId, auth);
  if (!images.length || !client) return null;
  const first = images[0];
  const fileName = typeof first === 'string' ? first : first.image_name || first.file_name || first.url || first.image_url || null;
  if (!fileName) return null;
  const url = /^https?:\/\//i.test(fileName) ? fileName : `${client.defaults.baseURL.replace(/\/api$/, '')}/products_images/${fileName}`;
  const r = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 8000,
    auth: client.defaults.auth,
  });
  return { contentType: r.headers['content-type'] || 'image/jpeg', buffer: Buffer.from(r.data) };
};

// Cache du tax_id par défaut Hiboutik (reset via reload())
let defaultTaxIdCache = null;

const getTaxes = async (auth = null) => {
  const client = buildClient(auth);
  if (!client) throw new Error('Hiboutik non configuré');
  const { data } = await client.get('/taxes');
  return Array.isArray(data) ? data : [];
};

// Résout le tax_id par défaut du compte Hiboutik (product_vat attend un ID, pas un %).
const getDefaultTaxId = async (auth = null) => {
  if (defaultTaxIdCache !== null) return defaultTaxIdCache;
  try {
    const taxes = await getTaxes(auth);
    // Cherche la taxe par défaut, sinon la première taxe activée, sinon 0
    const defaultTax = taxes.find(t => Number(t.tax_default) === 1)
      || taxes.find(t => Number(t.tax_enabled) === 1)
      || taxes[0];
    defaultTaxIdCache = defaultTax ? Number(defaultTax.tax_id) : 0;
  } catch (e) {
    console.warn('[hiboutik] Impossible de récupérer les taxes, utilisation de tax_id=0 :', e.message);
    defaultTaxIdCache = 0;
  }
  return defaultTaxIdCache;
};

// Crée un produit Hiboutik (utilisé pour matérialiser les produits locaux IA/CRUD au moment du checkout).
const createProduct = async ({ name, price, categoryId }, auth = null) => {
  const client = buildClient(auth);
  if (!client) throw new Error('Hiboutik non configuré');
  const taxId = await getDefaultTaxId(auth);
  const payload = {
    product_model: String(name || 'Produit').slice(0, 90),
    product_price: Number(price).toFixed(2),
    product_category: Number(categoryId),
    product_vat: taxId,
    product_stock_management: 0,
  };
  console.log('[hiboutik/createProduct] payload:', JSON.stringify(payload));
  try {
    const { data } = await client.post('/products', payload);
    const productId = data?.product_id ?? data?.id ?? data?.[0]?.product_id;
    if (!productId) throw new Error('product_id absent dans réponse Hiboutik');
    return Number(productId);
  } catch (e) {
    const f = formatError(e);
    console.error('[hiboutik/createProduct] Hiboutik 422 details:', JSON.stringify(f));
    const err = new Error(`Création produit "${name}" : ${f.message}`);
    err.hiboutik = f;
    throw err;
  }
};

// Renvoie l'ID d'une catégorie utilisable (la 1re catégorie active du compte Hiboutik).
const getFallbackCategoryId = async (auth = null) => {
  const cats = await getCategories(auth);
  const first = Array.isArray(cats) ? cats[0] : null;
  const id = Number(first?.category_id ?? first?.id);
  if (!id) throw new Error('Aucune catégorie Hiboutik disponible (créez-en une dans Hiboutik).');
  return id;
};

const createSale = async ({ vendorId, storeId, customerId, currencyCode = 'EUR' }, auth = null) => {
  const client = buildClient(auth);
  if (!client) throw new Error('Hiboutik non configuré');
  const payload = {
    vendor_id: vendorId || config.hiboutik.vendorId,
    store_id: storeId || config.hiboutik.storeId,
    customer_id: customerId || config.hiboutik.defaultCustomerId,
    currency_code: currencyCode,
  };
  try {
    const { data } = await client.post('/sales', payload);
    const saleId = data?.sale_id ?? data?.id ?? data?.[0]?.sale_id;
    if (!saleId) throw new Error('sale_id absent dans la réponse Hiboutik');
    return { saleId, raw: data };
  } catch (e) {
    const f = formatError(e);
    const err = new Error(`Création vente : ${f.message}`);
    err.hiboutik = f;
    throw err;
  }
};

const addItem = async (saleId, { productId, quantity, sizeId, price }, auth = null) => {
  const client = buildClient(auth);
  if (!client) throw new Error('Hiboutik non configuré');

  const buildPayload = (sid) => {
    const p = {
      sale_id: saleId,
      product_id: productId,
      size_id: sid,
      quantity: Math.max(1, Math.round(quantity)),
      stock_withdrawal: '1',
    };
    if (typeof price === 'number' && Number.isFinite(price)) p.product_price = Number(price).toFixed(2);
    return p;
  };

  let effectiveSizeId = sizeId ?? (sizeCache.has(productId) ? sizeCache.get(productId) : 0);

  try {
    const { data } = await client.post('/sales/add_product', buildPayload(effectiveSizeId));
    return data;
  } catch (e) {
    const status = e.response?.status;
    const details = e.response?.data?.details || {};
    const sizeError = typeof details.size_id === 'string' && /size.?id/i.test(details.size_id);

    if (status === 422 && sizeError && effectiveSizeId === 0) {
      const resolved = await resolveSizeId(productId, auth);
      if (resolved) {
        const { data } = await client.post('/sales/add_product', buildPayload(resolved));
        return data;
      }
    }
    const f = formatError(e);
    const err = new Error(`Ajout produit ${productId} : ${f.message}`);
    err.hiboutik = f;
    throw err;
  }
};

const recordPayment = async (saleId, { payment }, auth = null) => {
  const client = buildClient(auth);
  if (!client) throw new Error('Hiboutik non configuré');
  try {
    const { data } = await client.put(`/sale/${saleId}`, {
      sale_attribute: 'payment',
      new_value: payment,
    });
    return data;
  } catch (e) {
    const f = formatError(e);
    const err = new Error(`Paiement ${payment} : ${f.message}`);
    err.hiboutik = f;
    throw err;
  }
};

const closeSale = async (saleId, auth = null) => {
  const client = buildClient(auth);
  if (!client) throw new Error('Hiboutik non configuré');
  try {
    const { data } = await client.post('/sales/close', { sale_id: saleId });
    return data;
  } catch (e) {
    const f = formatError(e);
    const err = new Error(`Clôture vente ${saleId} : ${f.message}`);
    err.hiboutik = f;
    throw err;
  }
};

const cancelSale = async (saleId, storeId, auth = null) => {
  const client = buildClient(auth);
  if (!client) return null;
  try {
    const { data } = await client.post('/sales/void', { sale_id: saleId, store_id: storeId || config.hiboutik.storeId });
    return data;
  } catch (e) {
    return null;
  }
};

module.exports = {
  isConfigured: (auth = null) => !!(auth?.account || config.hiboutik.isConfigured),
  reload: () => { sizeCache.clear(); defaultTaxIdCache = null; },
  ping,
  getProducts,
  getCategories,
  getTaxes,
  getStores,
  getUsers,
  getVendors: getUsers,
  getPaymentTypes,
  getProductImages,
  getProductImageBinary,
  createProduct,
  getFallbackCategoryId,
  createSale,
  addItem,
  recordPayment,
  closeSale,
  cancelSale,
  resolveSizeId,
};
