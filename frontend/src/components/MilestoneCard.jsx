import { useState } from "react";
import StatusChip from "./StatusChip.jsx";
import { actions } from "../chain/client.js";

// One milestone of an escrow: amount, status, delivery hash, and the
// actions that make sense for it right now, gated by the connected
// account's role. The gating is a UX hint only — the contract
// re-verifies the caller on-chain for every call.

export default function MilestoneCard({ summary, milestone, account, runTx, busy }) {
  const [deliveryHash, setDeliveryHash] = useState(`QmMilestone${milestone.index + 1}Delivery`);
  const [reason, setReason] = useState("Needs a few changes");

  const isClient = account?.toLowerCase() === summary.client.toLowerCase();
  const isFreelancer = account?.toLowerCase() === summary.freelancer.toLowerCase();
  const funded = ["Funded", "Delivered"].includes(summary.statusName);
  const disputed = summary.statusName === "Disputed";

  return (
    <div className="milestone-card" data-testid="milestone-card" data-index={milestone.index}>
      <div className="milestone-head">
        <strong>
          Milestone {milestone.index + 1} · {milestone.amountEth} ETH
        </strong>
        <StatusChip status={milestone.statusName} />
      </div>

      {milestone.deliveryHash && (
        <p className="milestone-hash">
          Delivery: <code>{milestone.deliveryHash}</code>
          {milestone.deliveredAt && (
            <> · {new Date(milestone.deliveredAt).toLocaleString()}</>
          )}
        </p>
      )}

      {funded && !disputed && milestone.statusName === "Pending" && (
        <div className="milestone-actions">
          <input
            type="text"
            value={deliveryHash}
            onChange={(e) => setDeliveryHash(e.target.value)}
            placeholder="Delivery hash (e.g. IPFS CID)"
            aria-label="Delivery hash"
          />
          <button
            className="btn"
            disabled={busy || !isFreelancer}
            title={isFreelancer ? "" : "Switch to the freelancer account to deliver"}
            data-testid="deliver-btn"
            onClick={() =>
              runTx(`Deliver milestone ${milestone.index + 1}`, () =>
                actions.deliverMilestone(account, summary.address, milestone.index, deliveryHash)
              )
            }
          >
            Deliver
          </button>
          {!isFreelancer && <span className="role-hint">freelancer only</span>}
        </div>
      )}

      {funded && !disputed && milestone.statusName === "Delivered" && (
        <div className="milestone-actions">
          <button
            className="btn btn-primary"
            disabled={busy || !isClient}
            title={isClient ? "" : "Switch to the client account to release"}
            data-testid="release-btn"
            onClick={() =>
              runTx(`Release milestone ${milestone.index + 1}`, () =>
                actions.releaseMilestone(account, summary.address, milestone.index)
              )
            }
          >
            Release {milestone.amountEth} ETH
          </button>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Revision reason"
            aria-label="Revision reason"
          />
          <button
            className="btn"
            disabled={busy || !isClient}
            title={isClient ? "" : "Switch to the client account to request a revision"}
            data-testid="revise-btn"
            onClick={() =>
              runTx(`Request revision on milestone ${milestone.index + 1}`, () =>
                actions.reviseMilestone(account, summary.address, milestone.index, reason)
              )
            }
          >
            Request revision
          </button>
          {!isClient && <span className="role-hint">client only</span>}
        </div>
      )}

      {milestone.statusName === "Released" && <p className="milestone-done">✓ Paid out</p>}
    </div>
  );
}
