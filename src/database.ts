import { readFile, rename, writeFile } from "node:fs/promises";

export type SessionKind = "worker" | "comment";

type SupabaseConfig = { url: string; key: string };

const localWriteQueues = new Map<string, Promise<void>>();
const databaseTimeoutMs = Math.max(2_000, Math.min(20_000, Number(process.env.SUPABASE_TIMEOUT_MS) || 8_000));

function supabase(): SupabaseConfig | null {
  const url = String(process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
  const key = String(process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!url && !key) return null;
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) || !key) {
    throw new Error("SUPABASE_URL dan SUPABASE_SECRET_KEY harus diisi bersama.");
  }
  return { url, key };
}

function restHeaders(config: SupabaseConfig, extra: Record<string, string> = {}) {
  return { apikey: config.key, authorization: `Bearer ${config.key}`, "content-type": "application/json", ...extra };
}

async function requireOk(response: Response, context: string) {
  if (response.ok) return response;
  const detail = (await response.text()).slice(0, 280);
  throw new Error(`${context}: ${response.status}${detail ? ` ${detail}` : ""}`);
}

async function supabaseRequest(config: SupabaseConfig, path: string, init: RequestInit, context: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), databaseTimeoutMs);
  try {
    const response = await fetch(`${config.url}/rest/v1/${path}`, { ...init, signal: controller.signal });
    return await requireOk(response, context);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${context}: koneksi Supabase terlalu lama. Coba lagi.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readLocal<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return fallback; }
}

async function writeLocal(file: string, value: unknown) {
  const previous = localWriteQueues.get(file) ?? Promise.resolve();
  const temporary = `${file}.${process.pid}.tmp`;
  const task = previous.then(async () => {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
    await rename(temporary, file);
  });
  localWriteQueues.set(file, task.catch(() => undefined));
  return task;
}

/** Uses the checked-in local store until both Supabase runtime credentials exist. */

// Efisiensi biaya: satu-satunya penulis store adalah proses server ini, jadi
// teks store boleh dicache dan di-refresh dari Supabase maksimal sekali per
// TTL (atau langsung setelah tulis sendiri). Ini memangkas ratusan ribu
// GET 87KB per hari tanpa mengubah semantik apa pun bagi pemanggil — setiap
// load() tetap menghasilkan objek baru hasil parse.
const storeTextCache = new Map<string, { text: string; fetchedAt: number }>();
const STORE_CACHE_TTL_MS = Number(process.env.STORE_CACHE_TTL_MS ?? 60_000);

export async function loadPersistentStore<T>(localFile: string, fallback: T): Promise<T> {
  const config = supabase();
  if (!config) return readLocal(localFile, fallback);
  const cached = storeTextCache.get(localFile);
  if (cached && Date.now() - cached.fetchedAt < STORE_CACHE_TTL_MS) return JSON.parse(cached.text) as T;
  const response = await supabaseRequest(config, "app_state?id=eq.primary&select=state", { headers: restHeaders(config) }, "Tidak bisa membaca database Supabase");
  const rows = await response.json() as { state?: T }[];
  const state = rows[0]?.state;
  if (state !== undefined) storeTextCache.set(localFile, { text: JSON.stringify(state), fetchedAt: Date.now() });
  return state ?? fallback;
}

export async function savePersistentStore<T>(localFile: string, value: T) {
  const config = supabase();
  if (!config) return writeLocal(localFile, value);
  const serialized = JSON.stringify(value);
  // Tulis yang isinya identik tidak dikirim ke Supabase — reconcile berkala
  // sebelumnya selalu menulis ulang walau tak ada perubahan.
  if (storeTextCache.get(localFile)?.text === serialized) return;
  await supabaseRequest(config, "app_state?id=eq.primary", {
    method: "PATCH",
    headers: restHeaders(config, { prefer: "return=minimal" }),
    body: JSON.stringify({ state: value, updated_at: new Date().toISOString() }),
  }, "Tidak bisa menyimpan database Supabase");
  storeTextCache.set(localFile, { text: serialized, fetchedAt: Date.now() });
}

export async function readEncryptedSessions(kind: SessionKind, localFile: string) {
  const config = supabase();
  if (!config) return readLocal<Record<string, string>>(localFile, {});
  const response = await supabaseRequest(config, `app_sessions?kind=eq.${encodeURIComponent(kind)}&select=session_id,encrypted_value`, { headers: restHeaders(config) }, "Tidak bisa membaca session Supabase");
  const rows = await response.json() as { session_id: string; encrypted_value: string }[];
  return Object.fromEntries(rows.map((row) => [row.session_id, row.encrypted_value]));
}

export async function saveEncryptedSession(kind: SessionKind, localFile: string, sessionId: string, encryptedValue: string) {
  const config = supabase();
  if (!config) {
    const sessions = await readEncryptedSessions(kind, localFile);
    sessions[sessionId] = encryptedValue;
    return writeLocal(localFile, sessions);
  }
  await supabaseRequest(config, "app_sessions?on_conflict=kind,session_id", {
    method: "POST",
    headers: restHeaders(config, { prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify([{ kind, session_id: sessionId, encrypted_value: encryptedValue, updated_at: new Date().toISOString() }]),
  }, "Tidak bisa menyimpan session Supabase");
}

export async function removeEncryptedSession(kind: SessionKind, localFile: string, sessionId: string) {
  const config = supabase();
  if (!config) {
    const sessions = await readEncryptedSessions(kind, localFile);
    delete sessions[sessionId];
    return writeLocal(localFile, sessions);
  }
  await supabaseRequest(config, `app_sessions?kind=eq.${encodeURIComponent(kind)}&session_id=eq.${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: restHeaders(config, { prefer: "return=minimal" }),
  }, "Tidak bisa menghapus session Supabase");
}

export function usingSupabase() { return Boolean(supabase()); }
