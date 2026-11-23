const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const AMOUNT = ethers.parseEther("10"); // 10 ETH job
const FEE_BPS = 250; // 2.5% platform fee
const SEVEN_DAYS = 7 * 24 * 60 * 60;

describe("FreelanceEscrow", function () {
  async function deployEscrowFixture() {
    const [owner, client, freelancer, arbiter, feeRecipient, other] =
      await ethers.getSigners();

    const Factory = await ethers.getContractFactory("EscrowFactory");
    const factory = await Factory.deploy(arbiter.address, feeRecipient.address, FEE_BPS);

    const deadline = (await time.latest()) + SEVEN_DAYS;
    const tx = await factory.connect(client).createEscrow(freelancer.address, AMOUNT, deadline);
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((log) => factory.interface.parseLog(log))
      .find((parsed) => parsed && parsed.name === "EscrowCreated");
    const escrowAddress = event.args.escrow;

    const escrow = await ethers.getContractAt("FreelanceEscrow", escrowAddress);
    return { factory, escrow, owner, client, freelancer, arbiter, feeRecipient, other, deadline };
  }

  async function fundedFixture() {
    const f = await loadFixture(deployEscrowFixture);
    await f.escrow.connect(f.client).fund({ value: AMOUNT });
    return f;
  }

  async function deliveredFixture() {
    const f = await loadFixture(fundedFixture);
    await f.escrow.connect(f.freelancer).submitDelivery("QmTestDeliveryHash123");
    return f;
  }

  describe("deployment", function () {
    it("stores client, freelancer, arbiter, amount, deadline and fee", async function () {
      const { escrow, client, freelancer, arbiter, feeRecipient, deadline } =
        await loadFixture(deployEscrowFixture);

      expect(await escrow.client()).to.equal(client.address);
      expect(await escrow.freelancer()).to.equal(freelancer.address);
      expect(await escrow.arbiter()).to.equal(arbiter.address);
      expect(await escrow.feeRecipient()).to.equal(feeRecipient.address);
      expect(await escrow.amount()).to.equal(AMOUNT);
      expect(await escrow.deadline()).to.equal(deadline);
      expect(await escrow.feeBps()).to.equal(FEE_BPS);
      expect(await escrow.status()).to.equal(0); // Created
    });

    it("rejects a zero freelancer address, zero amount and past deadline", async function () {
      const { factory, client, freelancer } = await loadFixture(deployEscrowFixture);
      const future = (await time.latest()) + SEVEN_DAYS;

      await expect(
        factory.connect(client).createEscrow(ethers.ZeroAddress, AMOUNT, future)
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(
        factory.connect(client).createEscrow(freelancer.address, 0, future)
      ).to.be.revertedWithCustomError(factory, "ZeroAmount");
      await expect(
        factory.connect(client).createEscrow(freelancer.address, AMOUNT, 1)
      ).to.be.revertedWithCustomError(factory, "DeadlineInPast");
      await expect(
        factory.connect(client).createEscrow(client.address, AMOUNT, future)
      ).to.be.revertedWithCustomError(factory, "SelfEscrow");
    });
  });

  describe("funding", function () {
    it("moves Created -> Funded and emits EscrowFunded", async function () {
      const { escrow, client } = await loadFixture(deployEscrowFixture);

      const tx = await escrow.connect(client).fund({ value: AMOUNT });
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const event = receipt.logs
        .map((log) => escrow.interface.parseLog(log))
        .find((parsed) => parsed && parsed.name === "EscrowFunded");
      expect(event.args.client).to.equal(client.address);
      expect(event.args.amount).to.equal(AMOUNT);
      expect(event.args.fundedAt).to.equal(block.timestamp);
      expect(await escrow.fundedAt()).to.equal(block.timestamp);

      expect(await escrow.status()).to.equal(1); // Funded
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(AMOUNT);
    });

    it("only the client can fund, with the exact amount, once", async function () {
      const { escrow, client, freelancer, other } = await loadFixture(deployEscrowFixture);

      await expect(
        escrow.connect(other).fund({ value: AMOUNT })
      ).to.be.revertedWithCustomError(escrow, "OnlyClient");
      await expect(
        escrow.connect(client).fund({ value: AMOUNT - 1n })
      ).to.be.revertedWithCustomError(escrow, "IncorrectFunding");
      await expect(
        escrow.connect(client).fund({ value: AMOUNT + 1n })
      ).to.be.revertedWithCustomError(escrow, "IncorrectFunding");

      await escrow.connect(client).fund({ value: AMOUNT });
      await expect(
        escrow.connect(client).fund({ value: AMOUNT })
      ).to.be.revertedWithCustomError(escrow, "InvalidStatus");
      expect(await escrow.status()).to.equal(1);
      expect(freelancer.address).to.not.equal(client.address);
    });

    it("rejects plain ETH transfers (funding goes via fund())", async function () {
      const { escrow, client } = await loadFixture(deployEscrowFixture);

      await expect(
        client.sendTransaction({ to: await escrow.getAddress(), value: AMOUNT })
      ).to.be.revertedWithCustomError(escrow, "IncorrectFunding");
    });

    it("cannot be funded after the deadline passed", async function () {
      const { escrow, client } = await loadFixture(deployEscrowFixture);
      await time.increase(SEVEN_DAYS + 1);

      await expect(
        escrow.connect(client).fund({ value: AMOUNT })
      ).to.be.revertedWithCustomError(escrow, "DeadlineInPast");
    });
  });

  describe("delivery and release (happy path)", function () {
    it("full flow: fund -> deliver -> release -> withdraw, with fee split", async function () {
      const { escrow, client, freelancer, feeRecipient } = await loadFixture(deployEscrowFixture);

      await escrow.connect(client).fund({ value: AMOUNT });
      const tx = await escrow.connect(freelancer).submitDelivery("QmHash");
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const event = receipt.logs
        .map((log) => escrow.interface.parseLog(log))
        .find((parsed) => parsed && parsed.name === "DeliverySubmitted");
      expect(event.args.freelancer).to.equal(freelancer.address);
      expect(event.args.deliveryHash).to.equal("QmHash");
      expect(event.args.deliveredAt).to.equal(block.timestamp);
      expect(await escrow.status()).to.equal(2); // Delivered
      expect(await escrow.deliveryHash()).to.equal("QmHash");

      const fee = (AMOUNT * BigInt(FEE_BPS)) / 10_000n; // 0.25 ETH
      const freelancerAmount = AMOUNT - fee; // 9.75 ETH

      await expect(escrow.connect(client).release())
        .to.emit(escrow, "Released")
        .withArgs(freelancer.address, freelancerAmount, fee);
      expect(await escrow.status()).to.equal(4); // Released
      expect(await escrow.pendingWithdrawals(freelancer.address)).to.equal(freelancerAmount);
      expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(fee);

      // Pull pattern: freelancer withdraws exactly once.
      await expect(() => escrow.connect(freelancer).withdraw()).to.changeEtherBalances(
        [freelancer, escrow],
        [freelancerAmount, -freelancerAmount]
      );
      await expect(escrow.connect(freelancer).withdraw()).to.be.revertedWithCustomError(
        escrow,
        "NothingToWithdraw"
      );

      await expect(() => escrow.connect(feeRecipient).withdraw()).to.changeEtherBalances(
        [feeRecipient, escrow],
        [fee, -fee]
      );
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0);
    });

    it("only the freelancer can deliver; only the client can release", async function () {
      const { escrow, client, freelancer, other } = await loadFixture(fundedFixture);

      await expect(
        escrow.connect(client).submitDelivery("QmHash")
      ).to.be.revertedWithCustomError(escrow, "OnlyFreelancer");
      await expect(
        escrow.connect(other).submitDelivery("QmHash")
      ).to.be.revertedWithCustomError(escrow, "OnlyFreelancer");
      await expect(
        escrow.connect(freelancer).release()
      ).to.be.revertedWithCustomError(escrow, "OnlyClient");
      // Release before delivery is also an invalid status.
      await escrow.connect(freelancer).submitDelivery("QmHash");
      await expect(
        escrow.connect(freelancer).release()
      ).to.be.revertedWithCustomError(escrow, "OnlyClient");
      expect(await escrow.status()).to.equal(2);
    });

    it("revision request sends work back; freelancer can re-deliver and be paid", async function () {
      const { escrow, client, freelancer } = await loadFixture(deliveredFixture);

      await expect(escrow.connect(client).requestRevision("Fix the header"))
        .to.emit(escrow, "RevisionRequested")
        .withArgs(client.address, "Fix the header", 1);
      expect(await escrow.status()).to.equal(1); // Funded again
      expect(await escrow.revisionCount()).to.equal(1);

      await escrow.connect(freelancer).submitDelivery("QmHashV2");
      await escrow.connect(client).release();
      expect(await escrow.status()).to.equal(4);
      expect(await escrow.pendingWithdrawals(freelancer.address)).to.equal(
        AMOUNT - (AMOUNT * BigInt(FEE_BPS)) / 10_000n
      );
    });
  });

  describe("cancel and deadline refund", function () {
    it("client can cancel before funding; a cancelled escrow cannot be funded", async function () {
      const { escrow, client } = await loadFixture(deployEscrowFixture);

      await expect(escrow.connect(client).cancel())
        .to.emit(escrow, "Cancelled")
        .withArgs(client.address);
      expect(await escrow.status()).to.equal(6); // Cancelled
      await expect(
        escrow.connect(client).fund({ value: AMOUNT })
      ).to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });

    it("only the client can cancel", async function () {
      const { escrow, freelancer } = await loadFixture(deployEscrowFixture);
      await expect(escrow.connect(freelancer).cancel()).to.be.revertedWithCustomError(
        escrow,
        "OnlyClient"
      );
    });

    it("full refund to the client after the deadline with no delivery", async function () {
      const { escrow, client } = await loadFixture(fundedFixture);

      await expect(escrow.connect(client).refundAfterDeadline()).to.be.revertedWithCustomError(
        escrow,
        "DeadlineNotReached"
      );

      await time.increase(SEVEN_DAYS + 1);
      await expect(escrow.connect(client).refundAfterDeadline())
        .to.emit(escrow, "Refunded")
        .withArgs(client.address, AMOUNT);
      expect(await escrow.status()).to.equal(5); // Refunded
      expect(await escrow.pendingWithdrawals(client.address)).to.equal(AMOUNT);

      await expect(() => escrow.connect(client).withdraw()).to.changeEtherBalances(
        [client, escrow],
        [AMOUNT, -AMOUNT]
      );
    });
  });

  describe("disputes", function () {
    it("freelancer can dispute while funded; arbiter splits 60/40", async function () {
      const { escrow, client, freelancer, arbiter, feeRecipient } =
        await loadFixture(fundedFixture);

      await expect(escrow.connect(freelancer).raiseDispute("Client went silent"))
        .to.emit(escrow, "DisputeRaised")
        .withArgs(freelancer.address, "Client went silent");
      expect(await escrow.status()).to.equal(3); // Disputed

      // Only the arbiter resolves.
      await expect(
        escrow.connect(client).resolveDispute(6000)
      ).to.be.revertedWithCustomError(escrow, "OnlyArbiter");

      const freelancerGross = (AMOUNT * 6000n) / 10_000n; // 6 ETH
      const fee = (freelancerGross * BigInt(FEE_BPS)) / 10_000n; // 0.15 ETH
      const freelancerNet = freelancerGross - fee; // 5.85 ETH
      const clientAmount = AMOUNT - freelancerGross; // 4 ETH

      await expect(escrow.connect(arbiter).resolveDispute(6000))
        .to.emit(escrow, "DisputeResolved")
        .withArgs(arbiter.address, 6000, freelancerNet, clientAmount, fee);
      expect(await escrow.status()).to.equal(7); // Resolved
      expect(await escrow.pendingWithdrawals(freelancer.address)).to.equal(freelancerNet);
      expect(await escrow.pendingWithdrawals(client.address)).to.equal(clientAmount);
      expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(fee);

      await expect(() => escrow.connect(freelancer).withdraw()).to.changeEtherBalances(
        [freelancer, escrow],
        [freelancerNet, -freelancerNet]
      );
      await expect(() => escrow.connect(client).withdraw()).to.changeEtherBalances(
        [client, escrow],
        [clientAmount, -clientAmount]
      );
    });

    it("client can dispute a delivered escrow; arbiter can award 0% or 100%", async function () {
      const { escrow, client, freelancer, arbiter } = await loadFixture(deliveredFixture);

      await escrow.connect(client).raiseDispute("Work does not match the brief");
      expect(await escrow.status()).to.equal(3);

      await expect(
        escrow.connect(arbiter).resolveDispute(10_001)
      ).to.be.revertedWithCustomError(escrow, "InvalidShare");

      // 0% to freelancer: full refund to the client.
      await escrow.connect(arbiter).resolveDispute(0);
      expect(await escrow.pendingWithdrawals(client.address)).to.equal(AMOUNT);
      expect(await escrow.pendingWithdrawals(freelancer.address)).to.equal(0);
      expect(await escrow.status()).to.equal(7);
    });

    it("100% to freelancer still takes the platform fee", async function () {
      const { escrow, client, freelancer, arbiter, feeRecipient } =
        await loadFixture(deliveredFixture);

      await escrow.connect(client).raiseDispute("Minor issue, pay in full");
      await escrow.connect(arbiter).resolveDispute(10_000);
      const fee = (AMOUNT * BigInt(FEE_BPS)) / 10_000n;
      expect(await escrow.pendingWithdrawals(freelancer.address)).to.equal(AMOUNT - fee);
      expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(fee);
    });

    it("outsiders cannot raise a dispute; resolved escrows are final", async function () {
      const { escrow, client, arbiter, other } = await loadFixture(fundedFixture);

      await expect(
        escrow.connect(other).raiseDispute("I am not a party")
      ).to.be.revertedWithCustomError(escrow, "OnlyClient");
      await escrow.connect(client).raiseDispute("Legit dispute");
      await escrow.connect(arbiter).resolveDispute(5000);
      await expect(
        escrow.connect(client).raiseDispute("Again")
      ).to.be.revertedWithCustomError(escrow, "InvalidStatus");
      await expect(
        escrow.connect(client).release()
      ).to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });
  });

  describe("reentrancy", function () {
    it("a malicious freelancer contract cannot drain the escrow via withdraw()", async function () {
      const [, client, , arbiter, feeRecipient] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("EscrowFactory");
      const factory = await Factory.deploy(arbiter.address, feeRecipient.address, FEE_BPS);

      // Deploy the attacker first, then create an escrow naming it freelancer.
      const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
      const attacker = await Attacker.deploy();

      const deadline = (await time.latest()) + SEVEN_DAYS;
      const tx = await factory
        .connect(client)
        .createEscrow(await attacker.getAddress(), AMOUNT, deadline);
      const receipt = await tx.wait();
      const event = receipt.logs
        .map((log) => factory.interface.parseLog(log))
        .find((parsed) => parsed && parsed.name === "EscrowCreated");
      const escrow = await ethers.getContractAt("FreelanceEscrow", event.args.escrow);

      await attacker.setEscrow(await escrow.getAddress());
      await escrow.connect(client).fund({ value: AMOUNT });
      await attacker.submitDelivery("QmMalicious");
      await escrow.connect(client).release();

      const fee = (AMOUNT * BigInt(FEE_BPS)) / 10_000n;
      const freelancerAmount = AMOUNT - fee;
      const balanceBefore = await ethers.provider.getBalance(await attacker.getAddress());

      await attacker.attackWithdraw();

      const balanceAfter = await ethers.provider.getBalance(await attacker.getAddress());
      expect(balanceAfter - balanceBefore).to.equal(freelancerAmount); // paid exactly once
      expect(await attacker.reentryAttempts()).to.equal(1);
      expect(await attacker.reentrySucceeded()).to.equal(false);
      expect(await escrow.pendingWithdrawals(await attacker.getAddress())).to.equal(0);
    });
  });

  describe("views", function () {
    it("getDetails returns the full snapshot", async function () {
      const { escrow, client, freelancer, arbiter } = await loadFixture(deliveredFixture);
      const d = await escrow.getDetails();
      expect(d._client).to.equal(client.address);
      expect(d._freelancer).to.equal(freelancer.address);
      expect(d._arbiter).to.equal(arbiter.address);
      expect(d._amount).to.equal(AMOUNT);
      expect(d._feeBps).to.equal(FEE_BPS);
      expect(d._status).to.equal(2);
      expect(d._deliveryHash).to.equal("QmTestDeliveryHash123");
      expect(d._revisionCount).to.equal(0);
    });
  });
});
