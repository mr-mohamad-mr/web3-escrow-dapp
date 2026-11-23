# Escrow Frontend

React + Vite frontend for the Web3 Escrow dApp — a **local-chain demo
only**. It talks to a Hardhat node on `127.0.0.1:8545` through the
interaction layer (`../lib/escrow.js`); "connecting a wallet"
means picking one of the node's unlocked demo accounts to act as.
No real wallet, no signing prompts, no mainnet/testnet, no real funds.

## Run it

From the project root, in two terminals:

```sh
npm run node          # terminal 1: local Hardhat chain on :8545
npm run seed:local    # terminal 2: deploy + seed 8 demo escrows
```

Then in this folder:

```sh
npm install
npm run dev           # http://127.0.0.1:5173
# or, for the production build:
npm run build && npm run preview   # http://127.0.0.1:4173
```

Click **Connect local wallet**, then pick an escrow. Use the account
switcher to act as the client, freelancer or arbiter and walk the
lifecycle: create → fund → deliver milestones → release / request
revisions → dispute → arbiter resolution → withdraw.

## How it works

- `src/chain/client.js` — framework-free bridge to the interaction
  layer: provider, account list with demo-role labels, one wrapper per
  layer action, and the activity timeline (built from on-chain event
  logs using the ABIs the layer exports).
- `src/components/` — ConnectBar (account picker), EscrowList,
  EscrowDetail (facts, per-milestone cards, pending withdrawals,
  escrow actions, status timeline), CreateEscrow, TxBanner
  (pending → confirmed / failed with the decoded custom-error name).
- `vite.config.js` — bundles `../lib/escrow.js` for the browser with
  esbuild (artifacts inlined, `ethers` shared, the layer's Node-only
  `fs`/`path` use stubbed) and serves `../deployments/localhost.json`
  at `/deployment.json`, so a re-seed is picked up on reload.
- Role gating on buttons is a UX hint only — the contracts re-verify
  every caller and state transition on-chain.

## Smoke test

With the node running, the seed applied, and the frontend served:

```sh
BASE_URL=http://127.0.0.1:4173 \
PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npm run smoke
```

Drives the real UI headlessly (puppeteer-core with your installed Chrome,
or a Chrome cached under `~/.cache/puppeteer`; CI uses the runner's
`/usr/bin/google-chrome`): connects, checks the 8 seeded escrows, delivers and releases
the showcase escrow's last milestone, and asserts the on-screen state.
Re-run `npm run seed:local` afterwards to restore the demo state.
