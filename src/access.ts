export type Plan = "BROADCAST" | "USERBOT_BROADCAST" | "COMMENT";
export type Product = "ADMIN_BROADCAST" | "USERBOT_PROMO";

export function productPlans(product: Product): Plan[] { return product === "ADMIN_BROADCAST" ? ["BROADCAST"] : ["USERBOT_BROADCAST", "COMMENT"]; }
export function extendedEndsAt(timestamp: number, activeEndsAt: readonly string[], durationDays: number) {
  const extensionStart = Math.max(timestamp, ...activeEndsAt.map(Date.parse).filter(Number.isFinite));
  return new Date(extensionStart + durationDays * 86_400_000).toISOString();
}
export function retainUserbotSession(commentAccess: boolean, userbotBroadcastAccess: boolean) { return commentAccess || userbotBroadcastAccess; }
export function shouldCancelCommentWork(commentAccess: boolean) { return !commentAccess; }
export function shouldNotifyExpiry(productHasAccess: boolean, alreadyNotified: boolean) { return !productHasAccess && !alreadyNotified; }

export type AccessBuyer = {
  id: string;
  planBroadcast: boolean;
  planUserBroadcast?: boolean;
  planComment: boolean;
};

export type AccessSubscription = {
  buyerId: string;
  plan: Plan;
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  endsAt: string;
};

export type AccessStore = { subscriptions: readonly AccessSubscription[] };

function manualAccess(buyer: AccessBuyer, plan: Plan) {
  if (plan === "BROADCAST") return buyer.planBroadcast;
  if (plan === "USERBOT_BROADCAST") return Boolean(buyer.planUserBroadcast);
  return buyer.planComment;
}

function writeManualAccess(buyer: AccessBuyer, plan: Plan, enabled: boolean) {
  if (plan === "BROADCAST") buyer.planBroadcast = enabled;
  else if (plan === "USERBOT_BROADCAST") buyer.planUserBroadcast = enabled;
  else buyer.planComment = enabled;
}

function hasActiveSubscription(store: AccessStore, buyer: AccessBuyer, plan: Plan, timestamp: number) {
  return store.subscriptions.some((item) => item.buyerId === buyer.id && item.plan === plan && item.status === "ACTIVE" && Date.parse(item.endsAt) > timestamp);
}

/** Active subscriptions win; otherwise the persisted flag is a deliberate manual grant. */
export function hasPlanAccess(store: AccessStore, buyer: AccessBuyer, plan: Plan, timestamp = Date.now()) {
  return hasActiveSubscription(store, buyer, plan, timestamp) || manualAccess(buyer, plan);
}

/** Admin setup should not create a hidden perpetual grant beside an active payment. */
export function setManualPlanAccess(store: AccessStore, buyer: AccessBuyer, plan: Plan, enabled: boolean, timestamp = Date.now()) {
  if (hasActiveSubscription(store, buyer, plan, timestamp) && enabled) return;
  writeManualAccess(buyer, plan, enabled);
}

/** Payment becomes the source of truth for its plans, preventing access after expiry. */
export function clearManualPlanAccess(buyer: AccessBuyer, plans: readonly Plan[]) {
  for (const plan of plans) writeManualAccess(buyer, plan, false);
}

/** Mirrors cleanup's entitlement flags without touching any Telegram-specific state. */
export function reconcileManualPlanFlags(store: AccessStore, buyer: AccessBuyer, timestamp = Date.now()) {
  const hasSubscriptionHistory = store.subscriptions.some((item) => item.buyerId === buyer.id);
  const access = {
    broadcast: hasPlanAccess(store, buyer, "BROADCAST", timestamp),
    userbotBroadcast: hasPlanAccess(store, buyer, "USERBOT_BROADCAST", timestamp),
    comment: hasPlanAccess(store, buyer, "COMMENT", timestamp),
  };
  if (!hasSubscriptionHistory) return access;
  if (!access.broadcast) buyer.planBroadcast = false;
  if (!access.userbotBroadcast) buyer.planUserBroadcast = false;
  if (!access.comment) buyer.planComment = false;
  return access;
}

/** API responses expose effective entitlement while storage keeps only manual grants. */
export function buyerWithEffectiveAccess<T extends AccessBuyer>(store: AccessStore, buyer: T, timestamp = Date.now()) {
  return {
    ...buyer,
    planBroadcast: hasPlanAccess(store, buyer, "BROADCAST", timestamp),
    planUserBroadcast: hasPlanAccess(store, buyer, "USERBOT_BROADCAST", timestamp),
    planComment: hasPlanAccess(store, buyer, "COMMENT", timestamp),
  };
}
