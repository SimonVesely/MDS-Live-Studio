#!/usr/bin/env bash
# Sestaví nginx s nginx-rtmp-module pro macOS
# Výsledek: nginx/nginx-mac (stejná verze jako Windows balíček z e-learningu).
# Potřebuje: Xcode Command Line Tools (xcode-select --install), Homebrew.
set -euo pipefail
cd "$(dirname "$0")"

NGINX_VER=1.25.3
RTMP_VER=1.2.2

brew list openssl@3 >/dev/null 2>&1 || brew install openssl@3
brew list pcre2     >/dev/null 2>&1 || brew install pcre2
OPENSSL="$(brew --prefix openssl@3)"
PCRE="$(brew --prefix pcre2)"

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
curl -fsSL "https://nginx.org/download/nginx-$NGINX_VER.tar.gz" | tar xz -C "$BUILD"
curl -fsSL "https://github.com/arut/nginx-rtmp-module/archive/refs/tags/v$RTMP_VER.tar.gz" | tar xz -C "$BUILD"

cd "$BUILD/nginx-$NGINX_VER"
./configure \
  --prefix=. --sbin-path=nginx --conf-path=conf/nginx.conf \
  --pid-path=logs/nginx.pid --error-log-path=logs/error.log --http-log-path=logs/access.log \
  --http-client-body-temp-path=temp/client_body_temp --http-proxy-temp-path=temp/proxy_temp \
  --http-fastcgi-temp-path=temp/fastcgi_temp --http-scgi-temp-path=temp/scgi_temp \
  --http-uwsgi-temp-path=temp/uwsgi_temp \
  --with-http_ssl_module \
  --add-module="../nginx-rtmp-module-$RTMP_VER" \
  --with-cc-opt="-I$OPENSSL/include -I$PCRE/include -Wno-error" \
  --with-ld-opt="-L$OPENSSL/lib -L$PCRE/lib"
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

cp objs/nginx "$OLDPWD/nginx-mac"
cd "$OLDPWD"
./nginx-mac -V 2>&1 | head -1
echo "✔ hotovo: nginx/nginx-mac – spouštěj přes ./nginx.sh"
