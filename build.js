const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

async function build() {
  try {
    const exePath = path.resolve('Boutididact-Print-Server.exe');

    // Vérifier si le fichier est verrouillé (déjà en cours d'exécution)
    if (fs.existsSync(exePath)) {
      try {
        fs.unlinkSync(exePath);
      } catch (e) {
        console.error('❌ ERREUR : Le fichier Boutididact-Print-Server.exe est en cours d\'utilisation.');
        console.error('👉 Veuillez fermer l\'application avant de relancer le build.');
        process.exit(1);
      }
    }

    console.log('🚀 Compilation de l\'EXE (Mode sans corruption d\'icône)...');
    execSync('npx pkg . --output Boutididact-Print-Server.exe', { stdio: 'inherit' });

    console.log('✅ Build terminé ! Le logo sera appliqué sur le raccourci Bureau.');
  } catch (error) {
    console.error('❌ Erreur lors du build :', error.message);
    process.exit(1);
  }
}

build();
