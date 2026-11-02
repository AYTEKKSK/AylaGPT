#!/bin/bash
set -e

export PORT=${PORT:-8787}

# 1. Cloudflare Tunnel kimlik dosyasını oluştur ve başlat
if [ -n "$CLOUDFLARE_TUNNEL_CREDENTIALS" ]; then
    echo "Cloudflare Tunnel kimlik dosyasi yaziliyor..."
    echo "$CLOUDFLARE_TUNNEL_CREDENTIALS" > /app/tunnel-credentials.json
    echo "Cloudflare Tunnel (HF Spaces Replica) baslatiliyor..."
    cloudflared tunnel --config /app/cloudflared-config.yml run &
else
    echo "UYARI: CLOUDFLARE_TUNNEL_CREDENTIALS secret'i tanimli degil!"
fi

# 2. Node.js sunucusunu baslat
echo "Node.js sunucusu $PORT portunda baslatiliyor..."
exec node server/index.js
