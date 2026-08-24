import axios from "axios";
import { supabase } from "./supabase";
import { clearMeCache } from "./me";

const baseURL = (import.meta.env.VITE_API_URL as string) || "http://localhost:8787";

export const api = axios.create({
  baseURL,
  headers: { "Content-Type": "application/json" },
});

function purgeAuthStorage() {
  clearMeCache();
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("sb-") || k.includes("supabase") || k === "me_cache_v1") {
        localStorage.removeItem(k);
      }
    }
  } catch {}
}

// Ajoute automatiquement le Bearer token Supabase à chaque request
api.interceptors.request.use(async (config) => {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;

  if (token) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Gestion centralisée des erreurs 401 (Session expirée ou révoquée)
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401 && !window.location.pathname.includes("/login")) {
      purgeAuthStorage();
      try {
        await supabase.auth.signOut();
      } catch {}
      window.location.href = "/login?session_expired=1";
    }
    return Promise.reject(error);
  }
);