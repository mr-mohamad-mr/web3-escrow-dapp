import StatusChip from "./StatusChip.jsx";
import { shortAddress } from "../chain/client.js";

export default function EscrowList({ escrows, names, selected, onSelect }) {
  if (escrows.length === 0) {
    return <p className="empty">No escrows on this factory yet — create the first one.</p>;
  }
  return (
    <div className="escrow-list">
      {escrows.map((summary) => {
        const meta = names[summary.address.toLowerCase()];
        const releasedCount = summary.milestones.filter((m) => m.statusName === "Released").length;
        return (
          <button
            key={summary.address}
            className={`escrow-card ${selected === summary.address ? "selected" : ""}`}
            onClick={() => onSelect(summary.address)}
            data-testid="escrow-card"
            data-address={summary.address}
          >
            <span className="escrow-card-top">
              <strong>{meta ? meta.name : `Escrow ${shortAddress(summary.address)}`}</strong>
              <StatusChip status={summary.statusName} />
            </span>
            <span className="escrow-card-meta">
              {summary.amountEth} ETH · {summary.milestones.length} milestone
              {summary.milestones.length === 1 ? "" : "s"} · {releasedCount}/
              {summary.milestones.length} released
            </span>
            <span className="escrow-card-parties">
              C {shortAddress(summary.client)} → F {shortAddress(summary.freelancer)}
            </span>
            {meta?.note && <span className="escrow-card-note">{meta.note}</span>}
          </button>
        );
      })}
    </div>
  );
}
