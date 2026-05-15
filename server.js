/**
 * BOUTIDIDACT — Backend-for-Frontend
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const config = require('./config/env');
const { getLocalIp } = require('./services/printer');

const app = express();

// ---- CORS & PREFLIGHT (CRITICAL: MUST BE AT TOP) ----
app.use(cors());
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With, X-Hiboutik-Account, X-Hiboutik-User, X-Hiboutik-Api-Key');
  res.status(200).end();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// ---- Middleware Hiboutik Auth ----
app.use((req, res, next) => {
  if (req.url !== '/api/health' && !req.url.includes('poll-ticket')) {
    console.log(`[http] ${req.method} ${req.url}`);
  }
  
  // Extraction des headers Hiboutik pour les routes SaaS/Relais
  req.hiboutikAuth = {
    account: req.headers['x-hiboutik-account'],
    user: req.headers['x-hiboutik-user'],
    apiKey: req.headers['x-hiboutik-api-key'], // Fix: match frontend header name
  };
  next();
});

// ---- Routes API ----
const healthRouter = require('./routes/health');
const hiboutikRouter = require('./routes/hiboutik');
const checkoutRouter = require('./routes/checkout');
const printRouter = require('./routes/print');
const saasRouter = require('./routes/saas');

app.use('/api/health', healthRouter);
app.use('/api/hiboutik', hiboutikRouter);
app.use('/api/checkout', checkoutRouter);
app.use('/api/print', printRouter);
app.use('/api/saas', saasRouter);

// ---- Favicon ----
app.get('/favicon.ico', (req, res) => {
  const iconPath = path.join(process.cwd(), 'logo.ico');
  if (fs.existsSync(iconPath)) res.sendFile(iconPath);
  else res.status(404).end();
});

// ---- Gestion des paramètres locaux ----
const SETTINGS_PATH = path.join(process.cwd(), 'local-settings.json');
let localSettings = { activeShop: '', shops: [] };

function loadSettings() {
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      if (data.shopName && !data.shops) {
        localSettings.shops = [{ shopName: data.shopName, printerIp: data.printerIp, printerPort: data.printerPort || '9100', cloudUrl: data.cloudUrl || 'https://boutididact-backendd.vercel.app' }];
        localSettings.activeShop = data.shopName;
      } else {
        localSettings = { ...localSettings, ...data };
      }
      if (!Array.isArray(localSettings.shops)) localSettings.shops = [];
    } catch (e) {
      console.error('[config] Erreur lecture settings');
    }
  }
}
loadSettings();

function saveSettings() {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(localSettings, null, 2));
}

// ---- Endpoints Relais ----
app.post('/api/local-config', async (req, res) => {
  const { shopName, printerIp, printerPort, cloudUrl } = req.body;
  if (!shopName || !printerIp) return res.status(400).json({ error: 'Champs manquants' });
  
  const targetCloud = cloudUrl || 'https://boutididact-backendd.vercel.app';

  // Vérification de l'existence de la boutique sur le Cloud
  try {
    await axios.get(`${targetCloud}/api/saas/poll-ticket?shopName=${encodeURIComponent(shopName)}`, { timeout: 5000 });
  } catch (e) {
    if (e.response && e.response.status === 404) {
      return res.status(404).json({ error: `Boutique introuvable : "${shopName}" n'existe pas.` });
    }
    // Si erreur réseau (timeout), on laisse passer car le cloud est peut-être juste lent
    console.warn(`[config] Impossible de verifier ${shopName} :`, e.message);
  }

  const existing = localSettings.shops.find(s => s.shopName === shopName);
  if (existing) {
    existing.printerIp = printerIp;
    existing.printerPort = printerPort || '9100';
    existing.cloudUrl = targetCloud;
  } else {
    localSettings.shops.push({ shopName, printerIp, printerPort: printerPort || '9100', cloudUrl: targetCloud });
  }
  localSettings.activeShop = shopName;
  saveSettings();
  startRelayPolling();
  res.json({ success: true });
});

app.post('/api/switch-shop', (req, res) => {
  const { shopName } = req.body;
  if (shopName === '') {
     stopRelayPolling();
  } else {
     localSettings.activeShop = shopName;
     saveSettings();
     startRelayPolling();
  }
  res.json({ success: true, activeShop: localSettings.activeShop });
});

app.post('/api/delete-shop', (req, res) => {
  const { shopName } = req.body;
  localSettings.shops = localSettings.shops.filter(s => s.shopName !== shopName);
  if (localSettings.activeShop === shopName) {
    stopRelayPolling();
    localSettings.activeShop = '';
  }
  saveSettings();
  res.json({ success: true });
});

app.post('/api/stop-relay', (req, res) => {
  stopRelayPolling();
  res.json({ success: true });
});

app.post('/api/test-print', async (req, res) => {
  const shop = localSettings.shops.find(s => s.shopName === localSettings.activeShop);
  if (!shop) return res.status(400).json({ error: 'Aucune boutique active' });

  const ip = shop.printerIp;
  const port = shop.printerPort || '9100';

  // On reproduit exactement le contenu de jbjk dynamiquement
  const psScript = `
    $client = New-Object System.Net.Sockets.TcpClient("${ip}", ${port})
    $stream = $client.GetStream()
    $ESC = [char]27; $GS = [char]29; $LF = [char]10; $NUL = [char]0
    $payload = "$ESC@"
    $payload += "TEST-TEST-TEST-TEST-TEST-TEST-TEST-TEST-TEST-TEST"
    $payload += "BOUTIDIDACT - liaison OK$LF$LF$LF$LF$LF"
    $payload += "$GS" + "V" + "$NUL"
    $bytes = [Text.Encoding]::ASCII.GetBytes($payload)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
    Start-Sleep -Milliseconds 800
    $stream.Close(); $client.Close()
  `;

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  exec(`powershell -NoProfile -EncodedCommand ${encoded}`, (err) => {
    if (err) {
      console.error('[test] Erreur:', err.message);
      return res.status(500).json({ success: false, error: 'Connexion échouée' });
    }
    res.json({ success: true, message: 'Ticket de test envoyé !' });
  });
});

app.post('/api/test-printer', async (req, res) => {
  const { printerIp, printerPort } = req.body;
  if (!printerIp) return res.status(400).json({ error: 'IP manquante' });
  
  console.log(`[printer] TEST DE CONNEXION vers ${printerIp}:${printerPort || 9100}`);
  const printer = require('./services/printer');
  
  // On utilise la logique du fichier jbjk adaptée pour Node.js
  const testTicket = {
    ticketId: 'TEST-' + Date.now(),
    items: [{ name: 'BOUTIDIDACT - liaison OK', quantity: 1, price: 0 }],
    total: 0,
    paidAt: new Date().toISOString(),
    shopName: 'TEST LIAISON'
  };

  try {
    await printer.printTicket(testTicket, { 
      ip: printerIp, 
      port: printerPort || '9100', 
      type: 'escpos', 
      width: 32 
    });
    res.json({ success: true, message: 'Ticket de test envoyé !' });
  } catch (e) {
    console.error('[printer] Echec du test:', e.message);
    res.status(502).json({ error: `Erreur : ${e.message}. Verifiez l'IP et que l'imprimante est allumée.` });
  }
});

app.post('/api/shutdown', (req, res) => {
  res.json({ success: true });
  setTimeout(() => process.exit(0), 500);
});

app.post('/api/create-shortcut', (req, res) => {
  try {
    const exePath = process.execPath;
    const exeDir = path.dirname(exePath);
    const exeName = path.basename(exePath);
    const vbsPath = path.join(exeDir, 'launcher.vbs');
    const iconPath = path.join(exeDir, 'logo.ico');

    fs.writeFileSync(vbsPath, `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run "${exeName}", 0, False`);
    
    const script = `
      $d = [Environment]::GetFolderPath("Desktop");
      $s = (New-Object -COM WScript.Shell).CreateShortcut("$d\\Boutididact-Print.lnk");
      $s.TargetPath = "wscript.exe";
      $s.Arguments = "//B //Nologo ""${vbsPath}""";
      $s.WorkingDirectory = "${exeDir}";
      $s.IconLocation = "${iconPath}";
      $s.Save();
    `;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    exec(`powershell -NoProfile -EncodedCommand ${encoded}`, (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, message: 'Raccourci cree !' });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Interface Web ----
app.get('/', async (req, res) => {
  const localIp = getLocalIp();
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Boutididact Print</title>
        <meta charset="utf-8">
        <style>
          body { font-family: sans-serif; background: #0f172a; color: white; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
          .card { background: #1e293b; padding: 2rem; border-radius: 1.5rem; border: 1px solid #334155; width: 100%; max-width: 400px; text-align: center; }
          h1 { color: #fbbf24; font-size: 1.5rem; margin-bottom: 1.5rem; }
          .status { display: inline-flex; align-items: center; gap: 8px; padding: 6px 16px; border-radius: 100px; font-size: 0.75rem; font-weight: 800; margin-bottom: 25px; text-transform: uppercase; letter-spacing: 0.05em; }
          .online { background: rgba(16, 185, 129, 0.1); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.2); }
          .offline { background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2); }
          .form-group { text-align: left; margin-bottom: 15px; }
          label { font-size: 0.7rem; color: #94a3b8; text-transform: uppercase; display: block; margin-bottom: 5px; }
          input, select { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: white; box-sizing: border-box; }
          button { width: 100%; padding: 12px; border-radius: 12px; border: none; background: #fbbf24; color: #0f172a; font-weight: 800; font-size: 0.9rem; cursor: pointer; transition: all 0.2s; margin-top: 10px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
          button:hover { background: #f59e0b; transform: translateY(-1px); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.2); }
          button:active { transform: translateY(0); }
          .btn-danger { background: #ef4444 !important; color: white !important; }
          .btn-danger:hover { background: #dc2626 !important; }
          .btn-secondary { background: #334155 !important; color: #f8fafc !important; border: 1px solid #475569 !important; }
          .btn-secondary:hover { background: #475569 !important; }
          .footer { margin-top: 20px; font-size: 0.7rem; color: #64748b; }
          .link { color: #64748b; text-decoration: underline; cursor: pointer; background: none; border: none; font-size: 0.7rem; padding: 5px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Boutididact Print</h1>
          
          <div id="status" class="status offline">RELAIS INACTIF</div>

          <div id="shopManager" style="display:none;">
            <div class="form-group">
              <label>Boutique Active</label>
              <div style="display:flex; gap:5px;">
                <select id="shopSelector" onchange="doSwitch()"></select>
                <button onclick="doDelete()" style="width:auto; margin:0; padding:5px 10px; background:#ef4444;">X</button>
              </div>
            </div>
            <button id="relayBtn" onclick="doToggleRelay()">Demarrer le Relais</button>
            <button onclick="showAdd()" class="btn-secondary" style="font-size:0.7rem; padding:5px;">+ Ajouter une autre boutique</button>
          </div>

          <div id="addForm" style="margin-top:20px; border-top:1px solid #334155; padding-top:20px;">
            <div class="form-group">
              <label>Nom de la boutique</label>
              <input type="text" id="newName" placeholder="ex: MaBoutique">
            </div>
            <div class="form-group">
              <label>IP Imprimante</label>
              <input type="text" id="newIp" placeholder="192.168.1.100">
            </div>
            <button id="addBtn" onclick="doAdd()">Valider et Ajouter</button>
            <button id="cancelBtn" onclick="hideAdd()" class="btn-secondary" style="display:none;">Annuler</button>
          </div>

          <div class="footer">
            IP: ${localIp}<br>
            <button onclick="doShortcut()" class="btn-secondary" style="margin-top:10px;">Creer un raccourci Bureau</button><br>
            <button onclick="doQuit()" class="link">Quitter l'application</button>
          </div>
        </div>

        <script>
          const data = ${JSON.stringify(localSettings)} || { shops: [], activeShop: '' };
          window.isAdding = false;
          
          function refresh() {
            const hasShops = data.shops && data.shops.length > 0;
            const shopManager = document.getElementById('shopManager');
            const addForm = document.getElementById('addForm');
            const cancelBtn = document.getElementById('cancelBtn');

            if (shopManager) shopManager.style.display = (hasShops && !window.isAdding) ? 'block' : 'none';
            if (addForm) addForm.style.display = (!hasShops || window.isAdding) ? 'block' : 'none';
            if (cancelBtn) cancelBtn.style.display = hasShops ? 'block' : 'none';
            
            const sel = document.getElementById('shopSelector');
            sel.innerHTML = data.shops.map(s => '<option value="'+s.shopName+'" '+(s.shopName===data.activeShop?'selected':'')+'>'+s.shopName+'</option>').join('');
            
            const status = document.getElementById('status');
            const relayBtn = document.getElementById('relayBtn');
            if (data.activeShop) {
              status.className = 'status online';
              status.innerText = 'RELAIS ACTIF (' + data.activeShop + ')';
              relayBtn.innerText = 'Arreter le Relais';
              relayBtn.className = 'btn-danger';
            } else {
              status.className = 'status offline';
              status.innerText = 'RELAIS INACTIF';
              relayBtn.innerText = 'Demarrer le Relais';
              relayBtn.className = '';
            }
          }

          function showAdd() { window.isAdding = true; refresh(); }
          function hideAdd() { window.isAdding = false; refresh(); }

          async function api(path, body) {
            const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            return r.json();
          }

          async function doAdd() {
            const name = document.getElementById('newName').value.trim();
            const ip = document.getElementById('newIp').value.trim();
            if (!name || !ip) return alert('Remplissez tout');
            
            const btn = document.getElementById('addBtn');
            const oldText = btn.innerText;
            btn.innerText = 'Vérification...';
            btn.disabled = true;

            try {
              const res = await fetch('/api/local-config', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ shopName: name, printerIp: ip }) 
              });
              const data = await res.json();
              if (data.success) {
                window.location.reload();
              } else {
                alert(data.error || "Impossible d'ajouter cette boutique");
              }
            } catch (e) {
              alert('Erreur de connexion au serveur local');
            } finally {
              btn.innerText = oldText;
              btn.disabled = false;
            }
          }

          async function doSwitch() {
            const name = document.getElementById('shopSelector').value;
            await api('/api/switch-shop', { shopName: name });
            window.location.reload();
          }

          async function doDelete() {
            const name = document.getElementById('shopSelector').value;
            if (!confirm("Supprimer " + name + " ?")) return;
            await api('/api/delete-shop', { shopName: name });
            window.location.reload();
          }

          async function doToggleRelay() {
            if (data.activeShop) {
              await api('/api/stop-relay', {});
            } else {
              await doSwitch();
            }
            window.location.reload();
          }

          async function doShortcut() {
            const res = await api('/api/create-shortcut', {});
            alert(res.message || res.error);
          }

          function doQuit() {
            if (!confirm("Quitter ?")) return;
            api('/api/shutdown', {});
            document.body.innerHTML = '<h1>Serveur ferme</h1>';
          }

          refresh();
        </script>
      </body>
    </html>
  `);
});

// ---- Polling Relay ----
let relayInterval = null;
const POLL_INTERVAL = 5000;

function startRelayPolling() {
  if (relayInterval) clearInterval(relayInterval);
  relayInterval = setInterval(async () => {
    const shop = localSettings.shops.find(s => s.shopName === localSettings.activeShop);
    if (!shop) return;
    try {
      const { data } = await axios.get(`${shop.cloudUrl}/api/saas/poll-ticket?shopName=${encodeURIComponent(shop.shopName)}`, { timeout: 4000 });
      if (data && data.ticket) {
        console.log(`[relay] TICKET RECU: ${data.ticket.ticketId}`);
        const printer = require('./services/printer');
        await printer.printTicket(data.ticket, { ip: shop.printerIp, port: shop.printerPort, type: data.ticket.printer?.type || config.printer.type, width: data.ticket.printer?.width || config.printer.width });
      }
    } catch (e) {}
  }, POLL_INTERVAL);
}

function stopRelayPolling() {
  if (relayInterval) clearInterval(relayInterval);
  relayInterval = null;
  localSettings.activeShop = '';
  saveSettings();
}

// Start
app.listen(config.port, () => {
  console.log(`[server] Pret sur http://localhost:${config.port}`);
  if (localSettings.activeShop) startRelayPolling();
  if (process.pkg) exec(`start http://localhost:${config.port}`);
});

module.exports = app;
