# Web3 Escrow dApp

[![CI](https://github.com/mr-mohamad-mr/web3-escrow-dapp/actions/workflows/ci.yml/badge.svg)](https://github.com/mr-mohamad-mr/web3-escrow-dapp/actions/workflows/ci.yml)
![Solidity](https://img.shields.io/badge/Solidity-0.8.24-363636)
![Hardhat](https://img.shields.io/badge/Hardhat-2.29-yellow)
![ethers](https://img.shields.io/badge/ethers-v6-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-green)

Milestone-based escrow for freelance work on Ethereum. A client locks
payment in a contract, the freelancer delivers milestone by milestone,
and each milestone is paid out when the client accepts it. If things go
wrong, either side can open a dispute and a neutral arbiter splits only
the money that has not been paid yet.

The repo contains the Solidity contracts, a 39-test Hardhat suite, an
ethers v6 interaction layer, a CLI, a seed script with demo data in
every state, a React frontend, and a one-command Docker demo.

> **Local chain only.** Everything runs against a local Hardhat node
> (chain id 31337) with Hardhat's well-known test accounts. There is no
> testnet or mainnet configuration, no browser-wallet connection and no
> real signing, by design. The contracts have not been audited; this is
> a portfolio/demo project, not production code.

## Quick start (Docker)

```bash
git clone https://github.com/mr-mohamad-mr/web3-escrow-dapp.git
cd web3-escrow-dapp
docker compose up --build
```

The container starts a Hardhat node, deploys the factory, seeds 8 demo
escrows and serves the frontend:

- App: http://localhost:4173
- Local RPC: http://localhost:8545 (chain id 31337)

Both ports are bound to `127.0.0.1` only. Stop with `docker compose down`;
every start is a fresh chain with the same demo data.

## Quick start (Node.js)

Requires Node.js 22 (the version CI and the Docker image use).

```bash
npm install
npm --prefix frontend install

npx hardhat test                 # 39 tests on the in-process Hardhat network

# terminal 1: local chain
npm run node

# terminal 2: deploy + seed, then the app
npm run seed:local               # factory + 8 demo escrows
npm run app:build && npm run app:serve   # http://127.0.0.1:4173
# or: npm run app:dev            # http://127.0.0.1:5173
```

Click **Connect local wallet**, pick an escrow, and use the account
switcher to act as the client, freelancer or arbiter.

## How it works

1. **Create.** The client creates an escrow through the factory:
   `createEscrow(freelancer, amount, deadline)` for one payment, or
   `createEscrowWithMilestones(freelancer, [2 ETH, 3 ETH], deadline)` for
   a milestone split. The platform fee (default 2.5%, capped at 10%) and
   the arbiter are set by the factory owner.
2. **Fund.** The client locks the exact agreed amount with `fund()`.
3. **Deliver.** The freelancer submits each milestone with
   `submitMilestoneDelivery(index, contentHash)` (e.g. an IPFS CID).
4. **Review.** The client releases a milestone with
   `releaseMilestone(index)`, asks for changes with
   `requestMilestoneRevision(index, reason)`, or either party calls
   `raiseDispute(reason)`.
5. **Settle.** A released milestone credits the freelancer (minus the
   fee). In a dispute the arbiter calls `resolveDispute(freelancerShareBps)`
   over the *remaining* balance only. If the deadline passes with no
   milestone under review, the client reclaims the remainder with
   `refundAfterDeadline()`.
6. **Withdraw.** All payouts use the pull pattern: each party collects
   with `withdraw()`.

```
Created ──fund──▶ Funded ──deliver──▶ Delivered ──release──▶ Released
   │                │  ▲                  │
 cancel             │  └──revision────────┤
   ▼                │                     │
Cancelled           ├──deadline──▶ Refunded
                    └──────────dispute────┴──▶ Disputed ──arbiter──▶ Resolved
```

## Project structure

```
contracts/
  FreelanceEscrow.sol         one job: milestones, fees, disputes, refunds, pull payouts
  EscrowFactory.sol           deploys escrows, per-party registry, fee/arbiter admin
  test/ReentrancyAttacker.sol test-only malicious payee
lib/escrow.js                 ethers v6 interaction layer (used by scripts, CLI and UI)
scripts/
  deploy.js                   deploy + full-lifecycle smoke run
  seed.js                     deploy + 8 demo escrows, writes deployments/localhost.json
  interact.js                 CLI over the local RPC
  wait-for-rpc.js             waits for the local node (Docker/CI)
test/                         Hardhat + chai test suites
frontend/                     React 18 + Vite 5 app (see frontend/README.md)
docker/entrypoint.sh          node → seed → frontend, in one container
Dockerfile, docker-compose.yml
docs/DESIGN.md                design decisions and trade-offs
.github/workflows/ci.yml      tests, build, local-chain e2e, Docker check
```

## Security model

- Checks-Effects-Interactions everywhere; payouts are credited to
  `pendingWithdrawals` and pulled with `withdraw()`, so a failing
  recipient can never block a settlement.
- OpenZeppelin `ReentrancyGuard` on every value-moving entry point,
  proven by a malicious re-entering contract in the tests.
- Every role and state transition is checked on-chain; custom errors
  instead of revert strings; Solidity 0.8 overflow checks; no
  `delegatecall`; plain ETH transfers are rejected.
- Disputes and refunds only touch the unreleased remainder, so paid
  milestones are never re-split.

More detail in [docs/DESIGN.md](docs/DESIGN.md).

## Tests

```bash
npx hardhat test
```

**39 passing, 0 failing**:

| Suite | Tests | Covers |
| --- | --- | --- |
| `FreelanceEscrow.test.js` | 18 | lifecycle, exact fee splits, revisions, cancel, deadline refund, dispute splits (60/40, 0%, 100%), access control, reentrancy |
| `Milestones.test.js` | 11 | milestone creation rules, per-milestone payouts, out-of-order delivery, guards, remainder-only disputes and refunds |
| `EscrowFactory.test.js` | 6 | registry, events, admin controls, 10% fee cap |
| `InteractLayer.test.js` | 4 | `lib/escrow.js` end to end, including revert decoding |

CI (GitHub Actions) also runs, on every push: the frontend build, an
end-to-end job (local node → seed → CLI → headless browser test that
delivers and releases a milestone through the UI), and a Docker job that
builds the image, waits for the healthcheck and verifies the chain id
and the 8 seeded escrows.

## Demo data

`npm run seed:local` (and the Docker image) deploys a fresh factory and
creates 8 escrows covering every state:

| Escrow | State | Notes |
| --- | --- | --- |
| Website redesign | Created | 3 ETH, unfunded |
| Mobile app MVP | Funded | 5 ETH in milestones [2, 3] |
| Landing page + copy | Delivered | 1.5 ETH, awaiting review |
| API integration | Released | 2 ETH, freelancer withdrew |
| Logo & brand kit | Disputed | 2 ETH, awaiting the arbiter |
| Blog migration | Resolved | 4 ETH split 50/50 |
| Data cleanup | Refunded | 1 ETH returned after the deadline |
| Dashboard build | Delivered | 5 ETH in [2, 2, 1]: one paid, one under review, one pending |

Demo accounts (Hardhat defaults): 0 owner, 1 client, 2 freelancer,
3 arbiter, 4 fee recipient, 5 second freelancer.

## CLI

```bash
npm run interact -- list
npm run interact -- details <escrow>
npm run interact -- --signer 2 deliver <escrow> 0 QmYourDeliveryHash
npm run interact -- --signer 1 release <escrow> 0
npm run interact -- --signer 2 withdraw <escrow>
```

Also: `create`, `create-milestones`, `fund`, `revise`, `dispute`,
`resolve`, `refund`, `cancel`. See `scripts/interact.js`.

## Tech stack

Solidity 0.8.24 · Hardhat 2 · OpenZeppelin Contracts 5 · ethers v6 ·
Mocha/Chai · React 18 · Vite 5 · puppeteer-core · Docker · GitHub Actions

## Author

**Mamad Mirza**, full-stack developer based in London, UK, with 2–3
years of experience. Available for freelance work at $20/hour.

- GitHub: [@mr-mohamad-mr](https://github.com/mr-mohamad-mr)
- LaborX: [profile](https://laborx.com/freelancers/users/id476418)

## License

[MIT](LICENSE)
