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

// ---- Dashboard de configuration local ----
const os = require('os');
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    // Ignorer VirtualBox et autres interfaces virtuelles communes
    if (name.toLowerCase().includes('virtualbox') || name.toLowerCase().includes('vbox') || name.toLowerCase().includes('vmware')) continue;
    
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        // Ignorer les IPs typiques de VirtualBox si le nom n'était pas explicite
        if (iface.address.startsWith('192.168.56.')) continue;
        return iface.address;
      }
    }
  }
  return 'localhost';
}

app.get('/', (req, res) => {
  const localIp = getLocalIp();
  res.send(`
    <html>
      <head>
        <title>Himp Boutididact</title>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: white; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
          .card { background: #1e293b; padding: 2.5rem; border-radius: 2rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); text-align: center; border: 1px solid #334155; max-width: 600px; width: 100%; }
          h1 { color: #f59e0b; margin-top: 0; font-size: 2.2rem; margin-bottom: 0.5rem; }
          .status { background: #065f46; color: #34d399; padding: 0.5rem 1.5rem; border-radius: 9999px; font-size: 0.875rem; font-weight: bold; display: inline-block; margin-bottom: 2rem; }
          .step { background: #0f172a; padding: 1.5rem; border-radius: 1.5rem; margin-bottom: 1.5rem; text-align: left; border: 1px solid #334155; }
          .step-title { color: #f59e0b; font-weight: bold; margin-bottom: 1rem; display: block; font-size: 1.1rem; }
          input { width: 100%; padding: 0.8rem; border-radius: 0.8rem; border: 1px solid #475569; background: #1e293b; color: white; margin-bottom: 1rem; box-sizing: border-box; font-size: 1rem; }
          .code-block { background: #0f172a; padding: 1rem; border-radius: 1rem; border: 1px dashed #f59e0b; margin-top: 1rem; position: relative; }
          .code-val { color: #fef08a; font-family: monospace; font-size: 1.1rem; display: block; word-break: break-all; }
          .hint { font-size: 0.8rem; color: #64748b; margin-top: 0.5rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Himp Boutididact</h1>
          <div class="status">● Serveur de Liaison Actif</div>
          
          <div class="step">
            <span class="step-title">1️⃣ Adresse IP de l'imprimante</span>
            <p style="font-size: 0.9rem; color: #94a3b8; margin-bottom: 10px;">Entrez l'IP de votre imprimante thermique (ex: 192.168.1.26) :</p>
            <input type="text" id="printerIp" placeholder="Ex: 192.168.1.26" oninput="updateConfig()">
          </div>

          <div class="step">
            <span class="step-title">2️⃣ Configuration pour Vercel</span>
            <p style="font-size: 0.9rem; color: #94a3b8;">Copiez ces 2 informations dans votre interface d'administration Boutididact :</p>
            
            <div class="code-block">
              <span class="config-title" style="font-size: 0.7rem; color: #64748b; margin-top: 10px;">📱 POUR CET ORDINATEUR :</span>
              <span class="code-val">http://localhost:3001</span>
              
              <span class="config-title" style="font-size: 0.7rem; color: #64748b; margin-top: 10px;">🌐 POUR TABLETTES / RÉSEAU :</span>
              <span class="code-val">http://${localIp}:3001</span>
            </div>

            <div class="code-block" id="printerBox">
              <small style="color: #64748b; display:block; margin-bottom: 5px;">IP Imprimante :</small>
              <span class="code-val" id="displayIp">... (à remplir ci-dessus)</span>
            </div>
          </div>

          <p class="hint">Une fois ces infos saisies sur Vercel, cliquez sur "Tester la connexion" pour valider.</p>
        </div>

        <script>
          function updateConfig() {
            const ip = document.getElementById('printerIp').value || '...';
            document.getElementById('displayIp').innerText = ip;
          }
        </script>
      </body>
    </html>
  `);
});

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
    // Si exécuté via le .exe généré par pkg, on propose l'ajout au démarrage
    if (process.pkg && process.stdout.isTTY) {
      const fs = require('fs');
      const path = require('path');
      const { exec } = require('child_process');
      const readline = require('readline');
      
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      // Vérification si les raccourcis existent déjà
      const checkScript = `
        $s = [Environment]::GetFolderPath('Startup');
        $d = [Environment]::GetFolderPath('Desktop');
        $hasS = Test-Path (Join-Path $s 'Boutididact-Print.lnk');
        $hasD = Test-Path (Join-Path $d 'Boutididact-Print.lnk');
        if ($hasS -or $hasD) { "exists" } else { "none" }
      `.replace(/\n/g, ' ');

      exec(`powershell -Command "${checkScript}"`, (err, stdout) => {
        if (stdout.includes('exists')) {
          finish();
        } else {
          console.log('\n--- CONFIGURATION DE LA BORNE ---');
          rl.question('👉 Voulez-vous que le serveur se lance au démarrage de Windows ? (o/N) : ', (ansStartup) => {
            if (ansStartup.toLowerCase() === 'o') {
              const exePath = process.execPath;
              const iconPath = path.join(path.dirname(exePath), 'logo.ico');
              try {
                if (!fs.existsSync(iconPath)) {
                  const internalIcon = path.join(__dirname, 'logo.ico');
                  if (fs.existsSync(internalIcon)) fs.copyFileSync(internalIcon, iconPath);
                }
              } catch (e) {}

              const psScript = `
                $WshShell = New-Object -comObject WScript.Shell;
                $StartupPath = [Environment]::GetFolderPath('Startup');
                $LnkPath = Join-Path $StartupPath 'Boutididact-Print.lnk';
                $Shortcut = $WshShell.CreateShortcut($LnkPath);
                $Shortcut.TargetPath = '${exePath}';
                $Shortcut.IconLocation = '${iconPath}';
                $Shortcut.WindowStyle = 7;
                $Shortcut.Save();
              `.replace(/\n/g, ' ');
              
              exec(`powershell -Command "${psScript}"`, (err) => {
                if (err) console.error('❌ Erreur démarrage auto:', err.message);
                else console.log('✅ Configuré pour démarrer avec Windows.');
                askDesktop();
              });
            } else {
              askDesktop();
            }
          });
        }
      });

      function askDesktop() {
        rl.question('👉 Voulez-vous créer un raccourci sur le Bureau ? (o/N) : ', (ansDesktop) => {
          if (ansDesktop.toLowerCase() === 'o') {
            const exePath = process.execPath;
            const iconPath = path.join(path.dirname(exePath), 'logo.ico');
            
            const psScript = `
              $WshShell = New-Object -comObject WScript.Shell;
              $DesktopPath = [Environment]::GetFolderPath('Desktop');
              $LnkPath = Join-Path $DesktopPath 'Boutididact-Print.lnk';
              $Shortcut = $WshShell.CreateShortcut($LnkPath);
              $Shortcut.TargetPath = '${exePath}';
              $Shortcut.IconLocation = '${iconPath}';
              $Shortcut.Save();
            `.replace(/\n/g, ' ');
            
            exec(`powershell -Command "${psScript}"`, (err) => {
              if (err) console.error('❌ Erreur raccourci Bureau:', err.message);
              else console.log('✅ Raccourci créé sur le Bureau !');
              finish();
            });
          } else {
            finish();
          }
        });
      }

      function finish() {
        console.log('\n================================================');
        console.log('🚀 SERVEUR PRÊT ET EN COURS D\'EXÉCUTION');
        console.log('---');
        console.log('ℹ️  Le serveur est maintenant en attente d\'ordres.');
        console.log('👉 Dashboard de configuration : http://localhost:3001');
        console.log('================================================\n');
        
        // Ouverture automatique du navigateur
        exec('start http://localhost:3001');
        
        if (rl) rl.close();
        setInterval(() => {}, 1000 * 60 * 60);
      }
    }
  });
}

module.exports = app;
