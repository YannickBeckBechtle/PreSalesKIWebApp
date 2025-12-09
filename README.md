# Presales KI – Angebotsunterstützung

Kleine Node.js/Express-App, die eine bestehende HTML-Seite servt und für Azure Web App Deployment via GitHub vorbereitet ist.

## Lokal starten
1. `npm install`
2. `npm start`
3. App läuft auf `http://localhost:8080`

## Entwicklung (Hot Reload)
- Optional: `npm run dev` (verwendet nodemon)

## Deployment-Hinweise (Azure Web App)
- Laufzeit: Node.js (>=18)
- Startkommando: `npm start` (oder Standard-Node-Startskript)
- Statisches Serving aus `public/`
- Für GitHub Actions: Publish Profile als Secret hinterlegen (z. B. `AZURE_WEBAPP_PUBLISH_PROFILE`), App-Name als Secret/Env `AZURE_WEBAPP_NAME`.

## Struktur
- `server.js` – Express-Entry-Point
- `public/index.html` – bestehende UI
- `.github/workflows/azure-webapp.yml` – optionaler Deployment-Workflow
