#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ATM_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ATM_ROOT}"
exec java "${SCRIPT_DIR}/AtmBatchLauncher.java"
