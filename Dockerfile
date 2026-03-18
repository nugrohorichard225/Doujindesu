FROM node:20-bookworm-slim

# Install curl-impersonate-chrome (TLS fingerprint impersonation)
# Same approach as botasaurus: impersonate Chrome's JA3 TLS fingerprint
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    && wget -q https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz \
    -O /tmp/curl-impersonate.tar.gz \
    && mkdir -p /tmp/curl-impersonate \
    && tar -xzf /tmp/curl-impersonate.tar.gz -C /tmp/curl-impersonate \
    && cp /tmp/curl-impersonate/curl-impersonate-chrome /usr/local/bin/ \
    && cp /tmp/curl-impersonate/curl-impersonate-ff /usr/local/bin/ \
    && find /tmp/curl-impersonate -name "libcurl-*" -exec cp {} /usr/local/lib/ \; \
    && find /tmp/curl-impersonate -name "*.so*" -exec cp {} /usr/local/lib/ \; 2>/dev/null || true \
    && ldconfig \
    && chmod +x /usr/local/bin/curl-impersonate-chrome /usr/local/bin/curl-impersonate-ff \
    && rm -rf /tmp/curl-impersonate /tmp/curl-impersonate.tar.gz \
    && apt-get purge -y wget \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Shared libs needed by curl-impersonate
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libnspr4 \
    && rm -rf /var/lib/apt/lists/*

ENV CURL_IMPERSONATE_PATH=/usr/local/bin/curl-impersonate-chrome

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser appuser \
    && mkdir -p /app /home/appuser /tmp/mirror-cookies \
    && chown -R appuser:appuser /app /home/appuser /tmp/mirror-cookies

WORKDIR /app

COPY package*.json ./
RUN npm ci --production && npm cache clean --force

COPY . .

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
