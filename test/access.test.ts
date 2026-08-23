import assert from "node:assert/strict";
import test from "node:test";
import { clearManualPlanAccess, hasPlanAccess, reconcileManualPlanFlags } from "../src/access.ts";

const now = Date.parse("2026-08-23T00:00:00.000Z");
const buyer = (overrides = {}) => ({ id: "buyer_1", planBroadcast: false, planUserBroadcast: false, planComment: false, ...overrides });
const expired = { buyerId: "buyer_1", plan: "BROADCAST" as const, status: "EXPIRED" as const, endsAt: "2026-08-22T00:00:00.000Z" };
const active = { buyerId: "buyer_1", plan: "BROADCAST" as const, status: "ACTIVE" as const, endsAt: "2026-08-24T00:00:00.000Z" };

test("expired subscription falls back to a deliberate manual grant", () => {
  assert.equal(hasPlanAccess({ subscriptions: [expired] }, buyer({ planBroadcast: true }), "BROADCAST", now), true);
});

test("expired subscription without a manual grant has no access", () => {
  assert.equal(hasPlanAccess({ subscriptions: [expired] }, buyer(), "BROADCAST", now), false);
});

test("active subscription grants access without a manual flag", () => {
  assert.equal(hasPlanAccess({ subscriptions: [active] }, buyer(), "BROADCAST", now), true);
});

test("payment path clears the manual flags covered by its subscription", () => {
  const value = buyer({ planBroadcast: true, planUserBroadcast: true, planComment: true });
  clearManualPlanAccess(value, ["BROADCAST", "COMMENT"]);
  assert.deepEqual(value, buyer({ planBroadcast: false, planUserBroadcast: true, planComment: false }));
});

test("cleanup leaves a manual grant untouched when there is no subscription history", () => {
  const value = buyer({ planBroadcast: true });
  const access = reconcileManualPlanFlags({ subscriptions: [] }, value, now);
  assert.equal(access.broadcast, true);
  assert.equal(value.planBroadcast, true);
});
