// Chain client for the frontend.
//
// Framework-free bridge between the React UI and the
// interaction layer (../../../lib/escrow.js, bundled for the browser by
// the vite plugin in vite.config.js). Every contract write goes through
// the layer's named action functions — the UI never builds a raw
// contract call for a write. Reads use the layer's JSON-safe summaries;
// the one exception is the activity timeline, which is assembled here
// from on-chain event logs using the ABIs the layer exports.
//
// Local chain only: a plain JsonRpcProvider against the Hardhat node.
// "Connecting a wallet" in this demo means choosing one of the node's
// unlocked accounts — no real wallet, no signing prompts, no real
// funds, exactly as the project rules require.

import { ethers } from "ethers";
import * as escrow from "../../../lib/escrow.js";

export const RPC_URL = "http://127.0.0.1:8545";
export const STATUS_NAMES = escrow.STATUS_NAMES;
export const MILESTONE_STATUS_NAMES = escrow.MILESTONE_STATUS_NAMES;

let provider = null;

export function getProvider() {
  if (!provider) provider = new ethers.JsonRpcProvider(RPC_URL);
  return provider;
}

/// @notice The deployment written by scripts/seed.js, served fresh by
///         the vite plugin at /deployment.json.
export async function loadDeployment() {
  const res = await fetch("/deployment.json");
  if (!res.ok) {
    throw new Error(
      "Could not load deployments/localhost.json — start a local node " +
        "(`npm run node`) and seed it (`npm run seed:local`) first."
    );
  }
  return res.json();
}

export async function getChainId() {
  const network = await getProvider().getNetwork();
  return Number(network.chainId);
}

const ROLE_LABELS = {
  owner: "Owner / admin",
  client: "Client",
  freelancer: "Freelancer",
  freelancer2: "Freelancer 2",
  arbiter: "Arbiter",
  feeRecipient: "Fee recipient",
};

/// @notice The local node's unlocked accounts, labelled with the demo
///         roles from the deployment file where they match.
export async function listAccounts(deployment) {
  const p = getProvider();
  const signers = await p.listAccounts();
  const labels = {};
  if (deployment) {
    for (const [key, label] of Object.entries(ROLE_LABELS)) {
      const address = deployment[key];
      if (address) labels[address.toLowerCase()] = label;
    }
  }
  return Promise.all(
    signers.map(async (signer, i) => ({
      address: signer.address,
      label: labels[signer.address.toLowerCase()] || `Account ${i}`,
      balanceEth: ethers.formatEther(await p.getBalance(signer.address)),
    }))
  );
}

async function signerFor(account) {
  return getProvider().getSigner(account);
}

// ---------------------------------------------------------------------------
// Reads (via the interaction layer)
// ---------------------------------------------------------------------------

export function fetchEscrows(factoryAddress) {
  return escrow.listEscrows(getProvider(), factoryAddress);
}

export function fetchSummary(escrowAddress) {
  return escrow.getEscrowSummary(getProvider(), escrowAddress);
}

// ---------------------------------------------------------------------------
// Writes (via the interaction layer — one named function per action)
// ---------------------------------------------------------------------------

export const actions = {
  create: async (account, factoryAddress, options) =>
    escrow.createEscrow(await signerFor(account), factoryAddress, options),
  createMilestones: async (account, factoryAddress, options) =>
    escrow.createMilestoneEscrow(await signerFor(account), factoryAddress, options),
  fund: async (account, escrowAddress) =>
    escrow.fundEscrow(await signerFor(account), escrowAddress),
  deliverMilestone: async (account, escrowAddress, index, deliveryHash) =>
    escrow.submitMilestoneDelivery(await signerFor(account), escrowAddress, index, deliveryHash),
  releaseMilestone: async (account, escrowAddress, index) =>
    escrow.releaseMilestone(await signerFor(account), escrowAddress, index),
  reviseMilestone: async (account, escrowAddress, index, reason) =>
    escrow.requestMilestoneRevision(await signerFor(account), escrowAddress, index, reason),
  raiseDispute: async (account, escrowAddress, reason) =>
    escrow.raiseDispute(await signerFor(account), escrowAddress, reason),
  resolveDispute: async (account, escrowAddress, freelancerShareBps) =>
    escrow.resolveDispute(await signerFor(account), escrowAddress, freelancerShareBps),
  cancel: async (account, escrowAddress) =>
    escrow.cancelEscrow(await signerFor(account), escrowAddress),
  refund: async (account, escrowAddress) =>
    escrow.refundAfterDeadline(await signerFor(account), escrowAddress),
  withdraw: async (account, escrowAddress) =>
    escrow.withdraw(await signerFor(account), escrowAddress),
};

// ---------------------------------------------------------------------------
// Activity timeline (event logs, read with the layer's exported ABIs)
// ---------------------------------------------------------------------------

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function eth(wei) {
  return `${ethers.formatEther(wei)} ETH`;
}

function describeEvent(name, args) {
  switch (name) {
    case "EscrowCreated":
      return {
        title: "Escrow created",
        detail: `${eth(args.amount)} · client ${shortAddress(args.client)} · freelancer ${shortAddress(args.freelancer)}`,
      };
    case "MilestonesDefined":
      return {
        title: "Milestones defined",
        detail: `${args.amounts.length} milestones: ${args.amounts.map(eth).join(" + ")}`,
      };
    case "EscrowFunded":
      return { title: "Funded", detail: `${eth(args.amount)} locked by the client` };
    case "DeliverySubmitted":
      return { title: "Delivery submitted", detail: `Hash ${args.deliveryHash}` };
    case "MilestoneDelivered":
      return {
        title: `Milestone ${Number(args.index) + 1} delivered`,
        detail: `Hash ${args.deliveryHash}`,
      };
    case "RevisionRequested":
      return {
        title: "Revision requested",
        detail: `"${args.reason}" (revision #${Number(args.revisionCount)})`,
      };
    case "MilestoneRevisionRequested":
      return {
        title: `Revision requested on milestone ${Number(args.index) + 1}`,
        detail: `"${args.reason}" (revision #${Number(args.revisionCount)})`,
      };
    case "Released":
      return {
        title: "Released",
        detail: `Freelancer ${eth(args.freelancerAmount)} · fee ${eth(args.feeAmount)}`,
      };
    case "MilestoneReleased":
      return {
        title: `Milestone ${Number(args.index) + 1} released`,
        detail: `Freelancer ${eth(args.freelancerAmount)} · fee ${eth(args.feeAmount)}`,
      };
    case "DisputeRaised":
      return {
        title: "Dispute raised",
        detail: `${shortAddress(args.raisedBy)}: "${args.reason}"`,
      };
    case "DisputeResolved":
      return {
        title: "Dispute resolved",
        detail:
          `Freelancer share ${Number(args.freelancerShareBps) / 100}% — ` +
          `freelancer ${eth(args.freelancerAmount)} · client ${eth(args.clientAmount)} · fee ${eth(args.feeAmount)}`,
      };
    case "Cancelled":
      return { title: "Cancelled", detail: "Cancelled by the client before funding" };
    case "Refunded":
      return { title: "Refunded", detail: `${eth(args.amount)} returned to the client` };
    case "Withdrawn":
      return {
        title: "Withdrawn",
        detail: `${shortAddress(args.recipient)} withdrew ${eth(args.amount)}`,
      };
    default:
      return { title: name, detail: "" };
  }
}

/// @notice Chronological activity for one escrow, built from the
///         factory's EscrowCreated log plus every event the escrow
///         contract itself emitted. Block timestamps come from the
///         local chain.
export async function fetchTimeline(factoryAddress, escrowAddress) {
  const p = getProvider();
  const escrowContract = new ethers.Contract(escrowAddress, escrow.ESCROW_ABI, p);
  const factoryContract = new ethers.Contract(factoryAddress, escrow.FACTORY_ABI, p);

  const entries = [];
  const collect = (contract, logs) => {
    for (const log of logs) {
      try {
        const parsed = contract.interface.parseLog(log);
        if (parsed) {
          entries.push({
            blockNumber: log.blockNumber,
            logIndex: log.index,
            txHash: log.transactionHash,
            name: parsed.name,
            args: parsed.args,
          });
        }
      } catch {
        // Log from a different contract sharing the address filter — skip.
      }
    }
  };

  collect(escrowContract, await p.getLogs({ address: escrowAddress, fromBlock: 0 }));
  const createdTopic = factoryContract.interface.getEvent("EscrowCreated").topicHash;
  collect(
    factoryContract,
    await p.getLogs({
      address: factoryAddress,
      topics: [createdTopic, ethers.zeroPadValue(escrowAddress, 32)],
      fromBlock: 0,
    })
  );

  entries.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  const timestamps = {};
  for (const blockNumber of [...new Set(entries.map((e) => e.blockNumber))]) {
    const block = await p.getBlock(blockNumber);
    timestamps[blockNumber] = new Date(Number(block.timestamp) * 1000).toISOString();
  }

  return entries.map((entry) => ({
    ...describeEvent(entry.name, entry.args),
    name: entry.name,
    txHash: entry.txHash,
    blockNumber: entry.blockNumber,
    at: timestamps[entry.blockNumber],
  }));
}

export { shortAddress };
