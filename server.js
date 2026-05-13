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
app.use(cors());
app.use(express.json());

// ---- Gestion des paramètres locaux ----
const SETTINGS_PATH = path.join(process.cwd(), 'local-settings.json');
let localSettings = { 
  shopName: '', 
  printerIp: '192.168.1.100', 
  printerPort: '9100', 
  cloudUrl: 'https://boutididact-backendd.vercel.app' 
};

function loadLocalSettings() {
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      localSettings = { ...localSettings, ...data };
      console.log('[config] Paramètres locaux chargés :', localSettings.shopName);
    } catch (e) {
      console.error('[config] Erreur lecture local-settings.json');
    }
  }
}
loadLocalSettings();

function saveLocalSettings(settings) {
  localSettings = { ...localSettings, ...settings };
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
    // 1. Vérifier si la boutique existe sur le Cloud
    const targetUrl = cloudUrl || localSettings.cloudUrl;
    console.log(`[config] Vérification de la boutique "${shopName}" sur ${targetUrl}...`);
    
    const testRes = await axios.get(`${targetUrl}/api/saas/poll-ticket?shopName=${encodeURIComponent(shopName)}`, { timeout: 8000 });
    
    // 2. Tester l'imprimante
    const printer = require('./services/printer');
    const printerOnline = await printer.checkOnline({ ip: printerIp, port: printerPort });

    saveLocalSettings({ shopName, printerIp, printerPort, cloudUrl: targetUrl });

    res.json({ 
      success: true, 
      printerOnline,
      message: printerOnline ? 'Configuration enregistrée et validée !' : 'Boutique validée, mais imprimante locale injoignable.'
    });
    
    console.log(`[config] ✅ Configuration mise à jour. Polling relancé.`);
    startRelayPolling();
  } catch (e) {
    console.error('[config] ❌ Erreur validation :', e.message);
    let msg = 'Erreur de connexion au serveur Cloud';
    if (e.response?.status === 404) msg = `Boutique "${shopName}" introuvable sur le Cloud.`;
    else if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') msg = 'URL Cloud invalide ou serveur injoignable.';
    
    res.status(400).json({ error: msg });
  }
});

app.get('/', (req, res) => {
  const localIp = getLocalIp();
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
          #message { margin-top: 1.5rem; font-size: 0.875rem; border-radius: 0.75rem; padding: 1rem; display: none; }
          .msg-success { background: rgba(16, 185, 129, 0.1); color: #10b981; display: block !important; }
          .msg-error { background: rgba(239, 68, 68, 0.1); color: #ef4444; display: block !important; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Boutididact Print</h1>
          
          <div id="connectionStatus" class="status-badge status-offline">
            <span style="width: 8px; height: 8px; background: currentColor; border-radius: 50%;"></span>
            RELAY INACTIF
          </div>

          <div class="form-group">
            <label>Nom de la boutique (identique à l'inscription)</label>
            <input type="text" id="shopName" placeholder="ex: MaBoutique" value="${localSettings.shopName}">
          </div>

          <div class="form-group">
            <label>URL de votre API Cloud (Vercel)</label>
            <input type="text" id="cloudUrl" placeholder="https://votre-projet.vercel.app" value="${localSettings.cloudUrl}">
          </div>

          <div class="form-group">
            <label>IP de l'imprimante thermique locale</label>
            <input type="text" id="printerIp" placeholder="ex: 192.168.1.100" value="${localSettings.printerIp}">
          </div>

          <button id="saveBtn" onclick="saveConfig()">Enregistrer & Lancer le Relais</button>

          <div id="message"></div>
          
          <p style="margin-top: 2rem; font-size: 0.7rem; color: #64748b; line-height: 1.4;">
            IP de cet ordinateur : <code style="color: #fbbf24;">${localIp}</code><br>
            Laissez le .exe tourner en arrière-plan.
          </p>
        </div>

        <script>
          async function saveConfig() {
            const btn = document.getElementById('saveBtn');
            const msg = document.getElementById('message');
            const shopName = document.getElementById('shopName').value.trim();
            const cloudUrl = document.getElementById('cloudUrl').value.trim().replace(/\/$/, '');
            const printerIp = document.getElementById('printerIp').value.trim();

            if(!shopName || !printerIp || !cloudUrl) return alert('Veuillez remplir tous les champs.');

            btn.disabled = true;
            btn.innerText = 'Vérification en cours...';
            msg.className = '';
            msg.style.display = 'none';

            try {
              const res = await fetch('/api/local-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shopName, printerIp, printerPort: '9100', cloudUrl })
              });
              const data = await res.json();

              if(data.success) {
                msg.innerText = data.message;
                msg.className = 'msg-success';
                document.getElementById('connectionStatus').className = 'status-badge status-online';
                document.getElementById('connectionStatus').innerText = '● RELAY ACTIF';
              } else {
                throw new Error(data.error || 'Erreur inconnue');
              }
            } catch (e) {
              msg.innerText = e.message;
              msg.className = 'msg-error';
            } finally {
              btn.disabled = false;
              btn.innerText = 'Enregistrer & Lancer';
            }
          }

          // Check initial status
          if("${localSettings.shopName}") {
             document.getElementById('connectionStatus').className = 'status-badge status-online';
             document.getElementById('connectionStatus').innerText = '● RELAY ACTIF';
          }
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

let relayInterval = null;

function startRelayPolling() {
  if (relayInterval) clearInterval(relayInterval);
  
  const POLL_INTERVAL = 2500;
  console.log(`[relay] ⚡ Polling démarré sur ${localSettings.cloudUrl} (toutes les 2.5s)`);
  
  relayInterval = setInterval(async () => {
    const { shopName, cloudUrl } = localSettings;
    if (!shopName || shopName === 'placeholder' || shopName === 'BOUTIDIDACT') return;

    try {
      const { data } = await axios.get(`${cloudUrl}/api/saas/poll-ticket?shopName=${encodeURIComponent(shopName)}`, {
        timeout: 4000
      });

      if (data.ticket) {
        console.log(`[relay] 📥 TICKET REÇU ! ID: ${data.ticket.ticketId}`);
        const printer = require('./services/printer');
        const printerConfig = {
          ip: localSettings.printerIp,
          port: localSettings.printerPort,
          type: data.ticket.printer?.type || config.printer.type,
          width: data.ticket.printer?.width || config.printer.width
        };
        
        try {
          await printer.printTicket(data.ticket, printerConfig);
          console.log(`[relay] ✅ Impression réussie.`);
        } catch (printError) {
          console.error(`[relay] ❌ Erreur impression :`, printError.message);
        }
      }
    } catch (e) {
      // On logue uniquement les erreurs critiques, pas les timeouts normaux ou 404
      if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED') {
        console.error(`[relay] ❌ Serveur Cloud injoignable (${cloudUrl})`);
      } else if (e.response?.status === 401 || e.response?.status === 403) {
        console.error(`[relay] ❌ Erreur d'authentification sur le Cloud`);
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
    if (localSettings.shopName) {
      console.log(`[relay] Démarrage automatique pour : ${localSettings.shopName}`);
      startRelayPolling();
    }

    // Ouverture automatique du navigateur si pas encore configuré
    if (!localSettings.shopName && process.pkg) {
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

