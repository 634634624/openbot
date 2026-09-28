import { parseBillingPortalRequest } from "@openbot/contracts/billing";
import { describe, expect, it, vi } from "vitest";
import { type BillingAuthClient, BillingDesktopService } from "./billing-service";

describe("billing desktop service", () => {
  it.each([
    "https://evil.test/p/session/bps_1",
    "http://billing.stripe.com/p/session/bps_1",
    "https://billing.stripe.com.evil.test/p/session/bps_1",
    "https://user@billing.stripe.com/p/session/bps_1",
    "https://checkout.stripe.com/c/pay/cs_1",
    "javascript:alert(1)",
  ])("opens no page that is not a Customer Portal page: %s", async (url) => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const service = new BillingDesktopService(accountServer({ url }), openExternal);

    await expect(service.openPortal({ flow: "manage" })).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens the Stripe page that the account server returns", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const service = new BillingDesktopService(
      accountServer({ url: "https://billing.stripe.com/p/session/bps_1" }),
      openExternal,
    );

    await service.openPortal({ flow: "cancel", subscriptionId: "sub_1" });
    expect(openExternal).toHaveBeenCalledWith("https://billing.stripe.com/p/session/bps_1");
  });

  it("takes only a flow and a subscription id from the renderer", () => {
    expect(parseBillingPortalRequest({ flow: "manage", subscriptionId: "sub_1", url: "https://evil.test" })).toEqual({
      flow: "manage",
    });
    expect(parseBillingPortalRequest({ flow: "update", subscriptionId: "sub_1", returnUrl: "x" })).toEqual({
      flow: "update",
      subscriptionId: "sub_1",
    });
    expect(parseBillingPortalRequest({ flow: "cancel", subscriptionId: "sub_1/../customers" })).toBeNull();
    expect(parseBillingPortalRequest({ flow: "cancel" })).toBeNull();
    expect(parseBillingPortalRequest({ flow: "checkout" })).toBeNull();
    expect(parseBillingPortalRequest("manage")).toBeNull();
  });
});

function accountServer(response: unknown): BillingAuthClient {
  return {
    async requestAuthorized(_path, _init, decoder) {
      return decoder(response);
    },
  };
}
