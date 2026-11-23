#!/bin/sh
# One-container local demo: Hardhat node -> deploy + seed -> frontend.
# Local chain only (chain id 31337); nothing here talks to a real network.
set -eu

echo "[demo] starting Hardhat node on 0.0.0.0:8545"
npx hardhat node --hostname 0.0.0.0 --port 8545 > /tmp/hardhat-node.log 2>&1 &
NODE_PID=$!
trap 'kill "$NODE_PID" 2>/dev/null || true' INT TERM EXIT

node scripts/wait-for-rpc.js http://127.0.0.1:8545 90

echo "[demo] deploying the factory and seeding 8 demo escrows"
npx hardhat run scripts/seed.js --network localhost

echo "[demo] frontend on http://localhost:4173 (RPC on http://localhost:8545)"
cd frontend
exec npx vite preview --host 0.0.0.0 --port 4173 --strictPort
