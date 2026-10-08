# Pubblicazione su Plesk (Node.js)

Il pacchetto non ha dipendenze da installare: si carica, si configura e si avvia.

## 1. Prima di iniziare

- Un dominio o sottodominio dedicato, con **certificato SSL attivo** (Let's Encrypt va bene). Senza HTTPS il browser non concede il microfono.
- L'estensione **Node.js** di Plesk, con una versione di Node **20.12 o superiore** (consigliata la 22).

## 2. Caricare i file

1. In **File**, crea una cartella `aura-registrazioni` nella radice dello spazio del dominio, **accanto** a `httpdocs` e non dentro.
2. Carica lì dentro il file zip ed estrailo.
3. Nella stessa cartella carica il file delle credenziali rinominandolo **`.env`** (v. sotto).

Alla fine la cartella contiene `app.cjs`, `server.mjs`, `lib/`, `public/`, `.env`, ecc.

## 3. Credenziali e impostazioni

Tutta la configurazione sta nel file `.env`, letto all'avvio. Il modello è `.env.example`.

| Variabile | Valore |
|---|---|
| `USER_PASSWORD`, `ADMIN_PASSWORD` | le due password di accesso (diverse fra loro) |
| `SESSION_SECRET` | una stringa casuale lunga |
| `TRUST_PROXY`, `COOKIE_SECURE` | `1` |
| `GOOGLE_STT_CREDENTIALS_JSON` | la chiave del service account Google, su una riga sola fra apici singoli — la stessa del backend Aura |
| `GOOGLE_STT_LOCATION` | `eu` |
| `OPENROUTER_API_KEY` | la chiave OpenRouter |

Due alternative, se preferisci non usare il file:

- **Variabili d'ambiente di Plesk** (pannello Node.js → *Custom environment variables*): hanno la precedenza sul file `.env`. Vanno bene per password e chiave OpenRouter; per la chiave Google è facile che il pannello rovini virgolette e ritorni a capo.
- **Chiave Google come file**: carica il JSON del service account nella cartella dell'app come `google-credentials.json` e imposta `GOOGLE_STT_CREDENTIALS_FILE=google-credentials.json` al posto di `GOOGLE_STT_CREDENTIALS_JSON`.

Senza credenziali Google la piattaforma funziona lo stesso (il testo si scrive a mano); senza OpenRouter usa le conversazioni di `copioni.json`.

## 4. Attivare l'applicazione

Nel pannello **Node.js** del dominio:

| Campo | Valore |
|---|---|
| Node.js Version | 20.12 o superiore |
| Document Root | `/aura-registrazioni/public` |
| Application Mode | `production` |
| Application Root | `/aura-registrazioni` |
| Application Startup File | `app.cjs` |

Poi **Enable Node.js**. Non serve «NPM install». Dopo ogni modifica al file `.env` o ai file dell'app: **Restart App**.

## 5. Controlli dopo l'attivazione

1. Apri `https://tuo-dominio/`: deve comparire la pagina di accesso.
2. Apri `https://tuo-dominio/.env` e `https://tuo-dominio/data/`: devono dare **errore (404 o 403)**. Se si aprono, il *Document Root* non punta a `public`: correggilo subito, perché credenziali e registrazioni sarebbero scaricabili da chiunque.
3. Accedi come `user`, fai una registrazione di prova, poi accedi come `admin` e controlla che compaia con la trascrizione.

Se la pagina dà errore, i messaggi di avvio dell'applicazione sono nei **Log** del dominio (ad esempio «Variabili mancanti: …»).

## Dove sono i dati

In `aura-registrazioni/data/`: audio, schede e analisi. È la cartella da includere nei backup. Per spostarla altrove imposta `DATA_DIR` con un percorso assoluto.

## Aggiornare

Carica il nuovo zip nella stessa cartella, estrailo sovrascrivendo, e premi **Restart App**. `.env` e `data/` non sono nello zip e non vengono toccati.
