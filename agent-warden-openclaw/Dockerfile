FROM ghcr.io/openclaw/openclaw:2026.3.12

USER root

# Install Chrome system dependencies for agent-browser
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    libatspi2.0-0 libwayland-client0 \
    && rm -rf /var/lib/apt/lists/*

# Install agent-browser CLI
RUN npm install -g agent-browser && npm cache clean --force

# Download Chrome for agent-browser
RUN agent-browser install

# Copy browser to persistent-friendly location
RUN cp -r /root/.agent-browser /opt/agent-browser

USER node
