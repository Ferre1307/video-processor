FROM node:18

# Instalar FFmpeg y Python para edge-tts
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Instalar edge-tts (Microsoft TTS - gratis)
RUN pip3 install edge-tts --break-system-packages

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
