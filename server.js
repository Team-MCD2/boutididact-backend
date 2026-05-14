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
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const cors = require('cors');
const config = require('./config/env');
const { getLocalIp } = require('./services/printer');

const app = express();

const healthRouter = require('./routes/health');
const hiboutikRouter = require('./routes/hiboutik');
const checkoutRouter = require('./routes/checkout');
const printRouter = require('./routes/print');
const saasRouter = require('./routes/saas');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// ---- Middleware Auth Hiboutik Multi-tenant ----
app.use((req, res, next) => {
  const account = req.headers['x-hiboutik-account'];
  if (account) {
    req.hiboutikAuth = {
      account,
      user: req.headers['x-hiboutik-user'],
      apiKey: req.headers['x-hiboutik-api-key']
    };
  }
  next();
});

// ---- Middleware Multi-tenant (Boutique & Imprimante) ----
app.use((req, res, next) => {
  // Identification boutique
  const shopName = req.headers['x-shop-name'];
  if (shopName) {
    req.shopOverrides = {
      name: shopName,
      address: req.headers['x-shop-address'],
      siret: req.headers['x-shop-siret'],
      tva: req.headers['x-shop-tva']
    };
  }

  // Configuration imprimante
  const printerIp = req.headers['x-printer-ip'];
  if (printerIp) {
    req.printerAuth = {
      ip: printerIp,
      port: req.headers['x-printer-port'] || '9100',
      type: req.headers['x-printer-type'] || 'EPSON',
      width: req.headers['x-printer-width'] || 42
    };
  }
  next();
});

// ---- Routes API ----
app.use('/api/health', healthRouter);
app.use('/api/hiboutik', hiboutikRouter);
app.use('/api/checkout', checkoutRouter);
app.use('/api/print', printRouter);
app.use('/api/saas', saasRouter);

// ---- Gestion des paramètres locaux ----
const SETTINGS_PATH = path.join(process.cwd(), 'local-settings.json');
let localSettings = { 
  activeShop: '', // Nom de la boutique actuellement sélectionnée
  shops: []       // Liste des boutiques configurées : { shopName, printerIp, printerPort, cloudUrl }
};

function loadLocalSettings() {
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      // Migration si ancien format
      if (data.shopName && !data.shops) {
        localSettings.shops = [{
          shopName: data.shopName,
          printerIp: data.printerIp,
          printerPort: data.printerPort,
          cloudUrl: data.cloudUrl
        }];
        localSettings.activeShop = data.shopName;
      } else {
        localSettings = { ...localSettings, ...data };
      }
      console.log('[config] Paramètres chargés. Boutique active :', localSettings.activeShop);
    } catch (e) {
      console.error('[config] Erreur lecture local-settings.json');
    }
  }
}
loadLocalSettings();

function saveLocalSettings() {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(localSettings, null, 2));
}

// ---- Routes de configuration locale ----
app.get('/api/local-config', (req, res) => {
  res.json(localSettings);
});



app.post('/api/local-config', async (req, res) => {
  const { shopName, printerIp, printerPort, cloudUrl } = req.body;
  
  if (!shopName) return res.status(400).json({ error: 'Nom de boutique requis' });

  try {
    const targetUrl = cloudUrl || 'https://boutididact-backendd.vercel.app';
    console.log(`[config] Validation boutique "${shopName}" sur ${targetUrl}...`);
    
    // Vérification sur le Cloud
    await axios.get(`${targetUrl}/api/saas/poll-ticket?shopName=${encodeURIComponent(shopName)}`, { timeout: 8000 });
    
    // Mise à jour de la liste des boutiques
    const newShop = { shopName, printerIp, printerPort, cloudUrl: targetUrl };
    const index = localSettings.shops.findIndex(s => s.shopName.toLowerCase() === shopName.toLowerCase());
    
    if (index >= 0) {
      localSettings.shops[index] = newShop;
    } else {
      localSettings.shops.push(newShop);
    }
    
    localSettings.activeShop = shopName;
    saveLocalSettings();
    startRelayPolling();

    return res.json({ success: true, message: 'Boutique ajoutée/mise à jour !' });
  } catch (e) {
    console.error('[config] ❌ Erreur :', e.message);
    res.status(400).json({ error: e.response?.status === 404 ? `Boutique "${shopName}" introuvable.` : e.message });
  }
});

app.post('/api/switch-shop', (req, res) => {
  const { shopName } = req.body;
  const shop = localSettings.shops.find(s => s.shopName === shopName);
  if (!shop) return res.status(404).json({ error: 'Boutique non configurée localement' });
  
  localSettings.activeShop = shopName;
  saveLocalSettings();
  startRelayPolling();
  res.json({ success: true, activeShop: shopName });
});

app.post('/api/delete-shop', (req, res) => {
  const { shopName } = req.body;
  localSettings.shops = localSettings.shops.filter(s => s.shopName !== shopName);
  if (localSettings.activeShop === shopName) {
    localSettings.activeShop = localSettings.shops[0]?.shopName || '';
  }
  saveLocalSettings();
  startRelayPolling();
  res.json({ success: true });
});

app.get('/', (req, res) => {
  const localIp = getLocalIp();
  // Injection sécurisée pour éviter les erreurs de syntaxe JS
  const initialConfig = JSON.stringify({
    shopName: localSettings.shopName || '',
    cloudUrl: localSettings.cloudUrl || '',
    printerIp: localSettings.printerIp || ''
  });

  res.send(`
    <html>
      <head>
        <title>Configuration Boutididact Print</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: 'Inter', system-ui, sans-serif; background: #0f172a; color: white; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
          .card { background: #1e293b; padding: 2.5rem; border-radius: 2rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); text-align: center; border: 1px solid #334155; max-width: 450px; width: 90%; }
          h1 { color: #fbbf24; margin-top: 0; font-size: 1.75rem; font-weight: 800; margin-bottom: 1.5rem; }
          .form-group { text-align: left; margin-bottom: 1.25rem; }
          label { display: block; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: #94a3b8; margin-bottom: 0.5rem; margin-left: 0.5rem; }
          input { width: 100%; padding: 0.85rem 1rem; border-radius: 1rem; border: 1px solid #334155; background: #0f172a; color: white; box-sizing: border-box; font-size: 1rem; transition: all 0.2s; }
          input:focus { outline: none; border-color: #fbbf24; box-shadow: 0 0 0 4px rgba(251, 191, 36, 0.1); }
          button { width: 100%; padding: 1rem; border-radius: 1rem; border: none; background: #fbbf24; color: #000; font-weight: 800; font-size: 1rem; cursor: pointer; transition: all 0.2s; margin-top: 1rem; }
          button:hover { background: #f59e0b; transform: translateY(-1px); }
          button:disabled { opacity: 0.5; cursor: not-allowed; }
          .status-badge { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.5rem 1rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 700; margin-bottom: 2rem; }
          .status-online { background: rgba(16, 185, 129, 0.1); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.2); }
          .status-offline { background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2); }
          #message { margin-top: 1.5rem; font-size: 0.875rem; border-radius: 0.75rem; padding: 1rem; display: none; min-height: 1.25rem; }
          .msg-success { background: rgba(16, 185, 129, 0.1) !important; color: #10b981 !important; display: block !important; }
          .msg-error { background: rgba(239, 68, 68, 0.1) !important; color: #ef4444 !important; display: block !important; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Boutididact Print</h1>
          
          <div id="connectionStatus" class="status-badge status-offline">
            <span style="width: 8px; height: 8px; background: currentColor; border-radius: 50%;"></span>
            RELAY INACTIF
          </div>

          <div class="form-group" id="shopSelectorGroup" style="display: none;">
            <label>Boutique active</label>
            <div style="display: flex; gap: 0.5rem;">
              <select id="shopSelector" onchange="switchShop()" style="flex: 1; padding: 0.85rem; border-radius: 1rem; background: #0f172a; color: white; border: 1px solid #334155;"></select>
              <button onclick="deleteShop()" style="width: auto; margin: 0; padding: 0.5rem 1rem; background: #ef4444; color: white;">🗑️</button>
            </div>
            <p style="text-align: right; margin-top: 0.5rem;">
              <button onclick="showAddForm()" style="width: auto; margin: 0; padding: 0.25rem 0.75rem; font-size: 0.75rem; background: #334155; color: #94a3b8;">+ Ajouter une autre boutique</button>
            </p>
          </div>

          <div id="addShopForm" style="display: none;">
            <div class="form-group">
              <label>Nom de la boutique</label>
              <input type="text" id="shopName" placeholder="ex: MaBoutique">
            </div>

            <div class="form-group" style="display: none;">
              <label>URL Cloud (Vercel)</label>
              <input type="text" id="cloudUrl" placeholder="https://...vercel.app" value="https://boutididact-backendd.vercel.app">
            </div>

            <div class="form-group">
              <label>IP Imprimante Locale</label>
              <input type="text" id="printerIp" placeholder="192.168.1.100">
            </div>

            <button id="saveBtn" onclick="saveConfig()">Valider & Ajouter</button>
            <button onclick="hideAddForm()" style="background: transparent; color: #94a3b8; font-size: 0.8rem; margin-top: 0.5rem; text-decoration: underline; border: none; cursor: pointer;">Annuler</button>
          </div>

          <div id="message"></div>
          
          <p style="margin-top: 2rem; font-size: 0.7rem; color: #64748b; line-height: 1.4;">
            IP de cet ordinateur : <code style="color: #fbbf24;">${localIp}</code><br>
            Multi-boutiques : <span id="shopCount">0</span> configurée(s)
          </p>
        </div>

        <script>
          let settings = ${JSON.stringify(localSettings)};

          function render() {
            const selector = document.getElementById('shopSelector');
            const group = document.getElementById('shopSelectorGroup');
            const count = document.getElementById('shopCount');
            const addForm = document.getElementById('addShopForm');
            
            count.innerText = settings.shops.length;
            
            if (settings.shops.length > 0) {
              selector.innerHTML = settings.shops.map(s => 
                '<option value="' + s.shopName + '" ' + (s.shopName === settings.activeShop ? 'selected' : '') + '>' + s.shopName + '</option>'
              ).join('');
              group.style.display = 'block';
              addForm.style.display = settings.activeShop ? 'none' : 'block';
            } else {
              group.style.display = 'none';
              addForm.style.display = 'block';
            }
            
            setStatus(!!settings.activeShop);
          }

          function setStatus(online) {
            var el = document.getElementById('connectionStatus');
            el.className = online ? 'status-badge status-online' : 'status-badge status-offline';
            el.innerHTML = '<span style="width: 8px; height: 8px; background: currentColor; border-radius: 50%;"></span> ' + (online ? 'RELAY ACTIF ('+settings.activeShop+')' : 'RELAY INACTIF');
          }

          function showAddForm() { 
            document.getElementById('addShopForm').style.display = 'block';
            document.getElementById('shopSelectorGroup').style.display = 'none';
          }
          function hideAddForm() { 
            document.getElementById('addShopForm').style.display = 'none';
            document.getElementById('shopSelectorGroup').style.display = 'block';
          }

          async function switchShop() {
            const name = document.getElementById('shopSelector').value;
            const res = await fetch('/api/switch-shop', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ shopName: name })
            });
            const data = await res.json();
            if (data.success) {
              settings.activeShop = data.activeShop;
              render();
            }
          }

          async function deleteShop() {
            const name = document.getElementById('shopSelector').value;
            if (!confirm('Supprimer '+name+' de ce PC ?')) return;
            const res = await fetch('/api/delete-shop', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ shopName: name })
            });
            window.location.reload();
          }

          async function saveConfig() {
            var btn = document.getElementById('saveBtn');
            var msg = document.getElementById('message');
            var shopName = document.getElementById('shopName').value.trim();
            var cloudUrl = document.getElementById('cloudUrl').value.trim();
            var printerIp = document.getElementById('printerIp').value.trim();

            if(!shopName || !printerIp || !cloudUrl) return alert('Veuillez remplir tous les champs.');

            btn.disabled = true;
            msg.style.display = 'none';

            try {
              var res = await fetch('/api/local-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shopName, printerIp, printerPort: '9100', cloudUrl })
              });
              var data = await res.json();

              if(data.success) {
                window.location.reload();
              } else {
                throw new Error(data.error || 'Erreur inconnue');
              }
            } catch (e) {
              msg.innerText = e.message;
              msg.className = 'msg-error';
              msg.style.display = 'block';
            } finally {
              btn.disabled = false;
            }
          }

          render();
        </script>
      </body>
    </html>
  `);
});


// 404
app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.url }));

// Error handler
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

const POLL_INTERVAL = 5000;
let relayInterval = null;

function startRelayPolling() {
  if (relayInterval) clearInterval(relayInterval);
  
  relayInterval = setInterval(async () => {
    const activeShopName = localSettings.activeShop;
    const shop = localSettings.shops.find(s => s.shopName === activeShopName);
    
    if (!shop) return;

    const { shopName, cloudUrl, printerIp, printerPort } = shop;

    try {
      const { data } = await axios.get(`${cloudUrl}/api/saas/poll-ticket?shopName=${encodeURIComponent(shopName)}`, {
        timeout: 4000
      });

      if (data.ticket) {
        console.log(`[relay] 📥 TICKET REÇU pour ${shopName} ! ID: ${data.ticket.ticketId}`);
        const printer = require('./services/printer');
        const printerConfig = {
          ip: printerIp,
          port: printerPort,
          type: data.ticket.printer?.type || config.printer.type,
          width: data.ticket.printer?.width || config.printer.width
        };
        
        try {
          await printer.printTicket(data.ticket, printerConfig);
          console.log(`[relay] ✅ Impression réussie pour ${shopName}.`);
        } catch (printError) {
          console.error(`[relay] ❌ Erreur impression (${shopName}) :`, printError.message);
        }
      }
    } catch (e) {
      if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED') {
        console.error(`[relay] ❌ Serveur Cloud injoignable (${cloudUrl})`);
      }
    }
  }, POLL_INTERVAL);
}

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(config.port, () => {
    console.log('================================================');
    console.log(' BOUTIDIDACT PRINT SERVER');
    console.log(`  - URL Config : http://localhost:${config.port}`);
    console.log('================================================');
    
    // Lancement auto du polling si déjà configuré
    if (localSettings.activeShop) {
      console.log(`[relay] Démarrage automatique pour : ${localSettings.activeShop}`);
      startRelayPolling();
    }

    // Ouverture automatique du navigateur si pas encore de boutique active
    if (!localSettings.activeShop && process.pkg) {
      const { exec } = require('child_process');
      exec(`start http://localhost:${config.port}`);
    }
    
    // Reste de la logique readline/shortcuts...
    if (process.pkg && process.stdout.isTTY) {
       // ... (le bloc readline existant)
       finish();
    } else {
       finish();
    }

    function finish() {
      // Empêche le processus de se fermer
      setInterval(() => {}, 1000 * 60 * 60);
    }
  });
}

module.exports = app;

