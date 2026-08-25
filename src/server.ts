import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { createCipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { Bot, InlineKeyboard } from "grammy";
import { Api, TelegramClient, password as telegramPassword } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { loadPersistentStore, readEncryptedSessions, removeEncryptedSession, saveEncryptedSession, savePersistentStore } from "./database.js";
import { buyerWithEffectiveAccess, clearManualPlanAccess, extendedEndsAt, hasPlanAccess, productPlans, reconcileManualPlanFlags, retainUserbotSession, shouldCancelCommentWork, shouldNotifyExpiry, type Plan } from "./access.js";

type Product = "ADMIN_BROADCAST" | "USERBOT_PROMO" | "LEGACY_BUNDLE";
type Executor = "ADMIN" | "BUYER";
type UserbotAccountStatus = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECT_REQUIRED";
type Buyer = { id: string; name: string; telegramId: string; broadcastActive: boolean; userBroadcastActive?: boolean; commentActive: boolean; commentAccountConnected: boolean; userbotAccountStatus?: UserbotAccountStatus; userbotAccountIssue?: string; userbotLastSeenAt?: string; planBroadcast: boolean; planUserBroadcast?: boolean; planComment: boolean; legacyBundle?: boolean; workerId: string | null; updatedAt: string; broadcastEditingBy?: CommentActor; broadcastEditingUntil?: string; userBroadcastEditingBy?: CommentActor; userBroadcastEditingUntil?: string };
type Worker = { id: string; label: string; username: string; status: "AVAILABLE" | "ASSIGNED" | "COOLDOWN" | "DISABLED"; buyerId: string | null; cooldownUntil?: string; createdAt: string };
type ForwardSource = { channel: string; messageId: number; showSource: boolean };
type Broadcast = { buyerId: string; executor?: Executor; wording: string; mode: "TEXT" | "FORWARD"; forward?: ForwardSource; groups: string[]; intervalMinutes: number; updatedBy: "ADMIN" | "BUYER"; updatedAt: string; nextSendAt?: string; lastSentAt?: string; lastGroup?: string; groupCursor?: number; deliveryToken?: string; deliveryUntil?: string };
type LpmTargetStatus = "CONNECTING" | "PENDING_APPROVAL" | "READY" | "UNAVAILABLE" | "REMOVING" | "REMOVED";
type LpmTarget = { id: string; buyerId: string; workerId: string; executor?: Executor; username: string; status: LpmTargetStatus; desired: boolean; note?: string; createdAt: string; updatedAt: string };
type CommentDivision = { id: string; name: string; keywords: string[]; blacklist: string[]; wording: string };
type CommentActor = "ADMIN" | "BUYER";
type CommentConfig = { buyerId: string; bases: string[]; divisions: CommentDivision[]; mode: "APPROVAL" | "AUTO"; updatedAt: string; updatedBy: CommentActor; editingBy?: CommentActor; editingUntil?: string };
type CommentTargetStatus = "CHECKING" | "READY" | "PENDING_APPROVAL" | "UNAVAILABLE" | "MUTED";
type CommentTarget = { id: string; buyerId: string; base: string; discussion?: string; status: CommentTargetStatus; note?: string; updatedAt: string };
type Activity = { buyerId: string; kind: "BROADCAST" | "COMMENT"; status: string; label: string; link?: string; at: string };
type Candidate = { id: string; buyerId: string; base: string; messageId: string; link: string; wording: string; preview: string; createdAt: string };
type CommentJob = { id: string; buyerId: string; base: string; messageId: string; wording: string; link: string; preview: string; commentMessageId?: string; status: "PENDING" | "SENDING" | "DONE" | "FAILED" | "CANCELED" | "DELETE_PENDING" | "DELETING" | "DELETED" | "DELETE_FAILED"; deliveryToken?: string; deliveryUntil?: string; deleteToken?: string; deleteUntil?: string; createdAt: string };
type PackageService = Product;
// BUNDLE hanya untuk membaca riwayat sebelum pemisahan produk; tidak bisa dibuat lagi.
type PaymentPlan = Product | "BUNDLE";
type Package = { id: string; service: PackageService; name: string; price: number; durationDays: number; maxGroups: number; enabled: boolean; updatedAt: string };
type Payment = { id: string; telegramId: string; packageId: string; plan: PaymentPlan; amount: number; durationDays: number; maxGroups: number; status: "PENDING" | "PAID" | "FAILED" | "EXPIRED"; gatewayReference?: string; paymentUrl?: string; withdrawalId?: string; createdAt: string; paidAt?: string };
type Subscription = { id: string; buyerId: string; packageId?: string; plan: Plan; product: Product; source: "MANUAL" | "PAYMENT"; maxGroups: number; status: "ACTIVE" | "EXPIRED" | "REVOKED"; startsAt: string; endsAt: string; revokedAt?: string; expiryNotifiedAt?: string };
type WalletType = "DANA" | "GoPay" | "OVO" | "ShopeePay" | "LinkAja";
type PayoutProfile = { telegramId: string; walletType: WalletType; walletNumber: string; walletOwner: string; updatedAt: string };
type Withdrawal = { id: string; telegramId: string; grossAmount: number; fee: number; netAmount: number; walletType: WalletType; walletNumber: string; walletOwner: string; status: "REQUESTED" | "PAID"; createdAt: string; paidAt?: string };
type Store = { buyers: Buyer[]; workers: Worker[]; broadcasts: Broadcast[]; lpmTargets: LpmTarget[]; commentConfigs: CommentConfig[]; commentTargets: CommentTarget[]; activities: Activity[]; approvalCandidates: Candidate[]; commentJobs: CommentJob[]; dedupe: { buyerId: string; base: string; messageId: string; at: string }[]; payments: Payment[]; withdrawals: Withdrawal[]; payoutProfiles: PayoutProfile[]; subscriptions: Subscription[]; packages: Package[] };
type CommerceOrder = { id: string; orderId: string; buyer: string; plan: PaymentPlan; durationDays: number; maxGroups: number; amount: number; status: Payment["status"]; createdAt: string; paidAt?: string };
type CommerceWithdrawal = Pick<Withdrawal, "id" | "grossAmount" | "fee" | "netAmount" | "walletType" | "walletNumber" | "walletOwner" | "status" | "createdAt" | "paidAt">;
type Commerce = { today: number; week: number; month: number; paidCount: number; pendingBalance: number; availableBalance: number; requestedBalance: number; canRequestWithdrawal: boolean; orders: CommerceOrder[]; withdrawals: CommerceWithdrawal[] };

const root = dirname(fileURLToPath(import.meta.url));
const dataFile = join(root, "../data/store.json");
const sessionsFile = join(root, "../data/worker-sessions.json");
const commentSessionsFile = join(root, "../data/comment-sessions.json");
const app = Fastify({ logger: true });
// GramJS kadang melempar "TIMEOUT" dari update-loop internal (getDifference) —
// itu benign dan auto-retry. Tanpa tameng ini log produksi penuh noise
// unhandledRejection padahal sistem sehat.
process.on("unhandledRejection", (reason) => {
  const message = String((reason as { message?: string })?.message ?? reason);
  if (/TIMEOUT|FLOOD_WAIT_/i.test(message)) return;
  app.log.warn({ err: message.slice(0, 220) }, "Unhandled rejection ditangkap");
});
if (process.env.NODE_ENV === "production") await app.register(fastifyStatic, { root: join(root, "../dist") });
let storeLockTail: Promise<void> = Promise.resolve();
const requestUnlocks = new WeakMap<object, () => void>();
async function withStoreLock<T>(work: () => Promise<T>) {
  let unlock: () => void = () => undefined;
  const previous = storeLockTail;
  storeLockTail = new Promise<void>((resolve) => { unlock = resolve; });
  await previous;
  try { return await work(); } finally { unlock(); }
}
async function lockRequest(req: object) {
  let unlock: () => void = () => undefined;
  const previous = storeLockTail;
  storeLockTail = new Promise<void>((resolve) => { unlock = resolve; });
  await previous;
  requestUnlocks.set(req, unlock);
}
function unlockRequest(req: object) { const unlock = requestUnlocks.get(req); if (unlock) { requestUnlocks.delete(req); unlock(); } }
app.addHook("onRequest", async (req) => {
  // Static files must never wait behind a database write. API calls remain
  // serialized because this app currently saves one shared state document.
  if (!req.url.startsWith("/api/")) return;
  req.raw.once("aborted", () => unlockRequest(req));
  await lockRequest(req);
  if (req.raw.aborted) unlockRequest(req);
});
app.addHook("onResponse", async (req) => { unlockRequest(req); });
app.addHook("onError", async (req) => { unlockRequest(req); });
let bot: Bot | undefined;
let botPollingStatus = "disabled";
let botUsername = String(process.env.BOT_USERNAME ?? "").replace(/^@/, "").trim();
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
type PendingWorkerLogin = { workerId: string; phone: string; phoneCodeHash: string; client: TelegramClient; expiresAt: number };
type PendingCommentLogin = { buyerId: string; phone: string; phoneCodeHash: string; client: TelegramClient; expiresAt: number };
const pendingWorkerLogins = new Map<string, PendingWorkerLogin>();
const pendingCommentLogins = new Map<string, PendingCommentLogin>();
const workerRunners = new Map<string, ChildProcess>();
let userbotRunner: ChildProcess | undefined;
const userbotRosterFile = join(root, "../data/userbot-roster.json");
let userbotRosterText = "";
let userbotRosterSize = 0;
let runnerReconcileTimer: ReturnType<typeof setTimeout> | undefined;
let shuttingDown = false;
let runnerReconcileInFlight: Promise<void> | undefined;
let runnerReconcileRequested = false;
// Backoff ala engine NEXO: runner yang baru saja mati tidak boleh dinyalakan
// lagi beberapa detik kemudian — selain sia-sia (bakar CPU), koneksi ulang yang
// keburu-buru bisa memicu AUTH_KEY_DUPLICATED berantai. Kunci = "userbot-host"
// atau "worker:<id>", nilai = waktu paling cepat boleh nyala lagi.
const runnerRestartNotBefore = new Map<string, number>();
const RUNNER_CRASH_COOLDOWN_MS = 90_000;
const RUNNER_DUPLICATED_COOLDOWN_MS = 5 * 60_000;

function workerSessionKey() { const secret = process.env.WORKER_SESSION_KEY ?? ""; if (secret.length < 24) throw new Error("Konfigurasi session worker belum siap."); return createHash("sha256").update(secret).digest(); }
function encryptWorkerSession(value: string) { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", workerSessionKey(), iv); const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join("."); }
async function readWorkerSessions() { return readEncryptedSessions("worker", sessionsFile); }
async function saveWorkerSession(workerId: string, session: string) { await saveEncryptedSession("worker", sessionsFile, workerId, encryptWorkerSession(session)); }
async function removeWorkerSession(workerId: string) { await removeEncryptedSession("worker", sessionsFile, workerId); }
async function readCommentSessions() { return readEncryptedSessions("comment", commentSessionsFile); }
async function saveCommentSession(buyerId: string, session: string) { await saveEncryptedSession("comment", commentSessionsFile, buyerId, encryptWorkerSession(session)); }
async function removeCommentSession(buyerId: string) { await removeEncryptedSession("comment", commentSessionsFile, buyerId); }
function telegramCredentials() { const apiId = Number(process.env.TELEGRAM_API_ID); const apiHash = process.env.TELEGRAM_API_HASH ?? ""; if (!Number.isInteger(apiId) || !apiHash) throw new Error("API Telegram belum siap."); return { apiId, apiHash }; }
function telegramReason(error: unknown) { return String((error as { errorMessage?: string; message?: string })?.errorMessage ?? (error as Error)?.message ?? "Tidak bisa menghubungkan akun.").replace(/_/g, " "); }
function scheduleRunnerReconcile(delay = 5_000) { if (shuttingDown || runnerReconcileTimer) return; runnerReconcileTimer = setTimeout(() => { runnerReconcileTimer = undefined; void reconcileRunnersSafely(); }, delay); runnerReconcileTimer.unref(); }
// Runner di-spawn detached agar tidak ikut mati saat npm/tsx restart, tapi itu
// menyisakan proses yatim kalau server mati keras (OOM kill). Pidfile dipakai
// untuk membunuh sisa runner lama SEBELUM set baru dispawn — tanpa ini, tiap
// restart menumpuk proses GramJS dan memori kontainer makin cepat habis.
const runnerPidFile = join(root, "../data/comment-runner.pids");
const bootHostname = hostname();
type RunnerPidEntry = { pid: number; host: string; workerId?: string; userbotHost?: true };
function writeRunnerPids(entries: RunnerPidEntry[]) {
  try { writeFileSync(runnerPidFile, JSON.stringify(entries)); } catch (error) { app.log.warn({ err: error }, "Gagal menulis pidfile runner."); }
}
function collectRunnerPids(): RunnerPidEntry[] {
  const entries: RunnerPidEntry[] = [];
  if (userbotRunner?.exitCode === null && userbotRunner.pid) entries.push({ pid: userbotRunner.pid, host: bootHostname, userbotHost: true });
  for (const [workerId, runner] of workerRunners) if (runner.exitCode === null && runner.pid) entries.push({ pid: runner.pid!, host: bootHostname, workerId });
  return entries;
}
function killStaleRunner(pid: number) {
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}
function reapOrphanedRunners() {
  let stale: RunnerPidEntry[] = [];
  try { stale = JSON.parse(readFileSync(runnerPidFile, "utf8")) as RunnerPidEntry[]; } catch { return; }
  const alive = new Set(collectRunnerPids().map((entry) => entry.pid));
  let orphans = 0;
  for (const entry of stale) {
    // Pid dari kontainer/deploy lain tidak bisa dipercaya di namespace PID baru —
    // cukup buang catatannya, jangan pernah kirim sinyal ke pid yang bukan milik kita.
    if (!Number.isInteger(entry.pid) || entry.pid <= 1 || entry.host !== bootHostname || alive.has(entry.pid)) continue;
    killStaleRunner(entry.pid);
    app.log.warn({ pid: entry.pid, workerId: entry.workerId ?? null, userbotHost: Boolean(entry.userbotHost) }, "Runner yatim dari boot sebelumnya dimatikan.");
    orphans += 1;
  }
  if (orphans > 0) app.log.warn({ total: orphans }, "Pembersihan runner yatim selesai.");
}
function appendRunnerPid(entry: RunnerPidEntry) {
  let entries: RunnerPidEntry[] = [];
  try { entries = JSON.parse(readFileSync(runnerPidFile, "utf8")) as RunnerPidEntry[]; } catch {}
  writeRunnerPids([...entries.filter((item) => item.pid !== entry.pid && item.pid > 1), entry]);
}
function removeRunnerPid(pid: number | undefined) {
  if (!pid) return;
  try { const entries = JSON.parse(readFileSync(runnerPidFile, "utf8")) as RunnerPidEntry[]; writeRunnerPids(entries.filter((item) => item.pid !== pid)); } catch {}
}
// Spawn pelan-pelan satu-per-satu: lima koneksi GramJS serentak di awal bikin
// pemakaian memori melonjak sekaligus dan memicu OOM di kontainer kecil.
function scheduleStaggeredStarts(starts: (() => void)[], gapMs = 4_000) { starts.forEach((start, index) => { const timer = setTimeout(() => { if (!shuttingDown) start(); }, index * gapMs); timer.unref(); }); }
function terminateRunner(runner: ChildProcess | undefined) { if (!runner || runner.exitCode !== null) return; try { if (runner.pid) process.kill(-runner.pid, "SIGTERM"); else runner.kill(); } catch { runner.kill(); } }
function startWorkerRunner(workerId: string) { if (shuttingDown || workerRunners.get(workerId)?.exitCode === null) return; if (Date.now() < (runnerRestartNotBefore.get("worker:" + workerId) ?? 0)) return; const runner = spawn(process.execPath, [join(root, "../node_modules/tsx/dist/cli.mjs"), join(root, "../scripts/lpm-runner.ts"), workerId], { cwd: join(root, ".."), env: process.env, stdio: "ignore", detached: true }); workerRunners.set(workerId, runner); appendRunnerPid({ pid: runner.pid!, host: bootHostname, workerId }); runner.on("exit", () => { removeRunnerPid(runner.pid); workerRunners.delete(workerId); scheduleRunnerReconcile(); }); runner.unref(); }
function stopWorkerRunner(workerId: string) { terminateRunner(workerRunners.get(workerId)); workerRunners.delete(workerId); }
function writeUserbotRoster(buyerIds: string[]) {
  const text = JSON.stringify(buyerIds.sort());
  userbotRosterSize = buyerIds.length;
  if (text === userbotRosterText) return;
  writeFileSync(userbotRosterFile, text);
  userbotRosterText = text;
}
function startUserbotRunner() {
  if (shuttingDown || userbotRosterSize === 0 || userbotRunner?.exitCode === null) return;
  if (Date.now() < (runnerRestartNotBefore.get("userbot-host") ?? 0)) return;
  // Host userbot adalah bagian dari lifecycle server ini. Berbeda dengan runner
  // legacy per-akun, ia sengaja TIDAK detached: saat Railway menghentikan server,
  // shutdown di bawah mengirim SIGTERM ke host ini juga. Dengan begitu tidak ada
  // koneksi Telegram yatim yang masih memakai session setelah deploy berikutnya.
  const runner = spawn(process.execPath, [join(root, "../node_modules/tsx/dist/cli.mjs"), join(root, "../scripts/userbot-runner.ts")], { cwd: join(root, ".."), env: process.env, stdio: ["ignore", "ignore", "pipe"], detached: false });
  let stderr = "";
  runner.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1_200); });
  userbotRunner = runner;
  runner.on("error", (error) => app.log.error({ err: error }, "Could not start consolidated userbot runner"));
  runner.on("exit", (code, signal) => {
    if (userbotRunner === runner) userbotRunner = undefined;
    const failed = Boolean(code && code !== 0);
    if (!shuttingDown && failed) {
      const duplicated = /AUTH_KEY_DUPLICATED/i.test(stderr);
      const cooldown = duplicated ? RUNNER_DUPLICATED_COOLDOWN_MS : RUNNER_CRASH_COOLDOWN_MS;
      runnerRestartNotBefore.set("userbot-host", Date.now() + cooldown);
      scheduleRunnerReconcile(cooldown + 5_000);
      app.log.warn({ code, signal, backoffMs: cooldown, stderr: stderr.trim().slice(-400) }, "Runner userbot gabungan berhenti; dinyalakan ulang setelah backoff");
    } else if (!shuttingDown) {
      app.log.info({ code, signal }, "Runner userbot gabungan berhenti dengan normal; rekonsiliasi akan memutuskan");
    }
    scheduleRunnerReconcile();
  });
  runner.unref();
}
function stopUserbotRunner() { terminateRunner(userbotRunner); userbotRunner = undefined; }

const defaultPackages = (): Package[] => [];
const selfServiceSubscriptionsEnabled = process.env.SELF_SERVICE_SUBSCRIPTIONS === "true";
async function load(): Promise<Store> {
  const store = await loadPersistentStore<Partial<Store>>(dataFile, {});
  const ready = { ...store, buyers: store.buyers ?? [], workers: store.workers ?? [], broadcasts: store.broadcasts ?? [], commentConfigs: store.commentConfigs ?? [], activities: store.activities ?? [], approvalCandidates: store.approvalCandidates ?? [], dedupe: store.dedupe ?? [], payments: store.payments ?? [], withdrawals: store.withdrawals ?? [], payoutProfiles: store.payoutProfiles ?? [], subscriptions: store.subscriptions ?? [], packages: store.packages ?? defaultPackages(), lpmTargets: store.lpmTargets ?? [], commentTargets: store.commentTargets ?? [], commentJobs: store.commentJobs ?? [] } as Store;

  // Paket lama BUNDLE sengaja tidak dijual lagi. Aksesnya tetap dipertahankan sebagai
  // legacy sampai habis, jadi tidak ada buyer lama yang berganti executor diam-diam.
  ready.packages = ready.packages.map((item: any) => ({
    id: item.id ?? id("package"),
    service: item.service === "ADMIN_BROADCAST" || item.service === "USERBOT_PROMO" ? item.service : "LEGACY_BUNDLE" as PackageService,
    name: item.name || "Paket Promosi", price: item.price, durationDays: item.durationDays,
    maxGroups: Math.max(1, Math.floor(Number(item.maxGroups) || 15)),
    enabled: (item.service === "ADMIN_BROADCAST" || item.service === "USERBOT_PROMO") ? Boolean(item.enabled) : false,
    updatedAt: item.updatedAt ?? now(),
  }));
  const oldPlansByBuyer = new Map<string, Set<Plan>>();
  for (const item of ready.subscriptions as any[]) {
    const plans = oldPlansByBuyer.get(String(item.buyerId)) ?? new Set<Plan>();
    if (item.plan === "BROADCAST" || item.plan === "USERBOT_BROADCAST" || item.plan === "COMMENT") plans.add(item.plan);
    oldPlansByBuyer.set(String(item.buyerId), plans);
  }
  ready.subscriptions = (ready.subscriptions as any[]).map((item: any) => {
    const plans = oldPlansByBuyer.get(String(item.buyerId)) ?? new Set<Plan>();
    const inferredProduct: Product = item.product === "ADMIN_BROADCAST" || item.product === "USERBOT_PROMO" || item.product === "LEGACY_BUNDLE"
      ? item.product
      : plans.has("BROADCAST") && plans.has("COMMENT") ? "LEGACY_BUNDLE"
        : item.plan === "BROADCAST" ? "ADMIN_BROADCAST" : "USERBOT_PROMO";
    return { ...item, packageId: item.packageId || undefined, plan: item.plan as Plan, product: inferredProduct, source: item.source === "MANUAL" ? "MANUAL" : "PAYMENT", maxGroups: Math.max(1, Math.floor(Number(item.maxGroups) || 15)), status: item.status === "REVOKED" ? "REVOKED" : item.status === "EXPIRED" ? "EXPIRED" : "ACTIVE", startsAt: item.startsAt ?? now(), endsAt: item.endsAt ?? now() } as Subscription;
  });
  ready.broadcasts = (ready.broadcasts ?? []).map((item: any) => ({ ...item, executor: item.executor === "BUYER" ? "BUYER" : "ADMIN", mode: item.mode === "FORWARD" && item.forward ? "FORWARD" : "TEXT", forward: item.mode === "FORWARD" && item.forward ? { channel: String(item.forward.channel ?? ""), messageId: Number(item.forward.messageId), showSource: Boolean(item.forward.showSource) } : undefined, wording: String(item.wording ?? ""), intervalMinutes: broadcastInterval(item.intervalMinutes) }));
  ready.lpmTargets = ready.lpmTargets.map((item: any) => ({ ...item, executor: item.executor === "BUYER" ? "BUYER" : "ADMIN" }));
  ready.commentConfigs = (ready.commentConfigs ?? []).map((item: any) => ({ buyerId: item.buyerId, bases: item.bases ?? [], divisions: item.divisions ?? [{ id: id("division"), name: item.division ?? "Produk", keywords: item.keywords ?? [], blacklist: item.blacklist ?? [], wording: item.wording ?? "" }], mode: item.mode === "AUTO" ? "AUTO" : "APPROVAL", updatedAt: item.updatedAt ?? now(), updatedBy: item.updatedBy === "BUYER" ? "BUYER" : "ADMIN", ...(item.editingBy && item.editingUntil && Date.parse(item.editingUntil) > Date.now() ? { editingBy: item.editingBy === "BUYER" ? "BUYER" : "ADMIN", editingUntil: item.editingUntil } : {}) }));
  ready.approvalCandidates = (ready.approvalCandidates ?? []).map((item: any) => ({ ...item, wording: String(item.wording ?? ready.commentConfigs.find((config) => config.buyerId === item.buyerId)?.divisions[0]?.wording ?? ""), preview: String(item.preview ?? "") }));
  ready.commentJobs = ready.commentJobs.map((item: any) => ({ ...item, preview: String(item.preview ?? "") }));
  for (const buyer of ready.buyers) {
    buyer.planUserBroadcast ??= false; buyer.userBroadcastActive ??= false;
    buyer.userbotAccountStatus ??= buyer.commentAccountConnected ? "CONNECTED" : "DISCONNECTED";
    const oldPlans = ready.subscriptions.filter((item) => item.buyerId === buyer.id && !item.product);
    if (oldPlans.some((item) => item.plan === "BROADCAST") && oldPlans.some((item) => item.plan === "COMMENT")) buyer.legacyBundle = true;
  }
  for (const worker of ready.workers) if (worker.status === "COOLDOWN") { worker.status = "AVAILABLE"; worker.buyerId = null; delete worker.cooldownUntil; }
  for (const broadcast of ready.broadcasts.filter((item) => broadcastExecutor(item) === "ADMIN")) {
    const buyer = ready.buyers.find((item) => item.id === broadcast.buyerId);
    if (!buyer?.workerId || ready.lpmTargets.some((item) => item.buyerId === broadcast.buyerId && targetExecutor(item) === "ADMIN")) continue;
    for (const username of broadcast.groups) ready.lpmTargets.push({ id: id("lpm"), buyerId: broadcast.buyerId, workerId: buyer.workerId, executor: "ADMIN", username, status: "READY", desired: true, createdAt: now(), updatedAt: now() });
  }
  return ready;
}
const incomingLeadLocks = new Set<string>();
async function save(store: Store) {
  return savePersistentStore(dataFile, store);
}
function telegramUser(req: any): { id: string; name: string } | null {
  const initData = String(req.headers["x-telegram-init-data"] ?? "");
  if (!initData) return process.env.ALLOW_DEMO === "true" ? { id: String(req.headers["x-buyer-id"] ?? "buyer-demo"), name: "Buyer Demo" } : null;
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) return null;
  const data = new URLSearchParams(initData); const receivedHash = data.get("hash");
  if (!receivedHash) return null;
  const authDate = Number(data.get("auth_date") ?? 0);
  if (!Number.isFinite(authDate) || authDate < 1 || Date.now() / 1000 - authDate > 86_400) return null;
  data.delete("hash");
  const checkString = [...data.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + "=" + value).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secret).update(checkString).digest("hex");
  const received = Buffer.from(receivedHash, "hex"); const expected = Buffer.from(expectedHash, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const raw = JSON.parse(data.get("user") ?? "{}"); const userId = String(raw.id || "");
    if (!userId) return null;
    const name = raw.username ? "@" + String(raw.username) : [raw.first_name, raw.last_name].filter(Boolean).join(" ") || "Buyer " + userId;
    return { id: userId, name };
  } catch { return null; }
}
function telegramUserId(req: any) { return telegramUser(req)?.id ?? null; }
function buyerId(req: any) { return telegramUserId(req); }
function adminIds() { return new Set((process.env.ADMIN_TELEGRAM_IDS ?? process.env.ADMIN_TELEGRAM_ID ?? "").split(",").map((item) => item.trim()).filter(Boolean)); }
function isAdmin(req: any) { const telegramId = telegramUserId(req); return Boolean(telegramId && adminIds().has(telegramId)); }
async function adminOnly(req: any, reply: any) { if (!isAdmin(req)) return reply.code(403).send({ error: "admin_only", reason: "Halaman ini khusus pengelola layanan." }); }
function buyerForRequest(store: Store, req: any) {
  const requester = buyerId(req);
  return store.buyers.find((item) => item.telegramId === requester)
    ?? (process.env.ALLOW_DEMO === "true" ? store.buyers.find((item) => item.id === "buyer-demo") : undefined);
}
function cleanGroups(value: unknown, maxGroups = Number.POSITIVE_INFINITY): string[] {
  const raw = Array.isArray(value) ? value : [];
  const groups = raw.map((item) => String(item).trim().replace(/^@/, "")).filter((item) => /^[A-Za-z][A-Za-z0-9_]{3,}$/.test(item));
  if (!groups.length || new Set(groups.map((item) => item.toLowerCase())).size !== groups.length) throw new Error("Masukkan grup publik unik ber-username.");
  if (groups.length > maxGroups) throw new Error(`Paket buyer ini mendukung hingga ${maxGroups} grup LPM.`);
  return groups;
}
function targetExecutor(target: LpmTarget): Executor { return target.executor === "BUYER" ? "BUYER" : "ADMIN"; }
function broadcastExecutor(broadcast: Broadcast): Executor { return broadcast.executor === "BUYER" ? "BUYER" : "ADMIN"; }
function broadcastFor(store: Store, buyerId: string, executor: Executor) { return store.broadcasts.find((item) => item.buyerId === buyerId && broadcastExecutor(item) === executor); }
function syncLpmTargets(store: Store, buyer: Buyer, executorId: string, executor: Executor, groups: string[]) {
  const wanted = new Set(groups.map((item) => item.toLowerCase()));
  const current = store.lpmTargets.filter((item) => item.buyerId === buyer.id && targetExecutor(item) === executor && item.desired);
  for (const target of current) if (!wanted.has(target.username.toLowerCase())) { target.desired = false; target.status = "REMOVING"; target.note = undefined; target.updatedAt = now(); }
  for (const username of groups) {
    const existing = store.lpmTargets.find((item) => item.buyerId === buyer.id && targetExecutor(item) === executor && item.username.toLowerCase() === username.toLowerCase());
    if (existing) {
      const workerChanged = existing.workerId !== executorId;
      existing.desired = true; existing.workerId = executorId; existing.executor = executor;
      if (workerChanged || existing.status === "REMOVING" || existing.status === "REMOVED" || existing.status === "READY" || existing.status === "UNAVAILABLE") { existing.status = "CONNECTING"; existing.note = undefined; }
      existing.updatedAt = now();
      continue;
    }
    store.lpmTargets.push({ id: id("lpm"), buyerId: buyer.id, workerId: executorId, executor, username, status: "CONNECTING", desired: true, createdAt: now(), updatedAt: now() });
  }
}
function publicLpmTargets(store: Store, buyerId: string, executor?: Executor) { return store.lpmTargets.filter((item) => item.buyerId === buyerId && (!executor || targetExecutor(item) === executor) && (item.desired || item.status === "REMOVING") && item.status !== "REMOVED").sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
function notifyLpmStatus(store: Store, target: LpmTarget) {
  const buyer = store.buyers.find((item) => item.id === target.buyerId); if (!buyer?.telegramId || !bot) return;
  const text = ({ PENDING_APPROVAL: `@${target.username} menunggu persetujuan.`, READY: `@${target.username} siap dipakai.`, UNAVAILABLE: `@${target.username} tidak bisa dipakai.`, REMOVED: `@${target.username} dihapus.` } as Partial<Record<LpmTargetStatus, string>>)[target.status];
  if (text) void bot.api.sendMessage(buyer.telegramId, text).catch(() => undefined);
}
function syncCommentTargets(store: Store, buyerId: string, bases: string[]) {
  const wanted = new Set(bases.map((item) => item.replace(/^@/, "").toLowerCase()));
  store.commentTargets = store.commentTargets.filter((item) => item.buyerId !== buyerId || wanted.has(item.base.toLowerCase()));
  for (const base of wanted) {
    const current = store.commentTargets.find((item) => item.buyerId === buyerId && item.base.toLowerCase() === base);
    if (!current) store.commentTargets.push({ id: id("base"), buyerId, base, status: "CHECKING", updatedAt: now() });
    else if (current.status === "MUTED" || current.status === "UNAVAILABLE") { current.status = "CHECKING"; delete current.note; current.updatedAt = now(); }
  }
}
function sendBuyerAlert(store: Store, buyerId: string, title: string, detail: string, link?: string) { const buyer = store.buyers.find((item) => item.id === buyerId); if (!buyer?.telegramId || !bot) return; const text = [title, detail, link ? `Buka pesan: ${link}` : ""].filter(Boolean).join("\n"); void bot.api.sendMessage(buyer.telegramId, text).catch(() => undefined); }
function previewText(value: string) { return value.replace(/\s+/g, " ").trim().slice(0, 900) || "(Post tanpa teks)"; }
function sendApprovalAlert(store: Store, candidate: Candidate) { const buyer = store.buyers.find((item) => item.id === candidate.buyerId); if (!buyer?.telegramId || !bot) return; const text = [`Lead baru · @${candidate.base}`, "", "Post yang cocok:", candidate.preview, "", "Komentar yang akan dikirim:", candidate.wording, candidate.link ? `Link post MF: ${candidate.link}` : ""].filter(Boolean).join("\n"); const keyboard = new InlineKeyboard().text("✅ Tepat", `cm:g:${candidate.id}`).text("🚫 OOT", `cm:b:${candidate.id}`); void bot.api.sendMessage(buyer.telegramId, text, { reply_markup: keyboard, link_preview_options: { is_disabled: true } }).catch(() => undefined); }
function sendAutoCommentAlert(store: Store, job: CommentJob) { const buyer = store.buyers.find((item) => item.id === job.buyerId); if (!buyer?.telegramId || !bot) return; const text = [`Komentar otomatis terkirim · @${job.base}`, "", "Post yang cocok:", job.preview, "", "Komentar yang terkirim:", job.wording, job.link ? `Link post MF: ${job.link}` : ""].filter(Boolean).join("\n"); const keyboard = new InlineKeyboard().text("🚫 OOT — hapus komentar", `cm:d:${job.id}`); void bot.api.sendMessage(buyer.telegramId, text, { reply_markup: keyboard, link_preview_options: { is_disabled: true } }).catch(() => undefined); }
function split(value: unknown): string[] { return String(value ?? "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean).slice(0, 60); }
function cleanDivisions(value: unknown): CommentDivision[] { const raw = Array.isArray(value) ? value : []; const divisions = raw.map((item: any) => ({ id: String(item?.id ?? id("division")), name: String(item?.name ?? "").trim().slice(0, 50), keywords: Array.isArray(item?.keywords) ? item.keywords.map(String).map((word: string) => word.trim()).filter(Boolean).slice(0, 60) : split(item?.keywords), blacklist: Array.isArray(item?.blacklist) ? item.blacklist.map(String).map((word: string) => word.trim()).filter(Boolean).slice(0, 60) : split(item?.blacklist), wording: String(item?.wording ?? "").trim().slice(0, 4000) })).filter((item) => item.name && item.keywords.length && item.wording); if (!divisions.length) throw new Error("Setidaknya isi satu divisi, keyword, dan wording."); return divisions; }
const invisibleChars = /[​‌‍­﻿⁠]/g;
function normalizeMatch(value: string) { return value.replace(invisibleChars, "").replace(/\s+/g, " ").toLowerCase().trim(); }
function escapeMatch(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function matchTerm(term: string, normalizedText: string) { const normalizedTerm = normalizeMatch(term); if (!normalizedTerm) return false; const escaped = escapeMatch(normalizedTerm); const pattern = normalizedTerm.length <= 3 ? `(?<![a-z0-9])${escaped}(?![a-z0-9])` : `\\b${escaped}\\b`; return new RegExp(pattern, "i").test(normalizedText); }
function commentConfigFor(store: Store, buyerId: string) { let config = store.commentConfigs.find((item) => item.buyerId === buyerId); if (!config) { config = { buyerId, bases: [], divisions: [], mode: "APPROVAL", updatedAt: now(), updatedBy: "ADMIN" }; store.commentConfigs.push(config); } return config; }
function commentLock(config: CommentConfig, actor: CommentActor) { const locked = config.editingBy && config.editingUntil && Date.parse(config.editingUntil) > Date.now(); if (locked && config.editingBy !== actor) throw new Error(config.editingBy === "ADMIN" ? "Setup sedang diatur admin." : "Setup sedang diatur buyer."); config.editingBy = actor; config.editingUntil = new Date(Date.now() + 10 * 60_000).toISOString(); return config; }
function requireCommentLock(config: CommentConfig, actor: CommentActor) { if (config.editingBy !== actor || !config.editingUntil || Date.parse(config.editingUntil) <= Date.now()) throw new Error("Buka pengaturan dulu sebelum menyimpan."); }
function unlockComment(config: CommentConfig, actor: CommentActor) { if (config.editingBy === actor) { delete config.editingBy; delete config.editingUntil; } }
function broadcastLock(buyer: Buyer, actor: CommentActor) { const locked = buyer.broadcastEditingBy && buyer.broadcastEditingUntil && Date.parse(buyer.broadcastEditingUntil) > Date.now(); if (locked && buyer.broadcastEditingBy !== actor) throw new Error(buyer.broadcastEditingBy === "ADMIN" ? "Setup sedang diatur admin." : "Setup sedang diatur buyer."); buyer.broadcastEditingBy = actor; buyer.broadcastEditingUntil = new Date(Date.now() + 10 * 60_000).toISOString(); return buyer; }
function requireBroadcastLock(buyer: Buyer, actor: CommentActor) { if (buyer.broadcastEditingBy !== actor || !buyer.broadcastEditingUntil || Date.parse(buyer.broadcastEditingUntil) <= Date.now()) throw new Error("Buka pengaturan dulu sebelum menyimpan."); }
function unlockBroadcast(buyer: Buyer, actor: CommentActor) { if (buyer.broadcastEditingBy === actor) { delete buyer.broadcastEditingBy; delete buyer.broadcastEditingUntil; } }
function userBroadcastLock(buyer: Buyer, actor: CommentActor) { const locked = buyer.userBroadcastEditingBy && buyer.userBroadcastEditingUntil && Date.parse(buyer.userBroadcastEditingUntil) > Date.now(); if (locked && buyer.userBroadcastEditingBy !== actor) throw new Error(buyer.userBroadcastEditingBy === "ADMIN" ? "Setup sedang diatur admin." : "Setup sedang diatur buyer."); buyer.userBroadcastEditingBy = actor; buyer.userBroadcastEditingUntil = new Date(Date.now() + 10 * 60_000).toISOString(); return buyer; }
function requireUserBroadcastLock(buyer: Buyer, actor: CommentActor) { if (buyer.userBroadcastEditingBy !== actor || !buyer.userBroadcastEditingUntil || Date.parse(buyer.userBroadcastEditingUntil) <= Date.now()) throw new Error("Buka pengaturan dulu sebelum menyimpan."); }
function unlockUserBroadcast(buyer: Buyer, actor: CommentActor) { if (buyer.userBroadcastEditingBy === actor) { delete buyer.userBroadcastEditingBy; delete buyer.userBroadcastEditingUntil; } }
function scheduleNextBroadcast(broadcast: Broadcast, immediate = false) { broadcast.nextSendAt = immediate ? now() : new Date(Date.now() + broadcast.intervalMinutes * 60_000).toISOString(); broadcast.deliveryToken = undefined; broadcast.deliveryUntil = undefined; }
function broadcastInterval(value: unknown) { return Math.max(1, Math.floor(Number(value) || 15)); }
function cleanBroadcastWording(value: unknown) { const wording = String(value ?? ""); if (!wording.trim()) throw new Error("Isi wording promosi dulu."); if (Array.from(wording).length > 4096 || Buffer.byteLength(wording, "utf8") > 35_000) throw new Error("Wording terlalu panjang untuk dikirim Telegram."); return wording; }
function parseForwardSource(value: unknown, showSource: unknown): ForwardSource { const raw = String(value ?? "").trim(); const match = raw.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,})\/([1-9]\d*)\/?(?:\?[^\s]*)?$/i); if (!match) throw new Error("Tempel link bubble chat dari channel publik, contoh t.me/namachannel/123."); return { channel: match[1], messageId: Number(match[2]), showSource: Boolean(showSource) }; }
function broadcastContent(input: { mode?: unknown; wording?: unknown; forwardLink?: unknown; showForwardSource?: unknown }) { const mode = input.mode === "FORWARD" ? "FORWARD" as const : "TEXT" as const; return mode === "FORWARD" ? { mode, wording: "", forward: parseForwardSource(input.forwardLink, input.showForwardSource) } : { mode, wording: cleanBroadcastWording(input.wording), forward: undefined }; }
function queueApprovedComment(store: Store, candidate: Candidate) { const job: CommentJob = { id: id("comment"), buyerId: candidate.buyerId, base: candidate.base, messageId: candidate.messageId, wording: candidate.wording, link: candidate.link, preview: candidate.preview, status: "PENDING", createdAt: now() }; store.commentJobs.push(job); store.approvalCandidates = store.approvalCandidates.filter((item) => item.id !== candidate.id); return job; }

function jakartaDateParts(value: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(value);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { year: Number(pick("year")), month: Number(pick("month")), day: Number(pick("day")), hour: Number(pick("hour")), minute: Number(pick("minute")) };
}
function jakartaDateKey(value: Date) {
  const parts = jakartaDateParts(value);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}
function pakasirAvailableAt(paidAt: string) {
  const parts = jakartaDateParts(new Date(paidAt));
  // Asia/Jakarta is UTC+7 with no daylight saving time: H+1, 12.00 WIB = 05.00 UTC.
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 5, 0, 0));
}
function withdrawWindowOpen(value = new Date()) {
  const parts = jakartaDateParts(value);
  return parts.hour * 60 + parts.minute >= 12 * 60 + 30;
}
function commerceFor(store: Store): Commerce {
  const current = new Date(); const today = jakartaDateKey(current);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", weekday: "short" }).format(current);
  const sinceMonday = ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[weekday] ?? 0;
  const weekStart = jakartaDateKey(new Date(current.getTime() - sinceMonday * 86_400_000)); const month = today.slice(0, 7);
  const paid = store.payments.filter((item) => item.status === "PAID" && item.paidAt);
  const total = (items: Payment[]) => items.reduce((sum, item) => sum + item.amount, 0);
  const paidOn = (predicate: (key: string) => boolean) => paid.filter((item) => predicate(jakartaDateKey(new Date(item.paidAt!))));
  const buyerName = new Map(store.buyers.map((item) => [item.telegramId, item.name]));
  const orders = [...store.payments].sort((left, right) => Date.parse(right.paidAt ?? right.createdAt) - Date.parse(left.paidAt ?? left.createdAt)).slice(0, 100).map((item) => ({ id: item.id, orderId: item.gatewayReference ?? item.id, buyer: buyerName.get(item.telegramId) ?? "Buyer", plan: item.plan, durationDays: item.durationDays, maxGroups: item.maxGroups, amount: item.amount, status: item.status, createdAt: item.createdAt, paidAt: item.paidAt }));
  const lockedWithdrawalIds = new Set(store.withdrawals.filter((item) => item.status === "REQUESTED" || item.status === "PAID").map((item) => item.id));
  const unclaimed = paid.filter((item) => !item.withdrawalId || !lockedWithdrawalIds.has(item.withdrawalId));
  const pendingBalance = total(unclaimed.filter((item) => pakasirAvailableAt(item.paidAt!).getTime() > current.getTime()));
  const availableBalance = total(unclaimed.filter((item) => pakasirAvailableAt(item.paidAt!).getTime() <= current.getTime()));
  const requestedBalance = store.withdrawals.filter((item) => item.status === "REQUESTED").reduce((sum, item) => sum + item.grossAmount, 0);
  const withdrawals = [...store.withdrawals].sort((left, right) => Date.parse(right.paidAt ?? right.createdAt) - Date.parse(left.paidAt ?? left.createdAt)).slice(0, 20).map(({ id, grossAmount, fee, netAmount, walletType, walletNumber, walletOwner, status, createdAt, paidAt }) => ({ id, grossAmount, fee, netAmount, walletType, walletNumber, walletOwner, status, createdAt, paidAt }));
  return { today: total(paidOn((key) => key === today)), week: total(paidOn((key) => key >= weekStart && key <= today)), month: total(paidOn((key) => key.startsWith(month))), paidCount: paid.length, pendingBalance, availableBalance, requestedBalance, canRequestWithdrawal: withdrawWindowOpen(current) && availableBalance >= 30_000, orders, withdrawals };
}
function productLabel(product: "ADMIN_BROADCAST" | "USERBOT_PROMO") { return product === "ADMIN_BROADCAST" ? "Auto Sebar" : "Userbot Promosi"; }
function activeSubscription(store: Store, buyerId: string, plan: Plan, timestamp = Date.now()) { return store.subscriptions.find((item) => item.buyerId === buyerId && item.plan === plan && item.status === "ACTIVE" && Date.parse(item.endsAt) > timestamp); }
function productEntitlement(store: Store, buyer: Buyer, product: "ADMIN_BROADCAST" | "USERBOT_PROMO", timestamp = Date.now()) {
  const plans = productPlans(product); const subscriptions = plans.map((plan) => activeSubscription(store, buyer.id, plan, timestamp)).filter(Boolean) as Subscription[];
  const legacy = product === "ADMIN_BROADCAST" ? buyer.planBroadcast : Boolean(buyer.planUserBroadcast || buyer.planComment);
  const endsAt = subscriptions.length ? subscriptions.map((item) => item.endsAt).sort().at(-1) : undefined;
  const maxGroups = subscriptions.filter((item) => item.plan !== "COMMENT").map((item) => item.maxGroups).sort((a, b) => b - a)[0];
  return { active: subscriptions.length === plans.length, hasAccess: subscriptions.length > 0 || legacy, legacy: !subscriptions.length && legacy, endsAt, maxGroups };
}
function maxGroupsForBuyer(store: Store, buyer: Buyer, plan: "BROADCAST" | "USERBOT_BROADCAST" = "BROADCAST") {
  const active = store.subscriptions
    .filter((item) => item.buyerId === buyer.id && item.plan === plan && item.status === "ACTIVE" && Date.parse(item.endsAt) > Date.now())
    .sort((a, b) => Date.parse(b.endsAt) - Date.parse(a.endsAt))[0];
  return active ? Math.max(1, Number(active.maxGroups) || 1) : Number.POSITIVE_INFINITY;
}
function releaseWorker(store: Store, buyer: Buyer) {
  if (!buyer.workerId) return;
  const worker = store.workers.find((item) => item.id === buyer.workerId);
  if (worker) {
    worker.buyerId = null; worker.status = "AVAILABLE"; delete worker.cooldownUntil;
  }
  buyer.workerId = null;
}
function releaseWorkerWhenGroupsCleared(store: Store, buyer: Buyer) {
  const stillLeaving = store.lpmTargets.some((item) => item.buyerId === buyer.id && targetExecutor(item) === "ADMIN" && item.status !== "REMOVED");
  if (!stillLeaving) releaseWorker(store, buyer);
}
function cleanup(store: Store) {
  const before = JSON.stringify(store);
  const ago = (days: number) => Date.now() - days * 86_400_000;
  const expiredProducts = new Map<string, "ADMIN_BROADCAST" | "USERBOT_PROMO">();
  for (const subscription of store.subscriptions) if (subscription.status === "ACTIVE" && Date.parse(subscription.endsAt) <= Date.now()) {
    subscription.status = "EXPIRED";
    if (subscription.product === "ADMIN_BROADCAST" || subscription.product === "USERBOT_PROMO") expiredProducts.set(`${subscription.buyerId}:${subscription.product}`, subscription.product);
  }
  for (const buyer of store.buyers) {
    const ownsSubscription = store.subscriptions.some((item) => item.buyerId === buyer.id);
    if (!ownsSubscription) continue;
    const access = reconcileManualPlanFlags(store, buyer);
    if (!access.broadcast) { buyer.broadcastActive = false; for (const target of store.lpmTargets.filter((item) => item.buyerId === buyer.id && targetExecutor(item) === "ADMIN" && item.desired)) { target.desired = false; target.status = "REMOVING"; target.updatedAt = now(); } releaseWorkerWhenGroupsCleared(store, buyer); }
    if (!access.userbotBroadcast) { buyer.userBroadcastActive = false; const broadcast = broadcastFor(store, buyer.id, "BUYER"); if (broadcast) { broadcast.nextSendAt = undefined; broadcast.deliveryToken = undefined; broadcast.deliveryUntil = undefined; } }
    if (!access.comment) buyer.commentActive = false;
    if (!retainUserbotSession(access.comment, access.userbotBroadcast)) { buyer.commentAccountConnected = false; buyer.userbotAccountStatus = "DISCONNECTED"; delete buyer.userbotAccountIssue; }
  }
  const commentExpiredBuyerIds = new Set(store.buyers.filter((buyer) => shouldCancelCommentWork(hasPlanAccess(store, buyer, "COMMENT"))).map((buyer) => buyer.id));
  for (const job of store.commentJobs) if (commentExpiredBuyerIds.has(job.buyerId) && (job.status === "PENDING" || job.status === "SENDING")) { job.status = "CANCELED"; delete job.deliveryToken; delete job.deliveryUntil; }
  store.approvalCandidates = store.approvalCandidates.filter((item) => !commentExpiredBuyerIds.has(item.buyerId));
  store.dedupe = store.dedupe.filter((item) => !commentExpiredBuyerIds.has(item.buyerId));
  for (const [key, product] of expiredProducts) {
    const [buyerId] = key.split(":"); const buyer = store.buyers.find((item) => item.id === buyerId);
    if (!buyer || productEntitlement(store, buyer, product).hasAccess) continue;
    const subscriptions = store.subscriptions.filter((item) => item.buyerId === buyer.id && item.product === product);
    if (!shouldNotifyExpiry(false, subscriptions.some((item) => item.expiryNotifiedAt))) continue;
    const markedAt = now(); for (const subscription of subscriptions) subscription.expiryNotifiedAt = markedAt;
    sendBuyerAlert(store, buyer.id, "Masa aktif habis", `${productLabel(product)} sudah tidak aktif. Hubungi admin untuk lanjut.`);
  }
  store.approvalCandidates = store.approvalCandidates.filter((item) => Date.parse(item.createdAt) > ago(2));
  store.commentJobs = store.commentJobs.filter((item) => Date.parse(item.createdAt) > ago(30));
  store.dedupe = store.dedupe.filter((item) => Date.parse(item.at) > ago(7));
  const byBuyer = new Map<string, Activity[]>();
  for (const item of store.activities.filter((item) => Date.parse(item.at) > ago(30))) byBuyer.set(item.buyerId, [...(byBuyer.get(item.buyerId) ?? []), item]);
  store.activities = [...byBuyer.values()].flatMap((items) => items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 100));
  return JSON.stringify(store) !== before;
}

async function reconcileRunners() {
  if (shuttingDown) return;
  await withStoreLock(async () => {
    const store = await load(); cleanup(store); await save(store);
    const delayedStarts: (() => void)[] = [];
    const workerSessions = await readWorkerSessions();
    for (const workerId of Object.keys(workerSessions)) {
      const worker = store.workers.find((item) => item.id === workerId);
      // Worker tanpa pemilik (AVAILABLE) tidak dispawn: satu proses GramJS
      // nganggur makan ±100MB RAM terus-menerus padahal tidak mengerjakan apa pun.
      // Session-nya tetap disimpan, jadi begitu di-assign ke buyer reconcile
      // otomatis menyalakan runner-nya.
      if (worker && worker.status !== "DISABLED") { if (worker.buyerId) delayedStarts.push(() => startWorkerRunner(workerId)); else stopWorkerRunner(workerId); }
      else { stopWorkerRunner(workerId); await removeWorkerSession(workerId); }
    }
    const commentSessions = await readCommentSessions();
    const activeUserbotBuyers: string[] = [];
    for (const buyerId of Object.keys(commentSessions)) {
      const buyer = store.buyers.find((item) => item.id === buyerId);
      // Satu runner buyer mengelola dua modul Userbot Promosi. Jangan spawn runner
      // kedua untuk Jaseb akun buyer karena dua koneksi dengan session yang sama bisa
      // membuat Telegram menolak auth key atau mengirim dobel.
      const allowed = Boolean(buyer && retainUserbotSession(hasPlanAccess(store, buyer, "COMMENT"), hasPlanAccess(store, buyer, "USERBOT_BROADCAST")));
      if (buyer && buyer.commentAccountConnected && allowed) activeUserbotBuyers.push(buyerId);
      else { await removeCommentSession(buyerId); if (buyer) buyer.commentAccountConnected = false; }
    }
    writeUserbotRoster(activeUserbotBuyers);
    if (activeUserbotBuyers.length) startUserbotRunner(); else stopUserbotRunner();
    scheduleStaggeredStarts(delayedStarts);
    await save(store);
  });
}
function reconcileRunnersSafely(): Promise<void> {
  // Banyak pemicu bisa tiba hampir bersamaan (login, masa aktif habis, exit
  // runner, dan pemeriksaan berkala). Satu rekonsiliasi pada satu waktu cukup;
  // pemicu tambahan meminta satu putaran lagi setelahnya, tanpa antrean yang
  // terus membesar saat Supabase sedang lambat.
  if (runnerReconcileInFlight) {
    runnerReconcileRequested = true;
    return runnerReconcileInFlight;
  }
  runnerReconcileInFlight = reconcileRunners().catch((error) => {
    app.log.warn({ err: error }, "Runner reconciliation gagal; akan dicoba lagi.");
    scheduleRunnerReconcile(15_000);
  }).finally(() => {
    runnerReconcileInFlight = undefined;
    if (runnerReconcileRequested && !shuttingDown) {
      runnerReconcileRequested = false;
      scheduleRunnerReconcile(0);
    }
  });
  return runnerReconcileInFlight;
}

app.get("/api/buyer/dashboard", async (req, reply) => {
  const store = await load(); let changed = cleanup(store); let buyer = buyerForRequest(store, req);
  if (!buyer && !isAdmin(req)) {
    const visitor = telegramUser(req);
    if (visitor) {
      buyer = { id: id("buyer"), name: visitor.name, telegramId: visitor.id, broadcastActive: false, commentActive: false, commentAccountConnected: false, planBroadcast: false, planComment: false, workerId: null, updatedAt: now() };
      store.buyers.push(buyer); changed = true;
    }
  }
  if (changed) await save(store);
  if (!buyer) return { onboarding: true, buyer: null, worker: null, broadcast: null, userBroadcast: null, lpmTargets: [], userLpmTargets: [], commentTargets: [], comment: null, activity: [] };
  return {
    buyer: buyerWithEffectiveAccess(store, buyer),
    entitlements: entitlementSummary(store, buyer),
    broadcastQuota: (() => { const quota = maxGroupsForBuyer(store, buyer, "BROADCAST"); return Number.isFinite(quota) ? quota : null; })(),
    userBroadcastQuota: (() => { const quota = maxGroupsForBuyer(store, buyer, "USERBOT_BROADCAST"); return Number.isFinite(quota) ? quota : null; })(),
    worker: buyer.workerId ? store.workers.find((item) => item.id === buyer.workerId) ?? null : null,
    broadcast: (() => { const item = broadcastFor(store, buyer.id, "ADMIN"); return item ? { ...item, maxGroups: maxGroupsForBuyer(store, buyer, "BROADCAST") } : null; })(),
    userBroadcast: (() => { const item = broadcastFor(store, buyer.id, "BUYER"); return item ? { ...item, maxGroups: maxGroupsForBuyer(store, buyer, "USERBOT_BROADCAST") } : null; })(),
    lpmTargets: publicLpmTargets(store, buyer.id, "ADMIN"),
    userLpmTargets: publicLpmTargets(store, buyer.id, "BUYER"),
    commentTargets: store.commentTargets.filter((item) => item.buyerId === buyer.id),
    comment: store.commentConfigs.find((item) => item.buyerId === buyer.id) ?? null,
    activity: store.activities.filter((item) => item.buyerId === buyer.id).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 12),
  };
});

app.get("/api/app/session", async (req, reply) => {
  if (!telegramUserId(req)) return reply.code(401).send({ error: "open_from_telegram", reason: "Buka layanan ini dari bot Telegram." });
  return { role: isAdmin(req) ? "ADMIN" : "BUYER" };
});

app.get("/api/public/packages", async () => {
  const store = await load(); return store.packages.filter((item) => item.enabled).map(({ id: packageId, service, name, price, durationDays, maxGroups }) => ({ packageId, service, name, price, durationDays, maxGroups }));
});
function pakasirConfig() {
  const project = String(process.env.PAKASIR_PROJECT ?? "").trim();
  const apiKey = String(process.env.PAKASIR_API_KEY ?? "").trim();
  if (!project || !apiKey) throw new Error("Pembayaran belum diaktifkan.");
  return { project, apiKey };
}
function pakasirPaymentUrl(project: string, amount: number, orderId: string) {
  const url = new URL(`https://app.pakasir.com/pay/${encodeURIComponent(project)}/${amount}`);
  url.searchParams.set("order_id", orderId);
  const returnUrl = botUsername ? `https://t.me/${botUsername}?startapp=paid_${orderId}` : process.env.MINIAPP_URL ? `${process.env.MINIAPP_URL}${process.env.MINIAPP_URL.includes("?") ? "&" : "?"}payment=${encodeURIComponent(orderId)}` : "";
  if (returnUrl) url.searchParams.set("redirect", returnUrl);
  return url.toString();
}
async function pakasirTransaction(config: { project: string; apiKey: string }, payment: Payment) {
  const url = new URL("https://app.pakasir.com/api/transactiondetail");
  url.searchParams.set("project", config.project);
  url.searchParams.set("amount", String(payment.amount));
  url.searchParams.set("order_id", payment.gatewayReference ?? payment.id);
  url.searchParams.set("api_key", config.apiKey);
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Pakasir belum bisa memverifikasi pembayaran.");
  const body = await response.json() as { transaction?: { project?: unknown; amount?: unknown; order_id?: unknown; status?: unknown } };
  const transaction = body.transaction;
  if (!transaction || String(transaction.project) !== config.project || Number(transaction.amount) !== payment.amount || String(transaction.order_id) !== (payment.gatewayReference ?? payment.id)) throw new Error("Data pembayaran Pakasir tidak sesuai.");
  return String(transaction.status ?? "").toLowerCase();
}
function activateProduct(store: Store, buyer: Buyer, product: "ADMIN_BROADCAST" | "USERBOT_PROMO", durationDays: number, maxGroups: number, source: "MANUAL" | "PAYMENT", packageId?: string) {
  const plans = productPlans(product); const active = plans.map((plan) => activeSubscription(store, buyer.id, plan));
  const startsAt = now(); const endsAt = extendedEndsAt(Date.now(), active.filter(Boolean).map((item) => item!.endsAt), durationDays);
  for (const plan of plans) {
    const current = active.find((item) => item?.plan === plan);
    const planMaxGroups = plan === "COMMENT" ? 15 : maxGroups;
    if (current) {
      current.packageId = packageId; current.product = product; current.source = source; current.maxGroups = planMaxGroups; current.endsAt = endsAt; delete current.revokedAt; delete current.expiryNotifiedAt;
    } else store.subscriptions.push({ id: id("subscription"), buyerId: buyer.id, packageId, plan, product, source, maxGroups: planMaxGroups, status: "ACTIVE", startsAt, endsAt });
  }
  clearManualPlanAccess(buyer, plans); buyer.legacyBundle = false; buyer.updatedAt = now();
  return endsAt;
}
function activatePaidPackage(store: Store, payment: Payment) {
  const buyer = store.buyers.find((item) => item.telegramId === payment.telegramId);
  if (!buyer) throw new Error("Akun buyer tidak ditemukan.");
  if (payment.plan !== "ADMIN_BROADCAST" && payment.plan !== "USERBOT_PROMO") throw new Error("Paket lama tidak bisa diaktifkan lagi.");
  const endsAt = activateProduct(store, buyer, payment.plan, payment.durationDays, payment.maxGroups, "PAYMENT", payment.packageId);
  buyer.updatedAt = now();
  payment.status = "PAID"; payment.paidAt = now();
  sendBuyerAlert(store, buyer.id, "Pembayaran berhasil", `${productLabel(payment.plan)} aktif sampai ${new Date(endsAt).toLocaleDateString("id-ID")}.`);
}
function revokeProduct(store: Store, buyer: Buyer, product: "ADMIN_BROADCAST" | "USERBOT_PROMO") {
  const timestamp = now(); const plans = productPlans(product);
  for (const subscription of store.subscriptions) if (subscription.buyerId === buyer.id && subscription.product === product && subscription.status === "ACTIVE") { subscription.status = "REVOKED"; subscription.revokedAt = timestamp; }
  clearManualPlanAccess(buyer, plans); buyer.updatedAt = timestamp;
}
function entitlementSummary(store: Store, buyer: Buyer) {
  return { adminBroadcast: productEntitlement(store, buyer, "ADMIN_BROADCAST"), userbotPromo: productEntitlement(store, buyer, "USERBOT_PROMO") };
}
app.post<{ Body: { packageId?: string } }>("/api/public/checkout", async (req, reply) => {
  if (!selfServiceSubscriptionsEnabled) return reply.code(503).send({ error: "subscriptions_closed", reason: "Langganan sementara ditutup. Hubungi admin @Kertaaji untuk pengaktifan layanan." });
  const visitor = telegramUser(req); const telegramId = visitor?.id; const store = await load(); const selectedPackage = store.packages.find((item) => item.id === String(req.body?.packageId ?? "") && item.enabled);
  if (!telegramId) return reply.code(401).send({ error: "open_from_telegram", reason: "Buka layanan ini dari bot Telegram untuk berlangganan." });
  if (!selectedPackage || selectedPackage.price < 1) return reply.code(409).send({ error: "package_unavailable", reason: "Paket ini belum dibuka untuk pembayaran." });
  let config: ReturnType<typeof pakasirConfig>; try { config = pakasirConfig(); } catch (error) { return reply.code(503).send({ error: "payment_unavailable", reason: (error as Error).message }); }
  if (!store.buyers.some((item) => item.telegramId === telegramId)) store.buyers.push({ id: id("buyer"), name: visitor?.name ?? "Buyer " + telegramId, telegramId, broadcastActive: false, commentActive: false, commentAccountConnected: false, planBroadcast: false, planComment: false, workerId: null, updatedAt: now() });
  const payment: Payment = { id: id("payment"), telegramId, packageId: selectedPackage.id, plan: selectedPackage.service, amount: selectedPackage.price, durationDays: selectedPackage.durationDays, maxGroups: selectedPackage.maxGroups, status: "PENDING", createdAt: now() };
  payment.gatewayReference = payment.id;
  payment.paymentUrl = pakasirPaymentUrl(config.project, payment.amount, payment.gatewayReference);
  store.payments.push(payment); await save(store);
  return { paymentUrl: payment.paymentUrl, orderId: payment.gatewayReference };
});
app.get<{ Querystring: { orderId?: string } }>("/api/buyer/payment-result", async (req, reply) => {
  const telegramId = telegramUserId(req); const orderId = String(req.query?.orderId ?? "");
  if (!telegramId) return reply.code(401).send({ error: "open_from_telegram", reason: "Buka layanan ini dari bot Telegram." });
  const store = await load(); const payment = store.payments.find((item) => item.gatewayReference === orderId && item.telegramId === telegramId);
  if (!payment) return reply.code(404).send({ error: "payment_not_found", reason: "Pembayaran tidak ditemukan." });
  return { status: payment.status, plan: payment.plan, durationDays: payment.durationDays };
});

app.post<{ Body: { feature: "BROADCAST" | "USERBOT_BROADCAST" | "COMMENT"; active: boolean } }>("/api/buyer/toggle", async (req, reply) => {
  const store = await load(); cleanup(store); await save(store); const buyer = buyerForRequest(store, req);
  if (!buyer) return reply.code(404).send({ error: "buyer_not_found", reason: "Layanan belum disiapkan untuk akun Telegram ini." });
  const feature = req.body.feature;
  if (feature === "BROADCAST") {
    const ready = hasPlanAccess(store, buyer, "BROADCAST") && buyer.workerId && Boolean(broadcastFor(store, buyer.id, "ADMIN")) && store.lpmTargets.some((item) => item.buyerId === buyer.id && targetExecutor(item) === "ADMIN" && item.desired && item.status === "READY");
    if (req.body.active && !ready) return reply.code(409).send({ error: "setup_incomplete", reason: "Belum ada grup yang siap dipakai." });
    buyer.broadcastActive = req.body.active;
    const broadcast = broadcastFor(store, buyer.id, "ADMIN");
    if (broadcast) { if (req.body.active) scheduleNextBroadcast(broadcast, true); else { broadcast.nextSendAt = undefined; broadcast.deliveryToken = undefined; broadcast.deliveryUntil = undefined; } }
  } else if (feature === "USERBOT_BROADCAST") {
    const ready = hasPlanAccess(store, buyer, "USERBOT_BROADCAST") && buyer.commentAccountConnected && Boolean(broadcastFor(store, buyer.id, "BUYER")) && store.lpmTargets.some((item) => item.buyerId === buyer.id && targetExecutor(item) === "BUYER" && item.desired && item.status === "READY");
    if (req.body.active && !ready) return reply.code(409).send({ error: "setup_incomplete", reason: "Hubungkan akun dan siapkan grup LPM dulu." });
    buyer.userBroadcastActive = req.body.active;
    const broadcast = broadcastFor(store, buyer.id, "BUYER");
    if (broadcast) { if (req.body.active) scheduleNextBroadcast(broadcast, true); else { broadcast.nextSendAt = undefined; broadcast.deliveryToken = undefined; broadcast.deliveryUntil = undefined; } }
  } else {
    const configured = store.commentConfigs.some((item) => item.buyerId === buyer.id);
    const targetReady = store.commentTargets.some((item) => item.buyerId === buyer.id && item.status === "READY");
    const ready = hasPlanAccess(store, buyer, "COMMENT") && buyer.commentAccountConnected && configured && targetReady;
    if (req.body.active && !ready) return reply.code(409).send({ error: "setup_incomplete", reason: !buyer.commentAccountConnected ? "Hubungkan akun Telegram lo dulu." : !configured ? "Lengkapi setup Auto Komen dulu." : "Menunggu base siap dipakai." });
    buyer.commentActive = req.body.active;
  }
  buyer.updatedAt = now(); await save(store); return { ok: true, buyer };
});

app.put<{ Body: { mode?: "TEXT" | "FORWARD"; wording?: string; forwardLink?: string; showForwardSource?: boolean; groups?: string[]; intervalMinutes?: number } }>("/api/buyer/broadcast-setup", async (req, reply) => {
  const store = await load(); cleanup(store); const buyer = buyerForRequest(store, req);
  if (!buyer) return reply.code(404).send({ error: "buyer_not_found", reason: "Akun buyer belum ditemukan." });
  if (!hasPlanAccess(store, buyer, "BROADCAST")) return reply.code(403).send({ error: "subscription_required", reason: "Langganan Auto Sebar belum aktif." });
  let content: ReturnType<typeof broadcastContent>; try { content = broadcastContent(req.body ?? {}); } catch (error) { return reply.code(400).send({ error: "wording_invalid", reason: (error as Error).message }); }
  let groups: string[]; try { groups = cleanGroups(req.body?.groups, maxGroupsForBuyer(store, buyer)); } catch (error) { return reply.code(400).send({ error: "groups_invalid", reason: (error as Error).message }); }
  let worker = buyer.workerId ? store.workers.find((item) => item.id === buyer.workerId) : undefined;
  if (!worker) worker = store.workers.find((item) => item.status === "AVAILABLE");
  if (!worker) return reply.code(409).send({ error: "worker_unavailable", reason: "Akun kerja belum tersedia. Hubungi admin." });
  if (worker.status !== "AVAILABLE" && worker.buyerId !== buyer.id) return reply.code(409).send({ error: "worker_unavailable", reason: "Akun kerja belum tersedia. Hubungi admin." });
  for (const item of store.workers) if (item.buyerId === buyer.id && item.id !== worker.id) { item.buyerId = null; item.status = "AVAILABLE"; }
  worker.buyerId = buyer.id; worker.status = "ASSIGNED"; delete worker.cooldownUntil; buyer.workerId = worker.id;
  syncLpmTargets(store, buyer, worker.id, "ADMIN", groups);
  const broadcast: Broadcast = { buyerId: buyer.id, executor: "ADMIN", ...content, groups, intervalMinutes: broadcastInterval(req.body?.intervalMinutes), updatedBy: "BUYER", updatedAt: now() };
  store.broadcasts = [...store.broadcasts.filter((item) => item.buyerId !== buyer.id || broadcastExecutor(item) !== "ADMIN"), broadcast]; buyer.updatedAt = now(); await save(store);
  return { ok: true, broadcast };
});

// Userbot Promosi menggunakan satu session buyer untuk Auto Jaseb dan Auto Komen.
// Session itu wajib sudah tersambung, tetapi tak pernah menyentuh worker/admin pool.
app.post("/api/buyer/userbot-broadcast/edit", async (req, reply) => {
  const store = await load(); const buyer = buyerForRequest(store, req);
  if (!buyer) return reply.code(404).send({ error: "buyer_not_found" });
  if (!hasPlanAccess(store, buyer, "USERBOT_BROADCAST")) return reply.code(403).send({ error: "subscription_required", reason: "Akses Userbot Promosi belum aktif." });
  try { userBroadcastLock(buyer, "BUYER"); await save(store); return { ok: true, buyer }; }
  catch (error) { return reply.code(409).send({ error: "setup_locked", reason: (error as Error).message }); }
});
app.post("/api/buyer/userbot-broadcast/cancel", async (req, reply) => {
  const store = await load(); const buyer = buyerForRequest(store, req); if (buyer) unlockUserBroadcast(buyer, "BUYER"); await save(store); return { ok: true };
});
app.put<{ Body: { mode?: "TEXT" | "FORWARD"; wording?: string; forwardLink?: string; showForwardSource?: boolean; groups?: string[]; intervalMinutes?: number } }>("/api/buyer/userbot-broadcast-setup", async (req, reply) => {
  const store = await load(); cleanup(store); const buyer = buyerForRequest(store, req);
  if (!buyer) return reply.code(404).send({ error: "buyer_not_found", reason: "Akun buyer belum ditemukan." });
  if (!hasPlanAccess(store, buyer, "USERBOT_BROADCAST")) return reply.code(403).send({ error: "subscription_required", reason: "Akses Userbot Promosi belum aktif." });
  if (!buyer.commentAccountConnected) return reply.code(409).send({ error: "account_required", reason: "Hubungkan akun Telegram lo sekali dulu untuk memakai Userbot Promosi." });
  try { requireUserBroadcastLock(buyer, "BUYER"); } catch (error) { return reply.code(409).send({ error: "setup_locked", reason: (error as Error).message }); }
  let content: ReturnType<typeof broadcastContent>; try { content = broadcastContent(req.body ?? {}); } catch (error) { return reply.code(400).send({ error: "wording_invalid", reason: (error as Error).message }); }
  let groups: string[]; try { groups = cleanGroups(req.body?.groups, maxGroupsForBuyer(store, buyer, "USERBOT_BROADCAST")); } catch (error) { return reply.code(400).send({ error: "groups_invalid", reason: (error as Error).message }); }
  syncLpmTargets(store, buyer, buyer.id, "BUYER", groups);
  const broadcast: Broadcast = { buyerId: buyer.id, executor: "BUYER", ...content, groups, intervalMinutes: broadcastInterval(req.body?.intervalMinutes), updatedBy: "BUYER", updatedAt: now() };
  store.broadcasts = [...store.broadcasts.filter((item) => item.buyerId !== buyer.id || broadcastExecutor(item) !== "BUYER"), broadcast]; unlockUserBroadcast(buyer, "BUYER"); buyer.updatedAt = now(); await save(store);
  return { ok: true, broadcast };
});

// Admin dan buyer berbagi mekanisme lock yang sama. Admin boleh menyiapkan
// Auto Jaseb milik buyer, tetapi tidak pernah menerima atau menyimpan session
// buyer lewat jalur ini.
app.post<{ Params: { id: string } }>("/api/admin/buyers/:id/userbot-broadcast-config/edit", { preHandler: adminOnly }, async (req, reply) => {
  const store = await load(); const buyer = store.buyers.find((item) => item.id === req.params.id);
  if (!buyer) return reply.code(404).send({ error: "buyer_not_found", reason: "Buyer tidak ditemukan." });
  if (!hasPlanAccess(store, buyer, "USERBOT_BROADCAST")) return reply.code(403).send({ error: "subscription_required", reason: "Akses Userbot Promosi belum aktif." });
  try { userBroadcastLock(buyer, "ADMIN"); await save(store); return { ok: true, buyer }; }
  catch (error) { return reply.code(409).send({ error: "setup_locked", reason: (error as Error).message }); }
});
app.post<{ Params: { id: string } }>("/api/admin/buyers/:id/userbot-broadcast-config/cancel", { preHandler: adminOnly }, async (req) => {
  const store = await load(); const buyer = store.buyers.find((item) => item.id === req.params.id); if (buyer) unlockUserBroadcast(buyer, "ADMIN"); await save(store); return { ok: true };
});
app.put<{ Params: { id: string }; Body: { mode?: "TEXT" | "FORWARD"; wording?: string; forwardLink?: string; showForwardSource?: boolean; groups?: string[]; intervalMinutes?: number } }>("/api/admin/buyers/:id/userbot-broadcast-config", { preHandler: adminOnly }, async (req, reply) => {
  const store = await load(); const buyer = store.buyers.find((item) => item.id === req.params.id);
  if (!buyer) return reply.code(404).send({ error: "buyer_not_found", reason: "Buyer tidak ditemukan." });
  if (!hasPlanAccess(store, buyer, "USERBOT_BROADCAST")) return reply.code(403).send({ error: "subscription_required", reason: "Akses Userbot Promosi belum aktif." });
  try { requireUserBroadcastLock(buyer, "ADMIN"); } catch (error) { return reply.code(409).send({ error: "setup_locked", reason: (error as Error).message }); }
  let content: ReturnType<typeof broadcastContent>; try { content = broadcastContent(req.body ?? {}); } catch (error) { return reply.code(400).send({ error: "wording_invalid", reason: (error as Error).message }); }
  let groups: string[]; try { groups = cleanGroups(req.body?.groups, maxGroupsForBuyer(store, buyer, "USERBOT_BROADCAST")); } catch (error) { return reply.code(400).send({ error: "groups_invalid", reason: (error as Error).message }); }
  syncLpmTargets(store, buyer, buyer.id, "BUYER", groups);
  const broadcast: Broadcast = { buyerId: buyer.id, executor: "BUYER", ...content, groups, intervalMinutes: broadcastInterval(req.body?.intervalMinutes), updatedBy: "ADMIN", updatedAt: now() };
  store.broadcasts = [...store.broadcasts.filter((item) => item.buyerId !== buyer.id || broadcastExecutor(item) !== "BUYER"), broadcast]; unlockUserBroadcast(buyer, "ADMIN"); buyer.updatedAt = now(); await save(store);
  return { ok: true, buyer, broadcast };
});

app.post("/api/buyer/comment-config/edit", async (req, reply) => {
  const store = await load(); const buyer = buyerForRequest(store, req);
  if (!buyer) return reply.code(404).send({ error: "buyer_not_found", reason: "Layanan belum disiapkan untuk akun Telegram ini." });
  if (!hasPlanAccess(store, buyer, "COMMENT")) return reply.code(403).send({ error: "subscription_required", reason: "Akses Auto Komen lo belum aktif." });
  try { const config = commentLock(commentConfigFor(store, buyer.id), "BUYER"); await save(store); return { ok: true, config }; }
  catch (error) { return reply.code(409).send({ error: "setup_locked", reason: (error as Error).message }); }
});
app.post("/api/buyer/comment-config/cancel", async (req, reply) => {
  const store = await load(); const buyer = buyerForRequest(store, req); if (!buyer) return reply.code(404).send({ error: "buyer_not_found" });
  const config = store.commentConfigs.find((item) => item.buyerId === buyer.id); if (config) unlockComment(config, "BUYER"); await save(store); return { ok: true };
});
app.put<{ Body: { bases?: string; divisions?: unknown; mode?: "APPROVAL" | "AUTO" } }>("/api/buyer/comment-config", async (req, reply) => {
  const store = await load(); const buyer = buyerForRequest(store, req);
  if (!buyer) return reply.code(404).send({ error: "buyer_not_found", reason: "Layanan belum disiapkan untuk akun Telegram ini." });
  if (!hasPlanAccess(store, buyer, "COMMENT")) return reply.code(403).send({ error: "subscription_required", reason: "Akses Auto Komen lo belum aktif." });
  const config = commentConfigFor(store, buyer.id);
  try { requireCommentLock(config, "BUYER"); } catch (error) { return reply.code(409).send({ error: "setup_locked", reason: (error as Error).message }); }
  const bases = split(req.body.bases); if (!bases.length) return reply.code(400).send({ error: "bases_required", reason: "Isi setidaknya satu base tujuan." });
  let divisions: CommentDivision[]; try { divisions = cleanDivisions(req.body.divisions); } catch (error) { return reply.code(400).send({ error: "divisions_invalid", reason: (error as Error).message }); }
  config.bases = bases; config.divisions = divisions; config.mode = req.body.mode === "AUTO" ? "AUTO" : "APPROVAL"; config.updatedAt = now(); config.updatedBy = "BUYER"; unlockComment(config, "BUYER"); syncCommentTargets(store, buyer.id, bases); await save(store); return { ok: true, config };
});

async function lpmAdapterOnly(req: any, reply: any) {
  const token = process.env.LPM_ADAPTER_TOKEN;
  if (!token || req.headers["x-lpm-adapter-token"] !== token) return reply.code(403).send({ error: "adapter_only" });
}
app.get<{ Querystring: { workerId?: string } }>("/api/internal/lpm-jobs", { preHandler: lpmAdapterOnly }, async (req) => {
  const workerId = String(req.query.workerId ?? ""); const store = await load();
  return { jobs: store.lpmTargets.filter((item) => item.workerId === workerId && ((item.desired && item.status === "CONNECTING") || (!item.desired && item.status === "REMOVING"))).map((item) => ({ id: item.id, action: item.desired ? "JOIN" : "LEAVE", username: item.username })) };
});
app.get<{ Querystring: { buyerId?: string } }>("/api/internal/userbot-lpm-monitor", { preHandler: lpmAdapterOnly }, async (req, reply) => {
  const buyerId = String(req.query.buyerId ?? ""); const store = await load(); const buyer = store.buyers.find((item) => item.id === buyerId);
  if (!buyer || !buyer.commentAccountConnected || !hasPlanAccess(store, buyer, "USERBOT_BROADCAST")) return reply.code(404).send({ error: "userbot_not_ready" });
  return { targets: store.lpmTargets.filter((item) => item.buyerId === buyerId && targetExecutor(item) === "BUYER" && item.desired).map((item) => ({ id: item.id, username: item.username, status: item.status })) };
});
app.post<{ Params: { id: string }; Body: { workerId?: string; action?: "JOIN" | "LEAVE" } }>("/api/internal/lpm-targets/:id/confirm", { preHandler: lpmAdapterOnly }, async (req) => {
  const store = await load(); const target = store.lpmTargets.find((item) => item.id === req.params.id); const workerId = String(req.body?.workerId ?? ""); const action = req.body?.action;
  return { execute: Boolean(target && target.workerId === workerId && ((action === "JOIN" && target.desired && target.status === "CONNECTING") || (action === "LEAVE" && !target.desired && target.status === "REMOVING"))) };
});
app.post<{ Params: { id: string }; Body: { workerId?: string; status?: LpmTargetStatus; note?: string } }>("/api/internal/lpm-targets/:id/result", { preHandler: lpmAdapterOnly }, async (req, reply) => {
  const next = req.body?.status; const allowed: LpmTargetStatus[] = ["PENDING_APPROVAL", "READY", "UNAVAILABLE", "REMOVED"];
  if (!next || !allowed.includes(next)) return reply.code(400).send({ error: "status_invalid" });
  const store = await load(); const target = store.lpmTargets.find((item) => item.id === req.params.id); if (!target) return reply.code(404).send({ error: "target_not_found" });
  const workerId = String(req.body?.workerId ?? ""); const isCurrent = target.workerId === workerId && ((next === "REMOVED" && !target.desired && target.status === "REMOVING") || (next !== "REMOVED" && target.desired && target.status === "CONNECTING"));
  if (!isCurrent) return { ok: true, ignored: true };
  target.status = next; target.note = String(req.body?.note ?? "").trim().slice(0, 160) || undefined; target.updatedAt = now(); if (next === "REMOVED") { target.desired = false; const buyer = store.buyers.find((item) => item.id === target.buyerId); if (buyer && !buyer.planBroadcast) releaseWorkerWhenGroupsCleared(store, buyer); } await save(store); notifyLpmStatus(store, target); return { ok: true };
});

app.get<{ Querystring: { workerId?: string } }>("/api/internal/broadcast-jobs", { preHandler: lpmAdapterOnly }, async (req) => {
  const workerId = String(req.query.workerId ?? ""); const store = await load(); cleanup(store);
  const jobs: { buyerId: string; deliveryToken: string; group: string; wording: string; mode: Broadcast["mode"]; forward?: ForwardSource }[] = [];
  for (const broadcast of store.broadcasts) {
    if (broadcastExecutor(broadcast) !== "ADMIN") continue;
    const buyer = store.buyers.find((item) => item.id === broadcast.buyerId);
    if (!buyer || buyer.workerId !== workerId || !buyer.broadcastActive || !hasPlanAccess(store, buyer, "BROADCAST")) continue;
    if (broadcast.deliveryToken && broadcast.deliveryUntil && Date.parse(broadcast.deliveryUntil) > Date.now()) continue;
    if (!broadcast.nextSendAt || Date.parse(broadcast.nextSendAt) > Date.now()) continue;
    const readyGroups = broadcast.groups.filter((username) => store.lpmTargets.some((target) => target.buyerId === buyer.id && target.workerId === workerId && target.desired && target.status === "READY" && target.username.toLowerCase() === username.toLowerCase()));
    if (!readyGroups.length) continue;
    const cursor = Math.max(0, Number(broadcast.groupCursor) || 0) % readyGroups.length; const group = readyGroups[cursor]; const deliveryToken = id("send");
    broadcast.deliveryToken = deliveryToken; broadcast.deliveryUntil = new Date(Date.now() + 2 * 60_000).toISOString(); jobs.push({ buyerId: buyer.id, deliveryToken, group, wording: broadcast.wording, mode: broadcast.mode, forward: broadcast.forward });
  }
  await save(store); return { jobs };
});

app.post<{ Params: { id: string }; Body: { deliveryToken?: string; workerId?: string; group?: string } }>("/api/internal/broadcast-jobs/:id/confirm", { preHandler: lpmAdapterOnly }, async (req) => {
  const store = await load(); cleanup(store); const broadcast = broadcastFor(store, req.params.id, "ADMIN"); const buyer = store.buyers.find((item) => item.id === req.params.id); const workerId = String(req.body?.workerId ?? ""); const group = String(req.body?.group ?? "").replace(/^@/, "").toLowerCase();
  const targetReady = Boolean(buyer && store.lpmTargets.some((item) => item.buyerId === buyer.id && item.workerId === workerId && item.desired && item.status === "READY" && item.username.toLowerCase() === group));
  const allowed = Boolean(broadcast && buyer && broadcast.deliveryToken === String(req.body?.deliveryToken ?? "") && buyer.workerId === workerId && buyer.broadcastActive && hasPlanAccess(store, buyer, "BROADCAST") && broadcast.groups.some((item) => item.toLowerCase() === group) && targetReady);
  if (!allowed && broadcast?.deliveryToken === String(req.body?.deliveryToken ?? "")) { broadcast.deliveryToken = undefined; broadcast.deliveryUntil = undefined; if (buyer?.broadcastActive && hasPlanAccess(store, buyer, "BROADCAST")) scheduleNextBroadcast(broadcast, true); await save(store); }
  return { send: allowed };
});

app.post<{ Params: { id: string }; Body: { deliveryToken?: string; group?: string; messageId?: number; error?: string } }>("/api/internal/broadcast-jobs/:id/result", { preHandler: lpmAdapterOnly }, async (req, reply) => {
  const store = await load(); const broadcast = broadcastFor(store, req.params.id, "ADMIN"); const buyer = store.buyers.find((item) => item.id === req.params.id);
  if (!broadcast || !buyer || broadcast.deliveryToken !== String(req.body?.deliveryToken ?? "")) return reply.code(409).send({ error: "delivery_not_found" });
  const group = String(req.body?.group ?? "").replace(/^@/, ""); const failed = String(req.body?.error ?? "").trim(); const messageId = Number(req.body?.messageId);
  broadcast.deliveryToken = undefined; broadcast.deliveryUntil = undefined; broadcast.lastGroup = group || broadcast.lastGroup; broadcast.groupCursor = Math.max(0, Number(broadcast.groupCursor) || 0) + 1; scheduleNextBroadcast(broadcast);
  if (failed) { store.activities.unshift({ buyerId: buyer.id, kind: "BROADCAST", status: "failed", label: `Gagal di @${group}`, at: now() }); if (/CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|USER_RESTRICTED/i.test(failed)) { const target = store.lpmTargets.find((item) => item.buyerId === buyer.id && item.username.toLowerCase() === group.toLowerCase()); if (target) { target.status = "UNAVAILABLE"; target.note = "Akun worker tidak bisa mengirim"; target.updatedAt = now(); } sendBuyerAlert(store, buyer.id, `Info Auto Sebar · @${group}`, "Akun worker tidak bisa mengirim di grup ini. Periksa aturan atau pembatasan akun."); } else if (/CHAT_FORWARDS_RESTRICTED/i.test(failed)) sendBuyerAlert(store, buyer.id, `Info Auto Sebar · @${group}`, "Post sumber tidak mengizinkan forward. Gunakan post lain."); else if (/CHANNEL_PRIVATE|MESSAGE_ID_INVALID|MSG_ID_INVALID/i.test(failed)) sendBuyerAlert(store, buyer.id, `Info Auto Sebar · @${group}`, "Link forward tidak bisa diakses akun worker. Pastikan post berasal dari channel publik dan link-nya benar."); else sendBuyerAlert(store, buyer.id, `Info Auto Sebar · @${group}`, `Kiriman gagal: ${failed.replace(/_/g, " ").slice(0, 160)}`); }
  else { broadcast.lastSentAt = now(); const link = Number.isInteger(messageId) && messageId > 0 ? `https://t.me/${group}/${messageId}` : undefined; store.activities.unshift({ buyerId: buyer.id, kind: "BROADCAST", status: "sent", label: `Terkirim di @${group}`, link, at: now() }); }
  cleanup(store); await save(store); return { ok: true, nextSendAt: broadcast.nextSendAt };
});

// Jalur kirim khusus Userbot Promosi. Sengaja dipisah dari endpoint worker agar
// akun buyer tidak pernah bisa mengambil job yang dialokasikan untuk akun admin.
app.get<{ Querystring: { buyerId?: string } }>("/api/internal/userbot-broadcast-jobs", { preHandler: lpmAdapterOnly }, async (req) => {
  const buyerId = String(req.query.buyerId ?? ""); const store = await load(); cleanup(store);
  const buyer = store.buyers.find((item) => item.id === buyerId); const broadcast = broadcastFor(store, buyerId, "BUYER");
  if (!buyer || !broadcast || !buyer.userBroadcastActive || !buyer.commentAccountConnected || !hasPlanAccess(store, buyer, "USERBOT_BROADCAST")) return { jobs: [] };
  if (broadcast.deliveryToken && broadcast.deliveryUntil && Date.parse(broadcast.deliveryUntil) > Date.now()) return { jobs: [] };
  if (!broadcast.nextSendAt || Date.parse(broadcast.nextSendAt) > Date.now()) return { jobs: [] };
  const readyGroups = broadcast.groups.filter((username) => store.lpmTargets.some((target) => target.buyerId === buyer.id && targetExecutor(target) === "BUYER" && target.workerId === buyer.id && target.desired && target.status === "READY" && target.username.toLowerCase() === username.toLowerCase()));
  if (!readyGroups.length) return { jobs: [] };
  const cursor = Math.max(0, Number(broadcast.groupCursor) || 0) % readyGroups.length; const group = readyGroups[cursor]; const deliveryToken = id("send");
  broadcast.deliveryToken = deliveryToken; broadcast.deliveryUntil = new Date(Date.now() + 2 * 60_000).toISOString(); await save(store);
  return { jobs: [{ buyerId: buyer.id, deliveryToken, group, wording: broadcast.wording, mode: broadcast.mode, forward: broadcast.forward }] };
});
app.post<{ Params: { id: string }; Body: { deliveryToken?: string; group?: string } }>("/api/internal/userbot-broadcast-jobs/:id/confirm", { preHandler: lpmAdapterOnly }, async (req) => {
  const store = await load(); cleanup(store); const buyer = store.buyers.find((item) => item.id === req.params.id); const broadcast = broadcastFor(store, req.params.id, "BUYER"); const group = String(req.body?.group ?? "").replace(/^@/, "").toLowerCase();
  const targetReady = Boolean(buyer && store.lpmTargets.some((item) => item.buyerId === buyer.id && targetExecutor(item) === "BUYER" && item.workerId === buyer.id && item.desired && item.status === "READY" && item.username.toLowerCase() === group));
  const allowed = Boolean(broadcast && buyer && broadcast.deliveryToken === String(req.body?.deliveryToken ?? "") && buyer.userBroadcastActive && buyer.commentAccountConnected && hasPlanAccess(store, buyer, "USERBOT_BROADCAST") && broadcast.groups.some((item) => item.toLowerCase() === group) && targetReady);
  if (!allowed && broadcast?.deliveryToken === String(req.body?.deliveryToken ?? "")) { broadcast.deliveryToken = undefined; broadcast.deliveryUntil = undefined; if (buyer?.userBroadcastActive && hasPlanAccess(store, buyer, "USERBOT_BROADCAST")) scheduleNextBroadcast(broadcast, true); await save(store); }
  return { send: allowed };
});
app.post<{ Params: { id: string }; Body: { deliveryToken?: string; group?: string; messageId?: number; error?: string } }>("/api/internal/userbot-broadcast-jobs/:id/result", { preHandler: lpmAdapterOnly }, async (req, reply) => {
  const store = await load(); const buyer = store.buyers.find((item) => item.id === req.params.id); const broadcast = broadcastFor(store, req.params.id, "BUYER");
  if (!broadcast || !buyer || broadcast.deliveryToken !== String(req.body?.deliveryToken ?? "")) return reply.code(409).send({ error: "delivery_not_found" });
  const group = String(req.body?.group ?? "").replace(/^@/, ""); const failed = String(req.body?.error ?? "").trim(); const messageId = Number(req.body?.messageId);
  broadcast.deliveryToken = undefined; broadcast.deliveryUntil = undefined; broadcast.lastGroup = group || broadcast.lastGroup; broadcast.groupCursor = Math.max(0, Number(broadcast.groupCursor) || 0) + 1; scheduleNextBroadcast(broadcast);
  if (failed) {
    store.activities.unshift({ buyerId: buyer.id, kind: "BROADCAST", status: "failed", label: `Gagal di @${group}`, at: now() });
    const target = store.lpmTargets.find((item) => item.buyerId === buyer.id && targetExecutor(item) === "BUYER" && item.username.toLowerCase() === group.toLowerCase());
    if (/CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|USER_RESTRICTED/i.test(failed)) { if (target) { target.status = "UNAVAILABLE"; target.note = "Akun lo tidak bisa mengirim"; target.updatedAt = now(); } sendBuyerAlert(store, buyer.id, `Info Auto Sebar · @${group}`, "Akun lo tidak bisa mengirim di grup ini. Periksa aturan atau pembatasan akun."); }
    else if (/CHAT_FORWARDS_RESTRICTED/i.test(failed)) sendBuyerAlert(store, buyer.id, `Info Auto Sebar · @${group}`, "Post sumber tidak mengizinkan forward. Gunakan post lain.");
    else sendBuyerAlert(store, buyer.id, `Info Auto Sebar · @${group}`, `Kiriman gagal: ${failed.replace(/_/g, " ").slice(0, 160)}`);
  } else { broadcast.lastSentAt = now(); const link = Number.isInteger(messageId) && messageId > 0 ? `https://t.me/${group}/${messageId}` : undefined; store.activities.unshift({ buyerId: buyer.id, kind: "BROADCAST", status: "sent", label: `Terkirim di @${group}`, link, at: now() }); }
  cleanup(store); await save(store); return { ok: true, nextSendAt: broadcast.nextSendAt };
});

app.get<{ Querystring: { buyerId?: string } }>("/api/internal/comment-monitor", { preHandler: lpmAdapterOnly }, async (req, reply) => {
  const buyerId = String(req.query.buyerId ?? ""); const store = await load(); const buyer = store.buyers.find((item) => item.id === buyerId); const config = store.commentConfigs.find((item) => item.buyerId === buyerId);
  if (!buyer || !config || !buyer.commentAccountConnected || !hasPlanAccess(store, buyer, "COMMENT")) return reply.code(404).send({ error: "comment_not_ready" });
  return { buyerId, bases: config.bases, targets: store.commentTargets.filter((item) => item.buyerId === buyerId) };
});

app.get<{ Querystring: { workerId?: string } }>("/api/internal/worker-owner", { preHandler: lpmAdapterOnly }, async (req, reply) => {
  const store = await load(); const worker = store.workers.find((item) => item.id === String(req.query.workerId ?? "")); if (!worker?.buyerId) return reply.code(404).send({ error: "worker_unassigned" }); return { buyerId: worker.buyerId };
});

app.post<{ Body: { buyerId?: string; base?: string; discussion?: string; status?: CommentTargetStatus; note?: string } }>("/api/internal/comment-target-status", { preHandler: lpmAdapterOnly }, async (req, reply) => {
  const buyerId = String(req.body?.buyerId ?? ""); const base = String(req.body?.base ?? "").replace(/^@/, "").toLowerCase(); const next = req.body?.status; const allowed: CommentTargetStatus[] = ["CHECKING", "READY", "PENDING_APPROVAL", "UNAVAILABLE", "MUTED"];
  if (!base || !next || !allowed.includes(next)) return reply.code(400).send({ error: "target_invalid" }); const store = await load(); const target = store.commentTargets.find((item) => item.buyerId === buyerId && item.base.toLowerCase() === base); if (!target) return reply.code(404).send({ error: "target_not_found" });
  const previous = `${target.status}|${target.discussion ?? ""}|${target.note ?? ""}`; target.status = next; target.discussion = String(req.body?.discussion ?? "").replace(/^@/, "") || undefined; target.note = String(req.body?.note ?? "").slice(0, 160) || undefined; target.updatedAt = now();
  const current = `${target.status}|${target.discussion ?? ""}|${target.note ?? ""}`;
  if (current !== previous && next !== "CHECKING") {
    const detail = ({ READY: target.discussion ? `Akun lo siap memantau channel dan grup diskusinya (@${target.discussion}).` : "Akun lo siap memantau base ini.", PENDING_APPROVAL: "Permintaan join sedang menunggu persetujuan.", UNAVAILABLE: "Akun lo tidak bisa masuk atau mengakses target ini.", MUTED: "Akun lo tidak bisa mengirim komentar di target ini." } as Record<CommentTargetStatus, string>)[next];
    if (next === "UNAVAILABLE" || next === "MUTED") store.activities.unshift({ buyerId, kind: "COMMENT", status: "failed", label: `Komentar dijeda · @${base}`, at: now() });
    sendBuyerAlert(store, buyerId, `Info Auto Komen · @${base}`, detail);
  }
  await save(store);
  return { ok: true };
});

// Runner mengirim heartbeat ini hanya setelah session Telegram benar-benar lolos
// otorisasi. Kalau Telegram mencabut session, dua modul userbot dihentikan sebelum
// runner boleh mengambil pekerjaan baru.
app.post<{ Body: { buyerId?: string; status?: UserbotAccountStatus; note?: string } }>("/api/internal/userbot-account-status", { preHandler: lpmAdapterOnly }, async (req, reply) => {
  const buyerId = String(req.body?.buyerId ?? ""); const status = req.body?.status;
  const allowed: UserbotAccountStatus[] = ["CONNECTED", "RECONNECT_REQUIRED"];
  if (!buyerId || !status || !allowed.includes(status)) return reply.code(400).send({ error: "account_status_invalid" });
  const store = await load(); const buyer = store.buyers.find((item) => item.id === buyerId);
  if (!buyer) return reply.code(404).send({ error: "buyer_not_found" });
  const note = String(req.body?.note ?? "").replace(/[_\s]+/g, " ").trim().slice(0, 160);
  let removeSession = false;
  if (status === "CONNECTED") {
    buyer.commentAccountConnected = true; buyer.userbotAccountStatus = "CONNECTED"; buyer.userbotLastSeenAt = now(); delete buyer.userbotAccountIssue;
  } else {
    const changed = buyer.userbotAccountStatus !== "RECONNECT_REQUIRED";
    buyer.commentAccountConnected = false; buyer.userbotAccountStatus = "RECONNECT_REQUIRED"; buyer.userbotAccountIssue = note || "Sesi akun sudah tidak aktif."; buyer.commentActive = false; buyer.userBroadcastActive = false;
    const broadcast = broadcastFor(store, buyer.id, "BUYER");
    if (broadcast) { broadcast.nextSendAt = undefined; broadcast.deliveryToken = undefined; broadcast.deliveryUntil = undefined; }
    for (const job of store.commentJobs) if (job.buyerId === buyer.id && (job.status === "PENDING" || job.status === "SENDING")) { job.status = "CANCELED"; delete job.deliveryToken; delete job.deliveryUntil; }
    removeSession = true;
    if (changed) sendBuyerAlert(store, buyer.id, "Hubungkan ulang akun", "Sesi Telegram lo sudah tidak aktif. Auto Sebar dan Auto Komen dijeda sampai akun dihubungkan lagi.");
  }
  buyer.updatedAt = now(); await save(store);
  if (removeSession) await removeCommentSession(buyer.id).catch((error) => app.log.error({ err: error, buyerId }, "Could not remove revoked userbot session"));
  return { ok: true };
});

app.post<{ Body: { buyerId?: string; workerId?: string; chat?: string; type?: "MENTION" | "REPLY" | "MUTED"; text?: string; link?: string } }>("/api/internal/operational-alert", { preHandler: lpmAdapterOnly }, async (req, reply) => {
  const buyerId = String(req.body?.buyerId ?? ""); const chat = String(req.body?.chat ?? "").replace(/^@/, "").toLowerCase(); const type = req.body?.type; const store = await load(); const buyer = store.buyers.find((item) => item.id === buyerId);
  if (!buyer || !chat || !type) return reply.code(400).send({ error: "alert_invalid" });
  const workerId = String(req.body?.workerId ?? ""); const isWorkerSource = workerId && buyer.workerId === workerId && store.lpmTargets.some((item) => item.buyerId === buyerId && targetExecutor(item) === "ADMIN" && item.username.toLowerCase() === chat);
  const isUserbotBroadcastSource = workerId === buyer.id && store.lpmTargets.some((item) => item.buyerId === buyerId && targetExecutor(item) === "BUYER" && item.username.toLowerCase() === chat);
  const isCommentSource = !workerId && store.commentTargets.some((item) => item.buyerId === buyerId && (item.base.toLowerCase() === chat || item.discussion?.toLowerCase() === chat));
  if (!isWorkerSource && !isUserbotBroadcastSource && !isCommentSource) return reply.code(403).send({ error: "alert_source_invalid" });
  const accountLabel = isWorkerSource ? "Akun promosi" : "Akun lo"; const title = type === "MUTED" ? `Info · @${chat}` : type === "MENTION" ? `${accountLabel} di-tag di @${chat}` : `Ada balasan di @${chat}`; const snippet = String(req.body?.text ?? "").trim().replace(/\s+/g, " ").slice(0, 500);
  sendBuyerAlert(store, buyerId, title, snippet || (type === "MUTED" ? "Akun tidak bisa mengirim di target ini." : "Buka pesan untuk melihat detailnya."), String(req.body?.link ?? "") || undefined); return { ok: true };
});

async function clearPendingCommentLogin(buyerId: string) { const login = pendingCommentLogins.get(buyerId); pendingCommentLogins.delete(buyerId); if (login) await login.client.disconnect().catch(() => undefined); }
async function finishCommentLogin(login: PendingCommentLogin, buyer: Buyer, store: Store) { const session = login.client.session.save(); if (!session) throw new Error("Session akun tidak bisa disimpan."); runnerRestartNotBefore.delete("userbot-host"); await saveCommentSession(buyer.id, session); buyer.commentAccountConnected = true; buyer.userbotAccountStatus = "CONNECTED"; buyer.userbotLastSeenAt = now(); delete buyer.userbotAccountIssue; buyer.updatedAt = now(); await save(store); pendingCommentLogins.delete(buyer.id); await login.client.disconnect(); void reconcileRunnersSafely(); }

app.post<{ Body: { phone?: string } }>("/api/buyer/comment-account/send-code", async (req, reply) => {
  const store = await load(); cleanup(store); const buyer = buyerForRequest(store, req);
  if (!buyer) return reply.code(404).send({ error: "buyer_not_found", reason: "Layanan belum disiapkan untuk akun Telegram ini." });
  if (!hasPlanAccess(store, buyer, "COMMENT")) return reply.code(403).send({ error: "subscription_required", reason: "Akses Auto Komen lo belum aktif." });
  if (buyer.commentAccountConnected) return reply.code(409).send({ error: "account_already_connected", reason: "Akun Telegram lo sudah terhubung." });
  const phone = String(req.body?.phone ?? "").trim().replace(/[\s()-]/g, ""); if (!/^\+\d{8,15}$/.test(phone)) return reply.code(400).send({ error: "Masukkan nomor Telegram dengan kode negara." });
  try { await clearPendingCommentLogin(buyer.id); const credentials = telegramCredentials(); const client = new TelegramClient(new StringSession(""), credentials.apiId, credentials.apiHash, { connectionRetries: 3 }); await client.connect(); const sent = await client.sendCode(credentials, phone); buyer.userbotAccountStatus = "CONNECTING"; delete buyer.userbotAccountIssue; buyer.updatedAt = now(); await save(store); pendingCommentLogins.set(buyer.id, { buyerId: buyer.id, phone, phoneCodeHash: sent.phoneCodeHash, client, expiresAt: Date.now() + 5 * 60_000 }); return { ok: true, next: "CODE" }; }
  catch (error) { return reply.code(400).send({ error: telegramReason(error) }); }
});

app.post<{ Body: { code?: string } }>("/api/buyer/comment-account/verify-code", async (req, reply) => {
  const store = await load(); const buyer = buyerForRequest(store, req); if (!buyer) return reply.code(404).send({ error: "buyer_not_found", reason: "Layanan belum disiapkan untuk akun Telegram ini." }); const login = pendingCommentLogins.get(buyer.id); const code = String(req.body?.code ?? "").replace(/\s/g, "");
  if (!login || login.expiresAt < Date.now()) { await clearPendingCommentLogin(buyer.id); return reply.code(409).send({ error: "Kode sudah habis. Kirim ulang kode." }); }
  if (!/^\d{4,8}$/.test(code)) return reply.code(400).send({ error: "Masukkan kode Telegram." });
  try { await login.client.invoke(new Api.auth.SignIn({ phoneNumber: login.phone, phoneCodeHash: login.phoneCodeHash, phoneCode: code })); await finishCommentLogin(login, buyer, store); return { ok: true, next: "DONE" }; }
  catch (error) { const reason = telegramReason(error); if (reason.includes("SESSION PASSWORD NEEDED")) return { ok: true, next: "PASSWORD" }; return reply.code(400).send({ error: reason }); }
});

app.post<{ Body: { password?: string } }>("/api/buyer/comment-account/verify-password", async (req, reply) => {
  const store = await load(); const buyer = buyerForRequest(store, req); if (!buyer) return reply.code(404).send({ error: "buyer_not_found", reason: "Layanan belum disiapkan untuk akun Telegram ini." }); const login = pendingCommentLogins.get(buyer.id); const value = String(req.body?.password ?? "");
  if (!login || login.expiresAt < Date.now()) { await clearPendingCommentLogin(buyer.id); return reply.code(409).send({ error: "Sesi login sudah habis. Mulai lagi." }); }
  if (!value) return reply.code(400).send({ error: "Masukkan password 2FA." });
  try { const passwordInfo = await login.client.invoke(new Api.account.GetPassword()); const check = await telegramPassword.computeCheck(passwordInfo, value); await login.client.invoke(new Api.auth.CheckPassword({ password: check })); await finishCommentLogin(login, buyer, store); return { ok: true, next: "DONE" }; }
  catch (error) { return reply.code(400).send({ error: telegramReason(error) }); }
});

// Dipanggil oleh adapter Telegram userbot saat ada post baru di base. Tidak menyimpan
// isi post secara permanen: hanya jejak anti-duplikat atau kandidat approval singkat.
app.post<{ Body: { buyerId?: string; base?: string; messageId?: string; link?: string; text?: string } }>("/api/internal/incoming-message", { preHandler: lpmAdapterOnly }, async (req, reply) => {
  const body = req.body ?? {}; const targetBuyer = String(body.buyerId ?? ""); const base = String(body.base ?? "").replace(/^@/, ""); const messageId = String(body.messageId ?? ""); const sourceText = String(body.text ?? "").trim(); const text = normalizeMatch(sourceText);
  if (!targetBuyer || !base || !messageId || !text) return reply.code(400).send({ error: "buyerId, base, messageId, dan text wajib ada." });
  const leadKey = `${targetBuyer}:${base.toLowerCase()}:${messageId}`;
  if (incomingLeadLocks.has(leadKey)) return { action: "ignored", reason: "duplicate" };
  incomingLeadLocks.add(leadKey);
  try {
    const store = await load(); cleanup(store); const buyer = store.buyers.find((item) => item.id === targetBuyer); const config = store.commentConfigs.find((item) => item.buyerId === targetBuyer);
    if (!buyer?.commentActive || !hasPlanAccess(store, buyer, "COMMENT") || !config || !buyer.commentAccountConnected) {
      app.log.info({ buyerId: targetBuyer, base, messageId, reason: "comment_off_or_not_ready" }, "Incoming post ignored");
      return { action: "ignored", reason: "comment_off_or_not_ready" };
    }
    const baseAllowed = config.bases.some((item) => item.replace(/^@/, "").toLowerCase() === base.toLowerCase());
    const targetReady = store.commentTargets.some((item) => item.buyerId === targetBuyer && item.base.toLowerCase() === base.toLowerCase() && item.status === "READY");
    const division = config.divisions.map((item) => ({ ...item, hits: item.keywords.filter((word) => matchTerm(word, text)).length, blocked: item.blacklist.some((word) => matchTerm(word, text)) })).filter((item) => item.hits > 0 && !item.blocked).sort((a, b) => b.hits - a.hits)[0];
    const duplicate = store.dedupe.some((item) => item.buyerId === targetBuyer && item.base === base && item.messageId === messageId);
    if (!baseAllowed || !targetReady || !division || duplicate) {
      const reason = !baseAllowed ? "base_not_selected" : !targetReady ? "target_not_ready" : duplicate ? "duplicate" : "keyword_miss";
      app.log.info({ buyerId: targetBuyer, base, messageId, reason, preview: previewText(sourceText).slice(0, 120) }, "Incoming post ignored");
      return { action: "ignored", reason };
    }
    store.dedupe.push({ buyerId: targetBuyer, base, messageId, at: now() });
    if (config.mode === "APPROVAL") {
      const candidate: Candidate = { id: id("lead"), buyerId: targetBuyer, base, messageId, link: String(body.link ?? ""), wording: division.wording, preview: previewText(sourceText), createdAt: now() };
      store.approvalCandidates.push(candidate); await save(store);
      sendApprovalAlert(store, candidate);
      return { action: "approval", candidate, wording: division.wording };
    }
    store.activities.unshift({ buyerId: targetBuyer, kind: "COMMENT", status: "queued", label: `Komentar otomatis · @${base}`, link: String(body.link ?? ""), at: now() });
    cleanup(store); await save(store);
    return { action: "send_comment", wording: division.wording };
  } finally { incomingLeadLocks.delete(leadKey); }
});

app.post<{ Params: { id: string } }>("/api/buyer/approval/:id/send", async (req, reply) => {
  const store = await load(); cleanup(store); await save(store); const buyer = buyerForRequest(store, req); const candidate = store.approvalCandidates.find((item) => item.id === req.params.id && item.buyerId === buyer?.id);
  if (!candidate) return reply.code(404).send({ error: "Kandidat sudah habis atau tidak ditemukan." });
  if (!buyer || !buyer.commentActive || !hasPlanAccess(store, buyer, "COMMENT")) return reply.code(403).send({ error: "subscription_required", reason: "Auto Komen lo sedang tidak aktif." });
  queueApprovedComment(store, candidate); await save(store);
  return { ok: true };
});

app.get<{ Querystring: { buyerId?: string } }>("/api/internal/comment-jobs", { preHandler: lpmAdapterOnly }, async (req) => {
  const buyerId = String(req.query.buyerId ?? ""); const store = await load(); cleanup(store); const buyer = store.buyers.find((item) => item.id === buyerId);
  if (!buyer?.commentActive || !hasPlanAccess(store, buyer, "COMMENT") || !buyer.commentAccountConnected) { await save(store); return { jobs: [] }; }
  const job = store.commentJobs.find((item) => item.buyerId === buyerId && (item.status === "PENDING" || (item.status === "SENDING" && item.deliveryUntil && Date.parse(item.deliveryUntil) <= Date.now())));
  if (!job) return { jobs: [] };
  const token = id("deliver"); job.status = "SENDING"; job.deliveryToken = token; job.deliveryUntil = new Date(Date.now() + 2 * 60_000).toISOString(); await save(store);
  return { jobs: [{ id: job.id, deliveryToken: token, base: job.base, messageId: job.messageId, wording: job.wording, link: job.link }] };
});
app.post<{ Params: { id: string }; Body: { deliveryToken?: string } }>("/api/internal/comment-jobs/:id/confirm", { preHandler: lpmAdapterOnly }, async (req, reply) => {
  const store = await load(); cleanup(store); const job = store.commentJobs.find((item) => item.id === req.params.id); const buyer = job ? store.buyers.find((item) => item.id === job.buyerId) : undefined;
  const targetReady = Boolean(job && store.commentTargets.some((item) => item.buyerId === job.buyerId && item.base.toLowerCase() === job.base.toLowerCase() && item.status === "READY"));
  const allowed = Boolean(job && buyer?.commentActive && buyer.commentAccountConnected && hasPlanAccess(store, buyer, "COMMENT") && job.status === "SENDING" && job.deliveryToken === String(req.body?.deliveryToken ?? "") && targetReady);
  if (!allowed) { if (job?.status === "SENDING") { job.status = "CANCELED"; delete job.deliveryToken; delete job.deliveryUntil; await save(store); } return { send: false }; }
  return { send: true };
});
app.post<{ Params: { id: string }; Body: { deliveryToken?: string; commentMessageId?: number; error?: string } }>("/api/internal/comment-jobs/:id/result", { preHandler: lpmAdapterOnly }, async (req, reply) => {
  const store = await load(); const job = store.commentJobs.find((item) => item.id === req.params.id);
  if (!job || job.status !== "SENDING" || job.deliveryToken !== String(req.body?.deliveryToken ?? "")) return reply.code(409).send({ error: "comment_delivery_not_found" });
  const error = String(req.body?.error ?? "").trim(); job.status = error ? "FAILED" : "DONE"; delete job.deliveryToken; delete job.deliveryUntil;
  store.activities.unshift({ buyerId: job.buyerId, kind: "COMMENT", status: error ? "failed" : "sent", label: error ? `Komentar gagal · @${job.base}` : `Komentar terkirim · @${job.base}`, link: job.link, at: now() }); cleanup(store); await save(store); return { ok: true };
});

app.post<{ Body: { buyerId?: string; base?: string; messageId?: string; commentMessageId?: string | number; wording?: string; link?: string; text?: string } }>("/api/internal/auto-comment-delivered", { preHandler: lpmAdapterOnly }, async (req, reply) => {
  const body = req.body ?? {}; const buyerId = String(body.buyerId ?? ""); const base = String(body.base ?? "").replace(/^@/, ""); const messageId = String(body.messageId ?? ""); const commentMessageId = String(body.commentMessageId ?? "");
  if (!buyerId || !base || !messageId || !commentMessageId) return reply.code(400).send({ error: "Data komentar otomatis belum lengkap." });
  const store = await load(); const buyer = store.buyers.find((item) => item.id === buyerId);
  if (!buyer) return reply.code(404).send({ error: "Buyer tidak ditemukan." });
  if (!buyer.commentActive || !buyer.commentAccountConnected || !hasPlanAccess(store, buyer, "COMMENT")) return reply.code(403).send({ error: "comment_not_ready" });
  const existing = store.commentJobs.find((item) => item.buyerId === buyerId && item.base.toLowerCase() === base.toLowerCase() && item.messageId === messageId && item.commentMessageId === commentMessageId);
  if (existing) return { ok: true, duplicate: true };
  const job: CommentJob = { id: id("comment"), buyerId, base, messageId, commentMessageId, wording: String(body.wording ?? ""), link: String(body.link ?? ""), preview: previewText(String(body.text ?? "")), status: "DONE", createdAt: now() };
  store.commentJobs.push(job); store.activities.unshift({ buyerId, kind: "COMMENT", status: "sent", label: `Komentar otomatis · @${base}`, link: job.link, at: now() }); cleanup(store); await save(store); sendAutoCommentAlert(store, job);
  return { ok: true };
});

app.get<{ Querystring: { buyerId?: string } }>("/api/internal/comment-deletions", { preHandler: lpmAdapterOnly }, async (req) => {
  const buyerId = String(req.query.buyerId ?? ""); const store = await load(); const job = store.commentJobs.find((item) => item.buyerId === buyerId && item.commentMessageId && (item.status === "DELETE_PENDING" || (item.status === "DELETING" && item.deleteUntil && Date.parse(item.deleteUntil) <= Date.now())));
  if (!job) return { jobs: [] };
  const token = id("delete"); job.status = "DELETING"; job.deleteToken = token; job.deleteUntil = new Date(Date.now() + 2 * 60_000).toISOString(); await save(store);
  return { jobs: [{ id: job.id, deleteToken: token, base: job.base, commentMessageId: job.commentMessageId }] };
});

app.post<{ Params: { id: string }; Body: { deleteToken?: string; error?: string } }>("/api/internal/comment-jobs/:id/delete-result", { preHandler: lpmAdapterOnly }, async (req, reply) => {
  const store = await load(); const job = store.commentJobs.find((item) => item.id === req.params.id);
  if (!job || job.deleteToken !== String(req.body?.deleteToken ?? "")) return reply.code(409).send({ error: "comment_deletion_not_found" });
  const error = String(req.body?.error ?? "").trim(); job.status = error ? "DELETE_FAILED" : "DELETED"; delete job.deleteToken; delete job.deleteUntil;
  store.activities.unshift({ buyerId: job.buyerId, kind: "COMMENT", status: error ? "delete_failed" : "deleted", label: error ? `Komentar belum terhapus · @${job.base}` : `Komentar dihapus · @${job.base}`, at: now() }); cleanup(store); await save(store); return { ok: true };
});

app.get("/api/admin/overview", { preHandler: adminOnly }, async () => {
  const store = await load(); if (cleanup(store)) await save(store);
  const workerSessions = Object.keys(await readWorkerSessions());
  return { buyers: store.buyers.map((buyer) => buyerWithEffectiveAccess(store, buyer)), entitlements: Object.fromEntries(store.buyers.map((buyer) => [buyer.id, entitlementSummary(store, buyer)])), workers: store.workers, workerSessions, broadcasts: store.broadcasts, lpmTargets: store.lpmTargets.filter((item) => item.status !== "REMOVED"), comments: store.commentConfigs, subscriptions: store.subscriptions, packages: store.packages, commerce: commerceFor(store) };
});

app.post<{ Params: { id: string }; Body: { product?: "ADMIN_BROADCAST" | "USERBOT_PROMO"; durationDays?: number; maxGroups?: number } }>("/api/admin/buyers/:id/subscriptions", { preHandler: adminOnly }, async (req, reply) => {
  const product = req.body?.product; const durationDays = Math.floor(Number(req.body?.durationDays)); const maxGroups = Math.floor(Number(req.body?.maxGroups));
  if (product !== "ADMIN_BROADCAST" && product !== "USERBOT_PROMO") return reply.code(400).send({ error: "Produk akses tidak valid." });
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 365) return reply.code(400).send({ error: "Masa aktif harus 1 sampai 365 hari." });
  if (!Number.isInteger(maxGroups) || maxGroups < 1) return reply.code(400).send({ error: "Maksimal LPM harus diisi." });
  const store = await load(); const buyer = store.buyers.find((item) => item.id === req.params.id);
  if (!buyer) return reply.code(404).send({ error: "Buyer tidak ditemukan." });
  const endsAt = activateProduct(store, buyer, product, durationDays, maxGroups, "MANUAL"); cleanup(store); await save(store); reconcileRunnersSafely();
  return { ok: true, endsAt, entitlements: entitlementSummary(store, buyer) };
});

app.post<{ Params: { id: string; product: string } }>("/api/admin/buyers/:id/subscriptions/:product/revoke", { preHandler: adminOnly }, async (req, reply) => {
  const product = req.params.product;
  if (product !== "ADMIN_BROADCAST" && product !== "USERBOT_PROMO") return reply.code(400).send({ error: "Produk akses tidak valid." });
  const store = await load(); const buyer = store.buyers.find((item) => item.id === req.params.id);
  if (!buyer) return reply.code(404).send({ error: "Buyer tidak ditemukan." });
  revokeProduct(store, buyer, product); cleanup(store); await save(store); reconcileRunnersSafely();
  return { ok: true, entitlements: entitlementSummary(store, buyer) };
});

const withdrawalFee = 5_000;
const walletTypes = ["DANA", "GoPay", "OVO", "ShopeePay", "LinkAja"] as const;
function payoutDetails(input: { walletType?: string; walletNumber?: string; walletOwner?: string }): Pick<PayoutProfile, "walletType" | "walletNumber" | "walletOwner"> {
  const walletType = String(input.walletType ?? "") as WalletType;
  const walletNumber = String(input.walletNumber ?? "").replace(/\D/g, "");
  const walletOwner = String(input.walletOwner ?? "").trim().replace(/\s+/g, " ");
  if (!walletTypes.includes(walletType)) throw new Error("Pilih e-wallet tujuan.");
  if (walletNumber.length < 8 || walletNumber.length > 16) throw new Error("Isi nomor e-wallet yang benar.");
  if (!walletOwner || walletOwner.length > 80) throw new Error("Isi nama pemilik e-wallet.");
  return { walletType, walletNumber, walletOwner };
}
function withdrawalNotifyChatId() {
  const chatId = String(process.env.WITHDRAW_NOTIFY_TELEGRAM_ID ?? "").trim();
  if (!/^\d+$/.test(chatId)) throw new Error("Tujuan notifikasi penarikan belum diatur.");
  return chatId;
}
app.get("/api/admin/payout-profile", { preHandler: adminOnly }, async (req) => {
  const store = await load(); const telegramId = telegramUserId(req)!;
  return { profile: store.payoutProfiles.find((item) => item.telegramId === telegramId) ?? null };
});
app.put<{ Body: { walletType?: string; walletNumber?: string; walletOwner?: string } }>("/api/admin/payout-profile", { preHandler: adminOnly }, async (req, reply) => {
  let details: ReturnType<typeof payoutDetails>; try { details = payoutDetails(req.body ?? {}); } catch (error) { return reply.code(400).send({ error: "wallet_invalid", reason: (error as Error).message }); }
  const store = await load(); const telegramId = telegramUserId(req)!; const profile: PayoutProfile = { telegramId, ...details, updatedAt: now() };
  store.payoutProfiles = [...store.payoutProfiles.filter((item) => item.telegramId !== telegramId), profile]; await save(store);
  return { ok: true, profile };
});
app.post("/api/admin/withdrawals", { preHandler: adminOnly }, async (req, reply) => {
  const store = await load(); const summary = commerceFor(store);
  if (!withdrawWindowOpen()) return reply.code(409).send({ error: "withdraw_window_closed", reason: "Penarikan bisa diajukan mulai pukul 12.30 WIB." });
  if (summary.availableBalance < 30_000) return reply.code(409).send({ error: "withdrawal_minimum", reason: "Saldo siap tarik belum mencapai Rp30.000." });
  const requester = telegramUser(req); const profile = store.payoutProfiles.find((item) => item.telegramId === requester?.id);
  if (!profile) return reply.code(409).send({ error: "payout_profile_required", reason: "Atur tujuan e-wallet dulu." });
  let notifyChatId: string; try { notifyChatId = withdrawalNotifyChatId(); } catch (error) { return reply.code(503).send({ error: "withdrawal_unavailable", reason: (error as Error).message }); }
  if (!bot) return reply.code(503).send({ error: "withdrawal_unavailable", reason: "Bot belum siap mengirim permintaan penarikan." });
  const eligible = store.payments.filter((item) => item.status === "PAID" && item.paidAt && (!item.withdrawalId || !store.withdrawals.some((withdrawal) => withdrawal.id === item.withdrawalId && (withdrawal.status === "REQUESTED" || withdrawal.status === "PAID"))) && pakasirAvailableAt(item.paidAt).getTime() <= Date.now());
  const grossAmount = eligible.reduce((sum, item) => sum + item.amount, 0);
  if (grossAmount !== summary.availableBalance) return reply.code(409).send({ error: "withdrawal_changed", reason: "Saldo berubah. Buka ulang halaman lalu coba lagi." });
  const withdrawal: Withdrawal = { id: id("withdraw"), telegramId: requester?.id ?? "", grossAmount, fee: withdrawalFee, netAmount: grossAmount - withdrawalFee, walletType: profile.walletType, walletNumber: profile.walletNumber, walletOwner: profile.walletOwner, status: "REQUESTED", createdAt: now() };
  const text = ["Permintaan tarik saldo", `Diajukan oleh: ${requester?.name ?? "Admin client"}`, "", `Saldo siap tarik: Rp${new Intl.NumberFormat("id-ID").format(withdrawal.grossAmount)}`, `Potongan admin: Rp${new Intl.NumberFormat("id-ID").format(withdrawal.fee)}`, `Dikirim ke client: Rp${new Intl.NumberFormat("id-ID").format(withdrawal.netAmount)}`, "", "Tujuan e-wallet", `${withdrawal.walletType}: ${withdrawal.walletNumber}`, `a.n. ${withdrawal.walletOwner}`, "", `ID: ${withdrawal.id}`].join("\n");
  try { await bot.api.sendMessage(notifyChatId, text, { reply_markup: new InlineKeyboard().text("Tandai sudah dikirim", `wd:p:${withdrawal.id}`) }); }
  catch { return reply.code(502).send({ error: "withdrawal_notify_failed", reason: "Permintaan belum terkirim. Coba lagi." }); }
  for (const payment of eligible) payment.withdrawalId = withdrawal.id;
  store.withdrawals.push(withdrawal); await save(store);
  return { ok: true, withdrawal, commerce: commerceFor(store) };
});

app.get("/api/health", async () => ({ ok: true, bot: botPollingStatus }));

function validatePackage(input: { service?: Product; name?: string; price?: number; durationDays?: number; maxGroups?: number; enabled?: boolean }): Omit<Package, "id" | "updatedAt"> {
  const service = input.service;
  if (service !== "ADMIN_BROADCAST" && service !== "USERBOT_PROMO") throw new Error("Pilih produk paket.");
  const price = Math.max(0, Math.floor(Number(input.price) || 0)); const durationDays = Math.max(1, Math.min(365, Math.floor(Number(input.durationDays) || 30))); const maxGroups = Math.floor(Number(input.maxGroups) || 15);
  if (price > 10_000_000) throw new Error("Isi harga dan masa aktif paket dengan benar.");
  if (maxGroups < 1) throw new Error("Jumlah LPM minimal 1.");
  if (input.enabled && price < 1) throw new Error("Isi harga sebelum membuka paket untuk buyer.");
  const productName = service === "ADMIN_BROADCAST" ? "Auto Sebar" : "Userbot Promosi";
  return { service, name: String(input.name ?? "").trim() || `${productName} · ${durationDays} Hari`, price, durationDays, maxGroups, enabled: Boolean(input.enabled) };
}
app.post<{ Body: { service?: Product; name?: string; price?: number; durationDays?: number; maxGroups?: number; enabled?: boolean } }>("/api/admin/packages", { preHandler: adminOnly }, async (req, reply) => {
  try { const value = validatePackage(req.body); const store = await load(); if (store.packages.some((item) => item.service === value.service && item.durationDays === value.durationDays && item.maxGroups === value.maxGroups)) return reply.code(409).send({ error: "Pilihan paket ini sudah ada." }); const item: Package = { id: id("package"), ...value, updatedAt: now() }; store.packages.push(item); await save(store); return { package: item }; }
  catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
});
app.put<{ Params: { id: string }; Body: { service?: Product; name?: string; price?: number; durationDays?: number; maxGroups?: number; enabled?: boolean } }>("/api/admin/packages/:id", { preHandler: adminOnly }, async (req, reply) => {
  try { const store = await load(); const item = store.packages.find((entry) => entry.id === req.params.id); if (!item) return reply.code(404).send({ error: "Paket tidak ditemukan." }); const value = validatePackage({ ...req.body, service: item.service }); if (store.packages.some((entry) => entry.id !== item.id && entry.service === value.service && entry.durationDays === value.durationDays && entry.maxGroups === value.maxGroups)) return reply.code(409).send({ error: "Pilihan paket ini sudah ada." }); Object.assign(item, value, { updatedAt: now() }); await save(store); return { package: item }; }
  catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
});
app.delete<{ Params: { id: string } }>("/api/admin/packages/:id", { preHandler: adminOnly }, async (req, reply) => {
  const store = await load(); const item = store.packages.find((entry) => entry.id === req.params.id); if (!item) return reply.code(404).send({ error: "Paket tidak ditemukan." });
  if (store.payments.some((payment) => payment.packageId === item.id)) return reply.code(409).send({ error: "Paket yang sudah memiliki transaksi tidak bisa dihapus." });
  store.packages = store.packages.filter((entry) => entry.id !== item.id); await save(store); return { ok: true };
});

app.post<{ Body: { name?: string; telegramId?: string } }>("/api/admin/buyers", { preHandler: adminOnly }, async (req, reply) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) return reply.code(400).send({ error: "Nama buyer wajib diisi." });
  const store = await load(); const buyer: Buyer = { id: id("buyer"), name, telegramId: String(req.body.telegramId ?? ""), broadcastActive: false, commentActive: false, commentAccountConnected: false, planBroadcast: false, planComment: false, workerId: null, updatedAt: now() };
  store.buyers.push(buyer); await save(store); return { buyer };
});

app.post<{ Body: { label?: string; username?: string } }>("/api/admin/workers", { preHandler: adminOnly }, async (req, reply) => {
  const label = String(req.body.label ?? "").trim();
  if (!label) return reply.code(400).send({ error: "Isi nama akun worker." });
  const store = await load();
  const worker: Worker = { id: id("worker"), label, username: "", status: "AVAILABLE", buyerId: null, createdAt: now() }; store.workers.push(worker); await save(store); return { worker };
});

async function finishWorkerLogin(login: PendingWorkerLogin, worker: Worker, store: Store) {
  const me = await login.client.getMe(); const username = "username" in me ? String(me.username ?? "") : "";
  if (!username) throw new Error("Akun Telegram ini belum memiliki username.");
  if (store.workers.some((item) => item.id !== worker.id && item.username.toLowerCase() === username.toLowerCase())) throw new Error(`@${username} sudah terdaftar sebagai worker.`);
  worker.username = username; await save(store);
  const session = login.client.session.save(); if (!session) throw new Error("Session akun tidak bisa disimpan.");
  await saveWorkerSession(worker.id, session); pendingWorkerLogins.delete(worker.id); await login.client.disconnect(); runnerRestartNotBefore.delete("worker:" + worker.id); startWorkerRunner(worker.id);
  return username;
}
async function clearPendingWorkerLogin(workerId: string) { const login = pendingWorkerLogins.get(workerId); pendingWorkerLogins.delete(workerId); if (login) await login.client.disconnect().catch(() => undefined); }

app.post<{ Params: { id: string }; Body: { phone?: string } }>("/api/admin/workers/:id/login/send-code", { preHandler: adminOnly }, async (req, reply) => {
  const phone = String(req.body?.phone ?? "").trim().replace(/[\s()-]/g, "");
  if (!/^\+\d{8,15}$/.test(phone)) return reply.code(400).send({ error: "Masukkan nomor Telegram dengan kode negara, contoh +62812…" });
  const store = await load(); const worker = store.workers.find((item) => item.id === req.params.id); if (!worker) return reply.code(404).send({ error: "Akun worker tidak ditemukan." });
  try {
    await clearPendingWorkerLogin(worker.id); const credentials = telegramCredentials(); const client = new TelegramClient(new StringSession(""), credentials.apiId, credentials.apiHash, { connectionRetries: 3 });
    await client.connect(); const sent = await client.sendCode(credentials, phone); pendingWorkerLogins.set(worker.id, { workerId: worker.id, phone, phoneCodeHash: sent.phoneCodeHash, client, expiresAt: Date.now() + 5 * 60_000 });
    return { ok: true, next: "CODE", viaApp: sent.isCodeViaApp };
  } catch (error) { return reply.code(400).send({ error: telegramReason(error) }); }
});

app.post<{ Params: { id: string }; Body: { code?: string } }>("/api/admin/workers/:id/login/verify-code", { preHandler: adminOnly }, async (req, reply) => {
  const code = String(req.body?.code ?? "").replace(/\s/g, ""); const login = pendingWorkerLogins.get(req.params.id);
  if (!login || login.expiresAt < Date.now()) { await clearPendingWorkerLogin(req.params.id); return reply.code(409).send({ error: "Kode sudah habis. Kirim ulang kode." }); }
  if (!/^\d{4,8}$/.test(code)) return reply.code(400).send({ error: "Masukkan kode Telegram." });
  const store = await load(); const worker = store.workers.find((item) => item.id === login.workerId); if (!worker) return reply.code(404).send({ error: "Akun worker tidak ditemukan." });
  try { await login.client.invoke(new Api.auth.SignIn({ phoneNumber: login.phone, phoneCodeHash: login.phoneCodeHash, phoneCode: code })); const username = await finishWorkerLogin(login, worker, store); return { ok: true, next: "DONE", username }; }
  catch (error) { const reason = telegramReason(error); if (reason.includes("SESSION PASSWORD NEEDED")) return { ok: true, next: "PASSWORD" }; return reply.code(400).send({ error: reason }); }
});

app.post<{ Params: { id: string }; Body: { password?: string } }>("/api/admin/workers/:id/login/verify-password", { preHandler: adminOnly }, async (req, reply) => {
  const value = String(req.body?.password ?? ""); const login = pendingWorkerLogins.get(req.params.id);
  if (!login || login.expiresAt < Date.now()) { await clearPendingWorkerLogin(req.params.id); return reply.code(409).send({ error: "Sesi login sudah habis. Mulai lagi." }); }
  if (!value) return reply.code(400).send({ error: "Masukkan password 2FA." });
  const store = await load(); const worker = store.workers.find((item) => item.id === login.workerId); if (!worker) return reply.code(404).send({ error: "Akun worker tidak ditemukan." });
  try { const passwordInfo = await login.client.invoke(new Api.account.GetPassword()); const check = await telegramPassword.computeCheck(passwordInfo, value); await login.client.invoke(new Api.auth.CheckPassword({ password: check })); const username = await finishWorkerLogin(login, worker, store); return { ok: true, next: "DONE", username }; }
  catch (error) { return reply.code(400).send({ error: telegramReason(error) }); }
});

app.delete<{ Params: { id: string } }>("/api/admin/workers/:id", { preHandler: adminOnly }, async (req, reply) => {
  const store = await load(); const worker = store.workers.find((item) => item.id === req.params.id);
  if (!worker) return reply.code(404).send({ error: "Worker tidak ditemukan." });
  if (worker.buyerId) return reply.code(409).send({ error: "Worker sedang dipakai buyer dan tidak bisa dihapus." });
  await clearPendingWorkerLogin(worker.id); stopWorkerRunner(worker.id); await removeWorkerSession(worker.id);
  store.workers = store.workers.filter((item) => item.id !== worker.id); await save(store); return { ok: true };
});

app.post<{ Params: { id: string }; Body: { planBroadcast?: boolean; planComment?: boolean; workerId?: string | null; broadcastMode?: "TEXT" | "FORWARD"; wording?: string; forwardLink?: string; showForwardSource?: boolean; groups?: string[]; intervalMinutes?: number; bases?: string; divisions?: unknown; mode?: "APPROVAL" | "AUTO" } }>("/api/admin/buyers/:id/setup", { preHandler: adminOnly }, async (req, reply) => {
  const store = await load(); const buyer = store.buyers.find((item) => item.id === req.params.id);
  if (!buyer) return reply.code(404).send({ error: "Buyer tidak ditemukan." });
  if (Boolean(req.body.planBroadcast) && !hasPlanAccess(store, buyer, "BROADCAST")) return reply.code(403).send({ error: "subscription_required", reason: "Akses Auto Sebar belum aktif." });
  if (Boolean(req.body.planComment) && !hasPlanAccess(store, buyer, "COMMENT")) return reply.code(403).send({ error: "subscription_required", reason: "Akses Userbot Promosi belum aktif." });
  if (Boolean(req.body.planBroadcast)) {
    const worker = store.workers.find((item) => item.id === req.body.workerId);
    if (!worker || (worker.status !== "AVAILABLE" && worker.buyerId !== buyer.id)) return reply.code(409).send({ error: "Pilih worker yang tersedia untuk buyer ini." });
    let content: ReturnType<typeof broadcastContent>; try { content = broadcastContent({ mode: req.body.broadcastMode, wording: req.body.wording, forwardLink: req.body.forwardLink, showForwardSource: req.body.showForwardSource }); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    let groups: string[]; try { groups = cleanGroups(req.body.groups, maxGroupsForBuyer(store, buyer)); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    for (const item of store.workers) if (item.buyerId === buyer.id && item.id !== worker.id) { item.buyerId = null; item.status = "AVAILABLE"; }
    worker.buyerId = buyer.id; worker.status = "ASSIGNED"; delete worker.cooldownUntil; buyer.workerId = worker.id;
    syncLpmTargets(store, buyer, worker.id, "ADMIN", groups);
    const broadcast: Broadcast = { buyerId: buyer.id, executor: "ADMIN", ...content, groups, intervalMinutes: broadcastInterval(req.body.intervalMinutes), updatedBy: "ADMIN", updatedAt: now() };
    store.broadcasts = [...store.broadcasts.filter((item) => item.buyerId !== buyer.id || broadcastExecutor(item) !== "ADMIN"), broadcast];
  } else { buyer.broadcastActive = false; for (const target of store.lpmTargets.filter((item) => item.buyerId === buyer.id && targetExecutor(item) === "ADMIN" && item.desired)) { target.desired = false; target.status = "REMOVING"; target.updatedAt = now(); } releaseWorkerWhenGroupsCleared(store, buyer); store.broadcasts = store.broadcasts.filter((item) => item.buyerId !== buyer.id || broadcastExecutor(item) !== "ADMIN"); }
  if (Boolean(req.body.planComment)) {
    let divisions: CommentDivision[]; try { divisions = cleanDivisions(req.body.divisions); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    const config: CommentConfig = { buyerId: buyer.id, bases: split(req.body.bases), divisions, mode: req.body.mode === "AUTO" ? "AUTO" : "APPROVAL", updatedAt: now(), updatedBy: "ADMIN" };
    store.commentConfigs = [...store.commentConfigs.filter((item) => item.buyerId !== buyer.id), config]; syncCommentTargets(store, buyer.id, config.bases);
  } else { buyer.commentActive = false; store.commentConfigs = store.commentConfigs.filter((item) => item.buyerId !== buyer.id); }
  buyer.updatedAt = now(); await save(store); return { ok: true, buyer };
});

// These are deliberately separate from the legacy all-in-one setup route above.
// Admin can now change one service without accidentally overwriting the other.
app.put<{ Params: { id: string }; Body: { enabled?: boolean; workerId?: string; mode?: "TEXT" | "FORWARD"; wording?: string; forwardLink?: string; showForwardSource?: boolean; groups?: string[]; intervalMinutes?: number } }>("/api/admin/buyers/:id/broadcast-config", { preHandler: adminOnly }, async (req, reply) => {
  const store = await load(); const buyer = store.buyers.find((item) => item.id === req.params.id);
  if (!buyer) return reply.code(404).send({ error: "Buyer tidak ditemukan." });
  if (!req.body.enabled) {
    buyer.broadcastActive = false; unlockBroadcast(buyer, "ADMIN");
    for (const target of store.lpmTargets.filter((item) => item.buyerId === buyer.id && targetExecutor(item) === "ADMIN" && item.desired)) { target.desired = false; target.status = "REMOVING"; target.updatedAt = now(); }
    releaseWorkerWhenGroupsCleared(store, buyer); store.broadcasts = store.broadcasts.filter((item) => item.buyerId !== buyer.id || broadcastExecutor(item) !== "ADMIN");
    buyer.updatedAt = now(); await save(store); return { ok: true, buyer };
  }
  if (!hasPlanAccess(store, buyer, "BROADCAST")) return reply.code(403).send({ error: "subscription_required", reason: "Akses Auto Sebar belum aktif." });
  if (!req.body.workerId) {
    unlockBroadcast(buyer, "ADMIN"); buyer.updatedAt = now(); await save(store);
    return { ok: true, buyer };
  }
  try { requireBroadcastLock(buyer, "ADMIN"); } catch (error) { return reply.code(409).send({ error: "setup_locked", reason: (error as Error).message }); }
  const worker = store.workers.find((item) => item.id === req.body.workerId);
  if (!worker || (worker.status !== "AVAILABLE" && worker.buyerId !== buyer.id)) return reply.code(409).send({ error: "Pilih akun kerja yang tersedia." });
  let content: ReturnType<typeof broadcastContent>; try { content = broadcastContent(req.body ?? {}); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  let groups: string[]; try { groups = cleanGroups(req.body.groups, maxGroupsForBuyer(store, buyer)); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  for (const item of store.workers) if (item.buyerId === buyer.id && item.id !== worker.id) { item.buyerId = null; item.status = "AVAILABLE"; }
  worker.buyerId = buyer.id; worker.status = "ASSIGNED"; delete worker.cooldownUntil; buyer.workerId = worker.id;
  syncLpmTargets(store, buyer, worker.id, "ADMIN", groups);
  const broadcast: Broadcast = { buyerId: buyer.id, executor: "ADMIN", ...content, groups, intervalMinutes: broadcastInterval(req.body.intervalMinutes), updatedBy: "ADMIN", updatedAt: now() };
  store.broadcasts = [...store.broadcasts.filter((item) => item.buyerId !== buyer.id || broadcastExecutor(item) !== "ADMIN"), broadcast]; unlockBroadcast(buyer, "ADMIN"); buyer.updatedAt = now(); await save(store);
  return { ok: true, buyer, broadcast };
});

app.post<{ Params: { id: string } }>("/api/admin/buyers/:id/broadcast-config/edit", { preHandler: adminOnly }, async (req, reply) => {
  const store = await load(); const buyer = store.buyers.find((item) => item.id === req.params.id);
  if (!buyer) return reply.code(404).send({ error: "Buyer tidak ditemukan." });
  try { broadcastLock(buyer, "ADMIN"); await save(store); return { ok: true, buyer }; }
  catch (error) { return reply.code(409).send({ error: "setup_locked", reason: (error as Error).message }); }
});
app.post<{ Params: { id: string } }>("/api/admin/buyers/:id/broadcast-config/cancel", { preHandler: adminOnly }, async (req, reply) => {
  const store = await load(); const buyer = store.buyers.find((item) => item.id === req.params.id); if (buyer) unlockBroadcast(buyer, "ADMIN"); await save(store); return { ok: true };
});

app.post<{ Params: { id: string } }>("/api/admin/buyers/:id/comment-config/edit", { preHandler: adminOnly }, async (req, reply) => {
  const store = await load(); const buyer = store.buyers.find((item) => item.id === req.params.id);
  if (!buyer) return reply.code(404).send({ error: "Buyer tidak ditemukan." });
  try { const config = commentLock(commentConfigFor(store, buyer.id), "ADMIN"); await save(store); return { ok: true, config }; }
  catch (error) { return reply.code(409).send({ error: "setup_locked", reason: (error as Error).message }); }
});
app.post<{ Params: { id: string } }>("/api/admin/buyers/:id/comment-config/cancel", { preHandler: adminOnly }, async (req, reply) => {
  const store = await load(); const config = store.commentConfigs.find((item) => item.buyerId === req.params.id); if (config) unlockComment(config, "ADMIN"); await save(store); return { ok: true };
});
app.put<{ Params: { id: string }; Body: { enabled?: boolean; bases?: string; divisions?: unknown; mode?: "APPROVAL" | "AUTO" } }>("/api/admin/buyers/:id/comment-config", { preHandler: adminOnly }, async (req, reply) => {
  const store = await load(); const buyer = store.buyers.find((item) => item.id === req.params.id);
  if (!buyer) return reply.code(404).send({ error: "Buyer tidak ditemukan." });
  if (!req.body.enabled) {
    buyer.commentActive = false; buyer.userBroadcastActive = false; store.commentConfigs = store.commentConfigs.filter((item) => item.buyerId !== buyer.id);
    buyer.updatedAt = now(); await save(store); return { ok: true, buyer };
  }
  if (!hasPlanAccess(store, buyer, "COMMENT")) return reply.code(403).send({ error: "subscription_required", reason: "Akses Userbot Promosi belum aktif." });
  const bases = split(req.body.bases);
  if (!bases.length) {
    buyer.updatedAt = now(); await save(store);
    return { ok: true, buyer };
  }
  const current = commentConfigFor(store, buyer.id);
  try { requireCommentLock(current, "ADMIN"); } catch (error) { return reply.code(409).send({ error: "setup_locked", reason: (error as Error).message }); }
  let divisions: CommentDivision[]; try { divisions = cleanDivisions(req.body.divisions); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  current.bases = bases; current.divisions = divisions; current.mode = req.body.mode === "AUTO" ? "AUTO" : "APPROVAL"; current.updatedAt = now(); current.updatedBy = "ADMIN"; unlockComment(current, "ADMIN"); syncCommentTargets(store, buyer.id, current.bases); buyer.updatedAt = now(); await save(store);
  const config = current;
  return { ok: true, buyer, config };
});

app.post<{ Body: { order_id?: string; amount?: number; project?: string; status?: string } }>("/api/payments/pakasir/webhook", async (req, reply) => {
  if (!selfServiceSubscriptionsEnabled) return reply.code(503).send({ error: "subscriptions_closed", reason: "Aktivasi otomatis sedang ditutup." });
  let config: ReturnType<typeof pakasirConfig>; try { config = pakasirConfig(); } catch { return reply.code(503).send({ error: "payment_unavailable" }); }
  const orderId = String(req.body?.order_id ?? "");
  const store = await load(); const payment = store.payments.find((item) => item.gatewayReference === orderId);
  if (!payment) return reply.code(404).send({ error: "payment_not_found" });
  if (payment.status === "PAID") return { ok: true, status: "already_paid" };
  // The webhook only triggers verification. Access is granted exclusively after
  // Pakasir Transaction Detail confirms the stored amount, project and order ID.
  if (String(req.body?.project ?? "") !== config.project || Number(req.body?.amount) !== payment.amount || String(req.body?.status ?? "").toLowerCase() !== "completed") return reply.code(400).send({ error: "payment_payload_invalid" });
  try {
    const status = await pakasirTransaction(config, payment);
    if (status !== "completed") return reply.code(409).send({ error: "payment_not_completed" });
    activatePaidPackage(store, payment); await save(store);
    return { ok: true };
  } catch (error) {
    return reply.code(503).send({ error: "payment_verification_failed", reason: (error as Error).message });
  }
});

const token = process.env.BOT_TOKEN;
if (token) {
  bot = new Bot(token);
  botPollingStatus = "starting";
  const miniAppUrl = process.env.MINIAPP_URL;
  bot.command("start", async (ctx) => {
    await ctx.reply("Buka layanan promosi lo dari Mini App.", miniAppUrl ? { reply_markup: new InlineKeyboard().webApp("Buka Mini App", miniAppUrl) } : undefined);
  });
  bot.command("id", async (ctx) => { await ctx.reply("ID Telegram lo: " + String(ctx.from?.id ?? "")); });
  bot.callbackQuery(/^wd:p:(withdraw_[a-z0-9]+)/, async (ctx) => { await withStoreLock(async () => {
    let notifyChatId = ""; try { notifyChatId = withdrawalNotifyChatId(); } catch { await ctx.answerCallbackQuery({ text: "Tujuan penarikan belum diatur." }); return; }
    if (String(ctx.from.id) !== notifyChatId) { await ctx.answerCallbackQuery({ text: "Tombol ini khusus pengelola penarikan." }); return; }
    const store = await load(); const withdrawal = store.withdrawals.find((item) => item.id === ctx.match[1]);
    if (!withdrawal || withdrawal.status !== "REQUESTED") { await ctx.answerCallbackQuery({ text: "Permintaan ini sudah diproses." }); await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined); return; }
    withdrawal.status = "PAID"; withdrawal.paidAt = now(); await save(store);
    await ctx.answerCallbackQuery({ text: "Ditandai sudah dikirim." }); await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    const buyer = store.buyers.find((item) => item.telegramId === withdrawal.telegramId);
    if (buyer && bot) void bot.api.sendMessage(buyer.telegramId, `Penarikan Rp${new Intl.NumberFormat("id-ID").format(withdrawal.netAmount)} sudah dikirim.`).catch(() => undefined);
  }); });
  bot.callbackQuery(/^cm:(g|b):(lead_[a-z0-9]+)/, async (ctx) => { await withStoreLock(async () => {
    const store = await load(); const candidate = store.approvalCandidates.find((item) => item.id === ctx.match[2]); const buyer = candidate ? store.buyers.find((item) => item.id === candidate.buyerId) : undefined;
    if (!candidate || !buyer || buyer.telegramId !== String(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Lead ini sudah diproses atau tidak tersedia." }); return; }
    if (ctx.match[1] === "b") { store.approvalCandidates = store.approvalCandidates.filter((item) => item.id !== candidate.id); const acknowledged = ctx.answerCallbackQuery({ text: "Ditandai OOT." }); await save(store); await acknowledged; await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined); return; }
    if (!buyer.commentActive || !hasPlanAccess(store, buyer, "COMMENT")) { store.approvalCandidates = store.approvalCandidates.filter((item) => item.id !== candidate.id); const acknowledged = ctx.answerCallbackQuery({ text: "Auto Komen sedang tidak aktif." }); await save(store); await acknowledged; await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined); return; }
    queueApprovedComment(store, candidate); const acknowledged = ctx.answerCallbackQuery({ text: "Komentar sedang dikirim." }); await save(store); await acknowledged; await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
  }); });
  bot.callbackQuery(/^cm:d:(comment_[a-z0-9]+)/, async (ctx) => { await withStoreLock(async () => {
    const store = await load(); const job = store.commentJobs.find((item) => item.id === ctx.match[1]); const buyer = job ? store.buyers.find((item) => item.id === job.buyerId) : undefined;
    if (!job || !buyer || buyer.telegramId !== String(ctx.from.id) || job.status !== "DONE" || !job.commentMessageId) { await ctx.answerCallbackQuery({ text: "Komentar ini sudah diproses atau tidak tersedia." }); await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined); return; }
    job.status = "DELETE_PENDING"; const acknowledged = ctx.answerCallbackQuery({ text: "Komentar sedang dihapus." }); await save(store); await acknowledged; await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
  }); });
  // Error boundary: tanpa ini, satu update bermasalah (misal penerima sudah
  // block bot saat antrean update lama diputar ulang) me-reject bot.start()
  // dan polling mati permanen walaupun server masih hidup.
  bot.catch((error) => { app.log.warn({ err: error.error ?? error }, "Bot Telegram menemukan error pada satu update; polling tetap jalan."); });
  void bot.start({ onStart: (info) => { botPollingStatus = "ready"; botUsername = info.username ?? botUsername; app.log.info({ username: info.username }, "Bot Telegram siap menerima pesan"); if (miniAppUrl) void bot?.api.setChatMenuButton({ menu_button: { type: "web_app", text: "Buka layanan", web_app: { url: miniAppUrl } } }).catch((error) => app.log.error(error, "Menu Mini App belum tersambung")); } }).catch((error) => { botPollingStatus = `error: ${telegramReason(error)}`; app.log.error(error, "Bot Telegram gagal menerima pesan"); });
}

const runnerReconcileInterval = setInterval(() => { reconcileRunnersSafely(); }, 30_000);
runnerReconcileInterval.unref();
// Jejak memori tiap 60 detik: kalau kontainer OOM lagi, tren naiknya keliatan
// di log Railway sebelum proses mati — nggak perlu nebak-nebak lagi.
const memoryLogInterval = setInterval(() => {
  const memory = process.memoryUsage();
  app.log.info({ rssMb: Math.round(memory.rss / 1048576), heapUsedMb: Math.round(memory.heapUsed / 1048576), runners: (userbotRunner ? 1 : 0) + workerRunners.size, userbotAccounts: userbotRosterSize }, "Memory usage");
}, 60_000);
memoryLogInterval.unref();
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(runnerReconcileInterval); if (runnerReconcileTimer) clearTimeout(runnerReconcileTimer);
  for (const workerId of [...workerRunners.keys()]) stopWorkerRunner(workerId);
  stopUserbotRunner();
  for (const login of pendingWorkerLogins.values()) await login.client.disconnect().catch(() => undefined);
  for (const login of pendingCommentLogins.values()) await login.client.disconnect().catch(() => undefined);
  await bot?.stop().catch(() => undefined); await app.close().catch(() => undefined);
}
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
await app.listen({ port: Number(process.env.PORT ?? 8787), host: "0.0.0.0" });
reapOrphanedRunners();
reconcileRunnersSafely();
