// "Wallet connect" for the local demo: connecting means picking one of
// the Hardhat node's unlocked accounts to act as. The role labels come
// from the seed deployment (owner, client, freelancer, arbiter, fee
// recipient), so switching accounts is how you walk the lifecycle as
// each party. No real wallet is involved — local chain only.

export default function ConnectBar({
  connected,
  connecting,
  chainId,
  deployment,
  accounts,
  account,
  onConnect,
  onSelectAccount,
}) {
  if (!connected) {
    return (
      <div className="connect-bar">
        <button
          className="btn btn-primary"
          onClick={onConnect}
          disabled={connecting}
          data-testid="connect-btn"
        >
          {connecting ? "Connecting…" : "Connect local wallet"}
        </button>
        <span className="connect-note">
          Connects to the Hardhat node at 127.0.0.1:8545 and lets you act as one of its unlocked
          demo accounts. No real wallet, no real funds.
        </span>
      </div>
    );
  }

  const current = accounts.find((a) => a.address === account);

  return (
    <div className="connect-bar" data-testid="connect-bar">
      <span className="badge badge-network">⬢ Hardhat local · chain {chainId}</span>
      <label className="account-picker">
        <span>Acting as</span>
        <select
          value={account || ""}
          onChange={(e) => onSelectAccount(e.target.value)}
          data-testid="account-select"
        >
          {accounts.map((a) => (
            <option key={a.address} value={a.address}>
              {a.label} — {a.address.slice(0, 6)}…{a.address.slice(-4)} ({Number(a.balanceEth).toFixed(2)} ETH)
            </option>
          ))}
        </select>
      </label>
      {current && (
        <span className="account-balance">
          Balance: <strong>{Number(current.balanceEth).toFixed(4)} ETH</strong>
        </span>
      )}
      {deployment && (
        <span className="factory-note">
          Factory <code>{deployment.factory.slice(0, 6)}…{deployment.factory.slice(-4)}</code> ·
          fee {deployment.feeBps / 100}%
        </span>
      )}
    </div>
  );
}
