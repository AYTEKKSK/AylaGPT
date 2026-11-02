FROM node:22-slim

# Gerekli bağımlılıkları ve cloudflared aracını yükle
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb \
    && dpkg -i cloudflared.deb \
    && rm cloudflared.deb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev || true

COPY . .

RUN chmod +x entrypoint.sh

# Bilgisayarınızla tam aynı port (8787)
ENV PORT=8787
EXPOSE 8787
EXPOSE 7860

CMD ["./entrypoint.sh"]
