#!/usr/bin/env bash
# macOS / Linux spouštění nginx s konfigurací projektu.
#   ./nginx.sh          start (v popředí, Ctrl+C = konec)
#   ./nginx.sh stop | reload | test
set -euo pipefail
cd "$(dirname "$0")"

BIN=./nginx-mac
[ -x "$BIN" ] || BIN="$(command -v nginx || true)"
if [ -z "$BIN" ]; then
  echo "✖ nginx nenalezen – spusť ./build-macos.sh"; exit 1
fi
if ! "$BIN" -V 2>&1 | grep -q rtmp; then
  echo "✖ $BIN nemá nginx-rtmp-module – spusť ./build-macos.sh"; exit 1
fi

mkdir -p logs temp/hls
ARGS=(-p "$PWD/" -c conf/nginx.conf)

case "${1:-start}" in
  start)  "$BIN" -t -q "${ARGS[@]}" && echo "▶ nginx běží (https://localhost) – Ctrl+C ukončí" && exec "$BIN" "${ARGS[@]}" ;;
  stop)   "$BIN" "${ARGS[@]}" -s stop ;;
  reload) "$BIN" "${ARGS[@]}" -s reload ;;
  test)   "$BIN" -t "${ARGS[@]}" ;;
  *)      echo "Použití: $0 [start|stop|reload|test]"; exit 1 ;;
esac
