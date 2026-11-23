import { useState } from "react";
import { actions } from "../chain/client.js";

// Escrow-level actions: fund, cancel, refund after deadline, and the
// dispute pair (raise as a party, resolve as the arbiter). Like the
// milestone actions, role gating here is a UX hint — the contracts
// enforce every role and state transition on-chain.

export default function EscrowActions({ summary, account, runTx, busy }) {
  const [disputeReason, setDisputeReason] = useState("Work does not match the brief");
  const [sharePercent, setSharePercent] = useState(50);

  const me = account?.toLowerCase();
  const isClient = me === summary.client.toLowerCase();
  const isFreelancer = me === summary.freelancer.toLowerCase();
  const isArbiter = me === summary.arbiter.toLowerCase();
  const isParty = isClient || isFreelancer;
  const status = summary.statusName;
  const deadlinePassed = Date.now() > new Date(summary.deadline).getTime();

  const showFund = status === "Created";
  const showDispute = status === "Funded" || status === "Delivered";
  const showResolve = status === "Disputed";
  const showRefund = status === "Funded";
  const showCancel = status === "Created";

  if (!showFund && !showDispute && !showResolve && !showRefund && !showCancel) {
    return null;
  }

  return (
    <section className="panel actions-panel">
      <h3>Actions</h3>

      {showFund && (
        <div className="action-row">
          <button
            className="btn btn-primary"
            disabled={busy || !isClient}
            data-testid="fund-btn"
            onClick={() => runTx("Fund escrow", () => actions.fund(account, summary.address))}
          >
            Fund {summary.amountEth} ETH
          </button>
          {!isClient && <span className="role-hint">client only</span>}
        </div>
      )}

      {showDispute && (
        <div className="action-row">
          <input
            type="text"
            value={disputeReason}
            onChange={(e) => setDisputeReason(e.target.value)}
            placeholder="Dispute reason"
            aria-label="Dispute reason"
          />
          <button
            className="btn btn-danger"
            disabled={busy || !isParty}
            data-testid="dispute-btn"
            onClick={() =>
              runTx("Raise dispute", () => actions.raiseDispute(account, summary.address, disputeReason))
            }
          >
            Raise dispute
          </button>
          {!isParty && <span className="role-hint">client or freelancer only</span>}
        </div>
      )}

      {showResolve && (
        <div className="action-row">
          <label className="share-input">
            Freelancer share
            <input
              type="number"
              min="0"
              max="100"
              value={sharePercent}
              onChange={(e) => setSharePercent(e.target.value)}
            />
            %
          </label>
          <button
            className="btn btn-danger"
            disabled={busy || !isArbiter}
            data-testid="resolve-btn"
            onClick={() =>
              runTx("Resolve dispute", () =>
                actions.resolveDispute(account, summary.address, Math.round(Number(sharePercent) * 100))
              )
            }
          >
            Resolve dispute
          </button>
          {!isArbiter && <span className="role-hint">arbiter only</span>}
          <span className="action-note">
            Splits the remaining {summary.remainingEth} ETH; the fee comes out of the freelancer's
            share.
          </span>
        </div>
      )}

      {showRefund && (
        <div className="action-row">
          <button
            className="btn"
            disabled={busy || !isClient || !deadlinePassed}
            data-testid="refund-btn"
            onClick={() =>
              runTx("Refund after deadline", () => actions.refund(account, summary.address))
            }
          >
            Refund after deadline
          </button>
          {!isClient && <span className="role-hint">client only</span>}
          {isClient && !deadlinePassed && (
            <span className="action-note">
              Available after the deadline ({new Date(summary.deadline).toLocaleString()}).
            </span>
          )}
        </div>
      )}

      {showCancel && (
        <div className="action-row">
          <button
            className="btn"
            disabled={busy || !isClient}
            data-testid="cancel-btn"
            onClick={() => runTx("Cancel escrow", () => actions.cancel(account, summary.address))}
          >
            Cancel escrow
          </button>
          {!isClient && <span className="role-hint">client only</span>}
        </div>
      )}
    </section>
  );
}
