# Presales KI Web App (Frontend + Backend)

Diese App besteht aus einem statischen Frontend und einem Node/Express Backend als sicherem Proxy zu Azure AI Foundry.
Der API-Key bleibt **serverseitig** (Key Vault via Managed Identity).

## Repo-Struktur
- `frontend/` – statisches HTML/CSS/JS (Single Page)
- `frontend/config.js` – zentrale Frontend-Konfiguration (API_BASE_URL, Deployment-Label)
- `backend/config/app.config.json` – nicht-sensitive Backend-Config (Endpoints, Pfade, Labels, Timeouts, CORS, Demo-Default)
- `backend/config/secrets.map.json` – Mapping, welche Key Vault Secrets geladen werden (keine Werte im Repo)
- `backend/src/config.js` – lädt app.config.json + Env-Overrides
- `backend/src/secrets.js` – lädt Secrets aus Key Vault (DefaultAzureCredential) mit Cache
- `backend/server.js` – Express-Server + API-Proxy
- `.env.sample` – Beispiel für optionale Env-Overrides (keine Secrets)

## Lokales Setup
```bash
npm install
cp .env.sample .env
npm start
```
Anschließend die UI unter `http://localhost:8080` aufrufen.

## Frontend-Konfiguration (einfach ändern)
Einzige Stelle: `frontend/config.js`
```js
window.APP_CONFIG = {
  API_BASE_URL: "",         // leer = same-origin, ansonsten z. B. https://<app>.azurewebsites.net
  DEPLOYMENT_LABEL: "default"
};
```

## Backend-Konfiguration (nicht-sensitiv)
Ändern in `backend/config/app.config.json`:
- Foundry: endpoint, chatPath, modelOrDeployment, apiKeyHeader, extraHeaders
- App: deploymentLabel, port, requestTimeoutMs, demoModeDefault
- CORS: allowedOrigins
- Power Automate: enabled, triggerUrl, authHeaderName

Env-Overrides (Azure App Settings oder `.env`), keine Secrets:
- `KEY_VAULT_URI`
- `FOUNDRY_ENDPOINT`
- `FOUNDRY_MODEL_OR_DEPLOYMENT`
- `POWER_AUTOMATE_TRIGGER_URL`
- `DEMO_MODE`
- `CORS_ALLOWED_ORIGINS`
- `PORT`

## Secrets (Key Vault)
Mapping in `backend/config/secrets.map.json` (keine Werte im Repo):
- `foundryApiKey` -> Secret `FOUNDRY_API_KEY`
- `powerAutomateKey` -> Secret `POWER_AUTOMATE_KEY`

Managed Identity benötigt mindestens **Secrets Get** auf Key Vault. Demo-Modus aktiviert sich automatisch, wenn Config unvollständig ist oder das Foundry-Secret fehlt.

## Azure App Service (Web App) Setup
1. **Managed Identity aktivieren** (System Assigned)
2. Key Vault: der Managed Identity **Secrets Get** erlauben (RBAC oder Access Policy)
3. In der Web App unter **Configuration > Application settings** nur die benötigten Env-Overrides setzen (siehe oben)
4. Deployment via `npm start` (App Service startet den Express-Server)

## Endpoints
- `GET  /api/health`
- `POST /api/generate-offer-via-flow` (Power Automate Trigger, siehe Payload unten)
- `POST /api/generate-offer` (Foundry, falls aktiviert)
- `GET  /api/run/:id`
- `GET  /api/history`
- `POST /api/feedback`

## Power Automate Payload (Frontend)
Das UI sendet beim Klick auf **Angebot generieren** folgendes JSON (Flow-URL/Key bleiben unverändert):
```json
{
  "customer": {
    "companyOrProject": "string",
    "responsiblePerson": "string",
    "contactPerson": "string"
  },
  "offer": { "primaryCategory": "string" },
  "goals": { "primary": "string", "secondary": "string" },
  "context": {
    "customerSituation": "string",
    "serviceScope": "string",
    "pt": 0,
    "details": "string",
    "additionalNotes": "string"
  }
}
```
Das Pflichtfeld **Verantwortliche Person (Kunde)** befüllt `customer.responsiblePerson`. PT bleibt `null`, wenn leer oder nicht numerisch; Dezimal-Kommas werden in Zahlen umgewandelt.

## Wie ändere ich Endpoint/Config?
1. Frontend: `frontend/config.js` anpassen (`API_BASE_URL`)
2. Backend: `backend/config/app.config.json` anpassen (Endpoints, Labels, Timeouts, PowerAutomate, CORS)
3. Secrets: Secret-Namen in `backend/config/secrets.map.json` hinterlegen, Werte im Key Vault speichern
