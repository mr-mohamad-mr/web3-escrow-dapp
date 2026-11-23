const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const AMOUNT = ethers.parseEther("2");
const SEVEN_DAYS = 7 * 24 * 60 * 60;

describe("EscrowFactory", function () {
  async function deployFactoryFixture() {
    const [owner, client, freelancer, freelancer2, arbiter, arbiter2, feeRecipient] =
      await ethers.getSigners();

    const Factory = await ethers.getContractFactory("EscrowFactory");
    const factory = await Factory.deploy(arbiter.address, feeRecipient.address, 250);

    return { factory, owner, client, freelancer, freelancer2, arbiter, arbiter2, feeRecipient };
  }

  it("stores the arbiter, fee recipient and fee from construction", async function () {
    const { factory, arbiter, feeRecipient } = await loadFixture(deployFactoryFixture);
    expect(await factory.arbiter()).to.equal(arbiter.address);
    expect(await factory.feeRecipient()).to.equal(feeRecipient.address);
    expect(await factory.feeBps()).to.equal(250);
    expect(await factory.MAX_FEE_BPS()).to.equal(1000);
    expect(await factory.getEscrowCount()).to.equal(0);
  });

  it("rejects a fee above the 10% cap at construction", async function () {
    const [, , , , arbiter, , feeRecipient] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("EscrowFactory");
    await expect(
      Factory.deploy(arbiter.address, feeRecipient.address, 1001)
    ).to.be.revertedWithCustomError(Factory, "FeeTooHigh");
  });

  it("creates escrows, emits EscrowCreated and registers them per party", async function () {
    const { factory, client, freelancer, freelancer2 } =
      await loadFixture(deployFactoryFixture);
    const deadline = (await time.latest()) + SEVEN_DAYS;

    const tx = await factory.connect(client).createEscrow(freelancer.address, AMOUNT, deadline);
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((log) => factory.interface.parseLog(log))
      .find((parsed) => parsed && parsed.name === "EscrowCreated");
    const escrowAddress = event.args.escrow;
    expect(event.args.client).to.equal(client.address);
    expect(event.args.freelancer).to.equal(freelancer.address);
    expect(event.args.amount).to.equal(AMOUNT);
    expect(event.args.deadline).to.equal(deadline);

    expect(await factory.getEscrowCount()).to.equal(1);
    expect(await factory.getEscrowsByClient(client.address)).to.deep.equal([escrowAddress]);
    expect(await factory.getEscrowsByFreelancer(freelancer.address)).to.deep.equal([
      escrowAddress,
    ]);
    expect(await factory.getEscrowsByFreelancer(freelancer2.address)).to.deep.equal([]);

    // The deployed escrow carries the factory's terms.
    const escrow = await ethers.getContractAt("FreelanceEscrow", escrowAddress);
    expect(await escrow.client()).to.equal(client.address);
    expect(await escrow.freelancer()).to.equal(freelancer.address);
    expect(await escrow.amount()).to.equal(AMOUNT);
    expect(await escrow.feeBps()).to.equal(250);

    // A second escrow for another freelancer appends to the same client list.
    await factory.connect(client).createEscrow(freelancer2.address, AMOUNT, deadline);
    expect(await factory.getEscrowCount()).to.equal(2);
    expect((await factory.getEscrowsByClient(client.address)).length).to.equal(2);
  });

  it("a fee change applies only to escrows created afterwards", async function () {
    const { factory, client, freelancer } = await loadFixture(deployFactoryFixture);
    const deadline = (await time.latest()) + SEVEN_DAYS;

    await factory.connect(client).createEscrow(freelancer.address, AMOUNT, deadline);
    await factory.setFeeBps(500);
    await factory.connect(client).createEscrow(freelancer.address, AMOUNT, deadline);

    const escrows = await factory.getEscrowsByClient(client.address);
    const first = await ethers.getContractAt("FreelanceEscrow", escrows[0]);
    const second = await ethers.getContractAt("FreelanceEscrow", escrows[1]);
    expect(await first.feeBps()).to.equal(250);
    expect(await second.feeBps()).to.equal(500);
  });

  describe("admin controls", function () {
    it("only the owner can change arbiter, fee and fee recipient", async function () {
      const { factory, client, arbiter2, feeRecipient } =
        await loadFixture(deployFactoryFixture);

      await expect(
        factory.connect(client).setArbiter(arbiter2.address)
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
      await expect(factory.connect(client).setFeeBps(100)).to.be.revertedWithCustomError(
        factory,
        "OwnableUnauthorizedAccount"
      );
      await expect(
        factory.connect(client).setFeeRecipient(feeRecipient.address)
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    });

    it("owner updates are validated and emit events", async function () {
      const { factory, arbiter, arbiter2, feeRecipient } =
        await loadFixture(deployFactoryFixture);

      await expect(factory.setArbiter(arbiter2.address))
        .to.emit(factory, "ArbiterUpdated")
        .withArgs(arbiter.address, arbiter2.address);
      expect(await factory.arbiter()).to.equal(arbiter2.address);

      await expect(factory.setFeeBps(1000))
        .to.emit(factory, "FeeUpdated")
        .withArgs(250, 1000);
      await expect(factory.setFeeBps(1001)).to.be.revertedWithCustomError(
        factory,
        "FeeTooHigh"
      );
      await expect(factory.setArbiter(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        factory,
        "ZeroAddress"
      );
      await expect(
        factory.setFeeRecipient(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });
});
