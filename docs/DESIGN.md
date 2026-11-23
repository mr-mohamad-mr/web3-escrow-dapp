# Design notes

Why the code looks the way it does. For setup and usage see the
[README](../README.md).

## Contracts

```
EscrowFactory (Ownable)
  ├─ deploys one FreelanceEscrow per job (client = msg.sender)
  ├─ registry: allEscrows + escrowsByClient / escrowsByFreelancer
  └─ admin (owner): arbiter, feeBps (cap 10%), feeRecipient

FreelanceEscrow (ReentrancyGuard)
  States: Created → Funded → Delivered → Released
                              ↘ Disputed → Resolved
                              ↘ Refunded (deadline missed)
          Created → Cancelled
  Payouts: pull-over-push; release / resolveDispute / refund credit
           pendingWithdrawals, parties pull via withdraw().
  Fee: basis points on the freelancer's share, default 2.5%, cap 10%.
```

- **Milestones live inside the escrow**, not as separate contracts.
  `FreelanceEscrow` takes a `milestoneAmounts[]` array at creation; each
  amount must be > 0 and they must sum to the job total.
  `createEscrow()` deploys a one-milestone escrow, so the simple flow is
  unchanged; `createEscrowWithMilestones()` deploys a split.
- **Per-milestone lifecycle, aggregate escrow status.** Each milestone
  goes Pending → Delivered → Released on its own (and may be delivered
  out of order). The escrow status is recomputed from its milestones:
  Released only when all are released, Delivered while any is under
  review, otherwise Funded.
- **Disputes and deadline refunds split only the remaining balance**
  (`amount - releasedTotal`), so milestones already paid are never
  re-split. The fee is charged per milestone, on the freelancer's share
  only; a 0% dispute award refunds the client in full with no fee.
- **`refundAfterDeadline()` is blocked while a milestone is under
  review**: delivered work must be settled by release or dispute, not
  silently refunded.
- **One `raiseDispute()`** for both Funded and Delivered, callable by
  either party.
- **Single-milestone wrappers** (`submitDelivery` / `release` /
  `requestRevision`) work on one-milestone escrows and revert with
  `SingleMilestoneOnly` on split ones.
- **Security model:** Checks-Effects-Interactions, `ReentrancyGuard` on
  every value-moving entry point, pull payments, custom errors,
  Solidity 0.8.24 overflow checks, no `delegatecall`, plain ETH
  transfers rejected (funding only through `fund()`). A test-only
  `ReentrancyAttacker` contract proves `withdraw()` pays exactly once.

## Interaction layer (`lib/escrow.js`)

- A plain ethers v6 module, not tied to Hardhat: every action is one
  named function that sends the transaction, waits for one
  confirmation and returns `{ txHash, blockNumber }`. Reverts are
  decoded to their custom-error name.
- Reads return JSON-safe summaries (`getEscrowSummary`, `listEscrows`)
  shared by the CLI and the frontend.
- Deadlines can be absolute (unix seconds) as well as `deadlineDays`,
  because a fast-mining local node runs ahead of wall-clock time. The
  seed script uses `evm_increaseTime` for the refund demo, since a
  wall-clock sleep cannot move a local chain's timestamp.

## Frontend (`frontend/`)

- **The UI calls the interaction layer, never the contracts directly**,
  so revert decoding, confirmation waits and result shapes match the
  CLI. The activity timeline is the one read built in the client, from
  on-chain event logs using the ABIs the layer exports.
- **The CommonJS layer is bundled for the browser** by a small Vite
  plugin: esbuild inlines the artifact JSONs, stubs the layer's
  Node-only `fs`/`path` use, rewrites its `require("ethers")` to a real
  ESM import (one shared ethers instance) and re-exports the layer's
  names. The deployment file is served at `/deployment.json` rather
  than bundled, so a re-seed shows up on reload.
- **"Connect wallet" is an account picker, by design.** The app uses a
  plain `JsonRpcProvider` on the local node and lets you act as any of
  its unlocked demo accounts (client, freelancer, arbiter, ...). No
  browser wallet, no signing prompts, and it refuses to connect unless
  the node's chain id is 31337.
- **Every write goes through one `runTx` funnel** that drives the
  transaction banner (pending → confirmed with block and tx hash, or
  failed with the decoded error) and refreshes reads afterwards.
- UI role gating is a hint only; the contracts re-check every caller.

## Bugs found by the live smoke runs

- A 2-second deadline computed from wall-clock time was already past in
  chain time (Hardhat adds at least 1s per block under rapid mining).
  Fixed with absolute-deadline support plus `evm_increaseTime` in the
  seed.
- `getEscrowSummary()` returned `feeRecipient: undefined` (it read a
  field `getDetails()` does not have) and crashed the detail view on a
  pending fee row. Fixed to use the `feeRecipient()` getter.
- Vite bound to IPv6 localhost while the tooling used 127.0.0.1; the
  servers are pinned to 127.0.0.1 (overridable with `VITE_HOST`, which
  the Docker image sets to 0.0.0.0).
