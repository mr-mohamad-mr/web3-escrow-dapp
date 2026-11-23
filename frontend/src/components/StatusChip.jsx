const STATUS_CLASSES = {
  Created: "chip-created",
  Funded: "chip-funded",
  Delivered: "chip-delivered",
  Disputed: "chip-disputed",
  Released: "chip-released",
  Resolved: "chip-resolved",
  Refunded: "chip-refunded",
  Cancelled: "chip-cancelled",
  Pending: "chip-created",
};

export default function StatusChip({ status }) {
  return <span className={`chip ${STATUS_CLASSES[status] || ""}`}>{status}</span>;
}
