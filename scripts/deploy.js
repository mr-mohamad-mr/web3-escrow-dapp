// Deploys EscrowFactory to the local Hardhat network and walks one escrow
// through the full happy-path lifecycle (create -> fund -> deliver ->
// release -> withdraw), printing every step. Local chain only — no real
// network, no real wallet, no real funds.
//
// Usage:
//   npx hardhat run scripts/deploy.js            # in-process local network
//   npx hardhat node                             # terminal 1 (persistent node)
//   npx hardhat run scripts/deploy.js --network localhost   # terminal 2
const { ethers } = require("hardhat");

async function main() {
  const [owner, client, freelancer, arbiter, feeRecipient] = await ethers.getSigners();
  console.log("Owner (factory admin):", owner.address);
  console.log("Client:               ", client.address);
  console.log("Freelancer:           ", freelancer.address);
  console.log("Arbiter:              ", arbiter.address);
  console.log("Fee recipient:        ", feeRecipient.address);

  const Factory = await ethers.getContractFactory("EscrowFactory");
  const factory = await Factory.deploy(arbiter.address, feeRecipient.address, 250);
  await factory.waitForDeployment();
  console.log("\nEscrowFactory deployed at:", await factory.getAddress());

  const amount = ethers.parseEther("5");
  const deadline = (await ethers.provider.getBlock("latest")).timestamp + 7 * 24 * 60 * 60;
  const tx = await factory.connect(client).createEscrow(freelancer.address, amount, deadline);
  const receipt = await tx.wait();
  const event = receipt.logs
    .map((log) => factory.interface.parseLog(log))
    .find((parsed) => parsed && parsed.name === "EscrowCreated");
  const escrowAddress = event.args.escrow;
  const escrow = await ethers.getContractAt("FreelanceEscrow", escrowAddress);
  console.log("FreelanceEscrow created:", escrowAddress, "(5 ETH, 2.5% fee, 7-day deadline)");

  await (await escrow.connect(client).fund({ value: amount })).wait();
  console.log("Funded: status =", await escrow.status(), "(1 = Funded)");

  await (await escrow.connect(freelancer).submitDelivery("QmDemoDeliveryHash")).wait();
  console.log("Delivered: status =", await escrow.status(), "(2 = Delivered)");

  await (await escrow.connect(client).release()).wait();
  console.log("Released: status =", await escrow.status(), "(4 = Released)");
  console.log("  freelancer pending:", ethers.formatEther(await escrow.pendingWithdrawals(freelancer.address)), "ETH");
  console.log("  fee pending:      ", ethers.formatEther(await escrow.pendingWithdrawals(feeRecipient.address)), "ETH");

  const before = await ethers.provider.getBalance(freelancer.address);
  await (await escrow.connect(freelancer).withdraw()).wait();
  const after = await ethers.provider.getBalance(freelancer.address);
  console.log("Freelancer withdrew:", ethers.formatEther(after - before), "ETH (minus gas)");
  console.log("Escrow balance now: ", ethers.formatEther(await ethers.provider.getBalance(escrowAddress)), "ETH");
  console.log("\nSMOKE OK — full lifecycle completed on the local chain.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
