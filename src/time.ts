export function parseTimestamp(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Timestamp cannot be empty.");
  }

  const hms = trimmed.match(/^(\d+):(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (hms) {
    const hours = Number(hms[1]);
    const minutes = Number(hms[2]);
    const seconds = Number(hms[3]);
    const millis = Number((hms[4] ?? "0").padEnd(3, "0"));
    return hours * 3600 + minutes * 60 + seconds + millis / 1000;
  }

  const ms = trimmed.match(/^(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (ms) {
    const minutes = Number(ms[1]);
    const seconds = Number(ms[2]);
    const millis = Number((ms[3] ?? "0").padEnd(3, "0"));
    return minutes * 60 + seconds + millis / 1000;
  }

  const plain = trimmed.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/i);
  if (plain) {
    const amount = Number(plain[1]);
    const unit = (plain[2] ?? "s").toLowerCase();

    if (Number.isNaN(amount) || amount < 0) {
      throw new Error(`Invalid timestamp "${input}".`);
    }

    if (unit.startsWith("h")) return amount * 3600;
    if (unit.startsWith("m")) return amount * 60;
    return amount;
  }

  throw new Error(
    `Invalid timestamp "${input}". Use formats like 90, 1:30, 01:02:03, or 90s.`,
  );
}

export function formatTimestamp(seconds: number): string {
  const wholeSeconds = Math.floor(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const secs = wholeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${minutes}:${String(secs).padStart(2, "0")}`;
}
