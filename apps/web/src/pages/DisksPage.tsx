import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";
import type { Disk } from "../api/types";
import { Link } from "../components/Router";

function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1e12) return (n / 1e12).toFixed(1) + " TB";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  return (n / 1e3).toFixed(0) + " KB";
}

function formatDate(s: string | null): string {
  if (!s) return "never";
  return new Date(s).toLocaleString();
}

function DiskCard({ disk, onScan }: { disk: Disk; onScan: (id: number) => void }) {
  const usedBytes = disk.capacityBytes && disk.freeBytes !== null
    ? disk.capacityBytes - disk.freeBytes
    : null;
  const usedPct = usedBytes && disk.capacityBytes
    ? usedBytes / disk.capacityBytes
    : null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-white">{disk.label ?? disk.diskUuid.slice(0, 8)}</span>
            <span className={`inline-block w-2 h-2 rounded-full ${disk.isConnected ? "bg-green-400" : "bg-zinc-600"}`} />
          </div>
          <div className="mt-1 flex gap-3 text-xs text-zinc-500">
            <span className="uppercase">{disk.kind}</span>
            <span>·</span>
            <span>{disk.role}</span>
            {disk.mountPath && <><span>·</span><span className="font-mono">{disk.mountPath}</span></>}
          </div>
        </div>
        {disk.isConnected && (
          <button
            onClick={() => onScan(disk.id)}
            className="shrink-0 rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
          >
            Scan
          </button>
        )}
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
    </div>
  );
}

function RegisterModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    mountPath: "",
    label: "",
    kind: "hdd" as "ssd" | "hdd",
    role: "destination" as "source" | "destination",
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.disks.register(form);
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

        <label className="block space-y-1">
          <span className="text-xs text-zinc-400">Mount path</span>
          <input
            className="w-full rounded bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500"
            placeholder="/Volumes/My-HDD"
            value={form.mountPath}
            onChange={(e) => setForm((f) => ({ ...f, mountPath: e.target.value }))}
            required
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-zinc-400">Label</span>
          <input
            className="w-full rounded bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            placeholder="HDD-A"
            value={form.label}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            required
          />
        </label>

        <div className="flex gap-4">
          <label className="block flex-1 space-y-1">
            <span className="text-xs text-zinc-400">Kind</span>
            <select
              className="w-full rounded bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              value={form.kind}
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as "ssd" | "hdd" }))}
            >
              <option value="hdd">HDD</option>
              <option value="ssd">SSD</option>
            </select>
          </label>

          <label className="block flex-1 space-y-1">
            <span className="text-xs text-zinc-400">Role</span>
            <select
              className="w-full rounded bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as "source" | "destination" }))}
            >
              <option value="destination">Destination</option>
              <option value="source">Source</option>
            </select>
          </label>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="text-sm text-zinc-400 hover:text-white">
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
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
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDisks(await api.disks.list());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleScan = async (diskId: number) => {
    try {
      const { jobId } = await api.disks.scan(diskId);
      setScanMessage(`Scan started — job #${jobId}`);
      setTimeout(() => setScanMessage(null), 4000);
    } catch (err: any) {
      setScanMessage(`Error: ${err.message}`);
      setTimeout(() => setScanMessage(null), 4000);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white">Disks</h1>
        <div className="flex items-center gap-3">
          {scanMessage && <span className="text-xs text-zinc-400">{scanMessage}</span>}
          <button
            onClick={() => setShowRegister(true)}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
          >
            + Register disk
          </button>
        </div>
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
            <DiskCard key={d.id} disk={d} onScan={handleScan} />
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
