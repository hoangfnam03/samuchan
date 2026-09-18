FROM node:22-bookworm

WORKDIR /app

RUN apt-get update && \
    apt-get install -y python3 python3-pip && \
    ln -sf /usr/bin/python3 /usr/bin/python && \
    rm -rf /var/lib/apt/lists/*

# Frontend dependencies
COPY SAMUCHAN_UI/package.json SAMUCHAN_UI/package-lock.json ./SAMUCHAN_UI/

WORKDIR /app/SAMUCHAN_UI

RUN npm ci

# Python + Playwright
RUN pip3 install --break-system-packages playwright
RUN python -m playwright install --with-deps chromium

WORKDIR /app

# Backend
COPY samuchan.py ./samuchan.py

# Frontend source
COPY SAMUCHAN_UI ./SAMUCHAN_UI

# Build React/Vite frontend
WORKDIR /app/SAMUCHAN_UI
RUN npm run build

WORKDIR /app

EXPOSE 3001

CMD ["node", "SAMUCHAN_UI/index.js"]