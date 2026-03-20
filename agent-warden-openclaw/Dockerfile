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
    libatspi2.0-0 libwayland-client0 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g agent-browser && npm cache clean --force
RUN agent-browser install
RUN cp -r /root/.agent-browser /opt/agent-browser

# ── Runtime stage: minimal image with just the browser files + deps ──
FROM debian:bookworm-slim

# Install only the Chrome runtime shared libraries (no npm needed)
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    libatspi2.0-0 libwayland-client0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/agent-browser /opt/agent-browser

# Default entrypoint: copy browser files to the target volume
ENTRYPOINT ["sh", "-c", "cp -a /opt/agent-browser/. /target/ && echo 'Browser files copied to /target/'"]
