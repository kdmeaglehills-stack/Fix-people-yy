# Fix People Clean Package

Use this exact package.

Render settings:
- Build Command: npm install
- Start Command: npm start
- Root Directory: empty if package.json is at repo root

Environment Variables:
- MAGNIFIC_API_KEY = your full key
- POLL_TIMEOUT_MS = 300000
- DEFAULT_RESOLUTION = 1K
- PUBLIC_BASE_URL = your Render URL after first deploy

Do not put environment variables inside package.json.
