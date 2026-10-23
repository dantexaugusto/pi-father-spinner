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

echo "Starting new Pi-Father tmux session '${SESSION_NAME}' in ${FATHER_CWD}..."
tmux new-session -d -s "${SESSION_NAME}" -c "${FATHER_CWD}" bash -lc \
  "export PATH='${PATH}'; export PI_TELEGRAM_AUTOCONNECT=1; exec pi -e '${PROJECT_ROOT}/extensions/telegram.ts' -e '${PROJECT_ROOT}/extensions/father-spinner.ts' -c"

exec tmux attach -t "${SESSION_NAME}"
