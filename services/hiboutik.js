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

const buildClient = () => {
  if (!config.hiboutik.isConfigured) return null;
  return axios.create({
    baseURL: config.hiboutik.baseURL,
    timeout: 10_000,
    auth: {
      username: config.hiboutik.user,
      password: config.hiboutik.apiKey,
    },
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'BOUTIDIDACT-BFF/2.1',
    },
  });
};

let client = buildClient();

/**
 * Cache productId -> size_id par défaut.
 *  - 0  : produit sans tailles (ou non résolu, on continue avec size_id=0).
 *  - >0 : id de la première taille de ce produit, préalable obligatoire pour
 *         /sales/add_product quand le produit Hiboutik a un size_type non nul.
 *  Alimenté paresseusement par resolveSizeId() lors d'un 422 "size_id required".
 */
const sizeCache = new Map();

const reload = () => {
  client = buildClient();
  sizeCache.clear();
};

/** Extrait un message d'erreur lisible depuis une exception axios. */
const formatError = (e) => {
  const status = e.response?.status;
  const data = e.response?.data;
  if (data && typeof data === 'object') {
    const desc = data.error_description || data.error || 'Erreur Hiboutik';
    const details = data.details && typeof data.details === 'object'
      ? Object.entries(data.details).map(([k, v]) => `${k}: ${v}`).join(' | ')
      : '';
    return { status, code: data.error || 'hiboutik_error', message: details ? `${desc} (${details})` : desc, details: data.details || null };
  }
  return { status, code: e.code || 'network_error', message: e.message, details: null };
};

/** Vérifie la disponibilité de l'API. */
const ping = async () => {
  if (!client) return { ok: false, reason: 'not_configured' };
  try {
    const { status } = await client.get('/stores', { timeout: 5_000 });
    return { ok: status >= 200 && status < 300 };
  } catch (e) {
    return { ok: false, reason: e.response?.status || e.code || 'network_error' };
  }
};

const getProducts = async () => {
  if (!client) throw new Error('Hiboutik non configuré');
  const { data } = await client.get('/products');
  return Array.isArray(data) ? data : [];
};

const getCategories = async () => {
  if (!client) throw new Error('Hiboutik non configuré');
  const { data } = await client.get('/categories');
  return Array.isArray(data) ? data : [];
};

const getStores = async () => {
  if (!client) throw new Error('Hiboutik non configuré');
  const { data } = await client.get('/stores');
  return Array.isArray(data) ? data : [];
};

/** Hiboutik utilise /users (et non /vendors). */
const getUsers = async () => {
  if (!client) throw new Error('Hiboutik non configuré');
  const { data } = await client.get('/users');
  return Array.isArray(data) ? data : [];
};

/** Codes paiement actifs sur le store ('CB', 'ESP', 'CHE', 'TR', ...). */
const getPaymentTypes = async (storeId = config.hiboutik.storeId) => {
  if (!client) throw new Error('Hiboutik non configuré');
  const { data } = await client.get(`/payment_types/${storeId}`);
  return Array.isArray(data) ? data : [];
};

/**
 * Résout la première size_id valide pour un produit Hiboutik.
 *  Stratégie :
 *    1. GET /products/{id}        -> on lit product_size_type / size_type
 *    2. GET /sizes/{size_type}    -> on prend la première taille
 *  Le résultat est caché en mémoire pour les ventes suivantes.
 *  Renvoie 0 si le produit n'a pas de tailles ou si la résolution échoue.
 */
const resolveSizeId = async (productId) => {
  if (sizeCache.has(productId)) return sizeCache.get(productId);
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
    console.log(
      `[hiboutik] resolveSizeId(product=${productId}) -> size_type=${sizeType}, size_id=${sizeId}`
    );
    return sizeId;
  } catch (e) {
    console.warn(
      `[hiboutik] resolveSizeId(${productId}) impossible :`,
      e.response?.status || e.code || e.message
    );
    return 0;
  }
};

/** Récupère la liste des images d'un produit (peut être vide). */
const getProductImages = async (productId) => {
  if (!client) throw new Error('Hiboutik non configuré');
  const { data } = await client.get(`/products_images/${productId}`);
  return Array.isArray(data) ? data : [];
};

/**
 * Récupère la première image d'un produit en binaire.
 *  @returns {{ contentType, buffer } | null}
 */
const getProductImageBinary = async (productId) => {
  const images = await getProductImages(productId);
  if (!images.length) return null;
  // Hiboutik renvoie soit un nom de fichier soit une URL. On fabrique l'URL.
  const first = images[0];
  const fileName =
    typeof first === 'string' ? first
    : first.image_name || first.file_name || first.url || first.image_url || null;
  if (!fileName) return null;
  // Si le champ est déjà une URL absolue, on l'utilise directement.
  const url = /^https?:\/\//i.test(fileName)
    ? fileName
    : `${config.hiboutik.baseURL.replace(/\/api$/, '')}/products_images/${fileName}`;
  const r = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 8000,
    auth: { username: config.hiboutik.user, password: config.hiboutik.apiKey },
  });
  return { contentType: r.headers['content-type'] || 'image/jpeg', buffer: Buffer.from(r.data) };
};

/** Crée une vente. Hiboutik exige currency_code. */
const createSale = async ({ vendorId, storeId, customerId, currencyCode = 'EUR' }) => {
  if (!client) throw new Error('Hiboutik non configuré');
  const payload = {
    vendor_id: vendorId ?? config.hiboutik.vendorId,
    store_id: storeId ?? config.hiboutik.storeId,
    customer_id: customerId ?? config.hiboutik.defaultCustomerId,
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

/**
 * Ajoute un produit à une vente : POST /sales/add_product.
 *  stock_withdrawal=1 est OBLIGATOIRE pour pouvoir clôturer la vente
 *  (sinon /sales/close renvoie 422).
 *
 *  Gestion des tailles Hiboutik :
 *    - Si le produit n'a pas de tailles, size_id=0 suffit (cas par défaut).
 *    - Si le produit a un size_type non nul, Hiboutik renvoie 422
 *      ("size_id : please provide a valid size_id for this product_id").
 *      On rattrape ce cas : on résout la première size_id du produit
 *      via resolveSizeId() (avec cache) et on retente l'ajout une fois.
 *    - L'appelant peut préciser sizeId pour court-circuiter la résolution.
 */
const addItem = async (saleId, { productId, quantity, sizeId, price }) => {
  if (!client) throw new Error('Hiboutik non configuré');

  const buildPayload = (sid) => {
    const p = {
      sale_id: saleId,
      product_id: productId,
      size_id: sid,
      quantity: Math.max(1, Math.round(quantity)),
      stock_withdrawal: '1',
    };
    if (typeof price === 'number' && Number.isFinite(price)) {
      p.product_price = Number(price).toFixed(2);
    }
    return p;
  };

  // Pour la première tentative on utilise (dans l'ordre) :
  //   - sizeId passé explicitement par l'appelant,
  //   - sinon la valeur cachée (qui peut être 0 = "sans taille" déjà vérifié),
  //   - sinon 0.
  let effectiveSizeId = sizeId;
  if (effectiveSizeId == null) {
    effectiveSizeId = sizeCache.has(productId) ? sizeCache.get(productId) : 0;
  }

  try {
    const { data } = await client.post('/sales/add_product', buildPayload(effectiveSizeId));
    return data;
  } catch (e) {
    const status = e.response?.status;
    const details = e.response?.data?.details || {};
    const sizeError =
      typeof details.size_id === 'string' && /size.?id/i.test(details.size_id);

    if (status === 422 && sizeError && (effectiveSizeId == null || effectiveSizeId === 0)) {
      const resolved = await resolveSizeId(productId);
      if (resolved && resolved !== effectiveSizeId) {
        try {
          const { data } = await client.post('/sales/add_product', buildPayload(resolved));
          return data;
        } catch (e2) {
          const f = formatError(e2);
          const err = new Error(`Ajout produit ${productId} (size ${resolved}) : ${f.message}`);
          err.hiboutik = f;
          throw err;
        }
      }
    }

    const f = formatError(e);
    const err = new Error(`Ajout produit ${productId} : ${f.message}`);
    err.hiboutik = f;
    throw err;
  }
};

/**
 * Définit le moyen de paiement de la vente via PUT /sale/{id}
 *  (équivalent : sale_attribute=payment, new_value=<code>).
 *  Pour une borne : un seul paiement par vente -> on utilise cet endpoint
 *  plutôt que /sales_payment_div (qui exige sale_attribute=DIV).
 */
const recordPayment = async (saleId, { payment }) => {
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

/** Clôture la vente : POST /sales/close. */
const closeSale = async (saleId) => {
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

/** Annule la vente : POST /sales/void. */
const cancelSale = async (saleId, storeId = config.hiboutik.storeId) => {
  if (!client) return null;
  try {
    const { data } = await client.post('/sales/void', { sale_id: saleId, store_id: storeId });
    return data;
  } catch (e) {
    console.warn(`[hiboutik] cancelSale(${saleId}) impossible :`, e.response?.status, e.response?.data?.error_description || e.message);
    return null;
  }
};

module.exports = {
  isConfigured: () => config.hiboutik.isConfigured,
  reload,
  ping,
  getProducts,
  getCategories,
  getStores,
  getUsers,
  getVendors: getUsers, // alias rétro-compatible
  getPaymentTypes,
  getProductImages,
  getProductImageBinary,
  createSale,
  addItem,
  recordPayment,
  closeSale,
  cancelSale,
  resolveSizeId,
  _sizeCache: sizeCache, // exposition pour tests / debug
};
