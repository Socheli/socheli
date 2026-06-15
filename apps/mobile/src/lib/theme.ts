/* Socheli mobile theme — mirrors the web platform's premium monochrome dark UI. */
export const C = {
  bg: "#0a0a0a",
  surface: "#131313",
  elevated: "#1a1a1a",
  card: "#131313",
  border: "rgba(255,255,255,0.08)",
  borderStrong: "rgba(255,255,255,0.14)",
  text: "#ededed",
  textLight: "#d4d4d4",
  textSecondary: "#8f8f8f",
  textMuted: "#5f5f5f",
  accent: "#f5f5f5",
  accentDim: "#bdbdbd",
  success: "#5fd97a",
  warning: "#d9b54f",
  error: "#ef5350",
  info: "#5fa3ef",
} as const;

export const font = {
  body: undefined as string | undefined, // system
  mono: undefined as string | undefined,
};

export const statusColor = (s: string) =>
  s === "packaged" || s === "rendered" ? C.success
  : s === "qa_failed" || s === "failed" || s === "error" ? C.error
  : s === "running" || s === "busy" || s === "dispatched" ? C.accent
  : C.textSecondary;

export const channelName = (id: string) =>
  ({ concept_lab: "Labrinox", claude_code_lab: "Code Labrinox", agentic_builder: "Agentic Builder", moltjobs: "MoltJobs", cognitivx: "iCog" } as Record<string, string>)[id] ?? id.replace(/_/g, " ");
