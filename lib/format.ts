// Time and count formatting for the page and the tray. Pure.

const pad = (n: number) => String(n).padStart(2, "0");

/** A length: `42s`, `7m 05s`, `1h 04m`, `2d 3h`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${pad(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** How long ago: `just now`, `3m ago`, `2h ago`. */
export function formatAgo(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** A clock time `14:05` in the viewer's zone. */
export function formatClock(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A repo's short name (`acme/web` → `web`). */
export function shortRepo(full: string): string {
  const i = full.indexOf("/");
  return i === -1 ? full : full.slice(i + 1);
}

/** `1,234`. */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * A runner's short name for a narrow column: GitHub's `GitHub Actions 1000058781` → `#1000058781`;
 * any other name as is (the caller trims it with an ellipsis and keeps the full name as a tooltip).
 */
export function shortRunner(name: string): string {
  const m = /^GitHub Actions (\d+)$/.exec(name.trim());
  return m ? `#${m[1]}` : name;
}
