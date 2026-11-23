// Seeds a persistent local node with demo escrows in every state, for
// the frontend and manual testing. Local chain only —
// Hardhat's default accounts, no real wallet, no real funds.
//
//   npx hardhat node                              # terminal 1
//   npx hardhat run scripts/seed.js --network localhost   # terminal 2
//
// Writes deployments/localhost.json: the factory address plus every
// seeded escrow (name, address, expected state), which lib/escrow.js
// and scripts/interact.js read back.
//
// Signer roles (same order as scripts/deploy.js):
//   0 owner/admin  1 client  2 freelancer  3 arbiter  4 fee recipient
// A second freelancer (signer 5) is used for a couple of jobs so the
// registry shows more than one freelancer.

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const lib = require("../lib/escrow");

const SEVEN_DAYS = 7;

async function main() {
  const [owner, client, freelancer, arbiter, feeRecipient, freelancer2] =
    await ethers.getSigners();

  const Factory = await ethers.getContractFactory("EscrowFactory");
  const factory = await Factory.deploy(arbiter.address, feeRecipient.address, 250);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("EscrowFactory deployed at:", factoryAddress);

  const seeded = [];
  const record = (name, address, state, note) => {
    seeded.push({ name, address, state, note });
    console.log(`  ${name}: ${address} [${state}]${note ? ` — ${note}` : ""}`);
  };

  const create = async (signer, freelancerAddr, amountsEth, days = SEVEN_DAYS) => {
    if (amountsEth.length === 1) {
      return (
        await lib.createEscrow(signer, factoryAddress, {
          freelancer: freelancerAddr,
          amountEth: amountsEth[0],
          deadlineDays: days,
        })
      ).escrowAddress;
    }
    return (
      await lib.createMilestoneEscrow(signer, factoryAddress, {
        freelancer: freelancerAddr,
        amountsEth,
        deadlineDays: days,
      })
    ).escrowAddress;
  };

  // 1. Created — never funded.
  const created = await create(client, freelancer.address, ["3"]);
  record("Website redesign", created, "Created", "3 ETH, unfunded");

  // 2. Funded — milestones [2, 3] ETH, work in progress.
  const funded = await create(client, freelancer.address, ["2", "3"]);
  await lib.fundEscrow(client, funded);
  record("Mobile app MVP", funded, "Funded", "5 ETH in milestones [2, 3]");

  // 3. Delivered — single milestone, delivery awaiting review.
  const delivered = await create(client, freelancer2.address, ["1.5"]);
  await lib.fundEscrow(client, delivered);
  await lib.submitDelivery(freelancer2, delivered, "QmLandingPageV1");
  record("Landing page + copy", delivered, "Delivered", "1.5 ETH, hash QmLandingPageV1");

  // 4. Released — milestones [1, 1] ETH, both accepted, freelancer paid.
  const released = await create(client, freelancer.address, ["1", "1"]);
  await lib.fundEscrow(client, released);
  await lib.submitMilestoneDelivery(freelancer, released, 0, "QmApiPart1");
  await lib.releaseMilestone(client, released, 0);
  await lib.submitMilestoneDelivery(freelancer, released, 1, "QmApiPart2");
  await lib.releaseMilestone(client, released, 1);
  await lib.withdraw(freelancer, released);
  record("API integration", released, "Released", "2 ETH, freelancer withdrew");

  // 5. Disputed — freelancer raised a dispute while funded.
  const disputed = await create(client, freelancer2.address, ["2"]);
  await lib.fundEscrow(client, disputed);
  await lib.raiseDispute(freelancer2, disputed, "Client stopped replying after delivery");
  record("Logo & brand kit", disputed, "Disputed", "2 ETH, awaiting arbiter");

  // 6. Resolved — arbiter split 50/50; client withdrew, freelancer pending.
  const resolved = await create(client, freelancer.address, ["4"]);
  await lib.fundEscrow(client, resolved);
  await lib.raiseDispute(client, resolved, "Work does not match the brief");
  await lib.resolveDispute(arbiter, resolved, 5000);
  await lib.withdraw(client, resolved);
  record("Blog migration", resolved, "Resolved", "4 ETH split 50/50, client withdrew");

  // 7. Refunded — deadline set 30s ahead of the *chain* clock (a
  //    fast-mining local node runs ahead of wall-clock time), funded,
  //    then refunded after the deadline via evm_increaseTime.
  const latestBlock = await ethers.provider.getBlock("latest");
  const refundDeadline = latestBlock.timestamp + 30;
  const refunded = (
    await lib.createEscrow(client, factoryAddress, {
      freelancer: freelancer2.address,
      amountEth: "1",
      deadline: refundDeadline,
    })
  ).escrowAddress;
  await lib.fundEscrow(client, refunded);
  await ethers.provider.send("evm_increaseTime", [31]);
  await ethers.provider.send("evm_mine", []);
  await lib.refundAfterDeadline(client, refunded);
  record("Data cleanup", refunded, "Refunded", "1 ETH returned after deadline");

  // 8. Milestone showcase — [2, 2, 1] ETH: m0 released + withdrawn,
  //    m1 delivered and awaiting review, m2 still pending.
  const showcase = await create(client, freelancer.address, ["2", "2", "1"]);
  await lib.fundEscrow(client, showcase);
  await lib.submitMilestoneDelivery(freelancer, showcase, 0, "QmDashboardDesign");
  await lib.releaseMilestone(client, showcase, 0);
  await lib.withdraw(freelancer, showcase);
  await lib.submitMilestoneDelivery(freelancer, showcase, 1, "QmDashboardBuild");
  record(
    "Dashboard build",
    showcase,
    "Delivered",
    "5 ETH milestones [2, 2, 1]: m0 paid, m1 under review, m2 pending"
  );

  const deployment = {
    network: "localhost",
    chainId: 31337,
    factory: factoryAddress,
    feeBps: 250,
    arbiter: arbiter.address,
    feeRecipient: feeRecipient.address,
    owner: owner.address,
    client: client.address,
    freelancer: freelancer.address,
    freelancer2: freelancer2.address,
    deployedAt: new Date().toISOString(),
    escrows: seeded,
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "localhost.json");
  fs.writeFileSync(file, JSON.stringify(deployment, null, 2) + "\n");
  console.log(`\nSEED OK — ${seeded.length} escrows, deployment written to ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
