import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";
import type { Disk, Volume } from "../api/types";
import { navigate } from "../components/Router";
import { formatBytes, formatDate } from "../lib/format";

function DiskCard({ disk }: { disk: Disk }) {
  const usedBytes = disk.capacityBytes && disk.freeBytes !== null
    ? disk.capacityBytes - disk.freeBytes
    : null;
  const usedPct = usedBytes && disk.capacityBytes
    ? usedBytes / disk.capacityBytes
    : null;

  return (
    <button
      onClick={() => navigate(`/disks/${disk.id}`)}
      className="text-left rounded-lg border border-zinc-800 bg-zinc-900 p-5 flex flex-col gap-4 hover:border-zinc-700 hover:bg-zinc-900/80 transition-colors"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-white">{disk.label ?? disk.diskUuid.slice(0, 8)}</span>
            <span className={`inline-block w-2 h-2 rounded-full ${disk.isConnected ? "bg-green-400" : "bg-zinc-600"}`} />
          </div>
          <div className="mt-1 flex gap-3 text-xs text-zinc-500">
            <span className="uppercase">{disk.kind}</span>
            {disk.mountPath && <><span>·</span><span className="font-mono">{disk.mountPath}</span></>}
          </div>
        </div>
        <span className="text-xs text-zinc-600 group-hover:text-zinc-400">→</span>
      </div>

      {disk.capacityBytes && (
        <div className="space-y-1">
          <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-600"
              style={{ width: `${(usedPct ?? 0) * 100}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-zinc-500">
            <span>{formatBytes(usedBytes)} used</span>
            <span>{formatBytes(disk.freeBytes)} free / {formatBytes(disk.capacityBytes)}</span>
          </div>
        </div>
      )}

      <div className="text-xs text-zinc-600">
        Last scan: {formatDate(disk.lastScanAt)}
      </div>
    </button>
  );
}

function RegisterModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [volumes, setVolumes] = useState<Volume[] | null>(null);
  const [selected, setSelected] = useState<Volume | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.disks.volumes()
      .then((vols) => {
        setVolumes(vols);
        const firstUnregistered = vols.find((v) => !v.isWaypointDisk);
        if (firstUnregistered) {
          setSelected(firstUnregistered);
          setLabel(firstUnregistered.name);
        }
      })
      .catch((err) => setError(err.message));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setError(null);
    setLoading(true);
    try {
      await api.disks.register({ mountPath: selected.mountPath, label });
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <form
        className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="text-base font-semibold text-white">Register a disk</h2>

        <div className="space-y-1">
          <p className="text-xs text-zinc-400">Volume</p>
          {volumes === null ? (
            <p className="text-xs text-zinc-500">Loading volumes…</p>
          ) : volumes.length === 0 ? (
            <p className="text-xs text-zinc-500">No volumes mounted under <code>/Volumes</code>.</p>
          ) : (
            <div className="space-y-1 max-h-64 overflow-y-auto rounded border border-zinc-800">
              {volumes.map((v) => {
                const isSelected = selected?.mountPath === v.mountPath;
                return (
                  <button
                    type="button"
                    key={v.mountPath}
                    disabled={v.isWaypointDisk}
                    onClick={() => {
                      setSelected(v);
                      if (!label) setLabel(v.name);
                    }}
                    className={`w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors ${
                      v.isWaypointDisk
                        ? "opacity-40 cursor-not-allowed"
                        : isSelected
                          ? "bg-blue-900/40 text-white"
                          : "hover:bg-zinc-800 text-zinc-300"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{v.name}</div>
                      <div className="font-mono text-xs text-zinc-500 truncate">{v.mountPath}</div>
                    </div>
                    <div className="text-xs text-zinc-500 shrink-0 text-right">
                      {v.capacityBytes != null && <div>{formatBytes(v.capacityBytes)}</div>}
                      {v.isWaypointDisk && <div className="text-zinc-600">already registered</div>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <label className="block space-y-1">
          <span className="text-xs text-zinc-400">Label</span>
          <input
            className="w-full rounded bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            placeholder="My SSD"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
          />
        </label>

        <p className="text-xs text-zinc-600">
          Disk type (SSD/HDD) is auto-detected via <code>diskutil</code>.
        </p>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="text-sm text-zinc-400 hover:text-white">
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || !selected || !label}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            {loading ? "Registering…" : "Register"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function DisksPage() {
  const [disks, setDisks] = useState<Disk[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRegister, setShowRegister] = useState(false);

  const load = useCallback(async () => {
    try {
      setDisks(await api.disks.list());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white">Disks</h1>
        <button
          onClick={() => setShowRegister(true)}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
        >
          + Register disk
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : disks.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center space-y-2">
          <p className="text-sm text-zinc-400">No disks registered yet.</p>
          <p className="text-xs text-zinc-600">Click "Register disk" to add your first disk.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {disks.map((d) => (
            <DiskCard key={d.id} disk={d} />
          ))}
        </div>
      )}

      {showRegister && (
        <RegisterModal
          onClose={() => setShowRegister(false)}
          onDone={() => { setShowRegister(false); load(); }}
        />
      )}
    </div>
  );
}
