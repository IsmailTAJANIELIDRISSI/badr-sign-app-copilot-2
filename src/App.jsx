import { useEffect, useMemo, useRef, useState } from "react";

const pollMs = 1200;
const isElectron = typeof window !== "undefined" && window.electronAPI;

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

  // Priority ordering — array of fileNames in user-defined processing order.
  const [orderedFileNames, setOrderedFileNames] = useState([]);
  const [orderMode, setOrderMode] = useState(false);

  // Drag state (refs to avoid re-renders mid-drag).
  const dragIndexRef = useRef(null);
  const [dragOver, setDragOver] = useState(null); // index being hovered

  // Map from fileName → full ltaFiles item (for ordered render).
  const ltaMap = useMemo(
    () => Object.fromEntries(ltaFiles.map((f) => [f.fileName, f])),
    [ltaFiles],
  );

  // Ordered+selected list — what the backend will process, in priority order.
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

      // Merge new files into orderedFileNames: keep existing order, append new.
      setOrderedFileNames((prev) => {
        const existing = new Set(prev);
        const incoming = data.map((f) => f.fileName);
        const newOnes = incoming.filter((fn) => !existing.has(fn));
        // Remove stale ones (no longer in dums folder).
        const valid = prev.filter((fn) => incoming.includes(fn));
        return [...valid, ...newOnes];
      });

      // Load saved shipper names.
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
    const payload = {
      shipperByFileName: shippers,
      fileNames: selectedFileNames,
    };
    const r = await fetch("/api/jobs/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    setJobId(data.jobId);
    setJob(null);
  };

  // ── Drag-and-drop handlers ─────────────────────────────────────────────────
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

  // Items to render — in priority order.
  const orderedItems = orderedFileNames.map((fn) => ltaMap[fn]).filter(Boolean);

  return (
    <main className="min-h-screen px-4 py-8 md:px-10">
      <section className="mx-auto max-w-7xl animate-floatIn rounded-3xl border border-white/80 bg-white/75 p-6 shadow-soft backdrop-blur md:p-8">
        {/* ── Header ────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="font-display text-2xl font-semibold text-ink md:text-4xl">
              BADR DUM Signing Console
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-steel md:text-base">
              Detect Excel files from the dums folder, map each LTA to shipper
              data, then run the BADR workflow: validate, sign, and print PDFs
              per DUM.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={refresh}
              className="rounded-xl border border-steel/30 px-4 py-2 text-sm font-semibold text-steel transition hover:bg-steel/10"
            >
              {loading ? "Refreshing..." : "Refresh Files"}
            </button>
            {isElectron && outputsFolder && (
              <button
                onClick={() => window.electronAPI.openFolder(outputsFolder)}
                className="rounded-xl border border-mint/30 px-4 py-2 text-sm font-semibold text-mint transition hover:bg-mint/10"
              >
                📁 Open Output PDFs
              </button>
            )}
            <button
              onClick={() => setOrderMode((v) => !v)}
              className={`rounded-xl border px-4 py-2 text-sm font-semibold transition ${
                orderMode
                  ? "border-amber-400 bg-amber-400/20 text-amber-700"
                  : "border-steel/30 text-steel hover:bg-steel/10"
              }`}
            >
              {orderMode ? "✓ Done Reordering" : "⇅ Set Priority Order"}
            </button>
            <button
              onClick={run}
              disabled={
                !selectedFileNames.length || (job && job.status === "running")
              }
              className="rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white transition hover:bg-steel disabled:cursor-not-allowed disabled:opacity-60"
            >
              Run Signing Job
            </button>
          </div>
        </div>

        {/* ── Dums folder banner ─────────────────────────────────────────── */}
        {dumsFolder && (
          <div className="mt-6 rounded-xl border border-coral/30 bg-coral/10 p-4">
            <p className="text-xs font-semibold text-coral">📂 DUMS FOLDER:</p>
            <p className="mt-1 break-all font-mono text-sm text-steel">
              {dumsFolder}
            </p>
            <p className="mt-2 text-xs text-steel">
              Place your Excel files here. Click "Refresh Files" to detect them.
            </p>
          </div>
        )}

        {/* ── Priority order banner ─────────────────────────────────────── */}
        {orderMode && orderedItems.length > 0 && (
          <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
            <p className="text-xs font-semibold text-amber-700">
              ⇅ PRIORITY ORDER MODE — drag cards or use arrows to set processing
              order. The job will process LTAs top-to-bottom.
            </p>
          </div>
        )}

        {/* ── Run-order preview pill strip (normal mode) ────────────────── */}
        {!orderMode && selectedFileNames.length > 1 && (
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-steel">
              Processing order:
            </span>
            {selectedFileNames.map((fn, i) => (
              <span
                key={fn}
                className="rounded-full bg-ink/10 px-2 py-0.5 text-xs font-mono text-ink"
              >
                {i + 1}. {ltaMap[fn]?.ltaRef ?? fn}
              </span>
            ))}
          </div>
        )}

        {/* ── LTA cards ─────────────────────────────────────────────────── */}
        <div
          className={`mt-7 ${
            orderMode
              ? "flex flex-col gap-3"
              : "grid gap-4 md:grid-cols-2 xl:grid-cols-3"
          }`}
        >
          {orderedItems.map((item, idx) => {
            const priorityPos = selectedFileNames.indexOf(item.fileName) + 1; // 0 = not selected
            const isDraggingOver = dragOver === idx;

            return (
              <article
                key={item.fileName}
                draggable={orderMode}
                onDragStart={() => orderMode && onDragStart(idx)}
                onDragOver={(e) => orderMode && onDragOver(e, idx)}
                onDrop={(e) => orderMode && onDrop(e, idx)}
                onDragEnd={onDragEnd}
                style={!orderMode ? { animationDelay: `${idx * 65}ms` } : {}}
                className={`animate-floatIn rounded-2xl border bg-gradient-to-br from-white to-mint/20 p-4 transition-all ${
                  orderMode
                    ? `cursor-grab active:cursor-grabbing ${
                        isDraggingOver
                          ? "border-amber-400 shadow-lg ring-2 ring-amber-300"
                          : "border-ink/10"
                      }`
                    : "border-ink/10"
                }`}
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  {/* Left: drag handle (order mode) OR checkbox (normal) */}
                  {orderMode ? (
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xs font-bold text-amber-700">
                        {idx + 1}
                      </span>
                      <span
                        className="cursor-grab select-none text-xl leading-none text-steel/60"
                        title="Drag to reorder"
                      >
                        ⠿
                      </span>
                    </div>
                  ) : (
                    <label className="flex items-center gap-2 text-sm font-semibold text-ink">
                      <input
                        type="checkbox"
                        checked={Boolean(selected[item.fileName])}
                        onChange={(e) =>
                          setSelected((prev) => ({
                            ...prev,
                            [item.fileName]: e.target.checked,
                          }))
                        }
                      />
                      Select
                    </label>
                  )}

                  <div className="flex items-center gap-1.5">
                    {/* Priority badge (always visible if selected) */}
                    {priorityPos > 0 && !orderMode && (
                      <span className="rounded-full bg-ink/10 px-2 py-0.5 text-xs font-bold text-ink">
                        #{priorityPos}
                      </span>
                    )}
                    <span className="rounded-full bg-coral/20 px-3 py-1 text-xs font-semibold text-coral">
                      {item.dumsCount} DUM
                    </span>
                  </div>
                </div>

                <h2 className="font-display text-lg font-semibold text-ink">
                  {item.ltaRef}
                </h2>
                <p className="mt-1 text-xs text-steel">{item.fileName}</p>

                {/* Up/Down arrows in order mode */}
                {orderMode && (
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => moveItem(idx, -1)}
                      disabled={idx === 0}
                      className="flex-1 rounded-lg border border-steel/20 py-1 text-xs font-semibold text-steel transition hover:bg-steel/10 disabled:opacity-30"
                    >
                      ↑ Move Up
                    </button>
                    <button
                      onClick={() => moveItem(idx, 1)}
                      disabled={idx === orderedItems.length - 1}
                      className="flex-1 rounded-lg border border-steel/20 py-1 text-xs font-semibold text-steel transition hover:bg-steel/10 disabled:opacity-30"
                    >
                      ↓ Move Down
                    </button>
                    <label className="flex items-center gap-1.5 rounded-lg border border-steel/20 px-3 py-1 text-xs font-semibold text-steel transition hover:bg-steel/10">
                      <input
                        type="checkbox"
                        checked={Boolean(selected[item.fileName])}
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

                {/* Shipper field (hidden in order mode to keep cards compact) */}
                {!orderMode && (
                  <>
                    <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-steel">
                      Expected Shipper Name
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
                      className="mt-1 w-full rounded-xl border border-ink/15 bg-white/95 px-3 py-2 text-sm outline-none transition focus:border-ink"
                    />
                  </>
                )}
              </article>
            );
          })}
        </div>

        {apiReady && ltaFiles.length === 0 && !loading && (
          <div className="mt-6 rounded-xl border border-mint/30 bg-mint/10 p-6 text-center">
            <p className="text-sm text-steel">
              📋 No Excel files detected. Place LTA Excel files in the dums
              folder above and click "Refresh Files".
            </p>
          </div>
        )}
      </section>

      {/* ── Live logs ─────────────────────────────────────────────────────── */}
      <section className="mx-auto mt-6 max-w-7xl rounded-3xl border border-white/80 bg-ink p-6 text-mist shadow-soft">
        <h3 className="font-display text-xl font-semibold">Live Run Logs</h3>
        {!jobId && (
          <p className="mt-2 text-sm text-mist/80">No job started yet.</p>
        )}
        {jobId && !job && (
          <p className="mt-2 text-sm text-mist/80">Loading job state...</p>
        )}

        {job && (
          <>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-mint/20 px-3 py-1">
                Status: {job.status}
              </span>
              <span className="rounded-full bg-mint/20 px-3 py-1">
                Done: {job.progress.done}
              </span>
              <span className="rounded-full bg-mint/20 px-3 py-1">
                Success: {job.progress.success}
              </span>
              <span className="rounded-full bg-steel/30 px-3 py-1">
                Skipped: {job.progress.skipped ?? 0}
              </span>
              <span className="rounded-full bg-coral/30 px-3 py-1">
                Failed: {job.progress.failed}
              </span>
            </div>
            <div className="mt-4 max-h-[420px] overflow-auto rounded-xl border border-white/15 bg-[#0b1019] p-3 font-mono text-xs leading-6 text-[#d3f7ec]">
              {(job.logs || []).map((line, i) => (
                <div key={`${line.at}-${i}`}>
                  [{new Date(line.at).toLocaleTimeString()}]{" "}
                  {line.level.toUpperCase()} - {line.message}
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

export default App;
