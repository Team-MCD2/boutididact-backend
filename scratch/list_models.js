const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

async function listModels() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  try {
    const modelList = await genAI.listModels();
    console.log('--- MODÈLES DISPONIBLES ---');
    modelList.models.forEach(m => {
      console.log(`${m.name} (methods: ${m.supportedMethods.join(', ')})`);
    });
  } catch (e) {
    console.error('Erreur lors du listing des modèles :', e.message);
  }
}

listModels();
