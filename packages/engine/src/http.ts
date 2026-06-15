import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/* Shared curl wrapper. Google APIs are geo-blocked in some regions and must route
   through the SOCKS5 tunnel; everything else (Meta, TikTok, object storage) goes
   direct. So the proxy is opt-in per call — pass {proxy:true} for Google, omit it
   for the rest. */
export const PROXY = process.env.ELEVEN_PROXY || process.env.HTTPS_PROXY || "socks5h://127.0.0.1:11080";

/* The curl proxy flags for the SOCKS tunnel. Shared so callers that build their
   own curl invocation (e.g. research/orchestrator.ts's async fetchPage) derive
   the `--socks5-hostname host:port` exactly the way httpCurl does — one place to
   keep the flag + scheme-strip in sync. */
export function socksProxyArgs(): string[] {
  return ["--socks5-hostname", PROXY.replace(/^socks5h?:\/\//, "")];
}

export function httpCurl(args: string[], opts: { proxy?: boolean; timeoutMs?: number } = {}): SpawnSyncReturns<string> {
  const base = ["-s"];
  if (opts.proxy) base.push(...socksProxyArgs());
  return spawnSync("curl", [...base, ...args], { encoding: "utf8", timeout: opts.timeoutMs ?? 1000 * 60 * 10, maxBuffer: 1024 * 1024 * 64 });
}

/* Is the SOCKS tunnel actually up? Used by the scheduler to explain a no-op in
   the log instead of failing a YouTube upload silently. */
export function proxyReachable(): boolean {
  const hostPort = PROXY.replace(/^socks5h?:\/\//, "");
  const [host, port] = hostPort.split(":");
  const r = spawnSync("nc", ["-z", "-w", "2", host, port || "1080"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0;
}
