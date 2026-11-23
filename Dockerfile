# Web3 Escrow dApp: local demo image.
# Runs a Hardhat node, deploys + seeds 8 demo escrows, serves the frontend.
# Local chain only (31337). No keys, no RPC URLs, no real network access needed at runtime.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=development \
    HARDHAT_DISABLE_TELEMETRY_PROMPT=true \
    VITE_HOST=0.0.0.0

# Root dependencies (Hardhat toolchain + OpenZeppelin)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Frontend dependencies (puppeteer-core never downloads a browser)
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm --prefix frontend ci --no-audit --no-fund

# Sources, then compile contracts (solc is fetched once, at build time) and build the UI
COPY . .
RUN npx hardhat compile && npm --prefix frontend run build

EXPOSE 8545 4173
CMD ["sh", "docker/entrypoint.sh"]
