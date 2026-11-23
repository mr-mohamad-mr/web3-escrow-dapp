// Ethers.js interaction layer for the Web3 Escrow dApp.
//
// The single place the frontend and scripts talk to the
// contracts through: every escrow action is one named function that
// sends the transaction, waits for one confirmation and returns a
// plain-object result. Reverts are decoded to their custom-error name
// where possible instead of surfacing raw hex.
//
// Local chain only — no mainnet/testnet, no real wallet, no real funds.
// Works with any ethers v6 provider/signer; the Hardhat signers on a
// local node are the intended signers in scripts.
//
// Usage (Node):
//   const { getEscrowSummary, createMilestoneEscrow } = require("./lib/escrow");
//   const summary = await getEscrowSummary(provider, escrowAddress);
//   const { escrowAddress } = await createMilestoneEscrow(signer, factoryAddress,
//     { freelancer, amountsEth: ["2", "3"], deadlineDays: 14 });
//
// The ABIs are exported too, so a browser build (the frontend) can reuse
// them without reading the Hardhat artifacts directory.

const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

const FACTORY_ARTIFACT = require("../artifacts/contracts/EscrowFactory.sol/EscrowFactory.json");
const ESCROW_ARTIFACT = require("../artifacts/contracts/FreelanceEscrow.sol/FreelanceEscrow.json");

const FACTORY_ABI = FACTORY_ARTIFACT.abi;
const ESCROW_ABI = ESCROW_ARTIFACT.abi;

const STATUS_NAMES = [
  "Created",
  "Funded",
  "Delivered",
  "Disputed",
  "Released",
  "Refunded",
  "Cancelled",
  "Resolved",
];
const MILESTONE_STATUS_NAMES = ["Pending", "Delivered", "Released"];

// ---------------------------------------------------------------------------
// Contract handles
// ---------------------------------------------------------------------------

function getFactory(providerOrSigner, factoryAddress) {
  return new ethers.Contract(factoryAddress, FACTORY_ABI, providerOrSigner);
}

function getEscrow(providerOrSigner, escrowAddress) {
  return new ethers.Contract(escrowAddress, ESCROW_ABI, providerOrSigner);
}

/// @notice Read a deployment file written by scripts/seed.js.
function loadDeployment(network = "localhost") {
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment file found: ${file} — run scripts/seed.js first.`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatEth(wei) {
  return ethers.formatEther(wei);
}

function deadlineTimestamp(deadlineDays) {
  return Math.floor(Date.now() / 1000) + Math.round(deadlineDays * 24 * 60 * 60);
}

/// @notice Resolve the deadline for a new escrow: an absolute unix
///         timestamp (`options.deadline`) wins; otherwise `deadlineDays`
///         from now. Absolute deadlines are the right choice when the
///         caller already knows the chain's clock (e.g. seed scripts),
///         because a fast-mining local node can run ahead of wall-clock
///         time.
function resolveDeadline(options) {
  if (options.deadline !== undefined && options.deadline !== null) {
    return Math.floor(Number(options.deadline));
  }
  return deadlineTimestamp(options.deadlineDays ?? 7);
}

/// @notice Turn an ethers revert into a readable message: prefer the
///         contract's custom-error name (e.g. `InvalidMilestoneStatus`)
///         over the raw revert data.
function decodeError(error, contract) {
  const data = findRevertData(error);
  if (data && contract) {
    try {
      const parsed = contract.interface.parseError(data);
      if (parsed) {
        const args = parsed.args.map((a) => String(a)).join(", ");
        return `${parsed.name}(${args})`;
      }
    } catch {
      // Not a known custom error — fall through to the raw message.
    }
  }
  if (error && error.shortMessage) return error.shortMessage;
  if (error && error.message) return error.message.split("\n")[0];
  return String(error);
}

function findRevertData(error) {
  if (!error || typeof error !== "object") return null;
  if (typeof error.data === "string" && error.data.startsWith("0x")) return error.data;
  // ethers v6 nests the revert data a few levels deep.
  for (const key of ["error", "info"]) {
    if (error[key]) {
      const found = findRevertData(error[key]);
      if (found) return found;
    }
  }
  return null;
}

/// @notice Send a transaction promise, wait for 1 confirmation, and
///         return a plain result. Throws a decoded Error on revert.
async function sendAndWait(txPromise, contract) {
  let tx;
  try {
    tx = await txPromise;
  } catch (error) {
    throw new Error(decodeError(error, contract));
  }
  let receipt;
  try {
    receipt = await tx.wait();
  } catch (error) {
    throw new Error(decodeError(error, contract));
  }
  if (receipt.status !== 1n && receipt.status !== 1) {
    throw new Error(`Transaction reverted: ${tx.hash}`);
  }
  return { txHash: tx.hash, blockNumber: receipt.blockNumber };
}

function escrowAddressFromReceipt(receipt, factory) {
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed && parsed.name === "EscrowCreated") return parsed.args.escrow;
    } catch {
      // Log belongs to another contract — ignore.
    }
  }
  throw new Error("EscrowCreated event not found in receipt");
}

// ---------------------------------------------------------------------------
// Writes — factory
// ---------------------------------------------------------------------------

/// @notice Create a single-milestone escrow. Returns its address.
///         Pass `deadlineDays` (from now) or an absolute unix `deadline`.
async function createEscrow(signer, factoryAddress, { freelancer, amountEth, deadlineDays, deadline }) {
  const factory = getFactory(signer, factoryAddress);
  const deadlineTs = resolveDeadline({ deadlineDays, deadline });
  const amount = ethers.parseEther(String(amountEth));
  const result = await sendAndWait(
    factory.createEscrow(freelancer, amount, deadlineTs),
    factory
  );
  const receipt = await signer.provider.getTransactionReceipt(result.txHash);
  return { escrowAddress: escrowAddressFromReceipt(receipt, factory), ...result };
}

/// @notice Create a milestone escrow. `amountsEth` is the per-milestone
///         split; the total is their sum.
async function createMilestoneEscrow(
  signer,
  factoryAddress,
  { freelancer, amountsEth, deadlineDays, deadline }
) {
  if (!Array.isArray(amountsEth) || amountsEth.length === 0) {
    throw new Error("amountsEth must be a non-empty array of ETH amounts");
  }
  const factory = getFactory(signer, factoryAddress);
  const deadlineTs = resolveDeadline({ deadlineDays, deadline });
  const amounts = amountsEth.map((a) => ethers.parseEther(String(a)));
  const result = await sendAndWait(
    factory.createEscrowWithMilestones(freelancer, amounts, deadlineTs),
    factory
  );
  const receipt = await signer.provider.getTransactionReceipt(result.txHash);
  return { escrowAddress: escrowAddressFromReceipt(receipt, factory), ...result };
}

// ---------------------------------------------------------------------------
// Writes — escrow lifecycle
// ---------------------------------------------------------------------------

async function fundEscrow(signer, escrowAddress) {
  const escrow = getEscrow(signer, escrowAddress);
  const amount = await escrow.amount();
  return sendAndWait(escrow.fund({ value: amount }), escrow);
}

async function submitMilestoneDelivery(signer, escrowAddress, milestoneIndex, deliveryHash) {
  const escrow = getEscrow(signer, escrowAddress);
  return sendAndWait(
    escrow.submitMilestoneDelivery(milestoneIndex, deliveryHash),
    escrow
  );
}

/// @notice Single-milestone wrapper (legacy single-milestone API).
async function submitDelivery(signer, escrowAddress, deliveryHash) {
  const escrow = getEscrow(signer, escrowAddress);
  return sendAndWait(escrow.submitDelivery(deliveryHash), escrow);
}

async function requestMilestoneRevision(signer, escrowAddress, milestoneIndex, reason) {
  const escrow = getEscrow(signer, escrowAddress);
  return sendAndWait(escrow.requestMilestoneRevision(milestoneIndex, reason), escrow);
}

/// @notice Single-milestone wrapper (legacy single-milestone API).
async function requestRevision(signer, escrowAddress, reason) {
  const escrow = getEscrow(signer, escrowAddress);
  return sendAndWait(escrow.requestRevision(reason), escrow);
}

async function releaseMilestone(signer, escrowAddress, milestoneIndex) {
  const escrow = getEscrow(signer, escrowAddress);
  return sendAndWait(escrow.releaseMilestone(milestoneIndex), escrow);
}

/// @notice Single-milestone wrapper (legacy single-milestone API).
async function release(signer, escrowAddress) {
  const escrow = getEscrow(signer, escrowAddress);
  return sendAndWait(escrow.release(), escrow);
}

async function raiseDispute(signer, escrowAddress, reason) {
  const escrow = getEscrow(signer, escrowAddress);
  return sendAndWait(escrow.raiseDispute(reason), escrow);
}

async function resolveDispute(signer, escrowAddress, freelancerShareBps) {
  const escrow = getEscrow(signer, escrowAddress);
  return sendAndWait(escrow.resolveDispute(freelancerShareBps), escrow);
}

async function cancelEscrow(signer, escrowAddress) {
  const escrow = getEscrow(signer, escrowAddress);
  return sendAndWait(escrow.cancel(), escrow);
}

async function refundAfterDeadline(signer, escrowAddress) {
  const escrow = getEscrow(signer, escrowAddress);
  return sendAndWait(escrow.refundAfterDeadline(), escrow);
}

async function withdraw(signer, escrowAddress) {
  const escrow = getEscrow(signer, escrowAddress);
  return sendAndWait(escrow.withdraw(), escrow);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// @notice Full human-readable snapshot of one escrow: plain JSON-safe
///         values (ETH strings, ISO dates, status names) for the UI.
async function getEscrowSummary(provider, escrowAddress) {
  const escrow = getEscrow(provider, escrowAddress);
  const d = await escrow.getDetails();
  const milestones = await escrow.getMilestones();
  const [releasedTotal, remaining, balance] = await Promise.all([
    escrow.releasedTotal(),
    escrow.remainingBalance(),
    provider.getBalance(escrowAddress),
  ]);
  const pending = {};
  const parties = {
    client: d._client,
    freelancer: d._freelancer,
    feeRecipient: await escrow.feeRecipient(),
  };
  for (const [role, address] of Object.entries(parties)) {
    pending[role] = formatEth(await escrow.pendingWithdrawals(address));
  }
  return {
    address: escrowAddress,
    client: d._client,
    freelancer: d._freelancer,
    arbiter: d._arbiter,
    feeRecipient: parties.feeRecipient,
    amountEth: formatEth(d._amount),
    releasedEth: formatEth(releasedTotal),
    remainingEth: formatEth(remaining),
    balanceEth: formatEth(balance),
    deadline: new Date(Number(d._deadline) * 1000).toISOString(),
    feeBps: Number(d._feeBps),
    status: Number(d._status),
    statusName: STATUS_NAMES[Number(d._status)],
    deliveryHash: d._deliveryHash,
    revisionCount: Number(d._revisionCount),
    disputeReason: await escrow.disputeReason(),
    milestones: milestones.map((m, i) => ({
      index: i,
      amountEth: formatEth(m.amount),
      status: Number(m.status),
      statusName: MILESTONE_STATUS_NAMES[Number(m.status)],
      deliveryHash: m.deliveryHash,
      deliveredAt: m.deliveredAt === 0n ? null : new Date(Number(m.deliveredAt) * 1000).toISOString(),
    })),
    pendingWithdrawalsEth: pending,
  };
}

/// @notice Summaries for every escrow the factory has created.
async function listEscrows(provider, factoryAddress) {
  const factory = getFactory(provider, factoryAddress);
  const count = Number(await factory.getEscrowCount());
  const summaries = [];
  // allEscrows is a public array: read it one index at a time.
  for (let i = 0; i < count; i++) {
    const address = await factory.allEscrows(i);
    summaries.push(await getEscrowSummary(provider, address));
  }
  return summaries;
}

module.exports = {
  FACTORY_ABI,
  ESCROW_ABI,
  STATUS_NAMES,
  MILESTONE_STATUS_NAMES,
  getFactory,
  getEscrow,
  loadDeployment,
  formatEth,
  decodeError,
  createEscrow,
  createMilestoneEscrow,
  fundEscrow,
  submitMilestoneDelivery,
  submitDelivery,
  requestMilestoneRevision,
  requestRevision,
  releaseMilestone,
  release,
  raiseDispute,
  resolveDispute,
  cancelEscrow,
  refundAfterDeadline,
  withdraw,
  getEscrowSummary,
  listEscrows,
};
