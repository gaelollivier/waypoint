import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { navigate } from "../components/Router";
import { formatBytes, formatDate } from "../lib/format";

function DiskCard({ disk }: { disk: import("../api/types").Disk }) {
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
        <span className="text-xs text-zinc-600">→</span>
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

function RegisterModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [selectedPath, setSelectedPath] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: volumes = [], isLoading: loadingVolumes } = useQuery({
    queryKey: ["volumes"],
    queryFn: api.disks.volumes,
  });

  const handleVolumeChange = (mountPath: string) => {
    setSelectedPath(mountPath);
    // Pre-fill label from the volume name
    const vol = volumes.find((v) => v.mountPath === mountPath);
    if (vol && !label) setLabel(vol.name);
  };

  const register = useMutation({
    mutationFn: ({ mountPath, label }: { mountPath: string; label: string }) =>
      api.disks.register({ mountPath, label }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["disks"] });
      onClose();
    },
    onError: (err: any) => setError(err.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPath) return;
    setError(null);
    register.mutate({ mountPath: selectedPath, label });
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
          <span className="text-xs text-zinc-400">Volume</span>
          {loadingVolumes ? (
            <p className="text-sm text-zinc-500 py-2">Loading volumes…</p>
          ) : volumes.length === 0 ? (
            <p className="text-sm text-zinc-500 py-2">No external volumes found.</p>
          ) : (
            <select
              value={selectedPath}
              onChange={(e) => handleVolumeChange(e.target.value)}
              className="w-full rounded bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            >
              <option value="">— select a volume —</option>
              {volumes.map((v) => (
                <option key={v.mountPath} value={v.mountPath}>
                  {v.name}
                  {v.capacityBytes != null ? ` (${formatBytes(v.capacityBytes)})` : ""}
                </option>
              ))}
            </select>
          )}
        </label>

        {selectedPath && (
          <div className="text-xs text-zinc-500 font-mono truncate">{selectedPath}</div>
        )}

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
            disabled={register.isPending || !selectedPath || !label}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            {register.isPending ? "Registering…" : "Register"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function DisksPage() {
  const [showRegister, setShowRegister] = useState(false);

  const { data: disks = [], isLoading } = useQuery({
    queryKey: ["disks"],
    queryFn: api.disks.list,
    refetchInterval: 5_000,
  });

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

      {isLoading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : disks.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center space-y-2">
          <p className="text-sm text-zinc-400">No disks registered yet.</p>
          <p className="text-xs text-zinc-600">Click "Register disk" to add your first disk.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {disks.map((d: import("../api/types").Disk) => (
            <DiskCard key={d.id} disk={d} />
          ))}
        </div>
      )}

      {showRegister && <RegisterModal onClose={() => setShowRegister(false)} />}
    </div>
  );
}
