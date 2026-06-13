import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Cliente único. Si faltan las env vars (p.ej. en un deploy sin configurar),
// supabase queda null y la app sigue funcionando en modo invitado (localStorage).
export const supabase = url && anonKey ? createClient(url, anonKey) : null;
export const cloudEnabled = !!supabase;
