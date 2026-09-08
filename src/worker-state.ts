export type WorkerAvailabilityStatus = "AVAILABLE" | "ASSIGNED" | "COOLDOWN" | "DISABLED";
export type WorkerAccountStatus = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECT_REQUIRED";

export type WorkerState = {
  id: string;
  username: string;
  status: WorkerAvailabilityStatus;
  buyerId: string | null;
  accountStatus?: WorkerAccountStatus;
};

export type ManagedLpmTarget = {
  id: string;
  buyerId: string;
  workerId: string;
  executor?: "ADMIN" | "BUYER";
  username: string;
  status: "CONNECTING" | "PENDING_APPROVAL" | "READY" | "UNAVAILABLE" | "REMOVING" | "REMOVED";
  desired: boolean;
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export function effectiveWorkerAccountStatus(worker: WorkerState, hasSession: boolean): WorkerAccountStatus {
  if (!hasSession) return "DISCONNECTED";
  if (worker.accountStatus) return worker.accountStatus;
  // Kompatibilitas worker lama: sebelum field accountStatus tersedia, worker
  // yang sudah punya username + session adalah akun yang sebelumnya siap pakai.
  return worker.username ? "CONNECTED" : "DISCONNECTED";
}

export function workerCanBeAssigned(worker: WorkerState, hasSession: boolean, buyerId?: string): boolean {
  if (worker.status === "DISABLED" || worker.status === "COOLDOWN") return false;
  if (effectiveWorkerAccountStatus(worker, hasSession) !== "CONNECTED") return false;
  if (worker.buyerId) return Boolean(buyerId && worker.buyerId === buyerId);
  return worker.status === "AVAILABLE";
}

export function syncManagedLpmTargets(
  targets: ManagedLpmTarget[],
  buyerId: string,
  executorId: string,
  executor: "ADMIN" | "BUYER",
  groups: string[],
  timestamp: string,
  createId: () => string,
) {
  const wanted = new Set(groups.map((item) => item.toLowerCase()));
  const current = targets.filter((item) => item.buyerId === buyerId && (item.executor === "BUYER" ? "BUYER" : "ADMIN") === executor && item.desired);

  // Saat worker diganti, target worker lama harus tetap hidup sebagai job LEAVE.
  // Record target baru dibuat terpisah agar akun baru bisa JOIN tanpa menghapus
  // jejak pekerjaan akun lama.
  for (const target of current) {
    if (target.workerId === executorId && wanted.has(target.username.toLowerCase())) continue;
    target.desired = false;
    target.status = "REMOVING";
    delete target.note;
    target.updatedAt = timestamp;
  }

  for (const username of groups) {
    const existing = targets.find((item) => item.buyerId === buyerId && (item.executor === "BUYER" ? "BUYER" : "ADMIN") === executor && item.workerId === executorId && item.username.toLowerCase() === username.toLowerCase());
    if (existing) {
      existing.desired = true;
      existing.executor = executor;
      if (existing.status !== "CONNECTING") {
        existing.status = "CONNECTING";
        delete existing.note;
      }
      existing.updatedAt = timestamp;
      continue;
    }
    targets.push({ id: createId(), buyerId, workerId: executorId, executor, username, status: "CONNECTING", desired: true, createdAt: timestamp, updatedAt: timestamp });
  }
}

export function workerHasPendingTargets(targets: ManagedLpmTarget[], workerId: string): boolean {
  return targets.some((item) => item.workerId === workerId && (item.executor === "BUYER" ? "BUYER" : "ADMIN") === "ADMIN" && item.status !== "REMOVED");
}
