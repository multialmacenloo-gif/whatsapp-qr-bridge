FROM node:18-slim

# Instalar dependencias de sistema para Chromium
RUN apt-get update && apt-get install -y \
    chromium-browser \
    libglib2.0-0 \
    libfreetype6 \
    libharfbuzz0b \
    ca-certificates \
    libgtk-3-0 \
    libasound2 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libmesa-glvnd0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "server.js"]
