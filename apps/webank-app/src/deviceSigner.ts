/**
 * Boundary for a future iOS Secure Enclave module.
 * A caller must only send this proof after a fresh biometric-only key use.
 * expo-local-authentication alone cannot produce a bank-verifiable signature.
 */
export type ActionVerification = {
  action_hash: `sha256:${string}`;
  device_signature: string;
  request_number?: string;
};

export type SignActionInput = {
  actionHash: `sha256:${string}`;
  approvalId: string;
  expiresAt: string;
  requestNumber?: string;
};

export interface DeviceSigner {
  isRegistered(): Promise<boolean>;
  signAction(input: SignActionInput): Promise<ActionVerification>;
}

export const unavailableDeviceSigner: DeviceSigner = {
  async isRegistered() {
    return false;
  },
  async signAction() {
    throw new Error(
      "No registered biometric-only Secure Enclave key is available.",
    );
  },
};

export function canSubmitLiveApproval(
  signerRegistered: boolean,
  approvalExpiresAt: string,
  requestNumber: string | undefined,
  requiresNumber: boolean,
  now = Date.now(),
): boolean {
  return (
    signerRegistered &&
    Date.parse(approvalExpiresAt) > now &&
    (!requiresNumber || /^\d{6}$/.test(requestNumber ?? ""))
  );
}
