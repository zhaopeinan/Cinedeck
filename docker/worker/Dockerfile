FROM python:3.11-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-impress \
    poppler-utils \
    ffmpeg \
    curl \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip install --no-cache-dir python-pptx pdf2image Pillow

# Clone and install Voicebox
WORKDIR /opt
RUN git clone https://github.com/jamiepine/voicebox.git \
    && cd voicebox \
    && pip install --no-cache-dir -r requirements.txt

# Copy worker agent
WORKDIR /app
COPY worker-agent.mjs .

# Shared data mount point
VOLUME /data

# Environment
ENV DISPATCHER_URL=http://dispatcher:3001
ENV WORKER_ID=""
ENV POLL_INTERVAL=2000
ENV DATA_DIR=/data

CMD ["node", "worker-agent.mjs"]
