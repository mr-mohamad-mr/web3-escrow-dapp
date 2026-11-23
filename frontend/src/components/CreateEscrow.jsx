import { useState } from "react";
import { actions } from "../chain/client.js";

// Create a new escrow through the factory. The connected account
// becomes the client. Either a single amount, or a milestone split
// (the amounts must sum to the total — the factory enforces it).

export default function CreateEscrow({ deployment, accounts, account, runTx, busy, onCreated }) {
  const [freelancer, setFreelancer] = useState("");
  const [customFreelancer, setCustomFreelancer] = useState("");
  const [mode, setMode] = useState("single");
  const [amount, setAmount] = useState("1");
  const [milestoneAmounts, setMilestoneAmounts] = useState(["1", "1"]);
  const [deadlineDays, setDeadlineDays] = useState(7);

  const effectiveFreelancer = customFreelancer.trim() || freelancer;

  const setMilestone = (i, value) => {
    const next = [...milestoneAmounts];
    next[i] = value;
    setMilestoneAmounts(next);
  };

  async function submit(e) {
    e.preventDefault();
    if (!effectiveFreelancer) return;
    const options = { freelancer: effectiveFreelancer, deadlineDays: Number(deadlineDays) };
    const result =
      mode === "single"
        ? await runTx("Create escrow", () =>
            actions.create(account, deployment.factory, { ...options, amountEth: amount })
          )
        : await runTx("Create milestone escrow", () =>
            actions.createMilestones(account, deployment.factory, {
              ...options,
              amountsEth: milestoneAmounts,
            })
          );
    if (result?.escrowAddress) onCreated(result.escrowAddress);
  }

  return (
    <form className="panel create-form" onSubmit={submit} data-testid="create-form">
      <h3>New escrow</h3>
      <p className="form-note">
        You ({account?.slice(0, 6)}…{account?.slice(-4)}) become the client. Funds stay locked
        until you release them, the deadline passes, or the arbiter resolves a dispute.
      </p>

      <label>
        Freelancer
        <select value={freelancer} onChange={(e) => setFreelancer(e.target.value)}>
          <option value="">Select an account…</option>
          {accounts
            .filter((a) => a.address.toLowerCase() !== account?.toLowerCase())
            .map((a) => (
              <option key={a.address} value={a.address}>
                {a.label} — {a.address.slice(0, 6)}…{a.address.slice(-4)}
              </option>
            ))}
        </select>
      </label>
      <label>
        …or a freelancer address
        <input
          type="text"
          value={customFreelancer}
          onChange={(e) => setCustomFreelancer(e.target.value)}
          placeholder="0x…"
        />
      </label>

      <div className="mode-row" role="radiogroup" aria-label="Escrow type">
        <label>
          <input type="radio" checked={mode === "single"} onChange={() => setMode("single")} />{" "}
          Single payment
        </label>
        <label>
          <input
            type="radio"
            checked={mode === "milestones"}
            onChange={() => setMode("milestones")}
          />{" "}
          Milestones
        </label>
      </div>

      {mode === "single" ? (
        <label>
          Amount (ETH)
          <input
            type="number"
            min="0"
            step="0.1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
      ) : (
        <div className="milestone-inputs">
          {milestoneAmounts.map((value, i) => (
            <label key={i}>
              Milestone {i + 1} (ETH)
              <span className="milestone-input-row">
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={value}
                  onChange={(e) => setMilestone(i, e.target.value)}
                />
                {milestoneAmounts.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => setMilestoneAmounts(milestoneAmounts.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                )}
              </span>
            </label>
          ))}
          <button
            type="button"
            className="btn btn-small"
            onClick={() => setMilestoneAmounts([...milestoneAmounts, "1"])}
          >
            + Add milestone
          </button>
          <p className="form-note">
            Total: {milestoneAmounts.reduce((sum, v) => sum + (Number(v) || 0), 0)} ETH
          </p>
        </div>
      )}

      <label>
        Deadline (days from now)
        <input
          type="number"
          min="1"
          value={deadlineDays}
          onChange={(e) => setDeadlineDays(e.target.value)}
        />
      </label>

      <button className="btn btn-primary" type="submit" disabled={busy || !effectiveFreelancer}>
        Create escrow
      </button>
    </form>
  );
}
