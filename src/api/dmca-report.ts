export type DmcaReportKind = "takedown" | "counter";

export type DmcaReportInput = {
  kind: DmcaReportKind;
  name: string;
  email: string;
  copyrightedWork: string;
  infringingMaterial: string;
  previewUrl?: string;
  contactAddress?: string;
  contactPhone?: string;
  details?: string;
  goodFaith: boolean;
  accuracy: boolean;
  website?: string;
};

export type DmcaReportValidation =
  | { ok: true; report: DmcaReportInput }
  | { ok: false; error: string };

function readString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

export function parseDmcaReportBody(body: unknown): DmcaReportValidation {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  if (readString(raw.website, 200)) {
    return {
      ok: true,
      report: {
        kind: "takedown",
        name: "honeypot",
        email: "honeypot@example.com",
        copyrightedWork: "honeypot",
        infringingMaterial: "honeypot",
        goodFaith: true,
        accuracy: true,
        website: "filled",
      },
    };
  }

  const kindRaw = readString(raw.kind, 32).toLowerCase();
  const kind: DmcaReportKind = kindRaw === "counter" ? "counter" : "takedown";

  const report: DmcaReportInput = {
    kind,
    name: readString(raw.name, 120),
    email: readString(raw.email, 254),
    copyrightedWork: readString(raw.copyrightedWork, 500),
    infringingMaterial: readString(raw.infringingMaterial, 3000),
    previewUrl: readString(raw.previewUrl, 500) || undefined,
    contactAddress: readString(raw.contactAddress, 500) || undefined,
    contactPhone: readString(raw.contactPhone, 64) || undefined,
    details: readString(raw.details, 3000) || undefined,
    goodFaith: raw.goodFaith === true,
    accuracy: raw.accuracy === true,
  };

  if (!report.name || !report.email || !report.copyrightedWork || !report.infringingMaterial) {
    return { ok: false, error: "missing_fields" };
  }

  if (!report.goodFaith || !report.accuracy) {
    return { ok: false, error: "missing_attestations" };
  }

  if (!report.email.includes("@")) {
    return { ok: false, error: "invalid_email" };
  }

  return { ok: true, report };
}

export function isDmcaHoneypot(report: DmcaReportInput): boolean {
  return report.website === "filled" || report.name === "honeypot";
}

export function formatDmcaNtfyPayload(report: DmcaReportInput, clientIp: string): string {
  const title =
    report.kind === "counter" ? "Jellybot DMCA counter-notification" : "Jellybot DMCA takedown";

  return [
    `site: jellybot.introvrtlounge.com`,
    `kind: ${report.kind}`,
    `name: ${report.name}`,
    `email: ${report.email}`,
    `ip: ${clientIp}`,
    report.contactAddress ? `address: ${report.contactAddress}` : null,
    report.contactPhone ? `phone: ${report.contactPhone}` : null,
    "",
    `${title}`,
    "",
    "Copyrighted work:",
    report.copyrightedWork,
    "",
    "Infringing material:",
    report.infringingMaterial,
    report.previewUrl ? `\nPreview URL:\n${report.previewUrl}` : null,
    report.details ? `\nAdditional details:\n${report.details}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function dmcaNtfyTitle(report: DmcaReportInput): string {
  return report.kind === "counter"
    ? "Jellybot counter-notification"
    : "Jellybot copyright report";
}
