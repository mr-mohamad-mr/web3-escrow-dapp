import { useCallback, useEffect, useMemo, useState } from "react";
import ConnectBar from "./components/ConnectBar.jsx";
import EscrowList from "./components/EscrowList.jsx";
import EscrowDetail from "./components/EscrowDetail.jsx";
import CreateEscrow from "./components/CreateEscrow.jsx";
import TxBanner from "./components/TxBanner.jsx";
import * as chain from "./chain/client.js";

// Frontend shell. State is deliberately plain React: components own
// presentation, the chain module owns chain access, App owns the
// session state.
//
// runTx is the single funnel for every write: it drives the explicit
// transaction lifecycle (pending → confirmed / failed with the decoded
// error) shown by TxBanner, then refreshes all reads from chain.

export default function App() {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [deployment, setDeployment] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [account, setAccount] = useState(null);
  const [escrows, setEscrows] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [tx, setTx] = useState({ status: "idle" });

  const busy = tx.status === "pending";

  const names = useMemo(() => {
    const map = {};
    if (deployment) {
      for (const entry of deployment.escrows || []) {
        map[entry.address.toLowerCase()] = { name: entry.name, note: entry.note };
      }
    }
    return map;
  }, [deployment]);

  const refresh = useCallback(async () => {
    if (!deployment) return;
    const [list, accts] = await Promise.all([
      chain.fetchEscrows(deployment.factory),
      chain.listAccounts(deployment),
    ]);
    setEscrows(list);
    setAccounts(accts);
    if (selected) {
      const [summary, events] = await Promise.all([
        chain.fetchSummary(selected),
        chain.fetchTimeline(deployment.factory, selected),
      ]);
      setDetail(summary);
      setTimeline(events);
    }
  }, [deployment, selected]);

  async function connect() {
    setConnecting(true);
    setConnectError(null);
    try {
      const dep = await chain.loadDeployment();
      const id = await chain.getChainId();
      if (id !== dep.chainId) {
        throw new Error(
          `Wrong chain: the node reports chain ${id}, the deployment expects ${dep.chainId}. ` +
            "This demo only runs against the local Hardhat chain."
        );
      }
      const accts = await chain.listAccounts(dep);
      const list = await chain.fetchEscrows(dep.factory);
      setDeployment(dep);
      setChainId(id);
      setAccounts(accts);
      setAccount(dep.client);
      setEscrows(list);
      setConnected(true);
    } catch (error) {
      setConnectError(error.message);
    } finally {
      setConnecting(false);
    }
  }

  // Load detail + timeline when the selection changes.
  useEffect(() => {
    if (!connected || !deployment || !selected) return;
    let cancelled = false;
    setDetailLoading(true);
    Promise.all([chain.fetchSummary(selected), chain.fetchTimeline(deployment.factory, selected)])
      .then(([summary, events]) => {
        if (cancelled) return;
        setDetail(summary);
        setTimeline(events);
      })
      .catch((error) => {
        if (!cancelled) setConnectError(error.message);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, deployment, selected]);

  const runTx = useCallback(
    async (label, action) => {
      setTx({ status: "pending", label });
      try {
        const result = await action();
        setTx({
          status: "confirmed",
          label,
          txHash: result.txHash,
          blockNumber: result.blockNumber,
        });
        await refresh();
        return result;
      } catch (error) {
        // The interaction layer already decoded the revert to its
        // custom-error name where possible.
        setTx({ status: "failed", label, error: error.message });
        return null;
      }
    },
    [refresh]
  );

  function handleCreated(escrowAddress) {
    setShowCreate(false);
    setSelected(escrowAddress);
  }

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Freelance Escrow</h1>
          <p className="subtitle">
            Lock funds, deliver work, release or dispute — on a local Hardhat chain.
          </p>
        </div>
        <span className="badge badge-demo">LOCAL DEMO · NO REAL FUNDS</span>
      </header>

      <ConnectBar
        connected={connected}
        connecting={connecting}
        chainId={chainId}
        deployment={deployment}
        accounts={accounts}
        account={account}
        onConnect={connect}
        onSelectAccount={setAccount}
      />

      {connectError && (
        <div className="tx-banner tx-failed" role="alert">
          ✗ {connectError}
        </div>
      )}

      <TxBanner tx={tx} />

      {connected && (
        <main className="layout">
          <aside className="sidebar">
            <div className="sidebar-head">
              <h2>Escrows</h2>
              <button
                className="btn btn-small"
                onClick={() => setShowCreate((v) => !v)}
                data-testid="new-escrow-btn"
              >
                {showCreate ? "Close" : "+ New escrow"}
              </button>
            </div>
            {showCreate && (
              <CreateEscrow
                deployment={deployment}
                accounts={accounts}
                account={account}
                runTx={runTx}
                busy={busy}
                onCreated={handleCreated}
              />
            )}
            <EscrowList escrows={escrows} names={names} selected={selected} onSelect={setSelected} />
          </aside>

          <section className="content">
            {detailLoading && !detail ? (
              <p className="empty">Loading escrow…</p>
            ) : (
              <EscrowDetail
                summary={detail}
                name={detail ? names[detail.address.toLowerCase()]?.name : null}
                timeline={timeline}
                account={account}
                runTx={runTx}
                busy={busy}
              />
            )}
          </section>
        </main>
      )}

      <footer className="app-footer">
        Demo frontend · contracts: FreelanceEscrow + EscrowFactory · all calls go through
        the interaction layer (lib/escrow.js) · local chain only — never connect a real
        wallet.
      </footer>
    </div>
  );
}
