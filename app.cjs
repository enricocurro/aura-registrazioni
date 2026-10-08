/**
 * Avvio per Plesk (Node.js / Phusion Passenger): è il "file di avvio dell'applicazione".
 *
 * Passenger carica questo file con require(), mentre il server è un modulo ES: qui lo si
 * importa e lo si avvia. Se nella cartella dell'applicazione c'è un file `.env`, viene
 * letto prima di partire; le variabili impostate nel pannello di Plesk hanno la precedenza.
 */
const path = require("node:path");

try {
  if (typeof process.loadEnvFile === "function") process.loadEnvFile(path.join(__dirname, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") console.error(`Non riesco a leggere .env: ${error.message}`);
}

import("./server.mjs")
  .then((server) => server.start())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
