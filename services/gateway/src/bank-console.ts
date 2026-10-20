import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { type Decision, demoVariants, type Mandate } from "@webank/contracts";

type CheckName = Decision["checks"][number]["name"];
type CheckResult = Decision["checks"][number]["result"];
type Light = "AMBER" | "GREEN" | "RED";
type Scene =
  | "treasurer_renewal_reserved"
  | "treasurer_renewal_paid"
  | "treasurer_topup_blocked";

export type BankConsoleEvent = {
  id: number;
  at: string;
  kind:
    | "pairing"
    | "mandate_lock"
    | "payment"
    | "check"
    | "precheck_denial"
    | "guardian"
    | "owner_approval"
    | "settlement"
    | "simulation";
  subject?: string;
  app?: string;
  merchant?: string;
  amount_fen?: number;
  light?: Light;
  model?: string;
  variant?: string;
  gtin_preview?: string;
  max_fen?: number;
  check?: CheckName;
  result?: CheckResult;
  reason?: string;
  elapsed_ms?: number | null;
  source?: "Hermes" | null;
  action?: "pairing" | "mandate" | "payment";
  request_number_matched?: true | null;
  biometric?: "simulated" | "verified";
  status?: "waiting" | "paid" | "denied" | "reconciliation_required";
  approval_source?: "owner" | "auto" | null;
  tx_preview?: string | null;
  block_number?: string | null;
  scene?: Scene;
  simulated?: true;
};

const merchants: Record<string, string> = {
  mch_shopA: "Shop A Electronics",
  mch_shopB: "Field Supply",
  mch_malicious: "Flash Deal Outlet",
  mch_decoy: "Demo decoy merchant",
};

const apps: Record<string, string> = {
  "Claude Code": "Claude Code",
  "claude.ai": "claude.ai",
};

const safeReasons: Record<string, string> = {
  merchant_unknown: "payee not in registry",
  merchant_signature_invalid: "merchant signature invalid",
  fire_drill_decoy: "registered demo decoy",
  variant_sku_mismatch: "signed item differs from registry",
  product_model_mismatch: "signed item differs from lock",
  duplicate_order: "duplicate order",
  duplicate_payment: "duplicate payment",
  over_per_payment_cap: "over per-payment cap",
  over_daily_cap: "over daily cap",
  over_monthly_cap: "over monthly cap",
  insufficient_wallet_funds: "wallet funds unavailable",
  first_payment_requires_number_match: "first purchase needs request number",
  guardian_unavailable: "Guardian unavailable",
  intent_mismatch: "purchase intent mismatch",
};

export function isLoopbackConsoleRequest(
  peer: string,
  host: string | undefined,
  origin: string | undefined,
): boolean {
  const localPeer =
    peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  const localHost =
    typeof host === "string" &&
    /^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(host);
  return localPeer && localHost && (!origin || origin === `http://${host}`);
}

function shortId(value: string): string {
  const match = /^(pay|mdt|agt|dec|aud)_[a-zA-Z0-9_-]+$/.exec(value);
  return match
    ? `${match[1]}_${createHash("sha256").update(value).digest("hex").slice(0, 10)}…`
    : "event";
}

function shortTx(value: string | undefined): string | null {
  return value && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? `${value.slice(0, 8)}…`
    : null;
}

function lockFacts(mandate: Mandate) {
  const product = mandate.constraints.find((item) => item.type === "product");
  const budget = mandate.constraints.find((item) => item.type === "budget");
  const same = (left: string | null | undefined, right: string) =>
    !left || left.trim().toLowerCase() === right.toLowerCase();
  const known = demoVariants.find((item) => {
    if (!product) return false;
    const referenced =
      product.skus?.includes(item.sku) || product.gtin === item.gtin;
    return (
      referenced &&
      same(product.brand, item.brand) &&
      same(product.model, item.model) &&
      same(product.variant, item.variant) &&
      (!product.gtin || product.gtin === item.gtin)
    );
  });
  return {
    model: known ? `${known.brand} ${known.model}` : "Product unavailable",
    variant:
      known && (product?.variant || product?.skus?.length === 1)
        ? known.variant
        : "Variant not fixed",
    gtin_preview: known ? `${known.gtin.slice(0, 2)}…` : "Unavailable",
    max_fen: budget?.max.amount,
  };
}

export class BankConsoleTape {
  private nextId = 1;
  private readonly events: BankConsoleEvent[] = [];
  private readonly simulationKeys = new Set<string>();
  private readonly settlementKeys = new Set<string>();

  constructor(private readonly simulationPath?: string) {}

  private append(event: Omit<BankConsoleEvent, "id">): void {
    this.events.push({ id: this.nextId++, ...event });
    if (this.events.length > 400) this.events.shift();
  }

  recordPairing(input: {
    agentId: string;
    clientAppName: string;
    simulated: boolean;
    at: string;
  }): void {
    this.append({
      at: input.at,
      kind: "pairing",
      subject: shortId(input.agentId),
      app: apps[input.clientAppName] ?? "Connected app",
      light: "AMBER",
      request_number_matched: true,
      biometric: input.simulated ? "simulated" : "verified",
    });
  }

  recordMandate(mandate: Mandate): void {
    this.append({
      at: mandate.created_at,
      kind: "mandate_lock",
      subject: shortId(mandate.mandate_id),
      ...lockFacts(mandate),
    });
  }

  recordPaymentDecision(input: {
    paymentId: string;
    mandate?: Mandate;
    merchantId: string;
    amountFen: number;
    light: Light;
    decision: Decision;
    guardianElapsedMs: number | null;
    guardianSource: "Hermes" | null;
  }): void {
    const { decision } = input;
    const subject = shortId(input.paymentId);
    this.append({
      at: decision.created_at,
      kind: "payment",
      subject,
      merchant: merchants[input.merchantId] ?? "Registered merchant",
      amount_fen: input.amountFen,
      light: input.light,
    });
    if (input.mandate)
      this.append({
        at: decision.created_at,
        kind: "mandate_lock",
        subject,
        ...lockFacts(input.mandate),
      });
    for (const check of decision.checks) {
      const reason =
        typeof check.detail?.reason === "string"
          ? safeReasons[check.detail.reason]
          : undefined;
      if (check.name === "guardian") {
        this.append({
          at: decision.created_at,
          kind: "guardian",
          subject,
          result: check.result,
          reason,
          elapsed_ms: input.guardianElapsedMs,
          source: input.guardianSource,
        });
      } else {
        this.append({
          at: decision.created_at,
          kind: "check",
          subject,
          check: check.name,
          result: check.result,
          ...(reason ? { reason } : {}),
        });
      }
    }
    if (decision.outcome === "STEP_UP")
      this.append({
        at: decision.created_at,
        kind: "settlement",
        subject,
        status: "waiting",
      });
  }

  recordEarlyDenial(input: {
    decisionId: string;
    code: string;
    merchantId?: string;
    at: string;
  }): void {
    const subject = shortId(input.decisionId);
    this.append({
      at: input.at,
      kind: "payment",
      subject,
      merchant: input.merchantId
        ? (merchants[input.merchantId] ?? "Unregistered payee")
        : "Payee unavailable",
    });
    this.append({
      at: input.at,
      kind: "precheck_denial",
      subject,
      result: "deny",
      reason: safeReasons[input.code] ?? "payment request invalid",
    });
    this.append({
      at: input.at,
      kind: "settlement",
      subject,
      status: "denied",
    });
  }

  recordOwnerApproval(input: {
    paymentId: string;
    requestNumberMatched: boolean;
    simulated: boolean;
    at: string;
  }): void {
    this.append({
      at: input.at,
      kind: "owner_approval",
      subject: shortId(input.paymentId),
      action: "payment",
      request_number_matched: input.requestNumberMatched ? true : null,
      biometric: input.simulated ? "simulated" : "verified",
    });
  }

  recordSettlement(input: {
    paymentId: string;
    status: "paid" | "denied" | "reconciliation_required";
    approvalSource?: "owner" | "auto" | null;
    tx?: string;
    blockNumber?: bigint | null;
    at: string;
  }): void {
    const key = `${input.paymentId}:${input.status}:${input.tx ?? ""}`;
    if (this.settlementKeys.has(key)) return;
    this.settlementKeys.add(key);
    this.append({
      at: input.at,
      kind: "settlement",
      subject: shortId(input.paymentId),
      status: input.status,
      approval_source: input.approvalSource ?? null,
      tx_preview: input.status === "paid" ? shortTx(input.tx) : null,
      block_number:
        input.status === "paid" && input.blockNumber !== undefined
          ? (input.blockNumber?.toString() ?? null)
          : null,
    });
  }

  private readSimulationFile(): void {
    if (!this.simulationPath) return;
    let content: string;
    try {
      const stat = lstatSync(this.simulationPath);
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.() ||
        stat.size > 131072
      )
        return;
      content = readFileSync(this.simulationPath, "utf8");
    } catch {
      return;
    }
    const complete = content.endsWith("\n")
      ? content
      : content.slice(0, content.lastIndexOf("\n") + 1);
    for (const line of complete.split("\n")) {
      if (!line) continue;
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const scene = value.scene;
      if (
        value.schema !== "console_simulation.v1" ||
        Object.keys(value).sort().join(",") !== "amount_fen,at,scene,schema" ||
        (scene !== "treasurer_renewal_reserved" &&
          scene !== "treasurer_renewal_paid" &&
          scene !== "treasurer_topup_blocked") ||
        typeof value.at !== "string" ||
        !Number.isFinite(Date.parse(value.at)) ||
        !Number.isSafeInteger(value.amount_fen) ||
        (value.amount_fen as number) < 0
      )
        continue;
      const at = new Date(value.at).toISOString();
      const key = `${scene}:${at}:${value.amount_fen}`;
      if (this.simulationKeys.has(key)) continue;
      this.simulationKeys.add(key);
      this.append({
        at,
        kind: "simulation",
        scene,
        amount_fen: value.amount_fen as number,
        simulated: true,
      });
    }
  }

  feed(after: number): {
    schema: "bank_console_feed.v1";
    events: BankConsoleEvent[];
    next_cursor: number;
  } {
    this.readSimulationFile();
    return {
      schema: "bank_console_feed.v1",
      events: this.events.filter((event) => event.id > after),
      next_cursor: this.nextId - 1,
    };
  }
}
