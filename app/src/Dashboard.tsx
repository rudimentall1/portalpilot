import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Icon, ThemeToggle } from "./ui";

type Network = "mainnet" | "local" | "testnet";
type Msg = {
  id: number;
  role: "user" | "assistant";
  text?: string;
  resp?: any;
  receipt?: any;
  executing?: boolean;
  error?: string;
};

const COMMANDS = [
  { icon: "coins", title: "Check a balance", ex: "balance of alice" },
  { icon: "send", title: "Send POT", ex: "send 1 POT to bob" },
  { icon: "layers", title: "Batch airdrop", ex: "airdrop 1 POT to bob and 2 POT to charlie" },
  { icon: "edit", title: "Post a remark", ex: "post on-chain remark: gm Portaldot" },
  { icon: "blocks", title: "Recent blocks", ex: "show last 5 blocks" },
  { icon: "activity", title: "Network status", ex: "network status" },
];

let idc = 1;

// On the hosted demo (e.g. *.vercel.app) the serverless backend can't reach a
// node on the visitor's machine, so "Local" (ws://127.0.0.1:9944) can never
// connect — default to Mainnet there. On localhost dev, default to Local.
const IS_HOSTED =
  typeof window !== "undefined" && !/^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);

export default function Dashboard({ onHome }: { onHome?: () => void }) {
  const [network, setNetwork] = useState<Network>(IS_HOSTED ? "mainnet" : "local");
  const [chain, setChain] = useState<any>(null);
  const [chainErr, setChainErr] = useState("");
  const [blocks, setBlocks] = useState<any[]>([]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [llm, setLlm] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.health().then((h: any) => setLlm(!!h.llm)).catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    // On the hosted demo, Local can't reach a node — skip polling entirely
    // (no failed requests, no serverless 502s) and show a clean state.
    if (IS_HOSTED && network === "local") {
      setChain(null);
      setChainErr("Local node isn't reachable from the hosted demo — use Mainnet.");
      setBlocks([]);
      return;
    }
    try {
      setChain(await api.chain(network));
      setChainErr("");
    } catch (e: any) {
      setChainErr(e?.message || "offline");
      setChain(null);
    }
    try {
      setBlocks(await api.blocks(network, 8));
    } catch {
      setBlocks([]);
    }
  }, [network]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 6000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 1e9, behavior: "smooth" });
  }, [messages]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setInput("");
    setMessages((m) => [...m, { id: idc++, role: "user", text: t }]);
    setBusy(true);
    try {
      const resp = await api.ask(t, network);
      setMessages((m) => [...m, { id: idc++, role: "assistant", resp }]);
    } catch (e: any) {
      let err = e?.message || "request failed";
      if (IS_HOSTED && network === "local")
        err = "The hosted demo can't reach a node on your machine. Switch to Mainnet for live data, or run PortalPilot locally for Local + POT-gas writes.";
      setMessages((m) => [...m, { id: idc++, role: "assistant", error: err }]);
    } finally {
      setBusy(false);
    }
  }

  async function confirmPlan(msgId: number, planId: string) {
    setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, executing: true } : x)));
    try {
      const receipt = await api.execute(planId);
      setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, executing: false, receipt } : x)));
      refresh();
    } catch (e: any) {
      setMessages((m) =>
        m.map((x) => (x.id === msgId ? { ...x, executing: false, receipt: { ok: false, error: e?.message } } : x))
      );
    }
  }

  async function cancelPlan(msgId: number, planId: string) {
    setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, executing: true } : x)));
    try {
      await api.cancel(planId);
      setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, executing: false, receipt: { cancelled: true } } : x)));
    } catch (e: any) {
      setMessages((m) => m.map((x) => (x.id === msgId ? {
        ...x, executing: false, receipt: { ok: false, error: "Cancellation failed: " + (e?.message || "request failed") }
      } : x)));
    }
  }

  return (
    <div className="app">
      <Header network={network} setNetwork={setNetwork} chain={chain} chainErr={chainErr} llm={llm} onHome={onHome} />
      <div className="body">
        <main className="chat">
          {IS_HOSTED && network === "local" && (
            <div className="net-note">
              <span><b>Local</b> runs against a node on your machine — not reachable from this hosted demo. Use <b>Mainnet</b> for live data (or run PortalPilot locally for POT-gas writes).</span>
              <button onClick={() => setNetwork("mainnet")}>Use Mainnet</button>
            </div>
          )}
          <div className="messages" ref={scroller}>
            {messages.length === 0 ? (
              <Hero onPick={send} llm={llm} />
            ) : (
              messages.map((msg) => (
                <MessageView key={msg.id} msg={msg} onConfirm={confirmPlan} onCancel={cancelPlan} onChip={send} />
              ))
            )}
            {busy && (
              <div className="msg assistant">
                <div className="avatar"><Icon name="sparkle" size={16} /></div>
                <div className="bubble typing"><span /><span /><span /></div>
              </div>
            )}
          </div>
          <Composer input={input} setInput={setInput} send={send} busy={busy} network={network} />
        </main>
        <Explorer network={network} chain={chain} blocks={blocks} chainErr={chainErr} />
      </div>
    </div>
  );
}

function Header({ network, setNetwork, chain, chainErr, llm, onHome }: any) {
  return (
    <header className="header">
      <button className="brand brand-btn" onClick={onHome} title="Back to home">
        <div className="brand-mark"><Icon name="portal" size={22} /></div>
        <div>
          <div className="title">PortalPilot</div>
          <div className="tag">AI copilot for Portaldot</div>
        </div>
      </button>
      <div className="head-right">
        <div className={"status " + (chainErr ? "off" : "")}>
          <span className="dot" />
          {chain ? (
            <span className="mono">{chain.chain} · #{Number(chain.blockNumber).toLocaleString()}</span>
          ) : (
            <span>{chainErr ? (network === "local" ? "local node offline" : "offline") : "connecting…"}</span>
          )}
        </div>
        <div className="seg">
          <button className={network === "mainnet" ? "active" : ""} onClick={() => setNetwork("mainnet")}>Mainnet</button>
          <button className={network === "testnet" ? "active" : ""} onClick={() => setNetwork("testnet")}>Testnet</button>
          <button className={network === "local" ? "active" : ""} onClick={() => setNetwork("local")}>Local</button>
        </div>
        <ThemeToggle />
        <div className={"ai-badge " + (llm ? "on" : "")} title={llm ? "Claude understanding enabled" : "Deterministic parser (no key needed)"}>
          <Icon name="sparkle" size={13} /> {llm ? "Claude" : "Rules"}
        </div>
      </div>
    </header>
  );
}

function Hero({ onPick, llm }: any) {
  return (
    <div className="hero">
      <div className="hero-mark"><Icon name="portal" size={30} /></div>
      <h1>Talk to <span className="accent">Portaldot</span> in plain English</h1>
      <p className="lead">
        PortalPilot reads the chain, explains what will happen, simulates every action with the real POT fee,
        and executes only after you confirm.
      </p>
      <div className="cmd-grid">
        {COMMANDS.map((c) => (
          <button key={c.ex} className="cmd" onClick={() => onPick(c.ex)}>
            <span className="ic"><Icon name={c.icon} size={18} /></span>
            <span>
              <div className="ct">{c.title}</div>
              <div className="cx">{c.ex}</div>
            </span>
          </button>
        ))}
      </div>
      <div className="hero-note">
        <Icon name="sparkle" size={14} />
        <span><b>Reads are free.</b> Writes are dry-run simulated &amp; confirmed — {llm ? "AI understanding on." : "no API key needed."}</span>
      </div>
    </div>
  );
}

const SUGGEST = [
  { t: "balance of alice", h: "read an account's POT balance" },
  { t: "send 1 POT to bob", h: "transfer — dry-run + fee preview first" },
  { t: "airdrop 1 POT to bob and 2 POT to charlie", h: "one atomic batch transfer" },
  { t: "post on-chain remark: gm Portaldot", h: "inscribe a message on-chain" },
  { t: "fee to send 5 POT to bob", h: "estimate gas without sending" },
  { t: "show last 5 blocks", h: "recent blocks on this network" },
  { t: "recent transfers", h: "scan recent POT transfers" },
  { t: "network status", h: "chain, block height & pallets" },
  { t: "what can I do?", h: "everything PortalPilot supports" },
];

function Composer({ input, setInput, send, busy, network }: any) {
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(-1);
  const q = input.trim().toLowerCase();
  // Only suggest while actually typing — never on an empty/focused box (that made it feel "stuck").
  const matches = q ? SUGGEST.filter((s) => s.t.toLowerCase().includes(q) || s.h.toLowerCase().includes(q)).slice(0, 6) : [];
  const open = focus && q.length > 0 && matches.length > 0 && !busy;

  function onKey(e: any) {
    if (!open) { if (e.key === "Enter") send(input); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, matches.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, -1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (active >= 0) { send(matches[active].t); setActive(-1); } else send(input); }
    else if (e.key === "Escape") { setFocus(false); setActive(-1); }
  }

  return (
    <div className="composer">
      <div className="composer-wrap">
        {open && (
          <div className="sugg">
            <div className="sugg-cap">Suggestions — click one, or keep typing</div>
            {matches.map((s, i) => (
              <button
                key={s.t}
                className={"sugg-row " + (i === active ? "active" : "")}
                onMouseDown={(e) => { e.preventDefault(); send(s.t); setActive(-1); }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="sugg-t"><Icon name="bolt" size={13} /> {s.t}</span>
                <span className="sugg-h">{s.h}</span>
              </button>
            ))}
          </div>
        )}
        <div className="field">
          <span className="field-ic"><Icon name="sparkle" size={16} /></span>
          <input
            value={input}
            onChange={(e) => { setInput(e.target.value); setActive(-1); }}
            onKeyDown={onKey}
            onFocus={() => setFocus(true)}
            onBlur={() => setTimeout(() => setFocus(false), 130)}
            placeholder={`Message PortalPilot on ${network}…  try "send 1 POT to bob"`}
            disabled={busy}
            autoFocus
          />
          <button className="send-btn" onClick={() => send(input)} disabled={busy || !input.trim()} aria-label="Send">
            <Icon name="send" size={17} />
          </button>
        </div>
        <div className="composer-hint">↑↓ to choose · Enter to run · every write is simulated &amp; confirmed before signing</div>
      </div>
    </div>
  );
}

function MessageView({ msg, onConfirm, onCancel, onChip }: any) {
  if (msg.role === "user")
    return (
      <div className="msg user">
        <div className="bubble">{msg.text}</div>
      </div>
    );
  if (msg.error)
    return (
      <div className="msg assistant">
        <div className="avatar err">!</div>
        <div className="bubble error">{msg.error}</div>
      </div>
    );
  const r = msg.resp;
  return (
    <div className="msg assistant">
      <div className="avatar"><Icon name="sparkle" size={16} /></div>
      <div className="bubble">
        {r.answer && <div className="answer">{r.answer}</div>}
        {r.kind === "read" && <ReadView view={r.view} data={r.data} />}
        {r.kind === "plan" && <PlanCard msg={msg} plan={r.plan} onConfirm={onConfirm} onCancel={onCancel} />}
        {(r.kind === "help" || r.kind === "unknown") && r.suggestions && <Chips items={r.suggestions} onChip={onChip} />}
        {r.intent?.engine && <div className="engine">parsed by {r.intent.engine}</div>}
      </div>
    </div>
  );
}

function workflowSteps(plan: any, msg: any) {
  const dry = plan.dryRun;
  const r = msg.receipt;
  const confirmed = !!r && !r.cancelled;
  const cancelled = !!r && r.cancelled;
  return [
    { k: "understand", label: "Understand", done: true },
    { k: "compose", label: "Compose", done: true },
    { k: "simulate", label: "Simulate", done: dry.ran && dry.ok, fail: dry.ran && !dry.ok },
    { k: "price", label: "Price", done: true },
    { k: "confirm", label: "Confirm", done: confirmed, fail: cancelled, active: !r && !msg.executing },
    { k: "submit", label: "Submit", done: !!(r && r.ok), fail: !!(r && r.ok === false && !r.cancelled), active: !!msg.executing },
    { k: "finalize", label: "Finalized", done: !!(r && r.ok) },
  ];
}

function WorkflowSteps({ steps }: any) {
  return (
    <div className="wf-steps">
      {steps.map((s: any, i: number) => {
        const state = s.fail ? "fail" : s.done ? "done" : s.active ? "active" : "";
        return (
          <div key={s.k} className={"wf-node " + state}>
            <span className={"wf-dot " + state}>{s.fail ? "✕" : s.done ? <Icon name="check" size={11} /> : i + 1}</span>
            <span className="wf-label">{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function PlanCard({ msg, plan, onConfirm, onCancel }: any) {
  const dry = plan.dryRun;
  const blocked = dry.ran && !dry.ok;
  const engine = msg.resp?.intent?.engine;
  const r = msg.receipt;
  const steps = workflowSteps(plan, msg);
  return (
    <div className="plan">
      <div className="plan-strip" />
      <div className="wf">
        <span className="wf-title"><Icon name="activity" size={12} /> AI → on-chain workflow{engine ? ` · via ${engine}` : ""}</span>
        <WorkflowSteps steps={steps} />
      </div>
      {!r ? (
        <>
          <div className="plan-head">
            <span className="plan-title">{plan.summary}</span>
            <span className={"badge " + (dry.ran ? (dry.ok ? "ok" : "bad") : "neutral")}>
              {dry.ran ? (dry.ok ? "✓ simulated" : "✗ would fail") : "structure ✓"}
            </span>
          </div>
          <div className="kv">
            <Row k="Extrinsic" v={<code>{actionLabel(plan.action)}</code>} />
            {plan.action.to && <Row k="Recipient" v={<Mono s={plan.action.to} />} />}
            {plan.action.amountPot && <Row k="Amount" v={<b>{plan.action.amountPot} POT</b>} />}
            {plan.action.transfers && <Row k="Recipients" v={`${plan.action.transfers.length} accounts`} />}
            {plan.action.message && <Row k="Message" v={`“${plan.action.message}”`} />}
            <Row k="Signer" v={<Mono s={plan.signer} />} />
            <Row k="Network fee" v={<span className="fee">{plan.feeDisplay}</span>} />
            <Row k="Dry-run" v={dry.detail} />
            <Row k="Call data" v={<code className="hex">{plan.callHex.slice(0, 22)}…</code>} />
          </div>
          {plan.warnings?.length > 0 && (
            <div className="warn">{plan.warnings.map((w: string, i: number) => <div key={i}>⚠ {w}</div>)}</div>
          )}
          <div className="plan-actions">
            <button className="btn ghost" disabled={msg.executing} onClick={() => onCancel(msg.id, plan.id)}>Cancel</button>
            <button
              className="btn primary"
              disabled={msg.executing || blocked}
              onClick={() => onConfirm(msg.id, plan.id)}
              title={blocked ? "Dry-run failed — execution is blocked for safety" : ""}
            >
              {msg.executing ? "Signing & submitting…" : "Confirm & sign"}
            </button>
          </div>
        </>
      ) : (
        <div className="plan-result"><ReceiptCard receipt={r} /></div>
      )}
    </div>
  );
}

function ReceiptCard({ receipt }: any) {
  if (receipt.cancelled) return <div className="receipt cancelled">Cancelled — nothing was submitted.</div>;
  if (!receipt.ok)
    return (
      <div className="receipt bad">
        <b>✗ Failed.</b> {receipt.error}
      </div>
    );
  return (
    <div className="receipt ok">
      <div className="receipt-top">
        <span className="ck"><Icon name="check" size={13} /></span>
        Executed on-chain — POT gas paid
      </div>
      <div className="kv">
        <Row k="Block" v={<Mono s={receipt.blockHash} />} />
        <Row k="Tx hash" v={<Mono s={receipt.txHash} />} />
        <Row k="Events" v={<span className="events">{receipt.events.join(", ")}</span>} />
      </div>
    </div>
  );
}

function ReadView({ view, data }: any) {
  if (!data) return null;
  if (view === "account") return <AccountCard a={data} />;
  if (view === "blocks") return <BlocksTable blocks={data} />;
  if (view === "transfers") return <TransfersTable t={data} />;
  if (view === "chain") return <ChainCard c={data} />;
  if (view === "fee")
    return (
      <div className="kv card">
        <Row k="Fee" v={<span className="fee">{data.feeDisplay}</span>} />
        <Row k="Weight" v={<code>{data.weight}</code>} />
      </div>
    );
  return null;
}

function AccountCard({ a }: any) {
  return (
    <div className="kv card">
      <Row k="Address" v={<Mono s={a.normalized} />} />
      <Row k="Free" v={<span className="fee">{a.free}</span>} />
      <Row k="Total" v={a.total} />
      <Row k="Nonce" v={a.nonce} />
      {a.identity && <Row k="Identity" v={a.identity} />}
    </div>
  );
}

function ChainCard({ c }: any) {
  return (
    <div className="kv card">
      <Row k="Chain" v={c.chain} />
      <Row k="Block" v={`#${Number(c.blockNumber).toLocaleString()}`} />
      <Row k="Runtime" v={`${c.specName} v${c.specVersion}`} />
      <Row k="Token" v={`${c.symbol} · ${c.decimals} dp`} />
      <Row k="Surface" v={`${c.palletCount} pallets · ${c.callCount} extrinsics`} />
      {c.peers !== undefined && <Row k="Peers" v={c.peers} />}
    </div>
  );
}

function BlocksTable({ blocks }: any) {
  return (
    <div className="mini">
      {blocks.map((b: any) => (
        <div className="mini-row" key={b.hash}>
          <span className="bn">#{b.number}</span>
          <span className="bx">{b.extrinsics} ext</span>
          <code className="bh">{b.hash.slice(0, 16)}…</code>
        </div>
      ))}
    </div>
  );
}

function TransfersTable({ t }: any) {
  if (!t.length) return <div className="muted">No transfers found in the recent window.</div>;
  return (
    <div className="mini">
      {t.map((x: any, i: number) => (
        <div className="mini-row" key={i}>
          <span className="bn">#{x.block}</span>
          <Mono s={x.from} />
          <span className="bx">→</span>
          <Mono s={x.to} />
          <span className="fee">{x.amount}</span>
        </div>
      ))}
    </div>
  );
}

function ExRow({ icon, k, v }: any) {
  return (
    <div className="ex-row2">
      <span className="ex-ic"><Icon name={icon} size={15} /></span>
      <span className="ex-k">{k}</span>
      <span className="ex-v">{v}</span>
    </div>
  );
}

function Explorer({ network, chain, blocks, chainErr }: any) {
  const [tab, setTab] = useState<"network" | "blocks" | "transfers">("network");
  const [transfers, setTransfers] = useState<any[]>([]);
  const [tLoading, setTLoading] = useState(false);
  useEffect(() => {
    if (tab !== "transfers") return;
    let alive = true;
    setTLoading(true);
    fetch(`/api/transfers?network=${network}`)
      .then((r) => r.json())
      .then((d) => { if (alive) setTransfers(Array.isArray(d) ? d : []); })
      .catch(() => {})
      .finally(() => { if (alive) setTLoading(false); });
    return () => { alive = false; };
  }, [tab, network]);
  const sa = (s: string) => (s && s.length > 12 ? s.slice(0, 6) + "…" + s.slice(-4) : s);

  return (
    <aside className="explorer">
      <div className="ex-head">
        <span className="ex-title">Live Explorer</span>
        <span className="ex-live"><span className="dot" />{network}</span>
      </div>
      <div className="ex-tabs">
        {(["network", "blocks", "transfers"] as const).map((t) => (
          <button key={t} className={"ex-tab " + (tab === t ? "active" : "")} onClick={() => setTab(t)}>
            {t === "network" ? "Network" : t === "blocks" ? "Blocks" : "Transfers"}
          </button>
        ))}
      </div>
      <div className="ex-scroll">
        {tab === "network" &&
          (chain ? (
            <div className="ex-list">
              <ExRow icon="globe" k="Chain" v={chain.chain} />
              <ExRow icon="blocks" k="Runtime" v={`${chain.specName} v${chain.specVersion}`} />
              <ExRow icon="coins" k="Token" v={`${chain.symbol} · ${chain.decimals} dp`} />
              <ExRow icon="grid" k="Surface" v={`${chain.palletCount}p · ${chain.callCount}x`} />
              <ExRow icon="activity" k="Peers" v={String(chain.peers ?? 0)} />
              <ExRow icon="terminal" k="Head" v={`#${Number(chain.blockNumber).toLocaleString()}`} />
            </div>
          ) : (
            <div className="muted">{chainErr ? `${network} unreachable` : "connecting…"}</div>
          ))}

        {tab === "blocks" && (
          <div className="ex-list">
            {blocks.map((b: any, i: number) => (
              <div className={"ex-item " + (i === 0 ? "sel" : "")} key={b.hash}>
                <span className={"ex-bullet " + (i === 0 ? "on" : "")} />
                <span className="ex-bn">#{b.number}</span>
                <span className="ex-bx">{b.extrinsics} ext</span>
                <code className="ex-bh">{b.hash.slice(0, 10)}…</code>
              </div>
            ))}
            {!blocks.length && <div className="muted">no data</div>}
          </div>
        )}

        {tab === "transfers" && (
          <div className="ex-list">
            {tLoading && <div className="muted">scanning recent blocks…</div>}
            {!tLoading && !transfers.length && <div className="muted">no recent transfers</div>}
            {transfers.map((x: any, i: number) => (
              <div className="ex-item" key={i}>
                <span className="ex-bullet on" />
                <span className="ex-bn">#{x.block}</span>
                <span className="ex-bx">{sa(x.from)} → {sa(x.to)}</span>
                <code className="ex-bh">{x.amount}</code>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="ex-footer">
        <span className="ex-avatar"><Icon name="portal" size={16} /></span>
        <div className="ex-foot-meta">
          <b>Portaldot</b>
          <span>{network} · {chain ? "live" : chainErr ? "offline" : "connecting…"}</span>
        </div>
        <span className={"ex-foot-dot " + (chainErr ? "off" : "")} />
      </div>
    </aside>
  );
}

const Row = ({ k, v }: { k: string; v: any }) => (
  <div className="row">
    <span className="rk">{k}</span>
    <span className="rv">{v}</span>
  </div>
);

const Chips = ({ items, onChip }: { items: string[]; onChip: (s: string) => void }) => (
  <div className="chips">
    {items.map((s, i) => (
      <button key={i} className="chip" onClick={() => onChip(s)}>{s}</button>
    ))}
  </div>
);

function Mono({ s }: { s: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <code
      className={"addr copyable " + (copied ? "copied" : "")}
      title={copied ? "Copied!" : "Click to copy"}
      onClick={() => { try { navigator.clipboard?.writeText(s); } catch {} setCopied(true); setTimeout(() => setCopied(false), 1100); }}
    >
      {s.length > 16 ? s.slice(0, 8) + "…" + s.slice(-6) : s}
    </code>
  );
}

function actionLabel(a: any) {
  return a.kind === "transfer"
    ? "balances.transferKeepAlive"
    : a.kind === "batchTransfer"
    ? "utility.batchAll"
    : a.kind === "remark"
    ? "system.remarkWithEvent"
    : a.kind;
}
