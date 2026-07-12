import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ebayAuthorizeUrl, ebayExchangeCode } from "@/lib/platforms/ebay";

describe("eBay OAuth identity capture", () => {
  beforeEach(() => {
    process.env.EBAY_CLIENT_ID = "client-id";
    process.env.EBAY_CLIENT_SECRET = "client-secret";
    process.env.EBAY_RU_NAME = "runame";
    process.env.EBAY_ENV = "production";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.EBAY_CLIENT_ID;
    delete process.env.EBAY_CLIENT_SECRET;
    delete process.env.EBAY_RU_NAME;
    delete process.env.EBAY_ENV;
  });

  it("requests the public identity scope", () => {
    const url = decodeURIComponent(ebayAuthorizeUrl("state-1"));
    expect(url).toContain("commerce.identity.readonly");
  });

  it("stores the immutable eBay user id after code exchange", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 7200,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            userId: "immutable-user",
            username: "seller-name",
            registrationMarketplaceId: "EBAY_US",
          }),
          { status: 200 }
        )
      );

    const connection = await ebayExchangeCode("auth-code");

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://apiz.ebay.com/commerce/identity/v1/user/",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
        }),
      })
    );
    expect(connection.meta).toEqual({
      ebayUserId: "immutable-user",
      ebayUsername: "seller-name",
      ebayRegistrationMarketplaceId: "EBAY_US",
    });
  });

  it("refuses to save an unidentifiable eBay connection", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token", expires_in: 60 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await expect(ebayExchangeCode("auth-code")).rejects.toThrow(
      "immutable user id"
    );
  });
});
