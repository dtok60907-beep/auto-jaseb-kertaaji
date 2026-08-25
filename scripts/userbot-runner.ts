// Userbot Promosi — satu proses meng-host SEMUA session akun buyer.
//
// Sebelumnya tiap akun = 1 proses Node terpisah (±100MB baseline per proses).
// Di kontainer Railway kecil, 5-6 akun langsung menembus batas memori (OOM kill
// berulang 2026-08-25). Dengan menyatukan koneksi ke satu proses, baseline Node
// hanya dibayar sekali dan total pemakaian turun dari ±800MB ke ±250MB.
//
// Roster (daftar buyerId yang harus hidup) ditulis server lewat
// data/userbot-roster.json dan dibaca ulang tiap tick — jadi tambah/hapus akun
// tidak butuh restart proses. Session Telegram tetap satu per akun (auth key
// Telegram memang tidak bisa digabung); yang digabung di sini hanya PROSES-nya.
import "dotenv/config";
import { createDecipheriv, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Api, TelegramClient } from "teleproto";
import { Logger } from "teleproto/extensions/Logger.js";
import { StringSession } from "teleproto/sessions/index.js";
import { NewMessage } from "teleproto/events/index.js";
import { readEncryptedSessions } from "../src/database.js";

// Logger GramJS default mencetak INFO ("Sleeping for 3s", dsb.) ke stdout dengan
// kode warna — menenggelamkan event JSON siklus hidup akun yang dibaca server.
// Karena itu semua client dipasok logger kustom: hanya WARN/ERROR yang diteruskan
// (via handler, bukan print langsung), INFO GramJS dibuang di sumbernya.
class QuietGramJsLogger extends Logger {
  constructor() { super("warn" as never); }
  canSend(level: string) { return level === "error" || level === "warn"; }
  log() { /* tidak pernah cetak langsung; lewat handler */ }
}
const quietLogger = new QuietGramJsLogger();

type Target = { base: string; discussion?: string; status: string; baseId?: string; discussionId?: string; baseInput?: any; discussionInput?: any };
type CommentJob = { id: string; deliveryToken: string; base: string; messageId: string; wording: string; link: string };
type CommentDeletion = { id: string; deleteToken: string; base: string; commentMessageId: string };
type LpmJob = { id: string; action: "JOIN" | "LEAVE"; username: string };
type UserBroadcastJob = { buyerId: string; deliveryToken: string; group: string; wording: string; mode: "TEXT" | "FORWARD"; forward?: { channel: string; messageId: number; showSource: boolean } };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rosterFile = join(root, "data/userbot-roster.json");
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH ?? "";
const sessionKey = process.env.WORKER_SESSION_KEY ?? "";
const adapterToken = process.env.LPM_ADAPTER_TOKEN ?? "";
const baseUrl = (process.env.LPM_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`).replace(/\/$/, "");
if (!Number.isInteger(apiId) || !apiHash || sessionKey.length < 24 || !adapterToken) throw new Error("Konfigurasi Auto Komen belum lengkap.");

const key = createHash("sha256").update(sessionKey).digest();
function decrypt(value: string) {
  const [iv, tag, content] = value.split(".");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(content, "base64url")), decipher.final()]).toString("utf8");
}
async function loadSession(buyerId: string) {
  const sessions = await readEncryptedSessions("comment", join(root, "data/comment-sessions.json"));
  const encrypted = sessions[buyerId];
  if (!encrypted) throw new Error("Session Auto Komen belum tersedia.");
  return decrypt(encrypted);
}
function readRoster(): string[] {
  try { const parsed = JSON.parse(readFileSync(rosterFile, "utf8")) as unknown; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; }
}
const headers = { "x-lpm-adapter-token": adapterToken, "content-type": "application/json" };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function normalizedChatId(value: unknown) { let raw = String(value ?? ""); if (raw.startsWith("-100")) raw = raw.slice(4); else if (raw.startsWith("-")) raw = raw.slice(1); return raw; }
function targetStatus(error: unknown): "PENDING_APPROVAL" | "UNAVAILABLE" { const message = String((error as Error).message ?? error); return message.includes("INVITE_REQUEST_SENT") ? "PENDING_APPROVAL" : "UNAVAILABLE"; }
function errorText(error: unknown) { return String((error as Error)?.message ?? error ?? ""); }
function sessionInvalid(error: unknown) { return /AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|SESSION_REVOKED|USER_DEACTIVATED|USER_DEACTIVATED_BAN/i.test(errorText(error)); }

// Semua state di bawah ini milik SATU akun — di-scope per pemanggilan
// runBuyerSession supaya banyak akun bisa hidup berdampingan dalam satu proses.
export async function runBuyerSession(buyerId: string, isStillWanted: () => boolean = () => true) {
  const client = new TelegramClient(new StringSession(await loadSession(buyerId)), apiId, apiHash, { connectionRetries: 5, baseLogger: quietLogger });
  let targets: Target[] = [];
  let userLpmTargets: string[] = [];
  let reconnectRequired = false;
  async function report(base: string, status: string, discussion?: string, note?: string) { await fetch(`${baseUrl}/api/internal/comment-target-status`, { method: "POST", headers, body: JSON.stringify({ buyerId, base, status, discussion, note }) }); }
  async function accountStatus(status: "CONNECTED" | "RECONNECT_REQUIRED", note?: string) { await fetch(`${baseUrl}/api/internal/userbot-account-status`, { method: "POST", headers, body: JSON.stringify({ buyerId, status, note }) }).catch(() => undefined); }
  async function joinTarget(entity: any) { try { await client.joinChannel(entity); } catch (error) { if (!String((error as Error).message ?? error).includes("USER_ALREADY_PARTICIPANT")) throw error; } }
  function commentTargetFailure(error: unknown): "MUTED" | "UNAVAILABLE" | undefined { const text = errorText(error); if (/CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|USER_RESTRICTED|CHAT_SEND_MEDIA_FORBIDDEN|CHAT_SEND_PLAIN_FORBIDDEN/i.test(text)) return "MUTED"; if (/CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED|PEER_ID_INVALID/i.test(text)) return "UNAVAILABLE"; return undefined; }
  function failureNote(status: "MUTED" | "UNAVAILABLE") { return status === "MUTED" ? "Akun lo tidak bisa mengirim komentar" : "Akun lo tidak bisa mengakses target"; }
  async function markCommentFailure(target: Target, error: unknown) { const status = commentTargetFailure(error); if (status) await report(target.base, status, target.discussion, failureNote(status)); }
  async function ensureTarget(target: Target) { const base = target.base.replace(/^@/, ""); try { await joinTarget("@" + base); const baseChat: any = await client.getEntity("@" + base); const baseInput = await client.getInputEntity("@" + base); const full: any = await client.invoke(new Api.channels.GetFullChannel({ channel: baseInput as any })); const linkedId = full?.fullChat?.linkedChatId; const discussionChat = linkedId ? (full?.chats ?? []).find((item: any) => String(item.id) === String(linkedId)) : undefined; if (discussionChat) await joinTarget(discussionChat); const discussion = String(discussionChat?.username ?? target.discussion ?? "").replace(/^@/, "") || undefined; const discussionInput = discussionChat ? await client.getInputEntity(discussionChat) : undefined; if (target.status !== "MUTED") await report(base, "READY", discussion); return { ...target, base, discussion, baseId: normalizedChatId(baseChat.id), discussionId: discussionChat ? normalizedChatId(discussionChat.id) : target.discussionId, baseInput, discussionInput }; } catch (error) { if (sessionInvalid(error)) throw error; await report(base, targetStatus(error), undefined, errorText(error).slice(0, 160)); return target; } }
  async function refreshTargets() { const response = await fetch(`${baseUrl}/api/internal/comment-monitor?buyerId=${encodeURIComponent(buyerId)}`, { headers }); if (!response.ok) return; const payload = await response.json() as { targets?: Target[] }; targets = []; for (const target of payload.targets ?? []) targets.push(await ensureTarget(target)); }
  async function alert(chat: string, type: "MENTION" | "REPLY" | "MUTED", text: string, messageId: number, workerId?: string) { await fetch(`${baseUrl}/api/internal/operational-alert`, { method: "POST", headers, body: JSON.stringify({ buyerId, workerId, chat, type, text, link: `https://t.me/${chat}/${messageId}` }) }); }
  async function processIncoming(target: Target, chat: string, message: any, inputChat: any) {
    const text = String(message?.message ?? "").trim(); if (!text || message?.out) return;
    const response = await fetch(`${baseUrl}/api/internal/incoming-message`, { method: "POST", headers, body: JSON.stringify({ buyerId, base: target.base, messageId: String(message.id), link: `https://t.me/${chat}/${message.id}`, text }) });
    if (!response.ok) return; const result = await response.json() as { action?: string; wording?: string };
    if (result.action !== "send_comment" || !result.wording) return;
    try {
      const sent = await client.sendMessage(inputChat, { message: result.wording, commentTo: Number(message.id) } as any);
      await fetch(`${baseUrl}/api/internal/auto-comment-delivered`, { method: "POST", headers, body: JSON.stringify({ buyerId, base: target.base, messageId: String(message.id), commentMessageId: String(sent.id), wording: result.wording, link: `https://t.me/${chat}/${message.id}`, text }) });
    }
    catch (error) { if (sessionInvalid(error)) throw error; await markCommentFailure(target, error); }
  }
  async function processCommentJobs() { const response = await fetch(`${baseUrl}/api/internal/comment-jobs?buyerId=${encodeURIComponent(buyerId)}`, { headers }); if (!response.ok) return; const payload = await response.json() as { jobs?: CommentJob[] }; for (const job of payload.jobs ?? []) { try { const confirmation = await fetch(`${baseUrl}/api/internal/comment-jobs/${job.id}/confirm`, { method: "POST", headers, body: JSON.stringify({ deliveryToken: job.deliveryToken }) }); const allowed = await confirmation.json() as { send?: boolean }; if (!confirmation.ok || !allowed.send) continue; const target = targets.find((item) => item.base.replace(/^@/, "").toLowerCase() === job.base.toLowerCase()); const input = target?.baseInput ?? await client.getInputEntity("@" + job.base); const sent = await client.sendMessage(input, { message: job.wording, commentTo: Number(job.messageId) } as any); await fetch(`${baseUrl}/api/internal/comment-jobs/${job.id}/result`, { method: "POST", headers, body: JSON.stringify({ deliveryToken: job.deliveryToken, commentMessageId: Number(sent.id) }) }); } catch (error) { if (sessionInvalid(error)) throw error; const target = targets.find((item) => item.base.replace(/^@/, "").toLowerCase() === job.base.toLowerCase()); if (target) await markCommentFailure(target, error); await fetch(`${baseUrl}/api/internal/comment-jobs/${job.id}/result`, { method: "POST", headers, body: JSON.stringify({ deliveryToken: job.deliveryToken, error: errorText(error).slice(0, 160) }) }); } } }
  async function processCommentDeletions() { const response = await fetch(`${baseUrl}/api/internal/comment-deletions?buyerId=${encodeURIComponent(buyerId)}`, { headers }); if (!response.ok) return; const payload = await response.json() as { jobs?: CommentDeletion[] }; for (const job of payload.jobs ?? []) { try { const target = targets.find((item) => item.base.replace(/^@/, "").toLowerCase() === job.base.toLowerCase()); const input = target?.baseInput ?? await client.getInputEntity("@" + job.base); await client.deleteMessages(input, [Number(job.commentMessageId)], { revoke: true }); await fetch(`${baseUrl}/api/internal/comment-jobs/${job.id}/delete-result`, { method: "POST", headers, body: JSON.stringify({ deleteToken: job.deleteToken }) }); } catch (error) { await fetch(`${baseUrl}/api/internal/comment-jobs/${job.id}/delete-result`, { method: "POST", headers, body: JSON.stringify({ deleteToken: job.deleteToken, error: String((error as Error).message ?? error).slice(0, 160) }) }); } } }
  async function reportLpm(id: string, status: "READY" | "PENDING_APPROVAL" | "UNAVAILABLE" | "REMOVED", note?: string) { await fetch(`${baseUrl}/api/internal/lpm-targets/${id}/result`, { method: "POST", headers, body: JSON.stringify({ workerId: buyerId, status, note }) }); }
  function lpmStatus(error: unknown): "PENDING_APPROVAL" | "UNAVAILABLE" { return String((error as Error).message ?? error).includes("INVITE_REQUEST_SENT") ? "PENDING_APPROVAL" : "UNAVAILABLE"; }
  async function processUserLpmTargets() { const response = await fetch(`${baseUrl}/api/internal/lpm-jobs?workerId=${encodeURIComponent(buyerId)}`, { headers }); if (!response.ok) return; const payload = await response.json() as { jobs?: LpmJob[] }; for (const job of payload.jobs ?? []) { try { const confirm = await fetch(`${baseUrl}/api/internal/lpm-targets/${job.id}/confirm`, { method: "POST", headers, body: JSON.stringify({ workerId: buyerId, action: job.action }) }); const allowed = await confirm.json() as { execute?: boolean }; if (!confirm.ok || !allowed.execute) continue; if (job.action === "JOIN") { await joinTarget("@" + job.username); await reportLpm(job.id, "READY"); } else { await client.leaveChannel("@" + job.username); await reportLpm(job.id, "REMOVED"); } } catch (error) { await reportLpm(job.id, job.action === "JOIN" ? lpmStatus(error) : "REMOVED", String((error as Error).message ?? error).slice(0, 160)); } await pause(2_500); } }
  async function forwardUserPost(job: UserBroadcastJob) { if (!job.forward) throw new Error("Sumber forward belum lengkap."); const source = "@" + job.forward.channel; const requested = await client.getMessages(source, { ids: job.forward.messageId }); const original: any = requested[0]; if (!original?.id) throw new Error("Post sumber tidak ditemukan atau tidak bisa diakses."); let ids = [Number(original.id)]; if (original.groupedId) { const near = await client.getMessages(source, { ids: Array.from({ length: 19 }, (_, index) => Number(original.id) - 9 + index).filter((value) => value > 0) }); ids = Array.from(new Set((near as any[]).filter((message) => message?.id && String(message.groupedId) === String(original.groupedId)).map((message) => Number(message.id)))).sort((left, right) => left - right); if (ids.length < 2) throw new Error("Album sumber tidak bisa dibaca lengkap."); } const result = await client.invoke(new Api.messages.ForwardMessages({ fromPeer: await client.getInputEntity(source), id: ids, toPeer: await client.getInputEntity("@" + job.group), dropAuthor: !job.forward.showSource })) as any; const sentIds = (result?.updates ?? []).filter((update: any) => update instanceof Api.UpdateNewChannelMessage || update instanceof Api.UpdateNewMessage).map((update: any) => Number(update.message?.id)).filter((value: number) => Number.isInteger(value) && value > 0); return { messageId: sentIds.length ? Math.min(...sentIds) : undefined }; }
  async function processUserBroadcastJobs() { const response = await fetch(`${baseUrl}/api/internal/userbot-broadcast-jobs?buyerId=${encodeURIComponent(buyerId)}`, { headers }); if (!response.ok) return; const payload = await response.json() as { jobs?: UserBroadcastJob[] }; for (const job of payload.jobs ?? []) { try { const confirm = await fetch(`${baseUrl}/api/internal/userbot-broadcast-jobs/${job.buyerId}/confirm`, { method: "POST", headers, body: JSON.stringify({ deliveryToken: job.deliveryToken, group: job.group }) }); const allowed = await confirm.json() as { send?: boolean }; if (!confirm.ok || !allowed.send) continue; if (job.mode === "FORWARD") { const result = await forwardUserPost(job); await fetch(`${baseUrl}/api/internal/userbot-broadcast-jobs/${job.buyerId}/result`, { method: "POST", headers, body: JSON.stringify({ deliveryToken: job.deliveryToken, group: job.group, ...result }) }); } else { const sent = await client.sendMessage("@" + job.group, { message: job.wording }); if (!sent) throw new Error("Pesan tidak bisa dikirim."); await fetch(`${baseUrl}/api/internal/userbot-broadcast-jobs/${job.buyerId}/result`, { method: "POST", headers, body: JSON.stringify({ deliveryToken: job.deliveryToken, group: job.group, messageId: sent.id }) }); } } catch (error) { await fetch(`${baseUrl}/api/internal/userbot-broadcast-jobs/${job.buyerId}/result`, { method: "POST", headers, body: JSON.stringify({ deliveryToken: job.deliveryToken, group: job.group, error: String((error as Error).message ?? error).slice(0, 160) }) }); } await pause(2_500); } }
  async function refreshUserLpmTargets() { const response = await fetch(`${baseUrl}/api/internal/userbot-lpm-monitor?buyerId=${encodeURIComponent(buyerId)}`, { headers }); if (!response.ok) { userLpmTargets = []; return; } const payload = await response.json() as { targets?: { username: string }[] }; userLpmTargets = (payload.targets ?? []).map((item) => item.username.toLowerCase()); }
  try {
    await client.connect(); if (!await client.checkAuthorization()) { await accountStatus("RECONNECT_REQUIRED", "Sesi akun sudah tidak aktif."); throw new Error("Session Auto Komen sudah tidak aktif."); }
    console.log(JSON.stringify({ event: "userbot-connected", buyerId }));
    await accountStatus("CONNECTED");
    client.addEventHandler(async (event: any) => { try { const message = event.message; const chat = await event.getChat(); const username = String(chat?.username ?? "").replace(/^@/, "").toLowerCase(); const chatId = normalizedChatId(event.chatId ?? chat?.id); const inputChat = await event.getInputChat(); const replyId = message?.replyTo?.replyToMsgId; const replies: any = replyId ? await client.getMessages(inputChat, { ids: replyId }) : []; const isReplyToBuyer = Boolean(replies?.[0]?.out); if (userLpmTargets.includes(username) && (message?.mentioned || isReplyToBuyer)) await alert(username, message.mentioned ? "MENTION" : "REPLY", String(message.message ?? ""), Number(message.id ?? 0), buyerId); const target = targets.find((item) => item.baseId === chatId || item.discussionId === chatId || item.base.replace(/^@/, "").toLowerCase() === username || item.discussion?.replace(/^@/, "").toLowerCase() === username); if (!target) return; const isBase = target.baseId === chatId || target.base.replace(/^@/, "").toLowerCase() === username; const source = username || (isBase ? target.base : target.discussion || target.base); if (isBase) await processIncoming(target, source, message, inputChat); if (!message?.mentioned && !isReplyToBuyer) return; await alert(source, message.mentioned ? "MENTION" : "REPLY", String(message.message ?? ""), Number(message.id ?? 0)); } catch (error) { if (sessionInvalid(error)) { reconnectRequired = true; await accountStatus("RECONNECT_REQUIRED", "Sesi akun sudah tidak aktif."); } } }, new NewMessage({ incoming: true }));
    let refreshAt = 0; let jobsAt = 0;
    for (;;) { if (!isStillWanted()) throw new Error("REMOVED_FROM_ROSTER"); try { if (reconnectRequired) throw new Error("SESSION_REVOKED"); if (Date.now() >= jobsAt) { await processUserLpmTargets(); await processUserBroadcastJobs(); await processCommentJobs(); await processCommentDeletions(); jobsAt = Date.now() + 3_000; } if (Date.now() >= refreshAt) { await refreshTargets(); await refreshUserLpmTargets(); refreshAt = Date.now() + 15_000; } } catch (error) { if (sessionInvalid(error)) { await accountStatus("RECONNECT_REQUIRED", "Sesi akun sudah tidak aktif."); throw error; } } await pause(500); }
  } finally { await client.disconnect(); console.log(JSON.stringify({ event: "userbot-disconnected", buyerId })); }
}

if (process.argv[1] && process.argv[1].endsWith("userbot-runner.ts")) {
  // Mode host: jaga roster tetap sesuai. Satu akun gagal TIDAK boleh menjatuhkan
  // akun lain di proses yang sama — masing-masing punya backoff sendiri.
  const live = new Map<string, Promise<void>>();
  const retryAt = new Map<string, number>();
  const CONNECT_GAP_MS = 4_000;
  let wanted = new Set<string>();
  for (;;) {
    const roster = readRoster();
    wanted = new Set(roster);
    for (const buyerId of roster) {
      if (live.has(buyerId)) continue;
      if ((retryAt.get(buyerId) ?? 0) > Date.now()) continue;
      const task = (async () => {
        try { await runBuyerSession(buyerId, () => wanted.has(buyerId)); retryAt.set(buyerId, Date.now() + 15_000); }
        catch (error) { console.error(JSON.stringify({ event: "userbot-exited", buyerId, error: String((error as Error)?.message ?? error).slice(0, 200) })); retryAt.set(buyerId, Date.now() + 30_000); }
      })();
      live.set(buyerId, task);
      task.finally(() => live.delete(buyerId));
      await pause(CONNECT_GAP_MS);
    }
    await pause(5_000);
  }
}
