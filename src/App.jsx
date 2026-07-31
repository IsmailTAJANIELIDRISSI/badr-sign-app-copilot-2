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

  // Import tab: pull DUM .xlsx from the Outlook inbox by LTA ref.
  const [importRefs, setImportRefs] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResults, setImportResults] = useState(null);
  const [importDebug, setImportDebug] = useState([]);
  const [cleaning, setCleaning] = useState(false);
  const [sendingAll, setSendingAll] = useState(false);

  // Extract only LTA-ref-shaped tokens (e.g. 235-96330754) from any text — so a
  // whole WhatsApp message ("Bonsoir, Veuillez valider sans blocage: …") can be
  // pasted and the greeting/instructions are ignored. De-duplicated.
  const parseRefs = (text) => [
    ...new Set(String(text).match(/\b\d{3}-\d{6,9}\b/g) || []),
  ];

  const fetchXlsxFromInbox = async () => {
    const refs = parseRefs(importRefs);
    if (!refs.length) return;
    setImporting(true);
    setImportResults(null);
    setImportDebug([]);
    try {
      const r = await fetch("/api/lta/fetch-xlsx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refs }),
      });
      const data = await r.json();
      setImportDebug(data.debug || []);
      if (r.ok && data.ok) {
        setImportResults(data.results || []);
        if (data.savedCount > 0) refresh(); // new files → reload the LTA list
      } else {
        setImportResults([
          { ref: "—", status: "error", detail: data.reason || "Échec." },
        ]);
      }
    } catch (e) {
      setImportResults([{ ref: "—", status: "error", detail: e.message }]);
    } finally {
      setImporting(false);
    }
  };

  // Paste the clipboard (a whole WhatsApp message) into the refs box. On mobile /
  // AnyDesk where Ctrl+V is awkward, this button does it. Appends so several
  // messages can be pasted in a row (parseRefs de-dupes).
  const pasteIntoRefs = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text)
        setImportRefs((prev) => (prev.trim() ? `${prev}\n${text}` : text));
    } catch {
      alert(
        "Impossible de lire le presse-papiers.\nCollez manuellement dans le champ (appui long → Coller).",
      );
    }
  };

  const copyRefs = async () => {
    const refs = parseRefs(importRefs);
    if (refs.length) await copyToClipboard(refs.join("\n"));
  };

  // Clean the DUM inputs and ARCHIVE the signed "…READY" folders (moved to
  // outputs/deja signé et envoyé, not deleted). `item` omitted → clean ALL;
  // otherwise just that one LTA. Guarded by confirm() and blocked mid-job.
  const cleanLtas = async (item) => {
    if (running) {
      alert("Un traitement est en cours — impossible de nettoyer maintenant.");
      return;
    }
    const ok = window.confirm(
      item
        ? `Supprimer le LTA ${item.ltaRef} ?\n\n` +
            `• son fichier .xlsx est supprimé du dossier DUMs\n` +
            `• son dossier signé (READY) est déplacé vers « deja signé et envoyé »\n\n` +
            `Continuer ?`
        : "Nettoyer / Supprimer tous les LTA ?\n\n" +
            "• tous les fichiers .xlsx sont supprimés du dossier DUMs\n" +
            "• tous les dossiers signés (READY) sont déplacés vers « deja signé et envoyé »\n\n" +
            "Continuer ?",
    );
    if (!ok) return;
    setCleaning(true);
    try {
      const r = await fetch("/api/lta/clean", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          item ? { fileName: item.fileName, ltaRef: item.ltaRef } : {},
        ),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        setImportResults(null);
        setImportDebug([]);
        await refresh();
        alert(
          `Nettoyage terminé.\n\n` +
            `DUMs supprimés : ${data.dumsRemoved}\n` +
            `Dossiers archivés : ${data.movedFolders?.length ?? 0}`,
        );
      } else {
        alert(data.reason || "Échec du nettoyage.");
      }
    } catch (e) {
      alert(`Échec du nettoyage : ${e.message}`);
    } finally {
      setCleaning(false);
    }
  };

  const copySubject = async (item) => {
    if (await copyToClipboard(mawbSubject(item))) {
      setCopiedSubject(item.fileName);
      setTimeout(() => setCopiedSubject(""), 1600);
    }
  };

  // Open a specific LTA's .xlsx in Excel.
  const openXlsx = async (filePath) => {
    if (!isElectron || !filePath) return;
    const ok = await window.electronAPI.openFile(filePath);
    if (!ok) alert("Impossible d'ouvrir le fichier Excel.");
  };

  // Pick ANY .xlsx via a native dialog and open it (defaults to the DUMs folder).
  const pickXlsx = async () => {
    if (!isElectron) return;
    await window.electronAPI.pickAndOpenXlsx(dumsFolder);
  };

  // Open an Outlook draft with the LTA's signed PDFs attached (backend uses
  // Outlook COM — mailto: can't carry attachments).
  // Core: open one Outlook draft. Sets per-item state and returns a result.
  // `silent` suppresses the per-item alerts (used by the bulk "Envoyer tous").
  const sendEmailRequest = async (item, { silent = false } = {}) => {
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
        // (new Outlook / web) opens compose with the PDFs on the clipboard.
        if (!silent && data.method === "clipboard") {
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
        return { ok: true, method: data.method };
      }
      setEmailState((p) => ({ ...p, [item.fileName]: "error" }));
      if (!silent) alert(data.reason || "Could not open the Outlook draft.");
      return { ok: false, reason: data.reason };
    } catch (e) {
      setEmailState((p) => ({ ...p, [item.fileName]: "error" }));
      if (!silent) alert(`Email failed: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  };

  const clearEmailStateSoon = (fileName) =>
    setTimeout(
      () =>
        setEmailState((p) => {
          const n = { ...p };
          delete n[fileName];
          return n;
        }),
      2500,
    );

  const sendByEmail = async (item) => {
    await sendEmailRequest(item);
    clearEmailStateSoon(item.fileName);
  };

  // Bulk: open an Outlook draft for every selected LTA, one at a time (COM can't
  // be driven in parallel). One summary at the end instead of N alerts.
  const sendAllEmails = async () => {
    const items = orderedItems.filter((it) => selected[it.fileName]);
    if (!items.length) return;
    if (
      !window.confirm(
        `Créer un brouillon Outlook pour ${items.length} LTA ?\n\n` +
          `Chaque brouillon s'ouvre avec ses PDF signés joints.`,
      )
    )
      return;
    setSendingAll(true);
    let ok = 0;
    const failed = [];
    try {
      for (const item of items) {
        const res = await sendEmailRequest(item, { silent: true });
        if (res.ok) ok++;
        else failed.push(item.ltaRef);
      }
    } finally {
      setSendingAll(false);
      items.forEach((it) => clearEmailStateSoon(it.fileName));
    }
    alert(
      `Brouillons créés : ${ok} / ${items.length}` +
        (failed.length ? `\n\nÉchecs (non signés ?) :\n${failed.join("\n")}` : ""),
    );
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
            <button
              onClick={() => cleanLtas()}
              disabled={cleaning || running}
              title="Nettoyer tous les LTA (supprime les .xlsx, archive les dossiers signés)"
              className={`${btn} border border-coral/40 bg-coral/10 text-coral hover:bg-coral/20`}
            >
              {cleaning ? "Nettoyage…" : "🗑 Nettoyer"}
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
              onClick={sendAllEmails}
              disabled={!selectedFileNames.length || running || sendingAll}
              title="Créer un brouillon Outlook pour tous les LTA sélectionnés"
              className={`${btn} bg-[#0F6CBD] text-white shadow-soft hover:bg-[#0B5AA2]`}
            >
              {sendingAll
                ? "Envoi…"
                : `✉ Envoyer tous${
                    selectedFileNames.length
                      ? ` (${selectedFileNames.length})`
                      : ""
                  }`}
            </button>
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
            { id: "import", label: "Import", badge: null },
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
                {isElectron && (
                  <button
                    onClick={pickXlsx}
                    className={btnGhost}
                    title="Ouvrir n'importe quel fichier Excel"
                  >
                    📊 Ouvrir un Excel
                  </button>
                )}
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
                  // Signed with a PROBLEM output folder → red card so it's seen
                  // before being emailed.
                  const isProblem = item.outputStatus === "problem";

                  return (
                    <article
                      key={item.fileName}
                      draggable={orderMode}
                      onDragStart={() => orderMode && onDragStart(idx)}
                      onDragOver={(e) => orderMode && onDragOver(e, idx)}
                      onDrop={(e) => orderMode && onDrop(e, idx)}
                      onDragEnd={onDragEnd}
                      className={`group rounded-2xl border p-4 shadow-sm backdrop-blur transition-all ${
                        isProblem
                          ? `border-red-400 bg-red-50 ring-1 ring-red-300 ${
                              orderMode
                                ? "cursor-grab active:cursor-grabbing"
                                : ""
                            }`
                          : orderMode
                            ? `bg-white/80 cursor-grab active:cursor-grabbing ${
                                dragOver === idx
                                  ? "border-amber-400 ring-2 ring-amber-300"
                                  : "border-ink/10"
                              }`
                            : isActive
                              ? "bg-white/80 border-emerald-400 ring-2 ring-emerald-300"
                              : isSelected
                                ? "bg-white/80 border-ink/25 hover:border-ink/40"
                                : "bg-white/80 border-ink/10 opacity-60 hover:opacity-100"
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
                          {isProblem && (
                            <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">
                              ⚠ PROBLEM
                            </span>
                          )}
                          {isActive && (
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                              ● SIGNING
                            </span>
                          )}
                          <span className="rounded-full bg-coral/15 px-2.5 py-0.5 text-[11px] font-bold text-coral">
                            {item.dumsCount} DUM
                          </span>
                          {!orderMode && !isActive && (
                            <button
                              type="button"
                              onClick={() => cleanLtas(item)}
                              disabled={cleaning || running}
                              title="Supprimer ce LTA (.xlsx supprimé, dossier signé archivé)"
                              className="flex h-6 w-6 items-center justify-center rounded-full bg-red-600 text-white shadow-sm transition hover:bg-red-700 disabled:opacity-40"
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="h-3.5 w-3.5"
                              >
                                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                                <line x1="10" y1="11" x2="10" y2="17" />
                                <line x1="14" y1="11" x2="14" y2="17" />
                              </svg>
                            </button>
                          )}
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

                          {isElectron && item.filePath && (
                            <button
                              type="button"
                              onClick={() => openXlsx(item.filePath)}
                              title="Ouvrir ce fichier .xlsx dans Excel"
                              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-600/30 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100"
                            >
                              📊 Ouvrir l'Excel
                            </button>
                          )}

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
        ) : tab === "import" ? (
          /* ── Import tab ────────────────────────────────────────────────── */
          <div className="h-full overflow-auto">
            <div className="mx-auto max-w-[900px] px-5 py-6">
              <h2 className="font-display text-lg font-semibold text-ink">
                Importer les DUMs depuis Outlook
              </h2>
              <p className="mt-1 text-sm text-steel">
                Collez le message WhatsApp complet — l'app en extrait
                automatiquement les références (format{" "}
                <span className="font-mono text-ink">235-96330754</span>) et
                ignore le reste du texte. Elle cherche ensuite dans la boîte de
                réception Outlook du compte{" "}
                <span className="font-semibold text-ink">medafrica-log.com</span>{" "}
                l'email dont l'objet contient la référence et{" "}
                <span className="font-semibold text-ink">« LTA Complet »</span>,
                puis enregistre le fichier{" "}
                <span className="font-mono text-ink">
                  generated_excel - &lt;ref&gt;.xlsx
                </span>{" "}
                dans le dossier des DUMs.
              </p>

              <div className="mt-4 rounded-2xl border border-ink/10 bg-white/70 p-4">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold uppercase tracking-wider text-steel">
                    Références LTA — collez le message WhatsApp
                  </label>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={pasteIntoRefs}
                      title="Coller depuis le presse-papiers"
                      className={`${btn} !px-3 !py-1.5 bg-ink text-white hover:bg-ink/90`}
                    >
                      📋 Coller
                    </button>
                    <button
                      onClick={copyRefs}
                      disabled={parseRefs(importRefs).length === 0}
                      title="Copier les références détectées"
                      className={`${btnGhost} !px-3 !py-1.5`}
                    >
                      ⧉ Copier
                    </button>
                    <button
                      onClick={() => setImportRefs("")}
                      disabled={!importRefs}
                      title="Effacer"
                      className={`${btnGhost} !px-3 !py-1.5`}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <textarea
                  value={importRefs}
                  onChange={(e) => setImportRefs(e.target.value)}
                  placeholder={
                    "Collez ici, ex :\n\nBonsoir,\nVeuillez valider sans blocage:\n235-96330754\n235-97644562\n235-98097145"
                  }
                  rows={10}
                  spellCheck={false}
                  className="mt-2 w-full resize-y rounded-xl border border-ink/15 bg-white/80 px-3 py-2.5 font-mono text-sm text-ink outline-none focus:border-ink/40"
                />
                {parseRefs(importRefs).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {parseRefs(importRefs).map((ref) => (
                      <span
                        key={ref}
                        className="rounded-full border border-[#0F6CBD]/30 bg-[#0F6CBD]/10 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-[#0F6CBD]"
                      >
                        {ref}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex items-center gap-3">
                  <button
                    onClick={fetchXlsxFromInbox}
                    disabled={importing || parseRefs(importRefs).length === 0}
                    className={`${btn} bg-ink text-white hover:bg-ink/90`}
                  >
                    {importing ? "⏳ Recherche…" : "Confirmer"}
                  </button>
                  {isElectron && (
                    <button
                      onClick={pickXlsx}
                      className={btnGhost}
                      title="Ouvrir n'importe quel fichier Excel"
                    >
                      📊 Ouvrir un Excel
                    </button>
                  )}
                  <span className="text-xs text-steel">
                    {parseRefs(importRefs).length} référence
                    {parseRefs(importRefs).length > 1 ? "s" : ""}
                  </span>
                  {dumsFolder && (
                    <span className="ml-auto truncate text-xs text-steel">
                      📂 {dumsFolder}
                    </span>
                  )}
                </div>
              </div>

              {importResults && (
                <div className="mt-4 space-y-2">
                  {importResults.map((res, i) => {
                    const tone =
                      res.status === "saved"
                        ? {
                            dot: "bg-emerald-500",
                            label: "Enregistré",
                            cls: "text-emerald-600",
                          }
                        : res.status === "no_xlsx"
                          ? {
                              dot: "bg-amber-500",
                              label: "Sans .xlsx",
                              cls: "text-amber-600",
                            }
                          : res.status === "error"
                            ? {
                                dot: "bg-coral",
                                label: "Erreur",
                                cls: "text-coral",
                              }
                            : {
                                dot: "bg-steel",
                                label: "Introuvable",
                                cls: "text-steel",
                              };
                    return (
                      <div
                        key={`${res.ref}-${i}`}
                        className="flex items-start gap-3 rounded-xl border border-ink/10 bg-white/70 px-4 py-2.5"
                      >
                        <span
                          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone.dot}`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="font-mono text-sm font-semibold text-ink">
                            {res.ref}
                          </p>
                          <p className="break-words text-xs text-steel">
                            {res.detail}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 text-xs font-bold ${tone.cls}`}
                        >
                          {tone.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {importDebug.length > 0 && (
                <details className="mt-4 rounded-2xl border border-ink/10 bg-white/60 px-4 py-3">
                  <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider text-steel">
                    Détails du diagnostic ({importDebug.length})
                  </summary>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-steel">
                    {importDebug.join("\n")}
                  </pre>
                </details>
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
