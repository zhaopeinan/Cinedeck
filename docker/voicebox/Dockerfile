FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
# Prefer pre-copied source; fallback clone during build if context includes it
COPY voicebox /opt/voicebox
WORKDIR /opt/voicebox

# CPU torch first, then remaining requirements
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir -r requirements.txt \
 && pip install --no-cache-dir "uvicorn[standard]"

ENV VOICEBOX_DATA_DIR=/data/voicebox \
    HF_HUB_CACHE=/data/huggingface/hub \
    VOICEBOX_MODELS_DIR=/data/huggingface/hub \
    HF_HUB_OFFLINE=1

EXPOSE 17493
VOLUME ["/data/voicebox", "/data/huggingface"]

CMD ["python", "-m", "backend.main", "--host", "0.0.0.0", "--port", "17493", "--data-dir", "/data/voicebox"]
