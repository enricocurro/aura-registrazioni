# Aura Registrazioni

Piattaforma autonoma per **registrare conversazioni** (reali o recitate) e farle **valutare allo psicologo** battuta per battuta, conservando l'audio e le misure della voce (volume, pause, velocità, intonazione).

È un servizio separato dall'app Aura: ha il suo repository e il suo deploy, e non va incorporato in `apps/admin` né in `apps/api` (ADR-003 di Aura). A differenza dell'app, qui l'audio **viene conservato**: è lo scopo dello strumento.

## Cosa fa

| Accesso | Cosa vede |
|---|---|
| `user` | Solo i pulsanti **Avvia registrazione reale** e **Recita una conversazione**. Dopo ogni registrazione la pagina torna vuota: chi registra non vede mai ciò che è stato raccolto. |
| `admin` | Gli stessi pulsanti, più **Valuta registrazioni**. |

- **Avvia registrazione reale** — consenso, conto alla rovescia 3-2-1, registrazione fino a «Termina». Il server divide poi l'audio in battute (una battuta finisce dopo 0,8 s di silenzio).
- **Recita una conversazione** — propone ogni volta una conversazione nuova (generata, oppure presa da `copioni.json`), da leggere una battuta alla volta come in un karaoke. Si avanza con il pulsante o con la barra spaziatrice: ogni passaggio segna il confine della battuta.
- **Valuta registrazioni** — elenco delle registrazioni; per ognuna l'audio da ascoltare, le battute con la trascrizione (correggibile), la scelta **Aggressivo / Assertivo / Neutro**, un campo note, e le misure della voce. Esportazione in CSV. In ogni battuta **Trascrizione** ed **Esito analisi** sono chiusi e si aprono cliccando sulla rispettiva etichetta, così chi valuta ascolta prima di leggere.

## Analisi automatica

Chiusa la registrazione e finita la trascrizione, ogni battuta viene classificata con i prompt di Aura: la cascata a due chiamate del backend (prompt aggressivo con le due battute precedenti come contesto; se non è aggressiva, prompt assertivo), `openai/gpt-4.1`, temperatura 0,2. I testi in `lib/prompts/` sono la copia esatta dei prompt del committente (`Prompt_aggressivo_BEST.txt` e `Prompt_assertivo_CoT_BEST.txt` di Aura); la variante che legge il TARGET dentro lo scambio **non** è inclusa, perché introduce falsi positivi.

- L'esito si vede **solo** in «Valuta registrazioni» (e nella colonna `esito_analisi` del CSV): chi registra non riceve alcun riscontro, né durante né dopo.
- Si analizza il testo trascritto (o corretto a mano); se manca, quello del copione. Correggendo una trascrizione, la battuta e le due successive vengono analizzate di nuovo. «Completa l'analisi» analizza solo le battute senza un esito valido (mai analizzate, fallite, o col testo cambiato): quelle già analizzate non vengono rifatte.
- Questi prompt **non hanno superato il gate FN=0 di Aura**: l'esito è materiale di confronto con la valutazione dello psicologo, non un giudizio clinicamente validato.

## Avvio in locale

Serve Node 20.6 o superiore. Nessuna dipendenza da installare.

```bash
cp .env.example .env      # impostare almeno USER_PASSWORD, ADMIN_PASSWORD, SESSION_SECRET
npm run dev               # http://localhost:3000
npm test
```

## Configurazione

Tutto passa da variabili d'ambiente, descritte in `.env.example`.

| Variabile | Obbligatoria | A cosa serve |
|---|---|---|
| `USER_PASSWORD`, `ADMIN_PASSWORD` | sì | Le due password (devono essere diverse). I nomi utente sono `user` e `admin`, modificabili con `USER_USERNAME` / `ADMIN_USERNAME`. |
| `SESSION_SECRET` | consigliata | Firma dei cookie di sessione. Senza, le sessioni si azzerano a ogni riavvio. |
| `DATA_DIR` | consigliata | Dove finiscono audio e valutazioni. In produzione deve essere un **disco persistente**. |
| `TRUST_PROXY=1` | in produzione | Da impostare quando l'HTTPS è gestito dall'hosting o da un proxy. |
| `GOOGLE_STT_CREDENTIALS_JSON`, `GOOGLE_STT_LOCATION` | no | Trascrizione automatica: le stesse variabili del backend Aura. Senza, il testo si scrive a mano. |
| `OPENROUTER_API_KEY` | no | Analisi automatica delle battute e conversazioni generate ogni volta. Senza, niente esito dell'analisi e si usano i copioni di `copioni.json`. |
| `ANALYSIS_MODEL` | no | Modello dell'analisi (default `openai/gpt-4.1`, quello di Aura). |
| `MAX_MINUTES` | no | Durata massima di una registrazione (default 30). |

## Pubblicazione

Due requisiti non negoziabili:

1. **HTTPS.** I browser concedono il microfono solo alle pagine servite in HTTPS (o su `localhost`).
2. **Disco persistente** per `DATA_DIR`. Su un hosting con filesystem effimero le registrazioni spariscono a ogni deploy.

Con Docker:

```bash
docker build -t aura-registrazioni .
docker run -d -p 3000:3000 --env-file .env -e TRUST_PROXY=1 -v aura-registrazioni-data:/data aura-registrazioni
```

Senza Docker, su qualunque macchina con Node: `node --env-file=.env server.mjs`, dietro un proxy che fornisca l'HTTPS (nginx, Caddy) o su un servizio che lo gestisce (Render, Railway, Fly.io: comando di avvio `node server.mjs`, un volume montato sul percorso di `DATA_DIR`).

Il servizio è un processo solo, con i dati su file: va tenuto su **una sola istanza**.

## Dati salvati

Per ogni registrazione, in `DATA_DIR/recordings/`:

| File | Contenuto |
|---|---|
| `<id>.wav` | Audio completo, PCM 16 bit mono, non elaborato (cancellazione dell'eco, riduzione del rumore e guadagno automatico sono spenti in registrazione). |
| `<id>.json` | Scheda: battute, trascrizioni, valutazioni, note, misure, esito dell'analisi con la risposta di ciascuno dei due prompt. |
| `<id>.analysis.json` | Volume (RMS) e intonazione (Hz) ogni 20 ms, per tutta la registrazione. |

Avendo l'audio originale, ogni misura si può ricalcolare in seguito con altri metodi.

### Colonne del CSV

`dialogo, riga, nome, testo, annotazione, nota` sono le stesse dei CSV di annotazione usati finora in Aura. In più: testo del copione e indicazione di tono (solo recitate), testo originale della trascrizione automatica, inizio/fine/durata, secondi di parlato, pausa prima della battuta, pause interne, parole al secondo, volume medio e di picco (dBFS), intonazione mediana/bassa/alta/deviazione standard (Hz), esito dell'analisi automatica.

## Privacy

- Le registrazioni contengono **voci di persone**, e quelle reali anche ciò che dicono: sono dati personali. Prima di ogni registrazione la pagina chiede di confermare il consenso dei presenti; l'informativa e la base giuridica restano a carico di chi pubblica il servizio.
- Chi registra non può riascoltare né vedere nulla. Solo `admin` accede ad audio e valutazioni, e può eliminare definitivamente una registrazione.
- Con la trascrizione attiva, l'audio delle singole battute viene inviato a Google Speech-to-Text (regione `eu` di default). Con l'analisi attiva, il **testo** di ogni battuta (anche delle registrazioni reali) viene inviato a OpenRouter insieme alle due battute precedenti; l'audio no. I copioni generati passano da OpenRouter, ma non contengono dati di nessuno.
- Le registrazioni raccolte qui **non vanno usate nella suite di regressione dell'app** senza una decisione esplicita (regola 6 di Aura: mai regressione su dati reali).

## Limiti noti

- Chi parla non viene riconosciuto in automatico: nelle recitate il nome viene dal copione, nelle reali lo scrive chi valuta (campo «Chi parla»).
- Nelle recitate il confine fra le battute è il momento in cui si preme «Battuta successiva»: se si preme in ritardo o in anticipo, l'audio della battuta si sposta di conseguenza.
- La trascrizione automatica lavora su battute fino a 58 secondi; le registrazioni reali vengono spezzate a 20 secondi.
- Una registrazione abbandonata (pagina chiusa senza terminare) resta «interrotta»: `admin` può elaborare l'audio arrivato oppure eliminarla.

## Struttura

```
server.mjs            server HTTP, accesso, API
lib/audio.mjs         divisione in battute, volume, pause, intonazione
lib/process.mjs       chiusura di una registrazione (WAV, misure, battute, trascrizione, analisi)
lib/stt.mjs           Google Speech-to-Text v2
lib/analysis.mjs      analisi delle battute (cascata a due prompt, OpenRouter)
lib/prompts/          i due prompt di Aura, copia esatta
lib/scripts.mjs       copioni: raccolta e generazione
lib/store.mjs         archivio su file
lib/auth.mjs          sessioni
copioni.json          raccolta di conversazioni da recitare (modificabile)
public/               interfaccia (una pagina, senza librerie)
test/                 node --test
```
