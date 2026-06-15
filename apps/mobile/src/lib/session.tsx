import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import * as SecureStore from "expo-secure-store";
import { createSocheli, type SocheliClient } from "./socheli";

/* Workspace session — the mobile app is a credentialed API client (like the CLI).
   The API URL + key live in the device keychain (SecureStore); the app is "connected"
   once a valid key is stored. No plaintext keys in source. */

const K_URL = "socheli_api_url";
const K_KEY = "socheli_api_key";
export const DEFAULT_API = "https://api.socheli.com";

type Session = {
  ready: boolean;
  connected: boolean;
  apiUrl: string;
  client: SocheliClient | null;
  connect: (apiUrl: string, apiKey: string) => Promise<{ ok: boolean; error?: string }>;
  disconnect: () => Promise<void>;
};

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [apiUrl, setApiUrl] = useState(DEFAULT_API);
  const [apiKey, setApiKey] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const url = (await SecureStore.getItemAsync(K_URL)) || DEFAULT_API;
        const key = await SecureStore.getItemAsync(K_KEY);
        setApiUrl(url);
        setApiKey(key);
      } catch { /* ignore */ }
      setReady(true);
    })();
  }, []);

  const client = useMemo(() => (apiKey ? createSocheli({ baseUrl: apiUrl, apiKey }) : null), [apiUrl, apiKey]);

  const connect: Session["connect"] = async (url, key) => {
    const u = url.trim().replace(/\/$/, "") || DEFAULT_API;
    const test = createSocheli({ baseUrl: u, apiKey: key.trim() });
    try {
      // /health is public; verify the key with an authed call
      await test.fleet();
    } catch (e: any) {
      if (e?.status === 401) return { ok: false, error: "Invalid API key for this workspace." };
      return { ok: false, error: e?.message ?? "Could not reach the API." };
    }
    await SecureStore.setItemAsync(K_URL, u);
    await SecureStore.setItemAsync(K_KEY, key.trim());
    setApiUrl(u);
    setApiKey(key.trim());
    return { ok: true };
  };

  const disconnect: Session["disconnect"] = async () => {
    await SecureStore.deleteItemAsync(K_KEY);
    setApiKey(null);
  };

  return <Ctx.Provider value={{ ready, connected: !!apiKey, apiUrl, client, connect, disconnect }}>{children}</Ctx.Provider>;
}

export const useSession = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession must be used within SessionProvider");
  return c;
};
