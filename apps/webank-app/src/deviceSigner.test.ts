import { describe, expect, it } from "vitest";
import { canSubmitLiveApproval, unavailableDeviceSigner } from "./deviceSigner";

describe("live approval signing gate", () => {
  it("fails closed without a registered Secure Enclave signer", async () => {
    expect(await unavailableDeviceSigner.isRegistered()).toBe(false);
    await expect(
      unavailableDeviceSigner.signAction({
        actionHash: `sha256:${"a".repeat(64)}`,
        approvalId: "apr_one",
        expiresAt: "2026-10-14T12:03:00Z",
        requestNumber: "123456",
      }),
    ).rejects.toThrow("No registered biometric-only Secure Enclave key");
    expect(
      canSubmitLiveApproval(
        false,
        "2026-10-14T12:03:00Z",
        "123456",
        true,
        Date.parse("2026-10-14T12:00:00Z"),
      ),
    ).toBe(false);
  });

  it("requires a fresh action and exact six digit connector number", () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    expect(
      canSubmitLiveApproval(true, "2026-10-14T12:03:00Z", "12345", true, now),
    ).toBe(false);
    expect(
      canSubmitLiveApproval(true, "2026-10-14T12:00:00Z", "123456", true, now),
    ).toBe(false);
    expect(
      canSubmitLiveApproval(true, "2026-10-14T12:03:00Z", "123456", true, now),
    ).toBe(true);
  });
});
