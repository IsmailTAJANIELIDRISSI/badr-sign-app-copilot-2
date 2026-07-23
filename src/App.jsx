import { useEffect, useMemo, useRef, useState } from "react";

const pollMs = 1200;
const isElectron = typeof window !== "undefined" && window.electronAPI;

/** Copy text to the clipboard. Electron's file:// origin is not a secure
 *  context, so navigator.clipboard can be unavailable — fall back to the
 *  legacy hidden-textarea trick. */
const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
};

/** Ready-to-paste mail subject. Must stay identical to the email_subject.txt
 *  written by server/automation.js. */
const mawbSubject = (item) => `MAWB ${item.ltaRef} - (${item.dumsCount} DUM)`;

const LEVEL_STYLES = {
  error: { dot: "bg-rose-400", text: "text-rose-300" },
  warn: { dot: "bg-amber-400", text: "text-amber-200" },
  info: { dot: "bg-mint", text: "text-[#d3f7ec]" },
  debug: { dot: "bg-slate-500", text: "text-slate-400" },
};

function App() {
  const [ltaFiles, setLtaFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState("");
  const [job, setJob] = useState(null);
  const [shippers, setShippers] = useState({});
  const [selected, setSelected] = useState({});
  const [outputsFolder, setOutputsFolder] = useState("");
  const [dumsFolder, setDumsFolder] = useState("");
  const [apiReady, setApiReady] = useState(false);

  // Shell
  const [tab, setTab] = useState("ltas");
  const [search, setSearch] = useState("");

  // Activity panel
  const [logLevel, setLogLevel] = useState("all");
  const [logQuery, setLogQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [copiedLogs, setCopiedLogs] = useState(false);
  const logEndRef = useRef(null);

  // Priority ordering — array of fileNames in user-defined processing order.
  const [orderedFileNames, setOrderedFileNames] = useState([]);
  const [orderMode, setOrderMode] = useState(false);

  // Drag state (refs to avoid re-renders mid-drag).
  const dragIndexRef = useRef(null);
  const [dragOver, setDragOver] = useState(null);

  const [copiedSubject, setCopiedSubject] = useState("");

  // fileName -> "sending" | "sent" | "error"  for the Outlook button state.
  const [emailState, setEmailState] = useState({});

  const copySubject = async (item) => {
    if (await copyToClipboard(mawbSubject(item))) {
      setCopiedSubject(item.fileName);
      setTimeout(() => setCopiedSubject(""), 1600);
    }
  };

  // Open an Outlook draft with the LTA's signed PDFs attached (backend uses
  // Outlook COM — mailto: can't carry attachments).
  const sendByEmail = async (item) => {
    setEmailState((p) => ({ ...p, [item.fileName]: "sending" }));
    try {
      const r = await fetch("/api/lta/outlook-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ltaRef: item.ltaRef,
          dumsCount: item.dumsCount,
        }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        setEmailState((p) => ({ ...p, [item.fileName]: "sent" }));
        // Classic Outlook (COM) attaches automatically. The clipboard fallback
        // (new Outlook / web) opens compose with the PDFs on the clipboard —
        // the user must paste them in.
        if (data.method === "clipboard") {
          const diag = data.comErr
            ? `\n\n— Diagnostic —\nAuto-attach (classic Outlook COM) failed:\n${data.comErr}\nApp running as Administrator: ${data.elevated ? "YES" : "no"}`
            : "";
          alert(
            `Email opened with the recipients and subject filled in.\n\n` +
              `The ${data.count} PDF${data.count > 1 ? "s" : ""} have been copied — ` +
              `click inside the message and press Ctrl+V to attach them.` +
              diag,
          );
        }
        setTimeout(
          () =>
            setEmailState((p) => {
              const n = { ...p };
              delete n[item.fileName];
              return n;
            }),
          2500,
        );
      } else {
        setEmailState((p) => ({ ...p, [item.fileName]: "error" }));
        alert(data.reason || "Could not open the Outlook draft.");
        setTimeout(
          () =>
            setEmailState((p) => {
              const n = { ...p };
              delete n[item.fileName];
              return n;
            }),
          2500,
        );
      }
    } catch (e) {
      setEmailState((p) => ({ ...p, [item.fileName]: "error" }));
      alert(`Email failed: ${e.message}`);
    }
  };

  const ltaMap = useMemo(
    () => Object.fromEntries(ltaFiles.map((f) => [f.fileName, f])),
    [ltaFiles],
  );

  const selectedFileNames = useMemo(
    () => orderedFileNames.filter((fn) => selected[fn] && ltaMap[fn]),
    [orderedFileNames, selected, ltaMap],
  );

  const refresh = async () => {
    setLoading(true);
    try {
      const configRes = await fetch("/api/config");
      if (configRes.ok) {
        const configData = await configRes.json();
        setDumsFolder(configData.dumsFolder);
        setOutputsFolder(configData.outputsFolder);
        setApiReady(true);
      }

      const r = await fetch("/api/lta-files");
      const data = await r.json();
      setLtaFiles(data);

      setOrderedFileNames((prev) => {
        const existing = new Set(prev);
        const incoming = data.map((f) => f.fileName);
        const newOnes = incoming.filter((fn) => !existing.has(fn));
        const valid = prev.filter((fn) => incoming.includes(fn));
        return [...valid, ...newOnes];
      });

      const shippersRes = await fetch("/api/shippers");
      if (shippersRes.ok) {
        const shippersData = await shippersRes.json();
        const byFileName = shippersData.byFileName || shippersData || {};
        const byLtaRef = shippersData.byLtaRef || {};
        const resolved = {};
        for (const item of data) {
          const value =
            byLtaRef[item.ltaRef] ||
            byFileName[item.fileName] ||
            item.shipperName ||
            "";
          if (value) resolved[item.fileName] = value;
        }
        setShippers(resolved);
      }

      setSelected((prev) => {
        const next = { ...prev };
        for (const item of data) {
          if (!(item.fileName in next)) next[item.fileName] = true;
        }
        return next;
      });
    } catch (error) {
      console.error("API error:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!jobId) return;
    const timer = setInterval(async () => {
      const r = await fetch(`/api/jobs/${jobId}`);
      if (!r.ok) return;
      const data = await r.json();
      setJob(data);
      if (data.status === "done" || data.status === "failed") {
        clearInterval(timer);
      }
    }, pollMs);
    return () => clearInterval(timer);
  }, [jobId]);

  const updateShipper = async (fileName, ltaRef, shipperName) => {
    setShippers((prev) => ({ ...prev, [fileName]: shipperName }));
    try {
      await fetch("/api/shippers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName, ltaRef, shipperName }),
      });
    } catch (error) {
      console.error("Failed to save shipper:", error);
    }
  };

  const run = async () => {
    const r = await fetch("/api/jobs/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shipperByFileName: shippers,
        fileNames: selectedFileNames,
      }),
    });
    const data = await r.json();
    setJobId(data.jobId);
    setJob(null);
    setTab("activity"); // jump straight to the live view
  };

  // ── Drag-and-drop ──────────────────────────────────────────────────────────
  const onDragStart = (idx) => {
    dragIndexRef.current = idx;
  };
  const onDragOver = (e, idx) => {
    e.preventDefault();
    setDragOver(idx);
  };
  const onDrop = (e, dropIdx) => {
    e.preventDefault();
    const dragIdx = dragIndexRef.current;
    if (dragIdx === null || dragIdx === dropIdx) {
      setDragOver(null);
      return;
    }
    setOrderedFileNames((prev) => {
      const next = [...prev];
      const [moved] = next.splice(dragIdx, 1);
      next.splice(dropIdx, 0, moved);
      return next;
    });
    dragIndexRef.current = null;
    setDragOver(null);
  };
  const onDragEnd = () => {
    dragIndexRef.current = null;
    setDragOver(null);
  };
  const moveItem = (idx, dir) => {
    const target = idx + dir;
    if (target < 0 || target >= orderedFileNames.length) return;
    setOrderedFileNames((prev) => {
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const orderedItems = orderedFileNames.map((fn) => ltaMap[fn]).filter(Boolean);
  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return orderedItems;
    return orderedItems.filter(
      (i) =>
        i.ltaRef.toLowerCase().includes(q) ||
        i.fileName.toLowerCase().includes(q),
    );
  }, [orderedItems, search]);

  const running = job?.status === "running";
  const logs = job?.logs || [];

  // Live counters derived from the log stream. The backend only fills
  // job.progress once the whole job finishes, so without this the progress bar
  // would sit at 0 for the entire run. Note: job.logs is capped at 1000 entries
  // server-side, so on very long runs these can undercount — once the job ends
  // we switch to the authoritative job.progress numbers.
  const liveStats = useMemo(() => {
    let success = 0;
    let failed = 0;
    let skipped = 0;
    let currentLta = "";
    for (const l of logs) {
      const m = l.message || "";
      if (m.includes("✓ SUCCESS - DUM")) success += 1;
      else if (m.includes("↷ SKIPPED - DUM")) skipped += 1;
      else if (m.includes("✗ FAILED - DUM") || m.includes("✗ ABORTED - DUM"))
        failed += 1;
      const proc = m.match(/^Processing LTA (\S+)/);
      if (proc) currentLta = proc[1];
    }
    return { success, failed, skipped, done: success + failed + skipped, currentLta };
  }, [logs]);

  const stats = running
    ? liveStats
    : {
        success: job?.progress?.success ?? 0,
        failed: job?.progress?.failed ?? 0,
        skipped: job?.progress?.skipped ?? 0,
        done: job?.progress?.done ?? 0,
        currentLta: "",
      };
  const total = job?.progress?.total ?? 0;
  const pct = total ? Math.min(100, Math.round((stats.done / total) * 100)) : 0;

  const filteredLogs = useMemo(() => {
    const q = logQuery.trim().toLowerCase();
    return logs.filter((l) => {
      if (logLevel !== "all" && l.level !== logLevel) return false;
      if (q && !(l.message || "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [logs, logLevel, logQuery]);

  useEffect(() => {
    if (autoScroll && tab === "activity") {
      logEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [filteredLogs.length, autoScroll, tab]);

  const copyLogs = async () => {
    const text = filteredLogs
      .map(
        (l) =>
          `[${new Date(l.at).toLocaleTimeString()}] ${l.level.toUpperCase()} - ${l.message}`,
      )
      .join("\n");
    if (await copyToClipboard(text)) {
      setCopiedLogs(true);
      setTimeout(() => setCopiedLogs(false), 1600);
    }
  };

  const allSelected =
    orderedItems.length > 0 && selectedFileNames.length === orderedItems.length;
  const toggleAll = () => {
    const next = {};
    for (const i of orderedItems) next[i.fileName] = !allSelected;
    setSelected((prev) => ({ ...prev, ...next }));
  };

  const btn =
    "rounded-xl px-3.5 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";
  const btnGhost = `${btn} border border-ink/15 bg-white/70 text-steel hover:border-ink/30 hover:text-ink`;

  return (
    <div className="flex h-screen flex-col overflow-hidden font-body text-ink">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header className="shrink-0 border-b border-ink/10 bg-white/70 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink font-display text-sm font-bold text-mint">
              B
            </div>
            <div className="leading-tight">
              <h1 className="font-display text-base font-semibold">
                BADR Signing Console
              </h1>
              <p className="text-[11px] text-steel">
                {apiReady ? (
                  <span className="text-emerald-600">● API connected</span>
                ) : (
                  <span className="text-rose-500">● API offline</span>
                )}
                {ltaFiles.length > 0 && (
                  <span className="text-steel">
                    {"  ·  "}
                    {ltaFiles.length} LTA
                    {ltaFiles.length > 1 ? "s" : ""} detected
                  </span>
                )}
              </p>
            </div>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button onClick={refresh} className={btnGhost} disabled={loading}>
              {loading ? "Refreshing…" : "↻ Refresh"}
            </button>
            {isElectron && outputsFolder && (
              <button
                onClick={() => window.electronAPI.openFolder(outputsFolder)}
                className={btnGhost}
              >
                📁 Output
              </button>
            )}
            <button
              onClick={run}
              disabled={!selectedFileNames.length || running}
              className={`${btn} bg-ink text-white shadow-soft hover:bg-steel`}
            >
              {running
                ? "Running…"
                : `▶ Run${
                    selectedFileNames.length
                      ? ` (${selectedFileNames.length})`
                      : ""
                  }`}
            </button>
          </div>
        </div>

        {/* Global progress — visible from any tab while a job runs */}
        {job && (
          <div className="mx-auto max-w-[1600px] px-5 pb-3">
            <div className="flex items-center gap-3">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink/10">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    stats.failed ? "bg-coral" : "bg-emerald-500"
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="shrink-0 font-mono text-[11px] text-steel">
                {stats.done}/{total} · {pct}%
                {running && stats.currentLta && (
                  <span className="text-ink"> · {stats.currentLta}</span>
                )}
              </span>
            </div>
          </div>
        )}

        {/* ── Tabs ──────────────────────────────────────────────────────── */}
        <div className="mx-auto flex max-w-[1600px] gap-1 px-5">
          {[
            { id: "ltas", label: "LTAs", badge: orderedItems.length || null },
            { id: "activity", label: "Activity", badge: null },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative -mb-px rounded-t-xl border-b-2 px-4 py-2.5 text-sm font-semibold transition ${
                tab === t.id
                  ? "border-ink text-ink"
                  : "border-transparent text-steel hover:text-ink"
              }`}
            >
              {t.label}
              {t.badge != null && (
                <span className="ml-2 rounded-full bg-ink/10 px-1.5 py-0.5 text-[10px] font-bold">
                  {t.badge}
                </span>
              )}
              {t.id === "activity" && running && (
                <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500 align-middle" />
              )}
              {t.id === "activity" && !running && stats.failed > 0 && (
                <span className="ml-2 rounded-full bg-coral/20 px-1.5 py-0.5 text-[10px] font-bold text-coral">
                  {stats.failed}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "ltas" ? (
          <div className="h-full overflow-auto">
            <div className="mx-auto max-w-[1600px] px-5 py-5">
              {/* Toolbar */}
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search LTA or file…"
                  className="w-56 rounded-xl border border-ink/15 bg-white/80 px-3 py-2 text-sm outline-none transition focus:border-ink"
                />
                <button onClick={toggleAll} className={btnGhost}>
                  {allSelected ? "Deselect all" : "Select all"}
                </button>
                <button
                  onClick={() => setOrderMode((v) => !v)}
                  className={
                    orderMode
                      ? `${btn} border border-amber-400 bg-amber-400/20 text-amber-700`
                      : btnGhost
                  }
                >
                  {orderMode ? "✓ Done reordering" : "⇅ Priority order"}
                </button>
                <span className="ml-auto text-xs text-steel">
                  {selectedFileNames.length} of {orderedItems.length} selected
                </span>
              </div>

              {orderMode && (
                <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs font-semibold text-amber-700">
                  ⇅ Drag the cards or use the arrows — LTAs are processed
                  top-to-bottom.
                </div>
              )}

              {!orderMode && selectedFileNames.length > 1 && (
                <div className="mb-4 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-semibold text-steel">
                    Order:
                  </span>
                  {selectedFileNames.map((fn, i) => (
                    <span
                      key={fn}
                      className="rounded-full bg-ink/[0.07] px-2 py-0.5 font-mono text-[11px]"
                    >
                      {i + 1}. {ltaMap[fn]?.ltaRef ?? fn}
                    </span>
                  ))}
                </div>
              )}

              {/* Cards */}
              <div
                className={
                  orderMode
                    ? "flex flex-col gap-2.5"
                    : "grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
                }
              >
                {visibleItems.map((item) => {
                  const idx = orderedItems.indexOf(item);
                  const priorityPos =
                    selectedFileNames.indexOf(item.fileName) + 1;
                  const isSelected = Boolean(selected[item.fileName]);
                  const isActive =
                    running && stats.currentLta === item.ltaRef;

                  return (
                    <article
                      key={item.fileName}
                      draggable={orderMode}
                      onDragStart={() => orderMode && onDragStart(idx)}
                      onDragOver={(e) => orderMode && onDragOver(e, idx)}
                      onDrop={(e) => orderMode && onDrop(e, idx)}
                      onDragEnd={onDragEnd}
                      className={`group rounded-2xl border bg-white/80 p-4 shadow-sm backdrop-blur transition-all ${
                        orderMode
                          ? `cursor-grab active:cursor-grabbing ${
                              dragOver === idx
                                ? "border-amber-400 ring-2 ring-amber-300"
                                : "border-ink/10"
                            }`
                          : isActive
                            ? "border-emerald-400 ring-2 ring-emerald-300"
                            : isSelected
                              ? "border-ink/25 hover:border-ink/40"
                              : "border-ink/10 opacity-60 hover:opacity-100"
                      }`}
                    >
                      <div className="mb-3 flex items-center justify-between gap-2">
                        {orderMode ? (
                          <div className="flex items-center gap-2">
                            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-100 text-[11px] font-bold text-amber-700">
                              {idx + 1}
                            </span>
                            <span className="cursor-grab select-none text-lg leading-none text-steel/50">
                              ⠿
                            </span>
                          </div>
                        ) : (
                          <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-steel">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-[#0E131F]"
                              checked={isSelected}
                              onChange={(e) =>
                                setSelected((prev) => ({
                                  ...prev,
                                  [item.fileName]: e.target.checked,
                                }))
                              }
                            />
                            {priorityPos > 0 ? `#${priorityPos}` : "Include"}
                          </label>
                        )}

                        <div className="flex items-center gap-1.5">
                          {isActive && (
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                              ● SIGNING
                            </span>
                          )}
                          <span className="rounded-full bg-coral/15 px-2.5 py-0.5 text-[11px] font-bold text-coral">
                            {item.dumsCount} DUM
                          </span>
                        </div>
                      </div>

                      <h2 className="font-display text-lg font-semibold tracking-tight">
                        {item.ltaRef}
                      </h2>
                      <p className="mt-0.5 truncate text-[11px] text-steel">
                        {item.fileName}
                      </p>

                      {!orderMode && (
                        <>
                          <button
                            type="button"
                            onClick={() => copySubject(item)}
                            title="Copy the mail subject"
                            className={`mt-3 flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[11px] transition ${
                              copiedSubject === item.fileName
                                ? "border-emerald-400 bg-emerald-50 text-emerald-700"
                                : "border-ink/10 bg-mist/60 text-steel hover:border-ink/30 hover:text-ink"
                            }`}
                          >
                            <span className="truncate font-mono">
                              {mawbSubject(item)}
                            </span>
                            <span className="shrink-0 font-bold">
                              {copiedSubject === item.fileName
                                ? "✓"
                                : "Copy"}
                            </span>
                          </button>

                          {/* Envoyer par email — opens an Outlook draft with
                              the signed PDFs attached. */}
                          <button
                            type="button"
                            onClick={() => sendByEmail(item)}
                            disabled={emailState[item.fileName] === "sending"}
                            title="Ouvrir un brouillon Outlook avec les PDF joints"
                            className={`mt-2 flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white shadow-sm transition disabled:opacity-70 ${
                              emailState[item.fileName] === "error"
                                ? "bg-rose-500 hover:bg-rose-600"
                                : emailState[item.fileName] === "sent"
                                  ? "bg-emerald-500"
                                  : "bg-[#0F6CBD] hover:bg-[#0B5AA2]"
                            }`}
                          >
                            <span aria-hidden className="text-base leading-none">
                              {emailState[item.fileName] === "sending"
                                ? "⏳"
                                : emailState[item.fileName] === "sent"
                                  ? "✓"
                                  : emailState[item.fileName] === "error"
                                    ? "⚠"
                                    : "✉"}
                            </span>
                            {emailState[item.fileName] === "sending"
                              ? "Ouverture d'Outlook…"
                              : emailState[item.fileName] === "sent"
                                ? "Brouillon ouvert"
                                : emailState[item.fileName] === "error"
                                  ? "Échec — réessayer"
                                  : "Envoyer par email"}
                          </button>

                          <label className="mt-3 block text-[10px] font-bold uppercase tracking-wider text-steel">
                            Expected shipper
                          </label>
                          <input
                            value={shippers[item.fileName] || ""}
                            onChange={(e) =>
                              updateShipper(
                                item.fileName,
                                item.ltaRef,
                                e.target.value,
                              )
                            }
                            placeholder="Type exact shipper name"
                            className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-2.5 py-1.5 text-sm outline-none transition focus:border-ink"
                          />
                        </>
                      )}

                      {orderMode && (
                        <div className="mt-3 flex items-center gap-2">
                          <button
                            onClick={() => moveItem(idx, -1)}
                            disabled={idx === 0}
                            title="Move up"
                            className="h-8 w-10 rounded-lg border border-ink/15 text-sm font-semibold text-steel transition hover:bg-ink/5 disabled:opacity-25"
                          >
                            ↑
                          </button>
                          <button
                            onClick={() => moveItem(idx, 1)}
                            disabled={idx === orderedItems.length - 1}
                            title="Move down"
                            className="h-8 w-10 rounded-lg border border-ink/15 text-sm font-semibold text-steel transition hover:bg-ink/5 disabled:opacity-25"
                          >
                            ↓
                          </button>
                          <label className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-lg border border-ink/15 px-3 py-1.5 text-xs font-semibold text-steel">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-[#0E131F]"
                              checked={isSelected}
                              onChange={(e) =>
                                setSelected((prev) => ({
                                  ...prev,
                                  [item.fileName]: e.target.checked,
                                }))
                              }
                            />
                            Include
                          </label>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>

              {/* Empty states */}
              {apiReady && ltaFiles.length === 0 && !loading && (
                <div className="rounded-2xl border border-dashed border-ink/20 bg-white/60 p-10 text-center">
                  <p className="font-display text-lg font-semibold">
                    No Excel files detected
                  </p>
                  <p className="mx-auto mt-2 max-w-lg text-sm text-steel">
                    Drop your LTA Excel files into the dums folder, then hit
                    Refresh.
                  </p>
                  {dumsFolder && (
                    <p className="mt-3 break-all font-mono text-xs text-steel">
                      {dumsFolder}
                    </p>
                  )}
                </div>
              )}
              {ltaFiles.length > 0 && visibleItems.length === 0 && (
                <div className="rounded-2xl border border-dashed border-ink/20 bg-white/60 p-10 text-center text-sm text-steel">
                  Nothing matches “{search}”.
                </div>
              )}

              {dumsFolder && ltaFiles.length > 0 && (
                <p className="mt-6 break-all font-mono text-[11px] text-steel/70">
                  📂 {dumsFolder}
                </p>
              )}
            </div>
          </div>
        ) : (
          /* ── Activity tab ──────────────────────────────────────────────── */
          <div className="flex h-full flex-col gap-3 px-5 py-4">
            <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3">
              {/* Stat tiles */}
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
                {[
                  { label: "Status", value: job?.status ?? "idle", tone: "" },
                  { label: "Done", value: `${stats.done}/${total || 0}`, tone: "" },
                  {
                    label: "Success",
                    value: stats.success,
                    tone: "text-emerald-600",
                  },
                  { label: "Skipped", value: stats.skipped, tone: "text-steel" },
                  { label: "Failed", value: stats.failed, tone: "text-coral" },
                ].map((s) => (
                  <div
                    key={s.label}
                    className="rounded-xl border border-ink/10 bg-white/80 px-3 py-2"
                  >
                    <p className="text-[10px] font-bold uppercase tracking-wider text-steel">
                      {s.label}
                    </p>
                    <p
                      className={`font-display text-lg font-semibold capitalize ${s.tone}`}
                    >
                      {s.value}
                    </p>
                  </div>
                ))}
              </div>

              {/* Log toolbar */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-xl border border-ink/15 bg-white/70 p-0.5">
                  {["all", "info", "warn", "error", "debug"].map((lv) => (
                    <button
                      key={lv}
                      onClick={() => setLogLevel(lv)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-semibold capitalize transition ${
                        logLevel === lv
                          ? "bg-ink text-white"
                          : "text-steel hover:text-ink"
                      }`}
                    >
                      {lv}
                    </button>
                  ))}
                </div>
                <input
                  value={logQuery}
                  onChange={(e) => setLogQuery(e.target.value)}
                  placeholder="Filter logs…"
                  className="w-48 rounded-xl border border-ink/15 bg-white/80 px-3 py-1.5 text-sm outline-none transition focus:border-ink"
                />
                <label className="flex items-center gap-1.5 text-xs font-semibold text-steel">
                  <input
                    type="checkbox"
                    className="accent-[#0E131F]"
                    checked={autoScroll}
                    onChange={(e) => setAutoScroll(e.target.checked)}
                  />
                  Auto-scroll
                </label>
                <button
                  onClick={copyLogs}
                  disabled={!filteredLogs.length}
                  className={`${btnGhost} ml-auto !py-1.5`}
                >
                  {copiedLogs ? "✓ Copied" : "Copy logs"}
                </button>
                <span className="font-mono text-[11px] text-steel">
                  {filteredLogs.length}/{logs.length}
                </span>
              </div>
            </div>

            {/* Console */}
            <div className="mx-auto min-h-0 w-full max-w-[1600px] flex-1 overflow-auto rounded-2xl border border-white/10 bg-[#0b1019] p-3 font-mono text-xs leading-6 shadow-soft">
              {!jobId && (
                <p className="p-6 text-center text-slate-500">
                  No job started yet — configure your LTAs, then press Run.
                </p>
              )}
              {jobId && !job && (
                <p className="p-6 text-center text-slate-500">
                  Starting job…
                </p>
              )}
              {job && filteredLogs.length === 0 && (
                <p className="p-6 text-center text-slate-500">
                  No log lines match the current filter.
                </p>
              )}
              {filteredLogs.map((line, i) => {
                const st = LEVEL_STYLES[line.level] || LEVEL_STYLES.debug;
                return (
                  <div
                    key={`${line.at}-${i}`}
                    className="flex gap-2 whitespace-pre-wrap break-words px-1 hover:bg-white/5"
                  >
                    <span className="shrink-0 text-slate-600">
                      {new Date(line.at).toLocaleTimeString()}
                    </span>
                    <span
                      className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${st.dot}`}
                    />
                    <span className={st.text}>{line.message}</span>
                  </div>
                );
              })}
              <div ref={logEndRef} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
