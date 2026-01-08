// src/lib/me.ts
import { api } from "./api";

export type Me = {
  id: string;
  email: string;
  role: "dev" | "pm";
  full_name: string | null;
};

const KEY = "me_cache_v1";
let inMemory: Me | null = null;

export function getCachedMe(): Me | null {
  if (inMemory) return inMemory;

  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    inMemory = JSON.parse(raw) as Me;
    return inMemory;
  } catch {
    return null;
  }
}

export function setCachedMe(me: Me | null) {
  inMemory = me;
  try {
    if (!me) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(me));
  } catch {
    // ignore storage errors
  }
}

export async function fetchMe(): Promise<Me> {
  const { data } = await api.get("/api/me");
  const me = data as Me;
  setCachedMe(me);
  return me;
}

export async function ensureMe(): Promise<Me> {
  const cached = getCachedMe();
  if (cached) return cached;
  return fetchMe();
}

export function clearMeCache() {
  setCachedMe(null);
}