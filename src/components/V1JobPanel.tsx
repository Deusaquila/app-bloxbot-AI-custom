import { useEffect, useState } from "react";
import { useStudioTargetOptional } from "@/providers/StudioTargetProvider";
import type { Job } from "@/types/job";
export default function V1JobPanel() {
  const studio = useStudioTargetOptional();
  const [open, setOpen] = useState(false);
  const [sourcePath, setSourcePath] = useState("");
  const [creatorId, setCreatorId] = useState("");
  const [running, setRunning] = useState(false);
  const [jobs, setJobs] = useState<readonly Job[]>([]);
  const [error, setError] = useState("");
  const api = window.bloxbot;
  useEffect(() => {
    if (!open || !api?.listV1Jobs) return;
    let live = true;
    const refresh = () =>
      api
        .listV1Jobs?.()
        .then((value) => {
          if (live) setJobs(value);
        })
        .catch(() => {
          if (live) setError("Could not read asset jobs.");
        });
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [open]);
  if (!api?.runV1Job) return null;
  const run = async () => {
    if (!studio?.selected || !api.runV1Job) return;
    setRunning(true);
    setError("");
    try {
      const result = await api.runV1Job({ sourcePath, studioId: studio.selected.key, creatorId });
      setJobs((previous) => [...previous.filter((job) => job.id !== result.id), result]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Asset job failed.");
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="relative text-xs">
      <button
        className="h-7 rounded-md border px-2"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        Asset job
      </button>
      {open && (
        <section
          aria-label="V1 asset job"
          className="absolute right-0 top-9 z-50 w-96 max-w-[90vw] space-y-3 rounded-lg border bg-card p-4 shadow-lg"
        >
          <h2 className="font-semibold">Make an asset black and twice as large</h2>
          <p>Target: {studio?.selected?.label ?? "Select a Studio first"}</p>
          <p className="text-muted-foreground">
            Uploads a reference and an edited model to your Roblox account, then inserts both in the
            selected Studio to verify the result.
          </p>
          <button
            className="rounded border px-2 py-1"
            disabled={running}
            onClick={async () => {
              try {
                const path = await api.pickV1Asset?.();
                if (path) setSourcePath(path);
              } catch {
                setError("Could not open the file picker.");
              }
            }}
          >
            Choose FBX
          </button>
          <p className="break-all">{sourcePath || "No file selected"}</p>
          <label className="block">
            Roblox creator user ID
            <input
              className="mt-1 w-full rounded border bg-background p-2"
              value={creatorId}
              onChange={(event) => setCreatorId(event.target.value)}
              inputMode="numeric"
              disabled={running}
            />
          </label>
          <button
            className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-40"
            disabled={
              running ||
              !sourcePath ||
              !/^[1-9][0-9]*$/.test(creatorId) ||
              studio?.status !== "ready" ||
              !studio.selected
            }
            onClick={() => void run()}
          >
            {running ? "Working…" : "Run asset job"}
          </button>
          {error && <p role="alert">{error}</p>}
          <ul aria-live="polite" className="max-h-48 space-y-2 overflow-auto">
            {[...jobs]
              .reverse()
              .slice(0, 5)
              .map((job) => (
                <li key={job.id}>
                  <span className="font-mono">{job.id.slice(0, 8)}</span> —{" "}
                  {job.state.replace(/_/g, " ")}
                  <p>
                    {job.requirements.filter((r) => r.status === "PASSED").length}/
                    {job.requirements.length} requirements passed
                  </p>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}
