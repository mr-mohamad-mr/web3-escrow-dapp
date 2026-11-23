// Tests for lib/escrow.js — the ethers.js interaction layer. Runs the
// layer end to end against the in-process Hardhat network: create, fund,
// deliver, release and read back, plus error decoding on a revert.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const lib = require("../lib/escrow");

const FEE_BPS = 250;

describe("Interaction layer (lib/escrow.js)", function () {
  async function deployFactory() {
    const [owner, client, freelancer, arbiter, feeRecipient] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("EscrowFactory");
    const factory = await Factory.deploy(arbiter.address, feeRecipient.address, FEE_BPS);
    const factoryAddress = await factory.getAddress();
    return { factoryAddress, owner, client, freelancer, arbiter, feeRecipient };
  }

  it("creates a milestone escrow, funds, delivers and releases via the layer", async function () {
    const { factoryAddress, client, freelancer, feeRecipient } = await deployFactory();

    const { escrowAddress, txHash } = await lib.createMilestoneEscrow(client, factoryAddress, {
      freelancer: freelancer.address,
      amountsEth: ["2", "3"],
      deadlineDays: 7,
    });
    expect(ethers.isAddress(escrowAddress)).to.equal(true);
    expect(txHash).to.be.a("string");

    const before = await lib.getEscrowSummary(ethers.provider, escrowAddress);
    expect(before.statusName).to.equal("Created");
    expect(before.amountEth).to.equal("5.0");
    expect(before.milestones.map((m) => m.amountEth)).to.deep.equal(["2.0", "3.0"]);
    expect(before.milestones.map((m) => m.statusName)).to.deep.equal(["Pending", "Pending"]);
    expect(before.feeBps).to.equal(FEE_BPS);

    await lib.fundEscrow(client, escrowAddress);
    await lib.submitMilestoneDelivery(freelancer, escrowAddress, 0, "QmLibM0");
    const released = await lib.releaseMilestone(client, escrowAddress, 0);
    expect(released.txHash).to.be.a("string");

    const after = await lib.getEscrowSummary(ethers.provider, escrowAddress);
    expect(after.statusName).to.equal("Funded"); // milestone 1 still pending
    expect(after.releasedEth).to.equal("2.0");
    expect(after.remainingEth).to.equal("3.0");
    expect(after.milestones[0].statusName).to.equal("Released");
    expect(after.milestones[0].deliveryHash).to.equal("QmLibM0");
    expect(after.milestones[1].statusName).to.equal("Pending");
    expect(after.pendingWithdrawalsEth.freelancer).to.equal("1.95"); // 2 - 2.5% fee
    expect(after.pendingWithdrawalsEth.feeRecipient).to.equal("0.05");

    await lib.withdraw(freelancer, escrowAddress);
    const withdrawn = await lib.getEscrowSummary(ethers.provider, escrowAddress);
    expect(withdrawn.pendingWithdrawalsEth.freelancer).to.equal("0.0");
  });

  it("lists every escrow from the factory", async function () {
    const { factoryAddress, client, freelancer } = await deployFactory();
    const a = await lib.createEscrow(client, factoryAddress, {
      freelancer: freelancer.address,
      amountEth: "1",
      deadlineDays: 7,
    });
    const b = await lib.createMilestoneEscrow(client, factoryAddress, {
      freelancer: freelancer.address,
      amountsEth: ["1", "1"],
      deadlineDays: 7,
    });

    const escrows = await lib.listEscrows(ethers.provider, factoryAddress);
    expect(escrows.map((s) => s.address).sort()).to.deep.equal(
      [a.escrowAddress, b.escrowAddress].sort()
    );
    expect(escrows.find((s) => s.address === b.escrowAddress).milestones.length).to.equal(2);
  });

  it("decodes a revert to its custom-error name", async function () {
    const { factoryAddress, client, freelancer } = await deployFactory();
    const { escrowAddress } = await lib.createEscrow(client, factoryAddress, {
      freelancer: freelancer.address,
      amountEth: "1",
      deadlineDays: 7,
    });
    await lib.fundEscrow(client, escrowAddress);

    // Releasing before delivery reverts with InvalidMilestoneStatus.
    await expect(lib.release(client, escrowAddress)).to.be.rejectedWith(
      /InvalidMilestoneStatus/
    );
    // Double funding reverts with InvalidStatus.
    await expect(lib.fundEscrow(client, escrowAddress)).to.be.rejectedWith(/InvalidStatus/);
  });

  it("runs the single-milestone flow through the legacy wrappers", async function () {
    const { factoryAddress, client, freelancer } = await deployFactory();
    const { escrowAddress } = await lib.createEscrow(client, factoryAddress, {
      freelancer: freelancer.address,
      amountEth: "4",
      deadlineDays: 7,
    });
    await lib.fundEscrow(client, escrowAddress);
    await lib.submitDelivery(freelancer, escrowAddress, "QmLegacy");
    await lib.requestRevision(client, escrowAddress, "Fix the footer");
    await lib.submitDelivery(freelancer, escrowAddress, "QmLegacyV2");
    await lib.release(client, escrowAddress);

    const summary = await lib.getEscrowSummary(ethers.provider, escrowAddress);
    expect(summary.statusName).to.equal("Released");
    expect(summary.revisionCount).to.equal(1);
    expect(summary.pendingWithdrawalsEth.freelancer).to.equal("3.9"); // 4 - 2.5%
  });
});
