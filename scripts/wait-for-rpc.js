// Waits until a local JSON-RPC node answers eth_chainId, then prints it.
// Used by the Docker entrypoint and CI before seeding.
//
//   node scripts/wait-for-rpc.js [url] [timeoutSeconds]

const url = process.argv[2] || process.env.RPC_URL || "http://127.0.0.1:8545";
const timeoutMs = Number(process.argv[3] || 60) * 1000;
const started = Date.now();

async function chainId() {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const body = await res.json();
  return parseInt(body.result, 16);
}

(async () => {
  for (;;) {
    try {
      const id = await chainId();
      console.log(`RPC ${url} is up (chain id ${id})`);
      if (id !== 31337) {
        console.error(`Refusing to continue: expected the local Hardhat chain (31337), got ${id}`);
        process.exit(2);
      }
      return;
    } catch {
      if (Date.now() - started > timeoutMs) {
        console.error(`Timed out after ${timeoutMs / 1000}s waiting for ${url}`);
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
})();
