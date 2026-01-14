FROM quay.io/iovisor/bpftrace:latest

# Install Node.js + build tools (needed for some npm native deps, incl. LevelDB bindings)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      nodejs \
      npm \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY src ./src

ENV PORT=7500
CMD ["node", "server.js"]
