#!/usr/bin/env bash
set -euo pipefail

# Resolve project root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SESSION_NAME="${PI_FATHER_TMUX_SESSION:-pi-father}"
FATHER_CWD="${PI_FATHER_CWD:-${PROJECT_ROOT}}"

if tmux has-session -t "=${SESSION_NAME}" 2>/dev/null; then
  echo "Attaching to existing Pi-Father tmux session '${SESSION_NAME}'..."
  exec tmux attach -t "${SESSION_NAME}"
fi

PI_DEFAULT_PROVIDER="${PI_DEFAULT_PROVIDER:-amazon-bedrock}"
PI_DEFAULT_MODEL="${PI_DEFAULT_MODEL:-deepseek.v3.2}"
AWS_REGION="${AWS_REGION:-us-east-1}"

echo "Starting new Pi-Father tmux session '${SESSION_NAME}' in ${FATHER_CWD} (${PI_DEFAULT_PROVIDER}/${PI_DEFAULT_MODEL})..."
tmux new-session -d -s "${SESSION_NAME}" -c "${FATHER_CWD}" bash -lc \
  "export PATH='${PATH}'; [ -f \"\$HOME/.pi/agent/.env\" ] && set -a && . \"\$HOME/.pi/agent/.env\" && set +a; export AWS_REGION='${AWS_REGION}'; export PI_DEFAULT_PROVIDER='${PI_DEFAULT_PROVIDER}'; export PI_DEFAULT_MODEL='${PI_DEFAULT_MODEL}'; export PI_TELEGRAM_AUTOCONNECT=1; exec pi --provider '${PI_DEFAULT_PROVIDER}' --model '${PI_DEFAULT_MODEL}' -e '${PROJECT_ROOT}/extensions/telegram.ts' -e '${PROJECT_ROOT}/extensions/father-spinner.ts' -c"

exec tmux attach -t "${SESSION_NAME}"
