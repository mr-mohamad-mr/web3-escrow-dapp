const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const FEE_BPS = 250; // 2.5% platform fee
const SEVEN_DAYS = 7 * 24 * 60 * 60;

describe("Milestones", function () {
  async function deployFactoryFixture() {
    const [owner, client, freelancer, arbiter, feeRecipient, other] =
      await ethers.getSigners();
    const Factory = await ethers.getContractFactory("EscrowFactory");
    const factory = await Factory.deploy(arbiter.address, feeRecipient.address, FEE_BPS);
    return { factory, owner, client, freelancer, arbiter, feeRecipient, other };
  }

  async function createMilestoneEscrow(fixture, amountsEth) {
    const { factory, client, freelancer } = fixture;
    const amounts = amountsEth.map((a) => ethers.parseEther(a));
    const deadline = (await time.latest()) + SEVEN_DAYS;
    const tx = await factory
      .connect(client)
      .createEscrowWithMilestones(freelancer.address, amounts, deadline);
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((log) => factory.interface.parseLog(log))
      .find((parsed) => parsed && parsed.name === "EscrowCreated");
    const escrow = await ethers.getContractAt("FreelanceEscrow", event.args.escrow);
    return { escrow, total: amounts.reduce((a, b) => a + b, 0n), deadline };
  }

  describe("creation", function () {
    it("creates a milestone escrow: total is the sum, milestones stored", async function () {
      const f = await loadFixture(deployFactoryFixture);
      const { escrow, total } = await createMilestoneEscrow(f, ["2", "3"]);
      expect(total).to.equal(ethers.parseEther("5"));
      expect(await escrow.amount()).to.equal(ethers.parseEther("5"));
      expect(await escrow.milestoneCount()).to.equal(2);
      expect(await escrow.remainingBalance()).to.equal(ethers.parseEther("5"));

      const m0 = await escrow.getMilestone(0);
      expect(m0.amount).to.equal(ethers.parseEther("2"));
      expect(m0.status).to.equal(0); // Pending
      const m1 = await escrow.getMilestone(1);
      expect(m1.amount).to.equal(ethers.parseEther("3"));
      expect(m1.status).to.equal(0);

      const all = await escrow.getMilestones();
      expect(all.length).to.equal(2);
      expect(all[1].amount).to.equal(ethers.parseEther("3"));
    });

    it("emits MilestonesDefined for multi-milestone escrows only", async function () {
      const { factory, client, freelancer } = await loadFixture(deployFactoryFixture);
      const deadline = (await time.latest()) + SEVEN_DAYS;
      const amounts = [ethers.parseEther("2"), ethers.parseEther("3")];

      await expect(
        factory.connect(client).createEscrowWithMilestones(freelancer.address, amounts, deadline)
      ).to.emit(factory, "MilestonesDefined");

      // Single-milestone createEscrow does not emit it.
      await expect(factory.connect(client).createEscrow(freelancer.address, amounts[0], deadline))
        .to.not.emit(factory, "MilestonesDefined");
    });

    it("rejects empty, zero and mismatched milestone lists", async function () {
      const { factory, client, freelancer } = await loadFixture(deployFactoryFixture);
      const deadline = (await time.latest()) + SEVEN_DAYS;
      // InvalidMilestones is raised by the escrow constructor, so the
      // matcher needs the escrow contract's ABI, not the factory's.
      const Escrow = await ethers.getContractFactory("FreelanceEscrow");

      await expect(
        factory.connect(client).createEscrowWithMilestones(freelancer.address, [], deadline)
      ).to.be.revertedWithCustomError(factory, "ZeroAmount");

      await expect(
        factory
          .connect(client)
          .createEscrowWithMilestones(freelancer.address, [ethers.parseEther("2"), 0], deadline)
      ).to.be.revertedWithCustomError(Escrow, "InvalidMilestones");
    });

    it("constructor rejects a milestone sum that does not match the amount", async function () {
      const { client, freelancer, arbiter, feeRecipient } =
        await loadFixture(deployFactoryFixture);
      const Escrow = await ethers.getContractFactory("FreelanceEscrow");
      const deadline = (await time.latest()) + SEVEN_DAYS;

      await expect(
        Escrow.deploy(
          client.address,
          freelancer.address,
          arbiter.address,
          ethers.parseEther("5"),
          [ethers.parseEther("2"), ethers.parseEther("2")],
          deadline,
          FEE_BPS,
          feeRecipient.address
        )
      ).to.be.revertedWithCustomError(Escrow, "MilestoneSumMismatch");
    });
  });

  describe("milestone lifecycle", function () {
    it("pays per milestone: release m0, escrow stays Funded until m1 releases", async function () {
      const f = await loadFixture(deployFactoryFixture);
      const { client, freelancer, feeRecipient } = f;
      const { escrow: e } = await createMilestoneEscrow(f, ["2", "3"]);
      const total = ethers.parseEther("5");
      await e.connect(client).fund({ value: total });

      // Milestone 0: deliver + release.
      const deliverTx = await e.connect(freelancer).submitMilestoneDelivery(0, "QmM0");
      const deliverReceipt = await deliverTx.wait();
      const deliverBlock = await ethers.provider.getBlock(deliverReceipt.blockNumber);
      const deliverEvent = deliverReceipt.logs
        .map((log) => e.interface.parseLog(log))
        .find((parsed) => parsed && parsed.name === "MilestoneDelivered");
      expect(deliverEvent.args.index).to.equal(0);
      expect(deliverEvent.args.freelancer).to.equal(freelancer.address);
      expect(deliverEvent.args.deliveryHash).to.equal("QmM0");
      expect(deliverEvent.args.deliveredAt).to.equal(deliverBlock.timestamp);
      expect(await e.status()).to.equal(2); // Delivered
      const fee0 = (ethers.parseEther("2") * BigInt(FEE_BPS)) / 10_000n;
      await expect(e.connect(client).releaseMilestone(0))
        .to.emit(e, "MilestoneReleased")
        .withArgs(0, freelancer.address, ethers.parseEther("2") - fee0, fee0);
      expect(await e.status()).to.equal(1); // Funded again — m1 still pending
      expect(await e.releasedTotal()).to.equal(ethers.parseEther("2"));
      expect(await e.remainingBalance()).to.equal(ethers.parseEther("3"));
      expect(await e.pendingWithdrawals(freelancer.address)).to.equal(
        ethers.parseEther("2") - fee0
      );

      // Milestone 1: revision loop, then release — escrow completes.
      await e.connect(freelancer).submitMilestoneDelivery(1, "QmM1v1");
      expect(await e.status()).to.equal(2);
      await expect(e.connect(client).requestMilestoneRevision(1, "Redo the checkout flow"))
        .to.emit(e, "MilestoneRevisionRequested")
        .withArgs(1, client.address, "Redo the checkout flow", 1);
      expect(await e.status()).to.equal(1);
      expect(await e.revisionCount()).to.equal(1);

      await e.connect(freelancer).submitMilestoneDelivery(1, "QmM1v2");
      const fee1 = (ethers.parseEther("3") * BigInt(FEE_BPS)) / 10_000n;
      await e.connect(client).releaseMilestone(1);
      expect(await e.status()).to.equal(4); // Released — all milestones done
      expect(await e.releasedTotal()).to.equal(total);
      expect(await e.remainingBalance()).to.equal(0);
      expect(await e.pendingWithdrawals(freelancer.address)).to.equal(
        ethers.parseEther("5") - fee0 - fee1
      );
      expect(await e.pendingWithdrawals(feeRecipient.address)).to.equal(fee0 + fee1);

      await expect(() => e.connect(freelancer).withdraw()).to.changeEtherBalances(
        [freelancer, e],
        [ethers.parseEther("5") - fee0 - fee1, -(ethers.parseEther("5") - fee0 - fee1)]
      );
      await expect(() => e.connect(feeRecipient).withdraw()).to.changeEtherBalances(
        [feeRecipient, e],
        [fee0 + fee1, -(fee0 + fee1)]
      );
      expect(await ethers.provider.getBalance(await e.getAddress())).to.equal(0);
    });

    it("milestones can be delivered out of order", async function () {
      const f = await loadFixture(deployFactoryFixture);
      const { client, freelancer } = f;
      const created = await createMilestoneEscrow(f, ["1", "1", "1"]);
      const esc = created.escrow;
      await esc.connect(client).fund({ value: ethers.parseEther("3") });

      await esc.connect(freelancer).submitMilestoneDelivery(2, "QmM2");
      expect(await esc.status()).to.equal(2);
      await esc.connect(client).releaseMilestone(2);
      expect(await esc.status()).to.equal(1);
      expect(await esc.releasedTotal()).to.equal(ethers.parseEther("1"));
    });
  });

  describe("guards", function () {
    it("rejects bad indices, wrong parties and wrong milestone states", async function () {
      const f = await loadFixture(deployFactoryFixture);
      const { client, freelancer, other } = f;
      const created = await createMilestoneEscrow(f, ["2", "3"]);
      const esc = created.escrow;
      await esc.connect(client).fund({ value: ethers.parseEther("5") });

      await expect(
        esc.connect(freelancer).submitMilestoneDelivery(2, "QmX")
      ).to.be.revertedWithCustomError(esc, "InvalidMilestoneIndex");
      await expect(
        esc.connect(client).submitMilestoneDelivery(0, "QmX")
      ).to.be.revertedWithCustomError(esc, "OnlyFreelancer");
      await expect(
        esc.connect(freelancer).releaseMilestone(0)
      ).to.be.revertedWithCustomError(esc, "OnlyClient");
      // Release before delivery.
      await expect(
        esc.connect(client).releaseMilestone(0)
      ).to.be.revertedWithCustomError(esc, "InvalidMilestoneStatus");
      // Revision before delivery.
      await expect(
        esc.connect(client).requestMilestoneRevision(0, "too early")
      ).to.be.revertedWithCustomError(esc, "InvalidMilestoneStatus");

      await esc.connect(freelancer).submitMilestoneDelivery(0, "QmM0");
      // Double delivery of the same milestone.
      await expect(
        esc.connect(freelancer).submitMilestoneDelivery(0, "QmM0again")
      ).to.be.revertedWithCustomError(esc, "InvalidMilestoneStatus");
      // Revision by anyone but the client.
      await expect(
        esc.connect(other).requestMilestoneRevision(0, "nope")
      ).to.be.revertedWithCustomError(esc, "OnlyClient");

      await esc.connect(client).releaseMilestone(0);
      // A released milestone cannot be delivered or released again.
      await expect(
        esc.connect(freelancer).submitMilestoneDelivery(0, "QmM0")
      ).to.be.revertedWithCustomError(esc, "InvalidMilestoneStatus");
      await expect(
        esc.connect(client).releaseMilestone(0)
      ).to.be.revertedWithCustomError(esc, "InvalidMilestoneStatus");
      await expect(esc.getMilestone(2)).to.be.revertedWithCustomError(
        esc,
        "InvalidMilestoneIndex"
      );
    });

    it("single-milestone wrappers revert on multi-milestone escrows", async function () {
      const f = await loadFixture(deployFactoryFixture);
      const { client, freelancer } = f;
      const created = await createMilestoneEscrow(f, ["2", "3"]);
      const esc = created.escrow;
      await esc.connect(client).fund({ value: ethers.parseEther("5") });

      await expect(
        esc.connect(freelancer).submitDelivery("QmX")
      ).to.be.revertedWithCustomError(esc, "SingleMilestoneOnly");
      await expect(esc.connect(client).release()).to.be.revertedWithCustomError(
        esc,
        "SingleMilestoneOnly"
      );
      await esc.connect(freelancer).submitMilestoneDelivery(0, "QmM0");
      await expect(
        esc.connect(client).requestRevision("nope")
      ).to.be.revertedWithCustomError(esc, "SingleMilestoneOnly");
    });
  });

  describe("disputes and refunds with milestones released", function () {
    it("dispute splits only the remaining balance after a milestone release", async function () {
      const f = await loadFixture(deployFactoryFixture);
      const { client, freelancer, arbiter, feeRecipient } = f;
      const { escrow: e } = await createMilestoneEscrow(f, ["2", "3"]);
      await e.connect(client).fund({ value: ethers.parseEther("5") });

      await e.connect(freelancer).submitMilestoneDelivery(0, "QmM0");
      await e.connect(client).releaseMilestone(0);
      const fee0 = (ethers.parseEther("2") * BigInt(FEE_BPS)) / 10_000n;
      const paid0 = ethers.parseEther("2") - fee0;

      // Dispute over the remaining 3 ETH; arbiter awards 50% of it.
      await e.connect(freelancer).raiseDispute("Client vanished on milestone 2");
      await e.connect(arbiter).resolveDispute(5000);
      const remaining = ethers.parseEther("3");
      const gross = remaining / 2n; // 1.5 ETH
      const fee = (gross * BigInt(FEE_BPS)) / 10_000n;
      expect(await e.pendingWithdrawals(freelancer.address)).to.equal(paid0 + gross - fee);
      expect(await e.pendingWithdrawals(client.address)).to.equal(remaining - gross);
      expect(await e.pendingWithdrawals(feeRecipient.address)).to.equal(fee0 + fee);
      expect(await e.status()).to.equal(7); // Resolved
    });

    it("deadline refund returns only the unreleased remainder", async function () {
      const f = await loadFixture(deployFactoryFixture);
      const { client, freelancer } = f;
      const { escrow: e } = await createMilestoneEscrow(f, ["2", "3"]);
      await e.connect(client).fund({ value: ethers.parseEther("5") });

      await e.connect(freelancer).submitMilestoneDelivery(0, "QmM0");
      await e.connect(client).releaseMilestone(0);

      await time.increase(SEVEN_DAYS + 1);
      await expect(e.connect(client).refundAfterDeadline())
        .to.emit(e, "Refunded")
        .withArgs(client.address, ethers.parseEther("3"));
      expect(await e.status()).to.equal(5); // Refunded
      expect(await e.pendingWithdrawals(client.address)).to.equal(ethers.parseEther("3"));
    });

    it("deadline refund is blocked while a milestone is under review", async function () {
      const f = await loadFixture(deployFactoryFixture);
      const { client, freelancer } = f;
      const { escrow: e } = await createMilestoneEscrow(f, ["2", "3"]);
      await e.connect(client).fund({ value: ethers.parseEther("5") });

      await e.connect(freelancer).submitMilestoneDelivery(1, "QmM1");
      await time.increase(SEVEN_DAYS + 1);
      await expect(
        e.connect(client).refundAfterDeadline()
      ).to.be.revertedWithCustomError(e, "InvalidStatus");
    });
  });
});
