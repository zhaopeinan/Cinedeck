FROM node:22-bookworm-slim

# Chromium deps + fonts + ffmpeg for official HyperFrames render
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROME_PATH=/usr/bin/chromium \
    HYPERFRAMES_BROWSER_PATH=/usr/bin/chromium \
    HYPERFRAMES_BROWSER_EXECUTABLE=/usr/bin/chromium

WORKDIR /opt/hyperframes
RUN npm install -g hyperframes@0.8.4

# Non-root friendly workdir for mounted compositions
WORKDIR /work
ENTRYPOINT ["hyperframes"]
CMD ["--help"]
