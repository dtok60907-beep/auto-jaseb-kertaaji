import "dotenv/config";
import { createDecipheriv, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { NewMessage } from "teleproto/events/index.js";
import { loadPersistentStore, readEncryptedSessions } from "../src/database.js";

type Job = { id: string; action: "JOIN" | "LEAVE"; username: string };
type BroadcastJob = { buyerId: string; deliveryToken: string; group: string; wording: string; mode: "TEXT" | "FORWARD"; forward?: { channel: string; messageId: number; showSource: boolean } };
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workerRef = String(process.argv[2] ?? "").replace(/^@/, ""); const apiId = Number(process.env.TELEGRAM_API_ID); const apiHash = process.env.TELEGRAM_API_HASH ?? ""; const sessionKey = process.env.WORKER_SESSION_KEY ?? ""; const adapterToken = process.env.LPM_ADAPTER_TOKEN ?? ""; const baseUrl = (process.env.LPM_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`).replace(/\/$/, "");
if (!workerRef || !Number.isInteger(apiId) || !apiHash || sessionKey.length < 24 || !adapterToken) throw new Error("@username worker dan konfigurasi Telegram/LPM belum lengkap.");
const store = await loadPersistentStore<{ workers?: { id: string; username: string }[] }>(join(root, "data/store.json"), {});
const worker = store.workers?.find((item) => item.id === workerRef || item.username.toLowerCase() === workerRef.toLowerCase());
if (!worker) throw new Error("Worker tidak ditemukan.");
const workerId = worker.id;
const key = createHash("sha256").update(sessionKey).digest();
function decrypt(value: string) { const [iv, tag, content] = value.split("."); const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url")); decipher.setAuthTag(Buffer.from(tag, "base64url")); return Buffer.concat([decipher.update(Buffer.from(content, "base64url")), decipher.final()]).toString("utf8"); }
const sessions = await readEncryptedSessions("worker", join(root, "data/worker-sessions.json"));
if (!sessions[workerId]) throw new Error("Session worker belum ada. Jalankan npm run worker:login -- <worker-id>.");
const client = new TelegramClient(new StringSession(decrypt(sessions[workerId])), apiId, apiHash, { connectionRetries: 5 });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)); const headers = { "x-lpm-adapter-token": adapterToken, "content-type": "application/json" };
async function report(id: string, status: "READY" | "PENDING_APPROVAL" | "UNAVAILABLE" | "REMOVED", note?: string) { await fetch(`${baseUrl}/api/internal/lpm-targets/${id}/result`, { method: "POST", headers, body: JSON.stringify({ workerId, status, note }) }); }
async function reportBroadcast(job: BroadcastJob, result: { messageId?: number; error?: string }) { await fetch(`${baseUrl}/api/internal/broadcast-jobs/${job.buyerId}/result`, { method: "POST", headers, body: JSON.stringify({ deliveryToken: job.deliveryToken, group: job.group, ...result }) }); }
async function alert(buyerId: string, chat: string, type: "MENTION" | "REPLY", text: string, messageId: number) { await fetch(`${baseUrl}/api/internal/operational-alert`, { method: "POST", headers, body: JSON.stringify({ buyerId, workerId, chat, type, text, link: `https://t.me/${chat}/${messageId}` }) }); }
function joinStatus(error: unknown): "PENDING_APPROVAL" | "READY" | "UNAVAILABLE" { const message = String((error as Error).message ?? error); if (message.includes("INVITE_REQUEST_SENT")) return "PENDING_APPROVAL"; if (message.includes("USER_ALREADY_PARTICIPANT")) return "READY"; return "UNAVAILABLE"; }
// Error level-session bukan urusan grup: melaporkannya sebagai UNAVAILABLE akan
// mencap grup yang sehat dan menggantung begitu akun dipulihkan. Begitu sesi
// mati, hentikan runner; target dibiarkan CONNECTING agar dicoba ulang nanti.
// Frasa "authorization key" menangkap bentuk kalimat Telegram tanpa kode yang
// terbukti muncul di produksi saat key PFS kadaluarsa.
const sessionFatal = (error: unknown) => /AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|CONCURRENT USAGE|authorization key/i.test(String((error as Error).message ?? error));
let sessionDead = false;
async function forwardSourcePost(job: BroadcastJob) {
  if (!job.forward) throw new Error("Sumber forward belum lengkap.");
  const source = "@" + job.forward.channel;
  const requested = await client.getMessages(source, { ids: job.forward.messageId });
  const original = requested[0] as any;
  if (!original?.id) throw new Error("Post sumber tidak ditemukan atau tidak bisa diakses.");

  // A Telegram album is several consecutive messages sharing one groupedId.
  // One copied bubble link points to only one of those IDs, so collect the
  // complete (max. 10-item) album before sending one forward request.
  let messageIds = [Number(original.id)];
  if (original.groupedId) {
    const nearbyIds = Array.from({ length: 19 }, (_, index) => Number(original.id) - 9 + index).filter((id) => id > 0);
    const nearby = await client.getMessages(source, { ids: nearbyIds });
    const groupedId = String(original.groupedId);
    messageIds = Array.from(new Set((nearby as any[])
      .filter((message) => message?.id && String(message.groupedId) === groupedId)
      .map((message) => Number(message.id))))
      .sort((left, right) => left - right);
    if (messageIds.length < 2) throw new Error("Album sumber tidak bisa dibaca lengkap. Coba salin ulang link post-nya.");
  }

  // Read the destination message ID from this exact MTProto response. Do not
  // query the group's latest message: a busy group could make us attach the
  // activity link to somebody else's post.
  const result = await client.invoke(new Api.messages.ForwardMessages({
    fromPeer: await client.getInputEntity(source),
    id: messageIds,
    toPeer: await client.getInputEntity("@" + job.group),
    dropAuthor: !job.forward.showSource,
  })) as any;
  const sentIds = (result?.updates ?? [])
    .filter((update: any) => update instanceof Api.UpdateNewChannelMessage || update instanceof Api.UpdateNewMessage)
    .map((update: any) => Number(update.message?.id))
    .filter((messageId: number) => Number.isInteger(messageId) && messageId > 0);

  // A resolved request means Telegram accepted the forward. Some Telegram
  // responses omit the message object, so only the activity link is optional;
  // delivery itself must not be reported as failed.
  return { messageId: sentIds.length ? Math.min(...sentIds) : undefined };
}
try {
  await client.connect(); if (!await client.checkAuthorization()) throw new Error("Session worker sudah tidak aktif. Login ulang.");
  client.addEventHandler(async (event: any) => { try { const chat = await event.getChat(); const username = String(chat?.username ?? ""); const message = event.message; if (!username || (!message?.mentioned && !message?.replyTo?.replyToMsgId)) return; const replyId = message?.replyTo?.replyToMsgId; const replies: any = replyId ? await client.getMessages(await event.getInputChat(), { ids: replyId }) : []; const isReplyToWorker = Boolean(replies?.[0]?.out); if (!message?.mentioned && !isReplyToWorker) return; const owner = await fetch(`${baseUrl}/api/internal/worker-owner?workerId=${encodeURIComponent(workerId)}`, { headers }); const payload = await owner.json() as { buyerId?: string }; if (!owner.ok || !payload.buyerId) return; await alert(payload.buyerId, username, message?.mentioned ? "MENTION" : "REPLY", String(message?.message ?? ""), Number(message?.id ?? 0)); } catch {} }, new NewMessage({ incoming: true }));
  for (;;) { try { const response = await fetch(`${baseUrl}/api/internal/lpm-jobs?workerId=${encodeURIComponent(workerId)}`, { headers }); if (!response.ok) { await pause(5_000); continue; } const payload = await response.json() as { jobs?: Job[] };
    for (const job of payload.jobs ?? []) { try { const confirmation = await fetch(`${baseUrl}/api/internal/lpm-targets/${job.id}/confirm`, { method: "POST", headers, body: JSON.stringify({ workerId, action: job.action }) }); const allowed = await confirmation.json() as { execute?: boolean }; if (!confirmation.ok || !allowed.execute) continue; if (job.action === "JOIN") { await client.joinChannel("@" + job.username); await report(job.id, "READY"); } else { await client.leaveChannel("@" + job.username); await report(job.id, "REMOVED"); } } catch (error) { if (sessionFatal(error)) { sessionDead = true; break; } await report(job.id, job.action === "JOIN" ? joinStatus(error) : "REMOVED", String((error as Error).message ?? error).slice(0, 160)); } if (sessionDead) break; await pause(2500); }
    if (sessionDead) break;
    const broadcastResponse = await fetch(`${baseUrl}/api/internal/broadcast-jobs?workerId=${encodeURIComponent(workerId)}`, { headers }); if (!broadcastResponse.ok) { await pause(5_000); continue; } const broadcastPayload = await broadcastResponse.json() as { jobs?: BroadcastJob[] };
    for (const job of broadcastPayload.jobs ?? []) { try { const confirmation = await fetch(`${baseUrl}/api/internal/broadcast-jobs/${job.buyerId}/confirm`, { method: "POST", headers, body: JSON.stringify({ deliveryToken: job.deliveryToken, workerId, group: job.group }) }); const allowed = await confirmation.json() as { send?: boolean }; if (!confirmation.ok || !allowed.send) continue; if (job.mode === "FORWARD") { const result = await forwardSourcePost(job); await reportBroadcast(job, result); } else { const message = await client.sendMessage("@" + job.group, { message: job.wording }); if (!message) throw new Error("Pesan tidak bisa dikirim."); await reportBroadcast(job, { messageId: message.id }); } } catch (error) { if (sessionFatal(error)) { sessionDead = true; break; } await reportBroadcast(job, { error: String((error as Error).message ?? error).slice(0, 160) }); } if (sessionDead) break; await pause(2500); }
    } catch {} if (sessionDead) break; await pause(5_000);
  }
} finally { await client.disconnect(); }
