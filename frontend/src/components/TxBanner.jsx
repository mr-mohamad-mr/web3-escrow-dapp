// Explicit transaction lifecycle banner: every write goes through
// pending → confirmed (tx hash + block) or failed (with the contract's
// decoded custom-error name, courtesy of the interaction layer).

export default function TxBanner({ tx }) {
  if (!tx || tx.status === "idle") return null;
  return (
    <div className={`tx-banner tx-${tx.status}`} data-testid="tx-banner" data-status={tx.status}>
      {tx.status === "pending" && (
        <span>
          <span className="spinner" aria-hidden="true" /> <strong>{tx.label}</strong> — transaction
          sent, waiting for 1 confirmation…
        </span>
      )}
      {tx.status === "confirmed" && (
        <span>
          ✓ <strong>{tx.label}</strong> — confirmed in block {tx.blockNumber} · tx{" "}
          <code>{tx.txHash.slice(0, 10)}…</code>
        </span>
      )}
      {tx.status === "failed" && (
        <span>
          ✗ <strong>{tx.label}</strong> — failed: <code>{tx.error}</code>
        </span>
      )}
    </div>
  );
}
