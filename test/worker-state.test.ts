import assert from "node:assert/strict";
import test from "node:test";
import { effectiveWorkerAccountStatus, syncManagedLpmTargets, workerCanBeAssigned, workerHasPendingTargets, type ManagedLpmTarget, type WorkerState } from "../src/worker-state.ts";

const worker = (overrides: Partial<WorkerState> = {}): WorkerState => ({ id: "worker_1", username: "workerone", status: "AVAILABLE", buyerId: null, accountStatus: "CONNECTED", ...overrides });

test("worker baru tanpa session tidak dapat menerima buyer", () => {
  assert.equal(workerCanBeAssigned(worker(), false), false);
});

test("worker sehat dan tersedia dapat menerima buyer", () => {
  assert.equal(workerCanBeAssigned(worker(), true), true);
});

test("worker reconnect required tidak dapat menerima buyer", () => {
  assert.equal(workerCanBeAssigned(worker({ accountStatus: "RECONNECT_REQUIRED" }), true), false);
});

test("worker nonaktif tetap tidak dapat menerima buyer walau session sehat", () => {
  assert.equal(workerCanBeAssigned(worker({ status: "DISABLED" }), true), false);
});

test("worker assigned hanya dapat dipakai ulang oleh buyer yang sama", () => {
  const assigned = worker({ status: "ASSIGNED", buyerId: "buyer_1" });
  assert.equal(workerCanBeAssigned(assigned, true, "buyer_1"), true);
  assert.equal(workerCanBeAssigned(assigned, true, "buyer_2"), false);
});

test("worker legacy dengan username dan session tetap kompatibel", () => {
  const legacy = worker({ accountStatus: undefined });
  assert.equal(effectiveWorkerAccountStatus(legacy, true), "CONNECTED");
});

test("pergantian worker membuat target lama draining dan target baru connecting", () => {
  const targets: ManagedLpmTarget[] = [{ id: "old", buyerId: "buyer_1", workerId: "worker_old", executor: "ADMIN", username: "grupsatu", status: "READY", desired: true, createdAt: "old", updatedAt: "old" }];
  syncManagedLpmTargets(targets, "buyer_1", "worker_new", "ADMIN", ["grupsatu"], "now", () => "new");
  assert.deepEqual(targets.map(({ id, workerId, status, desired }) => ({ id, workerId, status, desired })), [
    { id: "old", workerId: "worker_old", status: "REMOVING", desired: false },
    { id: "new", workerId: "worker_new", status: "CONNECTING", desired: true },
  ]);
  assert.equal(workerHasPendingTargets(targets, "worker_old"), true);
  targets[0].status = "REMOVED";
  assert.equal(workerHasPendingTargets(targets, "worker_old"), false);
});

test("target yang dihapus dari setup masuk antrean leave", () => {
  const targets: ManagedLpmTarget[] = [{ id: "one", buyerId: "buyer_1", workerId: "worker_1", executor: "ADMIN", username: "grupsatu", status: "READY", desired: true, createdAt: "old", updatedAt: "old" }];
  syncManagedLpmTargets(targets, "buyer_1", "worker_1", "ADMIN", ["gruplain"], "now", () => "two");
  assert.equal(targets[0].status, "REMOVING");
  assert.equal(targets[0].desired, false);
  assert.deepEqual(targets[1], { id: "two", buyerId: "buyer_1", workerId: "worker_1", executor: "ADMIN", username: "gruplain", status: "CONNECTING", desired: true, createdAt: "now", updatedAt: "now" });
});
