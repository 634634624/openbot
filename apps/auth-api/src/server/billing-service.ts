import {
  BILLING_INTERVALS,
  BILLING_METADATA,
  BILLING_PLAN_IDS,
  BILLING_SUBSCRIPTION_STATUSES,
  type BillingPortalRequest,
  type BillingServerPlan,
  type BillingState,
  isBillingAmount,
  parseBillingLookupKey,
} from "@openbot/contracts/billing";
import { isDynamicRecord, isOneOf, isString } from "@openbot/contracts/runtime-values";
import {
  isBillingCurrency,
  parseStripeEvent,
  StripeClient,
  type StripeEvent,
  type StripeFetch,
  StripeRequestError,
  type StripeSubscription,
  subscriptionAmount,
  subscriptionCustomerId,
  subscriptionPeriodEnd,
  verifyStripeSignature,
} from "./stripe-client";

/** Stripe retries a webhook for up to 3 days, so older event ids are not needed to stop duplicates. */
const WEBHOOK_EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const OPEN_STATUSES_SQL = "('active', 'trialing', 'past_due', 'unpaid', 'paused')";
/** The Remote host id shape (`requiredIdentifier` in remote-control-plane.ts). Other values are stored as no server. */
const SERVER_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/u;

/** Where the Stripe page sends the user back: the desktop return page or the web client. */
export type BillingReturnTarget = "desktop" | "web";

export class BillingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const BILLING_UNAVAILABLE_STATE: BillingState = { available: false, hasCustomer: false, servers: [] };

interface ServerPlanRow {
  stripe_subscription_id: string;
  server_id: string | null;
  server_name: string | null;
  plan: string;
  interval: string;
  currency: string;
  amount: number | null;
  status: string;
  current_period_end: number | null;
  cancel_at_period_end: number;
}

export interface BillingServiceOptions {
  database: D1Database;
  secretKey: string;
  webhookSecret: string | null;
  fetch: StripeFetch;
  now?: () => number;
}

export class BillingService {
  readonly #database: D1Database;
  readonly #stripe: StripeClient;
  readonly #webhookSecret: string | null;
  readonly #now: () => number;

  constructor(options: BillingServiceOptions) {
    this.#database = options.database;
    this.#stripe = new StripeClient(options.secretKey, options.fetch);
    this.#webhookSecret = options.webhookSecret;
    this.#now = options.now ?? Date.now;
  }

  /** The open plan of each server. The server name comes only from a host that the same account owns. */
  async getState(userId: string): Promise<BillingState> {
    const [customer, rows] = await Promise.all([
      this.#customerId(userId),
      this.#database
        .prepare(
          `SELECT s.stripe_subscription_id, s.server_id, h.name AS server_name, s.plan, s.interval, s.currency,
                  s.amount, s.status, s.current_period_end, s.cancel_at_period_end
           FROM billing_subscriptions s
           LEFT JOIN remote_hosts h ON h.host_id = s.server_id AND h.owner_user_id = s.user_id
           WHERE s.user_id = ? AND s.status IN ${OPEN_STATUSES_SQL}
           ORDER BY h.name IS NULL, h.name COLLATE NOCASE, s.updated_at DESC`,
        )
        .bind(userId)
        .all<ServerPlanRow>(),
    ]);
    const servers = rows.results.flatMap((row) => {
      const server = serverPlan(row);
      return server ? [server] : [];
    });
    return { available: true, hasCustomer: customer !== null, servers };
  }

  /**
   * Returns a Customer Portal page. The plan change and cancel flows open on one subscription, after
   * the service checks that the subscription belongs to the account.
   */
  async createPortal(
    userId: string,
    request: BillingPortalRequest,
    target: BillingReturnTarget,
    origin: string,
  ): Promise<string> {
    const customerId = await this.#customerId(userId);
    if (!customerId) throw new BillingError(404, "no_customer", "No billing account exists yet.");
    const returnUrl = portalReturnUrl(origin, target);
    if (request.flow === "manage") {
      return this.#stripeCall(() => this.#stripe.createPortalSession({ customerId, returnUrl }));
    }
    const owned = await this.#database
      .prepare(
        `SELECT 1 AS owned FROM billing_subscriptions
         WHERE stripe_subscription_id = ? AND user_id = ? AND stripe_customer_id = ? AND status IN ${OPEN_STATUSES_SQL}`,
      )
      .bind(request.subscriptionId, userId, customerId)
      .first<{ owned: number }>();
    if (!owned) throw new BillingError(404, "no_subscription", "This plan does not exist.");
    const type = request.flow === "update" ? "subscription_update" : "subscription_cancel";
    return this.#stripeCall(() =>
      this.#stripe.createPortalSession({
        customerId,
        returnUrl,
        flow: { type, subscriptionId: request.subscriptionId },
      }),
    );
  }

  /**
   * Applies one Stripe event. Each event gets the subscription from Stripe again, so a late or repeated
   * event cannot write an old state. An error makes the route answer 500, so Stripe sends the event again.
   */
  async handleWebhook(payload: string, signature: string | null): Promise<void> {
    if (!this.#webhookSecret) throw new BillingError(503, "billing_unavailable", "Billing is not available.");
    const now = this.#now();
    if (!(await verifyStripeSignature(payload, signature, this.#webhookSecret, now))) {
      throw new BillingError(400, "invalid_signature", "The Stripe signature is invalid.");
    }
    const event = parseStripeEvent(payload);
    if (!event) throw new BillingError(400, "invalid_event", "The Stripe event is invalid.");
    const seen = await this.#database
      .prepare("SELECT 1 AS seen FROM billing_webhook_events WHERE event_id = ?")
      .bind(event.id)
      .first<{ seen: number }>();
    if (seen) return;
    const subscriptionId = eventSubscriptionId(event);
    if (subscriptionId) await this.#syncSubscription(subscriptionId);
    // The event is recorded only after it is applied, so a failed event is applied again on retry.
    await this.#database.batch([
      this.#database
        .prepare("INSERT OR IGNORE INTO billing_webhook_events(event_id, type, received_at) VALUES (?, ?, ?)")
        .bind(event.id, event.type, now),
      this.#database
        .prepare("DELETE FROM billing_webhook_events WHERE received_at < ?")
        .bind(now - WEBHOOK_EVENT_RETENTION_MS),
    ]);
  }

  async #syncSubscription(subscriptionId: string): Promise<void> {
    const subscription = await this.#stripeCall(() => this.#stripe.getSubscription(subscriptionId));
    const customerId = subscriptionCustomerId(subscription);
    const key = parseBillingLookupKey(subscription.items.data[0]?.price.lookup_key);
    const currency = subscription.currency.toLowerCase();
    if (!key || !isBillingCurrency(currency) || !isOneOf(BILLING_SUBSCRIPTION_STATUSES, subscription.status)) {
      console.warn("billing: subscription is not an OpenBot plan", { subscriptionId });
      return;
    }
    const ownerId = await this.#subscriptionOwner(subscription, customerId);
    if (!ownerId) return;
    const serverId = subscription.metadata[BILLING_METADATA.serverId];
    await this.#database
      .prepare(
        `INSERT INTO billing_subscriptions(
           stripe_subscription_id, user_id, stripe_customer_id, server_id, plan, interval, currency, amount,
           status, current_period_end, cancel_at_period_end, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stripe_subscription_id) DO UPDATE SET
           server_id = excluded.server_id,
           plan = excluded.plan,
           interval = excluded.interval,
           currency = excluded.currency,
           amount = excluded.amount,
           status = excluded.status,
           current_period_end = excluded.current_period_end,
           cancel_at_period_end = excluded.cancel_at_period_end,
           updated_at = excluded.updated_at`,
      )
      .bind(
        subscription.id,
        ownerId,
        customerId,
        serverId && SERVER_ID_PATTERN.test(serverId) ? serverId : null,
        key.plan,
        key.interval,
        currency,
        subscriptionAmount(subscription),
        subscription.status,
        subscriptionPeriodEnd(subscription),
        subscription.cancel_at_period_end ? 1 : 0,
        this.#now(),
      )
      .run();
  }

  /**
   * The account of a subscription. A known customer names it. For a new customer, the subscription
   * metadata names the account, and the service links the customer to it. The service never moves a
   * customer or an account to a second link.
   */
  async #subscriptionOwner(subscription: StripeSubscription, customerId: string): Promise<string | null> {
    const known = await this.#database
      .prepare("SELECT user_id FROM billing_customers WHERE stripe_customer_id = ?")
      .bind(customerId)
      .first<{ user_id: string }>();
    if (known) return known.user_id;
    const userId = subscription.metadata[BILLING_METADATA.userId];
    const user = userId
      ? await this.#database.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first<{ id: string }>()
      : null;
    if (!user) {
      console.warn("billing: subscription names no OpenBot account", { subscriptionId: subscription.id });
      return null;
    }
    const now = this.#now();
    await this.#database
      .prepare(
        `INSERT INTO billing_customers(user_id, stripe_customer_id, created_at, updated_at)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .bind(user.id, customerId, now, now)
      .run();
    if ((await this.#customerId(user.id)) === customerId) return user.id;
    console.warn("billing: account already has another Stripe customer", { subscriptionId: subscription.id });
    return null;
  }

  async #customerId(userId: string): Promise<string | null> {
    const row = await this.#database
      .prepare("SELECT stripe_customer_id FROM billing_customers WHERE user_id = ?")
      .bind(userId)
      .first<{ stripe_customer_id: string }>();
    return row?.stripe_customer_id ?? null;
  }

  async #stripeCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof StripeRequestError)) throw error;
      // The error message holds only Stripe's error type and code.
      console.error("billing: Stripe request failed", error.message);
      throw new BillingError(
        502,
        "payment_service_failed",
        "The payment service could not complete the request. Try again later.",
      );
    }
  }
}

function serverPlan(row: ServerPlanRow): BillingServerPlan | null {
  if (
    !isOneOf(BILLING_PLAN_IDS, row.plan) ||
    !isOneOf(BILLING_INTERVALS, row.interval) ||
    !isBillingCurrency(row.currency) ||
    !(row.amount === null || isBillingAmount(row.amount)) ||
    !isOneOf(BILLING_SUBSCRIPTION_STATUSES, row.status)
  ) {
    return null;
  }
  return {
    subscriptionId: row.stripe_subscription_id,
    serverId: row.server_id,
    serverName: row.server_name,
    plan: row.plan,
    interval: row.interval,
    currency: row.currency,
    amount: row.amount,
    status: row.status,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
  };
}

function portalReturnUrl(origin: string, target: BillingReturnTarget): string {
  if (target === "web") return `${origin}/app?billing=portal`;
  return `${origin}/billing/return`;
}

/** The subscription that an event is about, or null for an event that does not change one. */
function eventSubscriptionId(event: StripeEvent): string | null {
  const object = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
      return object.mode === "subscription" && isString(object.subscription) ? object.subscription : null;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      return isString(object.id) ? object.id : null;
    case "invoice.paid":
    case "invoice.payment_failed": {
      if (isString(object.subscription)) return object.subscription;
      // From API version 2025-03-31 the invoice names its subscription under `parent`.
      const details = isDynamicRecord(object.parent) ? object.parent.subscription_details : null;
      return isDynamicRecord(details) && isString(details.subscription) ? details.subscription : null;
    }
    default:
      return null;
  }
}
