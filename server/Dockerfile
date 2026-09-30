FROM node:20-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
# Force linux/x64 native build (avoid wrong-arch prebuilds under qemu)
ENV npm_config_platform=linux \
    npm_config_arch=x64 \
    npm_config_target_arch=x64
RUN npm ci && npm rebuild better-sqlite3 --build-from-source
COPY . .
RUN npx tsc && npm prune --omit=dev

FROM node:20-slim

# PPT 备注解析 + 转图片 + 视频合成 + 数字人 docker exec
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    libreoffice-impress \
    poppler-utils \
    fonts-noto-cjk \
    ffmpeg \
    docker.io \
    fonts-dejavu-core \
    && pip3 install --no-cache-dir --break-system-packages \
      python-pptx \
      pdf2image \
      Pillow \
      matplotlib \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts/fix_pptx_omml.py ./scripts/fix_pptx_omml.py

EXPOSE 3001
CMD ["node", "dist/index.js"]
