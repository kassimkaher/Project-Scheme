#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required." >&2
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code is required and must be authenticated first." >&2
  exit 1
fi

if [ ! -f .env.local ]; then
  cp .env.example .env.local
  KEY="$(openssl rand -base64 32)"
  python3 - "$KEY" <<'PY'
from pathlib import Path
import sys
p=Path('.env.local')
s=p.read_text().replace('QA_MASTER_KEY=change-me-before-use', 'QA_MASTER_KEY='+sys.argv[1])
p.write_text(s)
PY
  echo "Created .env.local with a fresh QA_MASTER_KEY."
fi

npm install
npm run qa:doctor
printf '\nReady. Start with: npm run dev\nOpen: http://127.0.0.1:4100\n'
