import StatusChip from "./StatusChip.jsx";
import MilestoneCard from "./MilestoneCard.jsx";
import EscrowActions from "./EscrowActions.jsx";
import { actions, shortAddress } from "../chain/client.js";

// Full detail for one escrow: the facts grid, the dispute state, the
// per-milestone cards, pending withdrawals (pull pattern — each party
// withdraws their own balance), escrow-level actions, and the
// on-chain activity timeline.

export default function EscrowDetail({ summary, name, timeline, account, runTx, busy }) {
  if (!summary) {
    return (
      <div className="detail-empty">
        <p>Select an escrow to see its milestones, timeline and actions.</p>
      </div>
    );
  }

  const parties = [
    { role: "client", label: "Client", address: summary.client },
    { role: "freelancer", label: "Freelancer", address: summary.freelancer },
    { role: "feeRecipient", label: "Fee recipient", address: summary.feeRecipient },
  ];

  return (
    <div className="detail" data-testid="escrow-detail">
      <header className="detail-head">
        <h2>{name || `Escrow ${shortAddress(summary.address)}`}</h2>
        <StatusChip status={summary.statusName} />
      </header>
      <p className="detail-address">
        <code>{summary.address}</code>
      </p>

      <div className="facts-grid">
        <div>
          <span>Total</span>
          <strong>{summary.amountEth} ETH</strong>
        </div>
        <div>
          <span>Released</span>
          <strong>{summary.releasedEth} ETH</strong>
        </div>
        <div>
          <span>Remaining</span>
          <strong>{summary.remainingEth} ETH</strong>
        </div>
        <div>
          <span>Contract balance</span>
          <strong>{summary.balanceEth} ETH</strong>
        </div>
        <div>
          <span>Client</span>
          <strong>{shortAddress(summary.client)}</strong>
        </div>
        <div>
          <span>Freelancer</span>
          <strong>{shortAddress(summary.freelancer)}</strong>
        </div>
        <div>
          <span>Arbiter</span>
          <strong>{shortAddress(summary.arbiter)}</strong>
        </div>
        <div>
          <span>Fee</span>
          <strong>{summary.feeBps / 100}%</strong>
        </div>
        <div>
          <span>Deadline</span>
          <strong>{new Date(summary.deadline).toLocaleString()}</strong>
        </div>
        <div>
          <span>Revisions</span>
          <strong>{summary.revisionCount}</strong>
        </div>
      </div>

      {summary.statusName === "Disputed" && (
        <div className="dispute-banner" data-testid="dispute-banner">
          ⚖️ <strong>Disputed.</strong>{" "}
          {summary.disputeReason ? <>Reason: “{summary.disputeReason}”. </> : null}
          The arbiter resolves it below — already-released milestones are never re-split.
        </div>
      )}

      <section className="panel">
        <h3>Milestones</h3>
        <div className="milestone-list">
          {summary.milestones.map((milestone) => (
            <MilestoneCard
              key={milestone.index}
              summary={summary}
              milestone={milestone}
              account={account}
              runTx={runTx}
              busy={busy}
            />
          ))}
        </div>
      </section>

      <section className="panel">
        <h3>Pending withdrawals</h3>
        {parties.every((p) => Number(summary.pendingWithdrawalsEth[p.role]) === 0) ? (
          <p className="empty">Nothing waiting to be withdrawn.</p>
        ) : (
          <ul className="withdraw-list">
            {parties
              .filter((p) => Number(summary.pendingWithdrawalsEth[p.role]) > 0)
              .map((p) => {
                const mine = account?.toLowerCase() === p.address.toLowerCase();
                return (
                  <li key={p.role}>
                    <span>
                      {p.label} ({shortAddress(p.address)}):{" "}
                      <strong>{summary.pendingWithdrawalsEth[p.role]} ETH</strong>
                    </span>
                    <button
                      className="btn"
                      disabled={busy || !mine}
                      title={mine ? "" : `Switch to the ${p.label.toLowerCase()} account to withdraw`}
                      data-testid="withdraw-btn"
                      onClick={() =>
                        runTx(`Withdraw (${p.label})`, () => actions.withdraw(account, summary.address))
                      }
                    >
                      Withdraw
                    </button>
                  </li>
                );
              })}
          </ul>
        )}
      </section>

      <EscrowActions summary={summary} account={account} runTx={runTx} busy={busy} />

      <section className="panel">
        <h3>Activity</h3>
        {timeline.length === 0 ? (
          <p className="empty">No on-chain activity found.</p>
        ) : (
          <ol className="timeline" data-testid="timeline">
            {timeline.map((entry, i) => (
              <li key={`${entry.txHash}-${entry.logIndex ?? i}`} className="timeline-item">
                <span className="timeline-dot" aria-hidden="true" />
                <div>
                  <strong>{entry.title}</strong>
                  {entry.detail && <span className="timeline-detail"> — {entry.detail}</span>}
                  <div className="timeline-meta">
                    {new Date(entry.at).toLocaleString()} · block {entry.blockNumber} · tx{" "}
                    <code>{entry.txHash.slice(0, 10)}…</code>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
