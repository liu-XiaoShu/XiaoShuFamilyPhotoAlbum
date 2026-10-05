# 国内镜像加速（DaoCloud 代理 Docker Hub）
FROM docker.m.daocloud.io/library/python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai \
    PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PIP_TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn

# Debian apt → 清华源
# Check-Valid-Until=false：树莓派系统时钟不准时仍可构建
RUN sed -i \
      -e 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' \
      -e 's|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g' \
      /etc/apt/sources.list.d/debian.sources \
      /etc/apt/sources.list 2>/dev/null || true \
    && apt-get -o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false update \
    && apt-get -o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false install -y --no-install-recommends \
        ffmpeg \
        libheif1 \
        libde265-0 \
        openssl \
        ca-certificates \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 改代码时用 --build-arg CACHEBUST=$(date +%s) 强制刷新本层
ARG CACHEBUST=1
COPY app ./app
COPY run.py .
COPY config.example.json ./config.example.json

RUN mkdir -p album inbox data/thumbs data/brand data/map_pack data/geo data/certs

EXPOSE 8765

CMD ["python", "run.py"]
