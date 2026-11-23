// CLI for the escrow interaction layer (lib/escrow.js).
// Talks to a persistent local node over plain JSON-RPC — start one first:
//
//   npx hardhat node                                   # terminal 1
//   npx hardhat run scripts/seed.js --network localhost
//   node scripts/interact.js list
//
// The local node unlocks Hardhat's default accounts, so signers are
// picked by index — no private keys anywhere in this script.
// Signer roles (same order as scripts/deploy.js and scripts/seed.js):
//   0 owner/admin  1 client  2 freelancer  3 arbiter  4 fee recipient
//
//   node scripts/interact.js --signer 2 deliver <escrow> 0 QmYourDeliveryHash
//
// Options: --signer N (default 1), --factory 0x... (default: from
// deployments/localhost.json), --rpc URL (default http://127.0.0.1:8545)
//
// Commands:
//   list [factory]                 list every escrow with its state
//   details <escrow>               full summary of one escrow
//   create <freelancer> <eth> <days>
//   create-milestones <freelancer> <eth,eth,...> <days>
//   fund <escrow>
//   deliver <escrow> <milestone> <hash>
//   release <escrow> <milestone>
//   revise <escrow> <milestone> <reason...>
//   dispute <escrow> <reason...>
//   resolve <escrow> <freelancerShareBps>
//   refund <escrow>
//   withdraw <escrow>
//   cancel <escrow>
//
// Local chain only. Never points at a real network.

const { ethers } = require("ethers");
const lib = require("../lib/escrow");

function usage() {
  console.log("Usage: node scripts/interact.js [--signer N] [--factory 0x..] [--rpc URL] <command> [args]");
  console.log("Commands: list | details | create | create-milestones | fund | deliver |");
  console.log("          release | revise | dispute | resolve | refund | withdraw | cancel");
  console.log("Run with no command to see the seeded escrows (same as `list`).");
}

function parseArgs(argv) {
  let signerIndex = 1; // default: the client
  let factoryAddress = null;
  let rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--signer") {
      signerIndex = parseInt(argv[++i], 10);
    } else if (argv[i] === "--factory") {
      factoryAddress = argv[++i];
    } else if (argv[i] === "--rpc") {
      rpcUrl = argv[++i];
    } else {
      rest.push(argv[i]);
    }
  }
  return { signerIndex, factoryAddress, rpcUrl, rest };
}

function printSummary(s) {
  console.log(`\n${s.address}  [${s.statusName}]`);
  console.log(`  client ${s.client}  freelancer ${s.freelancer}`);
  console.log(
    `  total ${s.amountEth} ETH  released ${s.releasedEth}  remaining ${s.remainingEth}  balance ${s.balanceEth} ETH`
  );
  console.log(`  deadline ${s.deadline}  fee ${s.feeBps} bps  revisions ${s.revisionCount}`);
  if (s.disputeReason) console.log(`  dispute: ${s.disputeReason}`);
  for (const m of s.milestones) {
    console.log(
      `  milestone ${m.index}: ${m.amountEth} ETH [${m.statusName}]` +
        (m.deliveryHash ? ` hash ${m.deliveryHash}` : "")
    );
  }
  const p = s.pendingWithdrawalsEth;
  console.log(
    `  pending withdrawals — client ${p.client}, freelancer ${p.freelancer}, fee ${p.feeRecipient} ETH`
  );
}

async function main() {
  const { signerIndex, factoryAddress: factoryArg, rpcUrl, rest } = parseArgs(
    process.argv.slice(2)
  );
  const [command, ...args] = rest;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const accounts = await provider.listAccounts();
  if (Number.isNaN(signerIndex) || signerIndex < 0 || signerIndex >= accounts.length) {
    throw new Error(`--signer must be 0..${accounts.length - 1} on ${rpcUrl}`);
  }
  const signer = await provider.getSigner(signerIndex);

  let deployment = null;
  try {
    deployment = lib.loadDeployment("localhost");
  } catch {
    // No deployment file — the caller must pass --factory.
  }
  const factoryAddress = factoryArg || (deployment && deployment.factory);
  if (!factoryAddress && (command === "list" || command === "create" || command === "create-milestones" || !command)) {
    throw new Error("No factory address: pass --factory <address> or run scripts/seed.js first.");
  }

  const escrowAddress = (i) => {
    const a = args[i];
    if (!a || !ethers.isAddress(a)) throw new Error(`Expected an escrow address, got: ${a}`);
    return a;
  };

  switch (command) {
    case undefined:
    case "list": {
      const escrows = await lib.listEscrows(provider, factoryAddress);
      console.log(`Factory ${factoryAddress} — ${escrows.length} escrow(s):`);
      for (const s of escrows) printSummary(s);
      break;
    }
    case "details": {
      printSummary(await lib.getEscrowSummary(provider, escrowAddress(0)));
      break;
    }
    case "create": {
      const [freelancer, amountEth, days] = args;
      if (!ethers.isAddress(freelancer)) throw new Error(`Bad freelancer address: ${freelancer}`);
      const r = await lib.createEscrow(signer, factoryAddress, {
        freelancer,
        amountEth,
        deadlineDays: Number(days),
      });
      console.log(`Escrow created: ${r.escrowAddress} (tx ${r.txHash})`);
      break;
    }
    case "create-milestones": {
      const [freelancer, amounts, days] = args;
      if (!ethers.isAddress(freelancer)) throw new Error(`Bad freelancer address: ${freelancer}`);
      const r = await lib.createMilestoneEscrow(signer, factoryAddress, {
        freelancer,
        amountsEth: amounts.split(","),
        deadlineDays: Number(days),
      });
      console.log(`Milestone escrow created: ${r.escrowAddress} (tx ${r.txHash})`);
      break;
    }
    case "fund": {
      console.log(await lib.fundEscrow(signer, escrowAddress(0)));
      break;
    }
    case "deliver": {
      const [addr, index, hash] = args;
      console.log(await lib.submitMilestoneDelivery(signer, addr, Number(index), hash));
      break;
    }
    case "release": {
      console.log(await lib.releaseMilestone(signer, escrowAddress(0), Number(args[1])));
      break;
    }
    case "revise": {
      const [addr, index, ...reason] = args;
      console.log(
        await lib.requestMilestoneRevision(signer, addr, Number(index), reason.join(" "))
      );
      break;
    }
    case "dispute": {
      const [addr, ...reason] = args;
      console.log(await lib.raiseDispute(signer, addr, reason.join(" ")));
      break;
    }
    case "resolve": {
      console.log(await lib.resolveDispute(signer, escrowAddress(0), Number(args[1])));
      break;
    }
    case "refund": {
      console.log(await lib.refundAfterDeadline(signer, escrowAddress(0)));
      break;
    }
    case "withdraw": {
      console.log(await lib.withdraw(signer, escrowAddress(0)));
      break;
    }
    case "cancel": {
      console.log(await lib.cancelEscrow(signer, escrowAddress(0)));
      break;
    }
    default:
      usage();
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
