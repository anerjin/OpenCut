FROM python:3.12-slim

WORKDIR /app

# 시스템 의존성 (VSR + OpenCV 필요)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# FastAPI 서버 의존성
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# VSR Python 의존성 (vsr/ 가 볼륨 마운트 전에는 없으므로 런타임에 설치 필요)
# 런타임 설치는 entrypoint에서 처리: 빌드 시에는 FastAPI만 설치
# 실제 컨테이너 시작 후 최초 1회: docker exec vsr pip install -r /app/vsr/requirements.txt

COPY main.py .

EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:8001/health || exit 1

CMD ["python", "main.py"]
