#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Load optional environment variables (API keys, overrides)
if [[ -f "${HOME}/.pi/agent/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${HOME}/.pi/agent/.env"
  set +a
fi

if [[ -f "${PROJECT_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${PROJECT_ROOT}/.env"
  set +a
fi

export AWS_REGION="${AWS_REGION:-us-east-1}"
export PI_DEFAULT_PROVIDER="${PI_DEFAULT_PROVIDER:-amazon-bedrock}"
export PI_DEFAULT_MODEL="${PI_DEFAULT_MODEL:-deepseek.v3.2}"
export PI_TELEGRAM_AUTOCONNECT=1
export PI_PROJECTS_ROOT="${PI_PROJECTS_ROOT:-${HOME}/projects}"
mkdir -p "${PI_PROJECTS_ROOT}"

cd "${PROJECT_ROOT}"
rm -f /tmp/pi-father.stop

while true; do
  if [[ -f /tmp/pi-father.stop ]]; then
    echo "[pi-father] Stop marker found (/tmp/pi-father.stop). Exiting supervisor loop."
    rm -f /tmp/pi-father.stop
    exit 0
  fi

  echo "[pi-father] Launching Pi-Father coding agent (${PI_DEFAULT_PROVIDER}/${PI_DEFAULT_MODEL})..."
  pi --provider "${PI_DEFAULT_PROVIDER}" \
     --model "${PI_DEFAULT_MODEL}" \
     -e "${PROJECT_ROOT}/extensions/telegram.ts" \
     -e "${PROJECT_ROOT}/extensions/father-spinner.ts" \
     -e "${PROJECT_ROOT}/extensions/tavily.ts" \
     -c || true

  echo "[pi-father] Pi process exited. Restarting in 3 seconds (Ctrl+C to abort)..."
  sleep 3
done
