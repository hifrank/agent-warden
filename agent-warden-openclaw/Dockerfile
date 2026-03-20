# Browser init container — installs Chrome + deps for OpenClaw's agent-browser.
# Copies browser files to /opt/agent-browser which is shared with the gateway
# container via an emptyDir volume. This keeps the upstream OpenClaw image clean.
#
# Build: docker build --platform linux/amd64 -t <acr>/browser-init:latest .
# Usage: Init container copies /opt/agent-browser/* to shared volume.

FROM node:22-slim AS builder

# Install Chrome system dependencies + agent-browser
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    libatspi2.0-0 libwayland-client0 libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g agent-browser && npm cache clean --force
RUN agent-browser install
RUN cp -r /root/.agent-browser /opt/agent-browser

# Collect Chrome's shared-library dependencies into /opt/agent-browser/lib
# so the gateway container can use them via LD_LIBRARY_PATH.
# Also copy NSS PKCS#11 modules (libsoftokn3, libfreeblpriv3) that Chrome
# loads at runtime via dlopen — these aren't caught by ldd.
RUN mkdir -p /opt/agent-browser/lib && \
    CHROME=$(find /opt/agent-browser -name chrome -type f | head -1) && \
    ldd "$CHROME" 2>/dev/null | grep '=>' | awk '{print $3}' | \
    while read -r lib; do [ -f "$lib" ] && cp -L "$lib" /opt/agent-browser/lib/; done && \
    for nss in libsoftokn3.so libfreeblpriv3.so libfreebl3.so; do \
      f=$(find /usr/lib -name "$nss" 2>/dev/null | head -1); \
      [ -f "$f" ] && cp -L "$f" /opt/agent-browser/lib/; \
    done && \
    echo "Collected $(ls /opt/agent-browser/lib/ | wc -l) shared libs"

# Create google-chrome symlink so tools can find Chrome at a standard path.
RUN mkdir -p /opt/agent-browser/bin && \
    CHROME=$(find /opt/agent-browser/browsers -name chrome -type f | head -1) && \
    ln -s "$CHROME" /opt/agent-browser/bin/google-chrome

# ── Runtime stage: minimal image with browser files + shared libs ──
FROM debian:bookworm-slim

COPY --from=builder /opt/agent-browser /opt/agent-browser

# Default entrypoint: copy browser files + libs to the target volume
ENTRYPOINT ["sh", "-c", "cp -a /opt/agent-browser/. /target/ && echo 'Browser files copied to /target/'"]
