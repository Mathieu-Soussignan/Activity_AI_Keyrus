import axios from "axios";
import { supabase } from "./supabase";

const baseURL = (import.meta.env.VITE_API_URL as string) || "http://localhost:8787";

export const api = axios.create({
  baseURL,
  headers: { "Content-Type": "application/json" },
});

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