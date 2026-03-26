import { useEffect, useMemo, useState } from "react";

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

  const selectedFileNames = useMemo(
    () => ltaFiles.filter((f) => selected[f.fileName]).map((f) => f.fileName),
    [ltaFiles, selected],
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

  return (
    <main className="min-h-screen px-4 py-8 md:px-10">
      <section className="mx-auto max-w-7xl animate-floatIn rounded-3xl border border-white/80 bg-white/75 p-6 shadow-soft backdrop-blur md:p-8">
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
          <div className="flex gap-2">
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

        <div className="mt-7 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {ltaFiles.map((item, idx) => (
            <article
              key={item.fileName}
              style={{ animationDelay: `${idx * 65}ms` }}
              className="animate-floatIn rounded-2xl border border-ink/10 bg-gradient-to-br from-white to-mint/20 p-4"
            >
              <div className="mb-3 flex items-center justify-between">
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
                <span className="rounded-full bg-coral/20 px-3 py-1 text-xs font-semibold text-coral">
                  {item.dumsCount} DUM
                </span>
              </div>
              <h2 className="font-display text-lg font-semibold text-ink">
                {item.ltaRef}
              </h2>
              <p className="mt-1 text-xs text-steel">{item.fileName}</p>

              <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-steel">
                Expected Shipper Name
              </label>
              <input
                value={shippers[item.fileName] || ""}
                onChange={(e) =>
                  setShippers((prev) => ({
                    ...prev,
                    [item.fileName]: e.target.value,
                  }))
                }
                placeholder="Type exact shipper name"
                className="mt-1 w-full rounded-xl border border-ink/15 bg-white/95 px-3 py-2 text-sm outline-none transition focus:border-ink"
              />
            </article>
          ))}
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
