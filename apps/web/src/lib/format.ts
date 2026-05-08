// Formatting helpers shared across pages.

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1e12) return (n / 1e12).toFixed(2) + " TB";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}

export function formatBytesPerSec(n: number): string {
  if (!isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB/s";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB/s";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB/s";
  return n.toFixed(0) + " B/s";
}

export function formatRate(n: number, unit: string): string {
  if (!isFinite(n) || n <= 0) return "—";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k " + unit;
  if (n >= 100) return n.toFixed(0) + " " + unit;
  if (n >= 10) return n.toFixed(1) + " " + unit;
  return n.toFixed(2) + " " + unit;
}

export function formatDuration(secs: number): string {
  if (!isFinite(secs) || secs < 0) return "—";
  if (secs < 60) return `${Math.floor(secs)}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${Math.floor(secs % 60)}s`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

export function formatDate(s: string | null | undefined): string {
  if (!s) return "never";
  return new Date(s).toLocaleString();
}
