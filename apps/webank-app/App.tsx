import { CameraView, useCameraPermissions } from "expo-camera";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import * as LocalAuthentication from "expo-local-authentication";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import {
  AgentConnectionInfo,
  canReauthorizeConnection,
} from "./src/AgentConnectionInfo";
import {
  pairingCountdown,
  presentApproval,
  secondsRemaining,
  withPairingConsent,
} from "./src/approvalPresentation";
import {
  type Agent,
  type Approval,
  applyDemoBiometricApproval,
  type DemoState,
  enableWallet,
  formatMoney,
  freezeAgent,
  freezeAll,
  fundWallet,
  initialDemoState,
  matchRequestNumber,
  PAIRING_CODE,
  type Payment,
  queueFirstPayment,
  queuePairing,
  rejectApproval,
  simulateBlockedAttack,
} from "./src/flow";
import { parseYuanToFen } from "./src/funding";
import {
  approveLocalDemo,
  completeGatewayPolicyChange,
  completeSimulatedGatewayAgentAction,
  completeSimulatedGatewayDemoFastForwardGreen,
  completeSimulatedGatewayIdleReauthorization,
  completeSimulatedGatewayReturnToAmber,
  confirmSimulatedHumanPayment,
  deleteGatewayAgent,
  denyGatewayPairing,
  type EditablePolicyLimits,
  type FundingRecord,
  freezeGatewayAgent,
  GatewayRequestError,
  gatewaySnapshotErrorMessage,
  gatewayUrl,
  type IdleReauthorizationChallenge,
  type LiveHome,
  type LivePayment,
  type LivePaymentDetail,
  loadGatewayDemoDrillStatus,
  loadGatewayFunding,
  loadGatewayFundingHistory,
  loadGatewayHome,
  loadGatewayPayment,
  loadGatewayPaymentReview,
  loadGatewayPolicy,
  loadGatewaySnapshot,
  loadGatewaySweep,
  loadGatewaySweepHistory,
  loadGatewayTrustEvents,
  loadHumanPayment,
  loadPairingConsent,
  localDemoConfigured,
  loginLocalDemo,
  type PairingConsent,
  type PairingSummary,
  type PolicySnapshot,
  type PreparedPolicyChange,
  prepareGatewayAgentAction,
  prepareGatewayDemoFastForwardGreen,
  prepareGatewayFunding,
  prepareGatewayIdleReauthorization,
  prepareGatewayPolicyChange,
  prepareGatewayReturnToAmber,
  rejectGatewayApproval,
  type ScanResult,
  type SweepRecord,
  scanGatewayQrPayload,
  startGatewayDemoDrill,
  stopGatewayDemoDrill,
  submitSimulatedGatewayFunding,
  sweepGatewayWallet,
  type TrustActionChallenge,
  type TrustEvidence,
} from "./src/gateway";
import { PairingClientScope } from "./src/PairingClientScope";
import { PaymentReviewCard } from "./src/PaymentReviewCard";
import { PolicyLimitsPanel } from "./src/PolicyLimitsPanel";
import { type PaymentReview, reviewMatchesApproval } from "./src/paymentReview";
import {
  policyChangeIsLoosening,
  policyReviewStillCurrent,
  validatePolicySnapshot,
  validatePreparedPolicyChange,
} from "./src/policyLimits";
import { decodeQrImageBlob, decodeQrImageUri } from "./src/qr";
import { TransferControl } from "./src/TransferControl";
import { TrustEventReview } from "./src/TrustEventReview";
import { TrustLight } from "./src/TrustLight";
import {
  editTransferAmount,
  fundingPreparationIsCurrent,
  initialTransferState,
  reverseTransfer,
  reviewReturnAmount,
  transferActionsBlocked,
} from "./src/transferFlow";
import {
  reviewableTrustEvidence,
  trustEvidenceUnchanged,
} from "./src/trustEvidence";

type Tab = "home" | "wallet" | "approvals" | "agents" | "history";
type Detail = "pair" | "demo" | "scan" | null;
type PendingSimulation = {
  label: string;
  run: () => void;
  expiresAt?: string;
  fundingId?: string;
  policySnapshotHash?: string;
  policySnapshotBlock?: string;
} | null;

const colors = {
  ink: "#16131C",
  paper: "#F7F5F8",
  white: "#FFFFFF",
  muted: "#716D79",
  line: "#E8E3EB",
  purple: "#703BB6",
  purpleLight: "#F0E9F7",
  rose: "#D568B8",
  red: "#AF4148",
  redLight: "#FFF0F0",
  green: "#18785E",
  greenLight: "#ECF8F1",
  yellow: "#8A5A08",
  yellowLight: "#FFF3D1",
};

function Button({
  children,
  onPress,
  tone = "dark",
  disabled = false,
  testID,
}: {
  children: ReactNode;
  onPress: () => void;
  tone?: "dark" | "light" | "danger" | "ghost";
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={typeof children === "string" ? children : undefined}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        tone === "light" && styles.buttonLight,
        tone === "danger" && styles.buttonDanger,
        tone === "ghost" && styles.buttonGhost,
        (pressed || disabled) && { opacity: disabled ? 0.42 : 0.78 },
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          tone !== "dark" && styles.buttonTextDark,
          tone === "danger" && { color: colors.red },
        ]}
      >
        {children}
      </Text>
    </Pressable>
  );
}

function SectionTitle({
  kicker,
  title,
  right,
}: {
  kicker: string;
  title: string;
  right?: string;
}) {
  return (
    <View style={styles.sectionHead}>
      <View>
        <Text style={styles.kicker}>{kicker}</Text>
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {right ? <Text style={styles.sectionRight}>{right}</Text> : null}
    </View>
  );
}

function InfoRow({
  label,
  value,
  last = false,
}: {
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <View style={[styles.infoRow, !last && styles.infoRowBorder]}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

function Badge({
  children,
  tone = "purple",
}: {
  children: ReactNode;
  tone?: "purple" | "green" | "yellow" | "red" | "dark";
}) {
  return (
    <View
      style={[
        styles.badge,
        tone === "green" && styles.badgeGreen,
        tone === "yellow" && styles.badgeYellow,
        tone === "red" && styles.badgeRed,
        tone === "dark" && styles.badgeDark,
      ]}
    >
      <Text
        style={[
          styles.badgeText,
          tone === "green" && { color: colors.green },
          tone === "yellow" && { color: colors.yellow },
          tone === "red" && { color: colors.red },
          tone === "dark" && { color: colors.white },
        ]}
      >
        {children}
      </Text>
    </View>
  );
}

function showError(message: string) {
  if (Platform.OS === "web") window.alert(message);
  else Alert.alert("Agent Wallet", message);
}

function wrapHash(hash: string): string {
  return hash.match(/.{1,16}/g)?.join("\n") ?? hash;
}

function policyChangeError(error: unknown): string {
  if (error instanceof GatewayRequestError) {
    if (error.code === "action_changed")
      return "Policy, contract caps, or challenge changed. Refresh limits and review again.";
    if (error.code === "reconciliation_required")
      return "The limit change is being reconciled. Spending remains blocked until confirmed.";
    if (error.code === "chain_unavailable")
      return "Contract caps are unavailable. Refresh after the local chain recovers.";
  }
  return error instanceof Error ? error.message : "Limit change unavailable.";
}

function wrapApprovalLine(line: string): string {
  return line.replace(
    /\S{24,}/g,
    (token) => token.match(/.{1,16}/g)?.join("\u200b") ?? token,
  );
}

function approvalTrustInfo(approval: Approval) {
  if (approval.kind === "pairing")
    return {
      light: "AMBER" as const,
      reason:
        approval.trust_reason ||
        "New connection starts Amber: every purchase needs approval.",
    };
  if (approval.kind === "payment" || approval.kind === "mandate")
    return approval.trust_light
      ? {
          light: approval.trust_light,
          reason: approval.trust_reason || "Trust reason unavailable.",
        }
      : null;
  return null;
}

function ApprovalTrustDisplay({ approval }: { approval: Approval }) {
  const trust = approvalTrustInfo(approval);
  return trust ? <TrustLight {...trust} /> : null;
}

export default function App() {
  const { width } = useWindowDimensions();
  const [tab, setTab] = useState<Tab>("home");
  const [detail, setDetail] = useState<Detail>(null);
  const [demo, setDemo] = useState<DemoState>(initialDemoState);
  const [liveAgents, setLiveAgents] = useState<DemoState["agents"]>([]);
  const [liveApprovals, setLiveApprovals] = useState<Approval[]>([]);
  const [livePayments, setLivePayments] = useState<LivePayment[]>([]);
  const [liveHome, setLiveHome] = useState<LiveHome | null>(null);
  const [homeError, setHomeError] = useState("");
  const [homeSyncedAt, setHomeSyncedAt] = useState<number | null>(null);
  const [homeLoading, setHomeLoading] = useState(false);
  const [livePolicy, setLivePolicy] = useState<PolicySnapshot | null>(null);
  const latestPolicy = useRef<PolicySnapshot | null>(null);
  const [policyError, setPolicyError] = useState("");
  const [policyMessage, setPolicyMessage] = useState("");
  const [policyBusy, setPolicyBusy] = useState(false);
  const policyActionInFlight = useRef(false);
  const [fundingHistory, setFundingHistory] = useState<FundingRecord[]>([]);
  const [transfer, setTransfer] = useState(initialTransferState);
  const [fundingInFlight, setFundingInFlight] = useState<string | null>(null);
  const [fundingBusy, setFundingBusy] = useState(false);
  const transferEditVersion = useRef(0);
  const [fundingMessage, setFundingMessage] = useState("");
  const [sweepResult, setSweepResult] = useState<SweepRecord | null>(null);
  const [sweepHistory, setSweepHistory] = useState<SweepRecord[]>([]);
  const [sweepInFlight, setSweepInFlight] = useState<string | null>(null);
  const [sweepAttemptAt, setSweepAttemptAt] = useState<number | null>(null);
  const [livePaymentDetail, setLivePaymentDetail] =
    useState<LivePaymentDetail | null>(null);
  const [livePaymentError, setLivePaymentError] = useState("");
  const [paymentReview, setPaymentReview] = useState<PaymentReview | null>(
    null,
  );
  const [paymentReviewError, setPaymentReviewError] = useState("");
  const [paymentReviewLoading, setPaymentReviewLoading] = useState(false);
  const [paymentReviewRetry, setPaymentReviewRetry] = useState(0);
  const [livePairing, setLivePairing] = useState<PairingConsent | null>(null);
  const [livePairings, setLivePairings] = useState<PairingSummary[]>([]);
  const [livePairingCode, setLivePairingCode] = useState("");
  const [scanReview, setScanReview] = useState<Extract<
    ScanResult,
    { kind: "payment" }
  > | null>(null);
  const [scanStatus, setScanStatus] = useState("");
  const [scanReceipt, setScanReceipt] = useState<Awaited<
    ReturnType<typeof loadHumanPayment>
  > | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const dropZoneRef = useRef<View | null>(null);
  const scanInProgress = useRef(false);
  const scanPayloadHandler = useRef<(payload: string) => Promise<void>>(
    async () => {},
  );
  const [gatewayError, setGatewayError] = useState("");
  const [demoLoginToken, setDemoLoginToken] = useState("");
  const [demoAuthenticated, setDemoAuthenticated] = useState(false);
  const hadDemoSession = useRef(false);
  const hasSyncedGateway = useRef(false);
  const [localNumberFailures, setLocalNumberFailures] = useState<
    Record<string, number>
  >({});
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(
    null,
  );
  const [selectedPaymentId, setSelectedPaymentId] = useState<string | null>(
    null,
  );
  const [pairingCodeInput, setPairingCodeInput] = useState("");
  const [numberInput, setNumberInput] = useState("");
  const [numberMessage, setNumberMessage] = useState("");
  const approvalSubmissionInFlight = useRef(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [idleActionBusyId, setIdleActionBusyId] = useState<string | null>(null);
  const idleSubmissionInFlight = useRef(false);
  const [idleRenewalWindows, setIdleRenewalWindows] = useState<
    Record<string, string>
  >({});
  const [trustReview, setTrustReview] = useState<{
    agentId: string;
    evidence: TrustEvidence | null;
    error: string;
    loading: boolean;
  } | null>(null);
  const [trustActionBusyId, setTrustActionBusyId] = useState<string | null>(
    null,
  );
  const trustActionInFlight = useRef(false);
  const [demoDrill, setDemoDrill] = useState<{
    drill_id: string | null;
    active: boolean;
  } | null>(null);
  const [demoDrillBusy, setDemoDrillBusy] = useState(false);
  const [demoDrillError, setDemoDrillError] = useState("");
  const [pendingSimulation, setPendingSimulation] =
    useState<PendingSimulation>(null);
  const [clock, setClock] = useState(Date.now());
  const isLive = Boolean(gatewayUrl);
  const isLocalDemo =
    isLive &&
    localDemoConfigured &&
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    window.location.protocol === "http:" &&
    window.location.hostname === "127.0.0.1";

  useEffect(() => {
    if (!isLocalDemo || !demoAuthenticated) return;
    let active = true;
    const refresh = () => {
      void loadGatewayDemoDrillStatus()
        .then((status) => {
          if (active) {
            setDemoDrill(status);
            setDemoDrillError("");
          }
        })
        .catch((error) => {
          if (active)
            setDemoDrillError(
              error instanceof Error
                ? error.message
                : "Drill status unavailable.",
            );
        });
    };
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [isLocalDemo, demoAuthenticated]);

  const refreshGateway = useCallback(async () => {
    if (!isLive) return;
    if (!hasSyncedGateway.current) setLoading(true);
    try {
      const snapshot = await loadGatewaySnapshot();
      setLiveAgents(snapshot.agents);
      setLiveApprovals(snapshot.approvals);
      setLivePayments(snapshot.payments);
      setLivePairings(snapshot.pairings);
      setGatewayError("");
      if (isLocalDemo) {
        hadDemoSession.current = true;
        setDemoAuthenticated(true);
      }
      hasSyncedGateway.current = true;
      setLastSyncedAt(Date.now());
    } catch (error) {
      if (
        isLocalDemo &&
        error instanceof GatewayRequestError &&
        error.status === 401
      )
        setDemoAuthenticated(false);
      const message = gatewaySnapshotErrorMessage(
        error,
        isLocalDemo,
        hadDemoSession.current,
      );
      if (message) setGatewayError(message);
    } finally {
      setLoading(false);
    }
  }, [isLive, isLocalDemo]);

  const refreshWallet = useCallback(async () => {
    if (!isLive) return;
    setHomeLoading(true);
    try {
      const home = await loadGatewayHome();
      if (home.schema !== "home.v1" || home.simulated !== true)
        throw new Error("Gateway did not return a confirmed wallet balance.");
      setLiveHome(home);
      setHomeSyncedAt(Date.now());
      setHomeError("");
    } catch (error) {
      setHomeError(
        error instanceof Error ? error.message : "Balance unavailable.",
      );
    } finally {
      setHomeLoading(false);
    }
    try {
      const items = await loadGatewayFundingHistory();
      setFundingHistory(items);
      const unresolved = items.find(
        (item) =>
          item.status === "settling" ||
          item.status === "reconciliation_required",
      );
      if (unresolved) setFundingInFlight(unresolved.funding_id);
    } catch {
      // Balance errors are shown separately; retain the last confirmed history.
    }
    try {
      const items = await loadGatewaySweepHistory();
      setSweepHistory(items);
      const unresolved = items.find(
        (item) =>
          item.status === "settling" ||
          item.status === "reconciliation_required",
      );
      if (unresolved) setSweepInFlight(unresolved.sweep_id);
      else if (sweepInFlight) {
        const settled = items.find(
          (item) =>
            item.status === "completed" &&
            (item.sweep_id === sweepInFlight ||
              (sweepInFlight === "unknown" &&
                sweepAttemptAt !== null &&
                Date.parse(item.created_at) >= sweepAttemptAt - 1000)),
        );
        if (settled) {
          setSweepInFlight(null);
          setSweepResult(settled);
        }
      }
    } catch {
      // Keep uncertain sweep state until a successful history read.
    }
  }, [isLive, sweepAttemptAt, sweepInFlight]);

  const refreshPolicy = useCallback(async () => {
    if (!isLive) return;
    try {
      const snapshot = await loadGatewayPolicy();
      validatePolicySnapshot(snapshot);
      latestPolicy.current = snapshot;
      setLivePolicy(snapshot);
      setPendingSimulation((pending) =>
        pending?.policySnapshotHash &&
        !policyReviewStillCurrent(
          snapshot,
          pending.policySnapshotHash,
          pending.policySnapshotBlock ?? "",
        )
          ? null
          : pending,
      );
      setPolicyError("");
    } catch (error) {
      latestPolicy.current = null;
      setLivePolicy(null);
      setPendingSimulation((pending) =>
        pending?.policySnapshotHash ? null : pending,
      );
      setPolicyError(
        error instanceof Error ? error.message : "Policy values unavailable.",
      );
    }
  }, [isLive]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    void refreshGateway();
    const poller = isLive
      ? setInterval(() => void refreshGateway(), 3000)
      : null;
    return () => {
      if (poller) clearInterval(poller);
    };
  }, [refreshGateway, isLive]);

  useEffect(() => {
    void refreshWallet();
    const poller = isLive
      ? setInterval(() => void refreshWallet(), 3000)
      : null;
    return () => {
      if (poller) clearInterval(poller);
    };
  }, [refreshWallet, isLive]);

  useEffect(() => {
    if (!isLive || tab !== "wallet") return;
    void refreshPolicy();
    const poller = setInterval(() => void refreshPolicy(), 10_000);
    return () => clearInterval(poller);
  }, [isLive, refreshPolicy, tab]);

  useEffect(() => {
    if (!demoAuthenticated)
      setPendingSimulation((pending) =>
        pending?.policySnapshotHash ? null : pending,
      );
  }, [demoAuthenticated]);

  useEffect(() => {
    if (!isLive || !fundingInFlight) return;
    let active = true;
    const poll = async () => {
      try {
        const record = await loadGatewayFunding(fundingInFlight);
        if (!active) return;
        setFundingHistory((items) => [
          record,
          ...items.filter((item) => item.funding_id !== record.funding_id),
        ]);
        if (record.status === "completed" || record.status === "failed") {
          setFundingInFlight(null);
          setFundingMessage(
            record.status === "completed"
              ? "Transfer confirmed on the local FISCO chain."
              : "Transfer failed without moving funds.",
          );
          await refreshWallet();
        }
      } catch {
        // Keep the intent visible for reconciliation; never submit it again.
      }
    };
    void poll();
    const poller = setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      clearInterval(poller);
    };
  }, [fundingInFlight, isLive, refreshWallet]);

  useEffect(() => {
    if (!isLive || !sweepInFlight || sweepInFlight === "unknown") return;
    let active = true;
    const poll = async () => {
      try {
        const record = await loadGatewaySweep(sweepInFlight);
        if (!active) return;
        setSweepResult(record);
        setSweepHistory((items) => [
          record,
          ...items.filter((item) => item.sweep_id !== record.sweep_id),
        ]);
        if (record.status === "completed") {
          setSweepInFlight(null);
          setFundingMessage("Return confirmed on the local FISCO chain.");
          await refreshWallet();
        }
      } catch {
        // Do not submit another return while chain evidence is uncertain.
      }
    };
    void poll();
    const poller = setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      clearInterval(poller);
    };
  }, [isLive, sweepInFlight, refreshWallet]);

  useEffect(() => {
    if (!isLive || !selectedPaymentId) return;
    let active = true;
    const refreshDetail = async () => {
      try {
        const detail = await loadGatewayPayment(selectedPaymentId);
        if (active) {
          setLivePaymentDetail(detail);
          setLivePaymentError("");
        }
      } catch (error) {
        if (active)
          setLivePaymentError(
            error instanceof Error ? error.message : "Receipt unavailable.",
          );
      }
    };
    void refreshDetail();
    const poller = setInterval(() => void refreshDetail(), 3000);
    return () => {
      active = false;
      clearInterval(poller);
    };
  }, [isLive, selectedPaymentId]);

  const agents = isLive ? liveAgents : demo.agents;
  const approvals = isLive
    ? withPairingConsent(liveApprovals, livePairing)
    : demo.approvals;
  const pendingApprovals = approvals.filter(
    (approval) =>
      approval.status === "pending" && Date.parse(approval.expires_at) > clock,
  );
  const selectedApproval =
    approvals.find((approval) => approval.approval_id === selectedApprovalId) ??
    null;
  const compositeApprovalId =
    isLive &&
    selectedApproval?.kind === "payment" &&
    selectedApproval.review_schema === "payment_review.v1"
      ? selectedApproval.approval_id
      : null;
  const compositeReviewRequestKey = compositeApprovalId
    ? `${compositeApprovalId}:${selectedApproval?.payload_hash}:${paymentReviewRetry}`
    : null;
  useEffect(() => {
    setPaymentReview(null);
    setPaymentReviewError("");
    if (!compositeApprovalId || !compositeReviewRequestKey) {
      setPaymentReviewLoading(false);
      return;
    }
    let active = true;
    setPaymentReviewLoading(true);
    void loadGatewayPaymentReview(compositeApprovalId)
      .then((review) => {
        if (active) setPaymentReview(review);
      })
      .catch((error) => {
        if (active)
          setPaymentReviewError(
            error instanceof Error
              ? error.message
              : "Payment review unavailable.",
          );
      })
      .finally(() => {
        if (active) setPaymentReviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [compositeApprovalId, compositeReviewRequestKey]);
  const compositeReviewReady =
    compositeApprovalId === null ||
    reviewMatchesApproval(paymentReview, selectedApproval, clock);
  const currentApprovalReview = useRef<{
    approval: Approval | null;
    review: PaymentReview | null;
  }>({ approval: null, review: null });
  currentApprovalReview.current = {
    approval: selectedApproval,
    review: paymentReview,
  };
  const selectedPairing =
    selectedApproval?.kind === "pairing"
      ? (livePairings.find(
          (pairing) => pairing.user_code === selectedApproval.subject_id,
        ) ??
        (livePairing?.approval.approval_id === selectedApproval.approval_id
          ? livePairing.pairing
          : null))
      : null;
  const selectedNumberExpiry = selectedPairing?.request_number_expires_at;
  const selectedNumberSeconds = selectedPairing
    ? pairingCountdown(selectedPairing, clock).number
    : 0;
  const selectedNumberExpired =
    selectedApproval?.kind === "pairing" && selectedNumberSeconds === 0;

  useEffect(() => {
    if (
      selectedApproval?.kind === "pairing" &&
      selectedApproval.approval_id === selectedApprovalId &&
      (selectedNumberExpired || selectedNumberExpiry)
    )
      setNumberInput("");
  }, [
    selectedApproval?.kind,
    selectedApproval?.approval_id,
    selectedApprovalId,
    selectedNumberExpiry,
    selectedNumberExpired,
  ]);
  const approvalView = (approval: Approval) =>
    presentApproval(
      approval,
      isLive
        ? livePayments.find(
            (payment) => payment.payment_id === approval.subject_id,
          )
        : undefined,
    );
  const selectedApprovalTrust = selectedApproval
    ? approvalTrustInfo(selectedApproval)
    : null;
  const livePaymentRows: Payment[] = [...livePayments]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .map((payment) => ({
      payment_id: payment.payment_id,
      amount: payment.amount.amount,
      merchant: payment.merchant,
      merchantLegalName: payment.merchant,
      item: "See receipt detail",
      status: payment.status,
      reason: "See Gateway decision",
      at: payment.created_at,
      approvalSource: payment.approval_source,
    }));
  const paymentRows = isLive ? livePaymentRows : demo.payments;
  const selectedPayment =
    paymentRows.find((payment) => payment.payment_id === selectedPaymentId) ??
    null;
  const activeAgent = agents.find((agent) => agent.status === "active");
  const latestActivity = paymentRows.slice(0, 2);
  const balanceState = !isLive
    ? "demo"
    : !liveHome
      ? homeLoading
        ? "loading"
        : "unavailable"
      : homeError ||
          !homeSyncedAt ||
          clock - homeSyncedAt > 10_000 ||
          !Number.isFinite(Date.parse(liveHome.observed_at)) ||
          Date.parse(liveHome.observed_at) - clock > 15_000 ||
          clock - Date.parse(liveHome.observed_at) > 15_000
        ? "stale"
        : "confirmed";
  const liveBalanceUsable =
    balanceState === "confirmed" && !liveHome?.agent_wallet.frozen;
  const mainBalance = isLive
    ? balanceState === "confirmed"
      ? liveHome?.main_account.balance.amount
      : undefined
    : demo.mainBalance;
  const walletBalance = isLive
    ? balanceState === "confirmed"
      ? liveHome?.agent_wallet.balance.amount
      : undefined
    : demo.walletBalance;

  const securityAction = useCallback(
    async (label: string, run: () => void) => {
      if (isLive) {
        showError(
          "Live approval is unavailable until the phone registers a biometric-gated Secure Enclave signing key. No request was sent.",
        );
        return;
      }
      if (Platform.OS === "web") {
        setPendingSimulation({ label, run });
        return;
      }
      try {
        const hasHardware = await LocalAuthentication.hasHardwareAsync();
        const enrolled = await LocalAuthentication.isEnrolledAsync();
        if (!hasHardware || !enrolled) {
          showError(
            "Face ID or Touch ID is required. Device passcode and app PIN are not accepted for agent approvals.",
          );
          return;
        }
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: label,
          cancelLabel: "Cancel",
          disableDeviceFallback: true,
        });
        if (result.success) run();
      } catch (error) {
        showError(
          error instanceof Error ? error.message : "Biometric check failed",
        );
      }
    },
    [isLive],
  );

  const openApproval = (approvalId: string) => {
    setNumberInput("");
    setNumberMessage("");
    setSelectedApprovalId(approvalId);
    setTab("approvals");
  };

  const openPayment = (paymentId: string) => {
    setLivePaymentDetail(null);
    setLivePaymentError("");
    setSelectedPaymentId(paymentId);
    setTab("history");
  };

  const handleApprove = () => {
    if (!selectedApproval) return;
    if (approvalSubmissionInFlight.current) return;
    if (isLive && !isLocalDemo) {
      showError(
        "A live Secure Enclave approval signature is not available yet.",
      );
      return;
    }
    if (isLocalDemo) {
      if (!demoAuthenticated)
        return showError("Enter the private local app token first.");
      if (
        selectedApproval.status !== "pending" ||
        Date.parse(selectedApproval.expires_at) <= Date.now()
      )
        return showError("This approval has expired. Start a new request.");
      if (
        (selectedApproval.kind === "payment" ||
          selectedApproval.kind === "mandate") &&
        (!selectedApproval.trust_light ||
          selectedApproval.trust_light === "RED")
      )
        return showError(
          "This agent's trust light does not allow approval. Refresh the request.",
        );
      if (
        selectedApproval.kind === "pairing" &&
        !livePairing?.pairing.client_app_name
      )
        return showError(
          "This pairing has no client app identity. Start a new connection from the connector.",
        );
      if (
        selectedApproval.review_schema === "payment_review.v1" &&
        !reviewMatchesApproval(paymentReview, selectedApproval, Date.now())
      )
        return setNumberMessage(
          "The verified payment review is missing, changed, or expired. Reload it before approving.",
        );
      if (
        selectedApproval.kind === "pairing" &&
        (!selectedNumberExpiry ||
          Date.parse(selectedNumberExpiry) <= Date.now())
      ) {
        setNumberInput("");
        return setNumberMessage(
          "The request number expired. Ask the connector to refresh its number, then enter the new number here.",
        );
      }
      if (
        selectedApproval.level === "zero_trust" &&
        !/^\d{6}$/.test(numberInput)
      )
        return showError("Enter the six-digit number shown by the connector.");
      const card = selectedApproval;
      const enteredNumber =
        card.level === "zero_trust" ? numberInput : undefined;
      const pairingCode = card.kind === "pairing" ? livePairingCode : undefined;
      setPendingSimulation({
        label: `Simulate approval of ${approvalView(card).title}`,
        run: () => {
          if (approvalSubmissionInFlight.current) return;
          if (
            card.review_schema === "payment_review.v1" &&
            (!reviewMatchesApproval(
              currentApprovalReview.current.review,
              currentApprovalReview.current.approval,
              Date.now(),
            ) ||
              currentApprovalReview.current.approval?.approval_id !==
                card.approval_id ||
              currentApprovalReview.current.approval.payload_hash !==
                card.payload_hash)
          ) {
            setNumberMessage(
              "The verified payment review changed or expired. Reload it before approving.",
            );
            return;
          }
          if (
            card.kind === "pairing" &&
            (!selectedNumberExpiry ||
              Date.parse(selectedNumberExpiry) <= Date.now())
          ) {
            setNumberInput("");
            setNumberMessage(
              "The request number expired. Ask the connector to refresh its number, then enter the new number here.",
            );
            return;
          }
          approvalSubmissionInFlight.current = true;
          setApprovalBusy(true);
          setNumberMessage(
            "Submitting approval to Gateway. Wait for a result.",
          );
          void (async () => {
            try {
              await approveLocalDemo(card, enteredNumber, pairingCode);
              setLocalNumberFailures((current) => ({
                ...current,
                [card.approval_id]: 0,
              }));
              if (card.kind === "pairing") {
                setLivePairing(null);
                setLivePairingCode("");
              }
              setSelectedApprovalId(null);
              setNumberInput("");
              setNumberMessage("");
              await refreshGateway();
              setTab(
                card.kind === "pairing"
                  ? "agents"
                  : card.kind === "payment"
                    ? "history"
                    : "approvals",
              );
            } catch (error) {
              if (
                error instanceof GatewayRequestError &&
                error.code === "bad_signature"
              ) {
                const failures =
                  (localNumberFailures[card.approval_id] ?? 0) + 1;
                setLocalNumberFailures((current) => ({
                  ...current,
                  [card.approval_id]: failures,
                }));
                setNumberInput("");
                setNumberMessage(
                  failures >= 3
                    ? "Three incorrect numbers cancelled this request. Start again from the connector."
                    : `Number or simulated proof was rejected. ${3 - failures} attempt${3 - failures === 1 ? "" : "s"} left.`,
                );
                if (failures >= 3 && card.kind === "pairing") {
                  setLivePairing(null);
                  setSelectedApprovalId(null);
                }
                if (failures >= 3)
                  setGatewayError(
                    "Three incorrect numbers cancelled the simulated request. Start again from the connector.",
                  );
              } else if (
                error instanceof GatewayRequestError &&
                card.kind === "pairing" &&
                error.code === "request_number_expired"
              ) {
                setNumberInput("");
                setNumberMessage(
                  "That request number expired. Ask the connector to show its refreshed number, then enter it here. This did not count as a wrong attempt.",
                );
              } else if (
                error instanceof GatewayRequestError &&
                card.kind === "pairing" &&
                error.status === 503
              ) {
                setNumberMessage(
                  "Pairing could not complete because Gateway or the audit chain was unavailable. Check the request status, then retry if it is still pending.",
                );
              } else if (
                error instanceof GatewayRequestError &&
                card.kind === "pairing" &&
                error.status === 403
              ) {
                setNumberMessage(
                  "Pairing is unavailable or already being processed. Wait for its status to update before trying again.",
                );
              } else {
                setNumberMessage(
                  error instanceof Error
                    ? error.message
                    : "Simulated approval failed.",
                );
              }
              await refreshGateway();
            } finally {
              approvalSubmissionInFlight.current = false;
              setApprovalBusy(false);
            }
          })();
        },
      });
      return;
    }
    if (
      selectedApproval.status !== "pending" ||
      Date.parse(selectedApproval.expires_at) <= Date.now()
    ) {
      showError(
        "This approval has expired. Ask the agent to start a new request.",
      );
      return;
    }
    if (
      selectedApproval.level === "zero_trust" &&
      !demo.matchedApprovals.includes(selectedApproval.approval_id)
    ) {
      const match = matchRequestNumber(
        demo,
        selectedApproval.approval_id,
        numberInput,
      );
      setDemo(match.state);
      if (match.result === "wrong") {
        const remaining =
          3 - (match.state.numberFailures[selectedApproval.approval_id] ?? 0);
        setNumberMessage(
          `Number did not match. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`,
        );
        setNumberInput("");
        return;
      }
      if (match.result === "cancelled") {
        setNumberMessage("Three incorrect numbers cancelled this request.");
        return;
      }
      if (match.result !== "matched") {
        setNumberMessage(
          "Request expired. Start a new request from the agent.",
        );
        return;
      }
      setNumberMessage("Number matched. Complete a fresh biometric check.");
    }
    const action =
      selectedApproval.kind === "payment"
        ? "Approve ¥279.00 to Shop A Electronics"
        : "Connect Claude to Agent Wallet";
    void securityAction(action, () => {
      setDemo((current) =>
        applyDemoBiometricApproval(current, selectedApproval.approval_id, true),
      );
      setSelectedApprovalId(null);
      setNumberInput("");
      setNumberMessage("");
      setTab(selectedApproval.kind === "payment" ? "history" : "agents");
    });
  };

  const handleLocalDemoLogin = async () => {
    const token = demoLoginToken.trim();
    setDemoLoginToken("");
    try {
      await loginLocalDemo(token);
      hadDemoSession.current = true;
      setDemoAuthenticated(true);
      setGatewayError("");
      await refreshGateway();
      await refreshWallet();
      await refreshPolicy();
    } catch (error) {
      setDemoAuthenticated(false);
      setGatewayError(
        error instanceof Error ? error.message : "Local demo login failed.",
      );
    }
  };

  const submitPreparedPolicy = async (
    change: PreparedPolicyChange,
    simulatedProof: boolean,
    expectedPolicyHash: string,
    expectedContractBlock: string,
  ) => {
    if (policyActionInFlight.current) return;
    policyActionInFlight.current = true;
    setPolicyBusy(true);
    setPolicyError("");
    setPolicyMessage("Confirming contract caps and Gateway policy...");
    try {
      if (
        !policyReviewStillCurrent(
          latestPolicy.current,
          expectedPolicyHash,
          expectedContractBlock,
        ) ||
        (simulatedProof && (!isLocalDemo || !demoAuthenticated))
      )
        throw new Error("Policy or owner session changed after review.");
      const result = await completeGatewayPolicyChange(change, simulatedProof);
      validatePolicySnapshot(result);
      if (result.sync_status !== "consistent" || !result.contract)
        throw new Error(
          "Policy update was not confirmed. Refresh policy before another change.",
        );
      const confirmed = await loadGatewayPolicy();
      validatePolicySnapshot(confirmed);
      if (
        confirmed.sync_status !== "consistent" ||
        ![
          "per_payment_max",
          "daily_max",
          "monthly_max",
          "auto_approve_below",
        ].every(
          (field) =>
            confirmed.policy[field as keyof EditablePolicyLimits].amount ===
            change.proposed[field as keyof EditablePolicyLimits].amount,
        )
      )
        throw new Error("Confirmed limits changed before policy readback.");
      setLivePolicy(confirmed);
      latestPolicy.current = confirmed;
      setPolicyError("");
      setPolicyMessage("Limit change confirmed on the local FISCO chain.");
    } catch (error) {
      latestPolicy.current = null;
      setLivePolicy(null);
      setPolicyMessage("");
      setPolicyError(
        `${policyChangeError(error)} Refresh policy and contract caps before another change.`,
      );
    } finally {
      policyActionInFlight.current = false;
      setPolicyBusy(false);
    }
  };

  const handlePolicySave = (proposed: EditablePolicyLimits) => {
    const snapshot = livePolicy;
    const contractAtReview = snapshot?.contract;
    if (
      !isLive ||
      !snapshot ||
      snapshot.sync_status !== "consistent" ||
      !contractAtReview ||
      policyActionInFlight.current
    )
      return setPolicyError(
        "Refresh synchronized Gateway policy and contract caps first.",
      );
    policyActionInFlight.current = true;
    setPolicyBusy(true);
    setPolicyError("");
    setPolicyMessage("");
    void (async () => {
      let change: PreparedPolicyChange | null = null;
      try {
        validatePolicySnapshot(snapshot);
        change = await prepareGatewayPolicyChange(snapshot, proposed);
        validatePreparedPolicyChange(change, snapshot, proposed);
        if (
          !policyReviewStillCurrent(
            latestPolicy.current,
            snapshot.policy_hash,
            contractAtReview.block_number,
          )
        )
          throw new Error("Policy changed during review. Refresh limits.");
        if (
          change.requires_verification &&
          (!isLocalDemo || !demoAuthenticated)
        )
          throw new Error(
            "A registered owner biometric is required to raise these limits.",
          );
      } catch (error) {
        change = null;
        latestPolicy.current = null;
        setLivePolicy(null);
        setPolicyError(policyChangeError(error));
      } finally {
        policyActionInFlight.current = false;
        setPolicyBusy(false);
      }
      if (!change) return;
      const preparedChange = change;
      if (!preparedChange.requires_verification) {
        void submitPreparedPolicy(
          preparedChange,
          false,
          snapshot.policy_hash,
          contractAtReview.block_number,
        );
        return;
      }
      const formatLimits = (limits: EditablePolicyLimits) =>
        `per payment ${formatMoney(limits.per_payment_max.amount)}, daily ${formatMoney(limits.daily_max.amount)}, monthly ${formatMoney(limits.monthly_max.amount)}, Green threshold ${formatMoney(limits.auto_approve_below.amount)}`;
      setPendingSimulation({
        expiresAt: preparedChange.expires_at,
        policySnapshotHash: snapshot.policy_hash,
        policySnapshotBlock: contractAtReview.block_number,
        label: `${policyChangeIsLoosening(snapshot.policy, proposed) ? "Raise owner spending authority" : "Confirm owner policy change"}. Current: ${formatLimits(preparedChange.current)}. Proposed: ${formatLimits(preparedChange.proposed)}. Exact action hash: ${wrapHash(preparedChange.action_hash)}. This simulated biometric step authorizes only these limits; it does not add wallet funds or reopen denied payments.`,
        run: () => {
          void submitPreparedPolicy(
            preparedChange,
            true,
            snapshot.policy_hash,
            contractAtReview.block_number,
          );
        },
      });
    })();
  };

  const startFundingReview = async () => {
    if (transfer.direction !== "fund") return;
    const requestedAmountInput = transfer.amountInput;
    const requestVersion = transferEditVersion.current;
    const amountFen = parseYuanToFen(transfer.amountInput);
    if (!amountFen)
      return setFundingMessage(
        "Enter a positive CNY amount with at most two decimal places.",
      );
    if (
      !isLocalDemo ||
      !liveBalanceUsable ||
      !liveHome ||
      fundingInFlight ||
      sweepInFlight
    )
      return setFundingMessage(
        "A fresh confirmed balance and local owner session are required.",
      );
    if (amountFen > liveHome.main_account.balance.amount)
      return setFundingMessage(
        "This exceeds the confirmed main-account balance.",
      );
    setFundingBusy(true);
    setFundingMessage("");
    try {
      const challenge = await prepareGatewayFunding(amountFen);
      if (
        challenge.destination_address.toLowerCase() !==
        liveHome.agent_wallet.address.toLowerCase()
      )
        throw new Error(
          "Wallet destination changed. Refresh balances before transferring.",
        );
      setTransfer((current) =>
        fundingPreparationIsCurrent(
          current,
          requestedAmountInput,
          requestVersion,
          transferEditVersion.current,
        )
          ? { ...current, fundingReview: { amountFen, challenge } }
          : current,
      );
    } catch (error) {
      setFundingMessage(
        error instanceof Error ? error.message : "Transfer review unavailable.",
      );
    } finally {
      setFundingBusy(false);
    }
  };

  const confirmFunding = () => {
    if (transfer.direction !== "fund" || !transfer.fundingReview) return;
    const { amountFen, challenge } = transfer.fundingReview;
    const reviewVersion = transferEditVersion.current;
    if (Date.parse(challenge.expires_at) <= Date.now()) {
      setTransfer((current) => ({ ...current, fundingReview: null }));
      return setFundingMessage(
        "The confirmation expired. Review this transfer again.",
      );
    }
    setPendingSimulation({
      label: `Transfer ${formatMoney(amountFen)} from WeBank main account to Agent Wallet ${challenge.destination_address}. Confirm this exact amount.`,
      fundingId: challenge.funding_id,
      expiresAt: challenge.expires_at,
      run: () => {
        if (reviewVersion !== transferEditVersion.current) return;
        setTransfer((current) => ({ ...current, fundingReview: null }));
        setFundingInFlight(challenge.funding_id);
        setFundingBusy(true);
        setFundingMessage(
          "Submitting this transfer. Do not submit it again while its chain result is pending.",
        );
        void (async () => {
          try {
            const record = await submitSimulatedGatewayFunding(
              challenge,
              amountFen,
            );
            setFundingHistory((items) => [
              record,
              ...items.filter((item) => item.funding_id !== record.funding_id),
            ]);
            if (record.status === "completed") {
              setFundingInFlight(null);
              setFundingMessage("Transfer confirmed on the local FISCO chain.");
              await refreshWallet();
            }
          } catch (error) {
            if (
              error instanceof GatewayRequestError &&
              error.code === "reconciliation_required"
            )
              setFundingMessage(
                "Transfer result is being reconciled. The same funding ID remains blocked from duplicate submission.",
              );
            else if (
              error instanceof GatewayRequestError &&
              error.status < 500
            ) {
              setFundingInFlight(null);
              setFundingMessage(
                error instanceof Error ? error.message : "Transfer failed.",
              );
              await refreshWallet();
            } else {
              setFundingMessage(
                "Transfer response was lost or delayed. Checking the same funding ID for chain evidence; do not submit another transfer.",
              );
            }
          } finally {
            setFundingBusy(false);
          }
        })();
      },
    });
  };

  const startReturnReview = () => {
    if (transfer.direction !== "return") return;
    if (
      !liveBalanceUsable ||
      !liveHome ||
      fundingBusy ||
      fundingInFlight ||
      sweepInFlight
    )
      return setFundingMessage(
        "A fresh confirmed balance and no pending transfer are required.",
      );
    const review = reviewReturnAmount(
      transfer.amountInput,
      liveHome.agent_wallet.available.amount,
    );
    if (review.error) return setFundingMessage(review.error);
    setFundingMessage("");
    setTransfer((current) =>
      current.direction === "return"
        ? { ...current, returnReviewFen: review.amountFen }
        : current,
    );
  };

  const confirmSweep = async () => {
    if (transfer.direction !== "return") return;
    const amountFen = transfer.returnReviewFen;
    if (
      !amountFen ||
      !liveHome ||
      !liveBalanceUsable ||
      fundingInFlight ||
      sweepInFlight ||
      amountFen > liveHome.agent_wallet.available.amount
    )
      return setFundingMessage(
        "A fresh available balance is required before returning funds.",
      );
    setTransfer((current) => ({ ...current, returnReviewFen: null }));
    setSweepAttemptAt(Date.now());
    setSweepInFlight("unknown");
    setFundingBusy(true);
    setFundingMessage(
      "Returning only unreserved wallet funds to the main account.",
    );
    try {
      const receipt = await sweepGatewayWallet(amountFen);
      setSweepResult(receipt);
      setSweepInFlight(
        receipt.status === "completed" ? null : receipt.sweep_id,
      );
      setFundingMessage(
        receipt.status === "completed"
          ? "Return confirmed on the local FISCO chain."
          : "Return requires reconciliation; funds remain unavailable.",
      );
      await refreshWallet();
    } catch (error) {
      if (
        error instanceof GatewayRequestError &&
        error.code === "reconciliation_required"
      ) {
        setSweepInFlight(
          typeof error.details?.sweep_id === "string"
            ? error.details.sweep_id
            : "unknown",
        );
        setFundingMessage(
          "Return outcome is being reconciled. No second return will be submitted.",
        );
      } else if (error instanceof GatewayRequestError && error.status < 500) {
        setSweepInFlight(null);
        setFundingMessage(error.message);
      } else {
        setFundingMessage(
          "Return response was lost or delayed. Checking chain history before another transfer.",
        );
      }
      await refreshWallet();
    } finally {
      setFundingBusy(false);
    }
  };

  const startPairing = async () => {
    if (isLive) {
      const code = pairingCodeInput.trim().toUpperCase();
      if (!code)
        return showError("Enter the pairing code shown by the connector.");
      try {
        const consent = await loadPairingConsent(code);
        setLivePairing(consent);
        setLivePairingCode(code);
        setPairingCodeInput("");
        setDetail(null);
        openApproval(consent.approval.approval_id);
      } catch (error) {
        showError(
          error instanceof Error ? error.message : "Pairing lookup failed.",
        );
      }
      return;
    }
    if (pairingCodeInput.trim().toUpperCase() !== PAIRING_CODE) {
      showError(
        "Pairing code does not match the connector. Check the code displayed there.",
      );
      return;
    }
    const next = queuePairing(demo);
    setDemo(next);
    setDetail(null);
    setPairingCodeInput("");
    openApproval("apr_pair_claude");
  };

  const handleScannedPayload = async (payload: string) => {
    if (scanInProgress.current) return;
    scanInProgress.current = true;
    setScanBusy(true);
    setScanStatus("Checking this QR with WeBank...");
    setScanReview(null);
    setScanReceipt(null);
    setCameraOpen(false);
    try {
      const result = await scanGatewayQrPayload(payload);
      if (result.kind === "pairing") {
        const consent = await loadPairingConsent(result.user_code);
        setLivePairing(consent);
        setLivePairingCode(result.user_code);
        setDetail(null);
        openApproval(consent.approval.approval_id);
      } else {
        setScanReview(result);
        setScanStatus("Review the merchant and main-account payment below.");
      }
    } catch (error) {
      setScanStatus(
        error instanceof GatewayRequestError && error.code === "scan_invalid"
          ? "Not a WeBank payment code. Nothing was paid or paired."
          : error instanceof Error
            ? error.message
            : "This QR could not be checked.",
      );
    } finally {
      scanInProgress.current = false;
      setScanBusy(false);
    }
  };
  scanPayloadHandler.current = handleScannedPayload;

  const handleScanImage = async (uri: string) => {
    try {
      const payload = await decodeQrImageUri(uri);
      await handleScannedPayload(payload);
    } catch (error) {
      setScanStatus(
        error instanceof Error ? error.message : "The image could not be read.",
      );
    }
  };

  const chooseScanPhoto = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
      });
      if (!result.canceled && result.assets[0]?.uri)
        await handleScanImage(result.assets[0].uri);
    } catch (error) {
      setScanStatus(
        error instanceof Error ? error.message : "Photo selection failed.",
      );
    }
  };

  const chooseScanFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "image/*",
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (!result.canceled && result.assets[0]?.uri)
        await handleScanImage(result.assets[0].uri);
    } catch (error) {
      setScanStatus(
        error instanceof Error ? error.message : "File selection failed.",
      );
    }
  };

  const openScanCamera = async () => {
    if (Platform.OS === "web")
      return setScanStatus(
        "Use From photos or From files in this web preview.",
      );
    const granted =
      cameraPermission?.granted || (await requestCameraPermission()).granted;
    if (!granted) return setScanStatus("Camera access was not granted.");
    setCameraOpen(true);
    setScanStatus("Point the camera at a WeBank payment or pairing QR.");
  };

  const confirmScannedPayment = () => {
    const review = scanReview;
    if (!review || !isLocalDemo || !demoAuthenticated) {
      setScanStatus(
        "Secure payment signing is unavailable outside the explicit local demo.",
      );
      return;
    }
    if (Date.parse(review.expires_at) <= Date.now()) {
      setScanStatus("This review expired. Scan the QR again.");
      setScanReview(null);
      return;
    }
    setPendingSimulation({
      label: `Pay ${formatMoney(review.amount.amount)} from your main account to ${review.merchant_legal_name} (${review.merchant_uscc}) for order ${review.order_id}.`,
      run: () => {
        void (async () => {
          setScanBusy(true);
          setScanStatus("Waiting for a verified main-account transfer...");
          try {
            const receipt = await confirmSimulatedHumanPayment(review);
            setScanReceipt(receipt);
            setScanReview(null);
            setScanStatus(
              receipt.status === "completed"
                ? "Simulated main-account payment confirmed on FISCO BCOS."
                : "Payment outcome needs reconciliation. Do not submit it again.",
            );
            await refreshWallet();
          } catch (error) {
            if (
              error instanceof GatewayRequestError &&
              error.code === "reconciliation_required"
            ) {
              const receipt = await loadHumanPayment(
                review.confirmation_id,
              ).catch(() => null);
              if (receipt) setScanReceipt(receipt);
              setScanReview(null);
              setScanStatus(
                "Payment outcome needs reconciliation. Do not submit it again.",
              );
            } else {
              setScanStatus(
                error instanceof Error ? error.message : "Payment failed.",
              );
            }
          } finally {
            setScanBusy(false);
          }
        })();
      },
    });
  };

  useEffect(() => {
    if (Platform.OS !== "web" || detail !== "scan") return;
    const element = dropZoneRef.current as unknown as HTMLElement | null;
    if (!element) return;
    const prevent = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const onDrop = (event: DragEvent) => {
      prevent(event);
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      void (async () => {
        try {
          const payload = await decodeQrImageBlob(file);
          await scanPayloadHandler.current(payload);
        } catch (error) {
          setScanStatus(
            error instanceof Error
              ? error.message
              : "Dropped image could not be read.",
          );
        }
      })();
    };
    element.addEventListener("dragover", prevent);
    element.addEventListener("drop", onDrop);
    return () => {
      element.removeEventListener("dragover", prevent);
      element.removeEventListener("drop", onDrop);
    };
  }, [detail]);

  const handleFreezeAgent = async (agentId: string) => {
    if (isLive) {
      try {
        await freezeGatewayAgent(agentId);
        await refreshGateway();
      } catch (error) {
        showError(error instanceof Error ? error.message : "Freeze failed");
      }
      return;
    }
    setDemo((current) => freezeAgent(current, agentId));
  };

  const handleUnfreezeAgent = (agentId: string) => {
    if (isLive) {
      if (!isLocalDemo)
        return showError(
          "A registered biometric Secure Enclave key is required to unfreeze this agent.",
        );
      setPendingSimulation({
        label: `Simulate user-only Unfreeze for ${agentId}. This does not change a Red trust light.`,
        run: () => {
          void (async () => {
            try {
              const challenge = await prepareGatewayAgentAction(
                agentId,
                "unfreeze",
              );
              await completeSimulatedGatewayAgentAction(
                agentId,
                "unfreeze",
                challenge,
              );
              await refreshGateway();
            } catch (error) {
              showError(
                error instanceof Error ? error.message : "Unfreeze failed",
              );
            }
          })();
        },
      });
      return;
    }
    void securityAction(`Unfreeze ${agentId}`, () =>
      setDemo((current) => ({
        ...current,
        agents: current.agents.map((agent) =>
          agent.agent_id === agentId ? { ...agent, status: "active" } : agent,
        ),
      })),
    );
  };

  const handleIdleReauthorization = (agent: Agent) => {
    if (!isLive || !isLocalDemo)
      return showError(
        "A registered biometric Secure Enclave key is required to re-approve this connection.",
      );
    if (!demoAuthenticated)
      return showError("Sign in to the local owner app first.");
    if (
      !canReauthorizeConnection(agent) ||
      idleActionBusyId ||
      idleSubmissionInFlight.current
    )
      return showError("This connection is not eligible for idle re-approval.");
    setIdleActionBusyId(agent.agent_id);
    void (async () => {
      try {
        const challenge: IdleReauthorizationChallenge =
          await prepareGatewayIdleReauthorization(agent.agent_id);
        if (
          challenge.action !== "idle_reauthorize" ||
          challenge.agent_id !== agent.agent_id ||
          challenge.agent_summary.agent_id !== agent.agent_id ||
          challenge.agent_summary.client_app_id !== agent.client_app_id ||
          challenge.agent_summary.client_app_name !== agent.client_app_name ||
          !challenge.agent_summary.public_key_preview ||
          !Array.isArray(challenge.agent_summary.scopes) ||
          !/^sha256:[0-9a-fA-F]{64}$/.test(challenge.action_hash) ||
          Date.parse(challenge.expires_at) <= Date.now()
        )
          throw new Error(
            "The prepared connection details changed. Refresh and try again.",
          );
        setPendingSimulation({
          expiresAt: challenge.expires_at,
          label: `Re-approve ${challenge.agent_summary.display_name} in ${challenge.agent_summary.client_app_name}. This covers every chat in that app. Registered key: ${challenge.agent_summary.public_key_preview}. Scopes: ${challenge.agent_summary.scopes.join(", ")}. Exact action hash: ${wrapHash(challenge.action_hash)}. This owner action opens a ten-minute key renewal window; spending stays paused until the same connector key renews.`,
          run: () => {
            if (idleSubmissionInFlight.current) return;
            idleSubmissionInFlight.current = true;
            setIdleActionBusyId(agent.agent_id);
            void (async () => {
              try {
                const result =
                  await completeSimulatedGatewayIdleReauthorization(
                    agent.agent_id,
                    challenge,
                  );
                setIdleRenewalWindows((current) => ({
                  ...current,
                  [agent.agent_id]: result.renewal_expires_at,
                }));
                await refreshGateway();
              } catch (error) {
                showError(
                  error instanceof GatewayRequestError &&
                    error.code === "action_changed"
                    ? "This re-approval challenge expired or changed. Start a fresh one."
                    : error instanceof Error
                      ? error.message
                      : "Connection re-approval failed.",
                );
              } finally {
                idleSubmissionInFlight.current = false;
                setIdleActionBusyId(null);
              }
            })();
          },
        });
      } catch (error) {
        showError(
          error instanceof Error
            ? error.message
            : "Could not prepare connection re-approval.",
        );
      } finally {
        setIdleActionBusyId(null);
      }
    })();
  };

  const handleTrustEventReview = (agent: Agent) => {
    if (!isLive) return;
    setTrustReview({
      agentId: agent.agent_id,
      evidence: null,
      error: "",
      loading: true,
    });
    void (async () => {
      try {
        const result = await loadGatewayTrustEvents(agent.agent_id);
        if (!reviewableTrustEvidence(result, agent.agent_id))
          throw new Error("Trust evidence is unavailable or incomplete.");
        setTrustReview({
          agentId: agent.agent_id,
          evidence: result,
          error: "",
          loading: false,
        });
      } catch (error) {
        setTrustReview({
          agentId: agent.agent_id,
          evidence: null,
          error:
            error instanceof Error
              ? error.message
              : "Trust event history is unavailable.",
          loading: false,
        });
      }
    })();
  };

  const handleReturnToAmber = (agent: Agent) => {
    const reviewedEvidence = trustReview?.evidence ?? null;
    if (!isLocalDemo)
      return showError(
        "A registered biometric Secure Enclave key is required to return this agent to Amber.",
      );
    if (
      !demoAuthenticated ||
      agent.licence.level !== "RED" ||
      trustReview?.agentId !== agent.agent_id ||
      !reviewableTrustEvidence(reviewedEvidence, agent.agent_id) ||
      trustReview.error ||
      trustActionBusyId ||
      trustActionInFlight.current
    )
      return showError(
        "Review this agent's trust events before returning it to Amber.",
      );
    setTrustActionBusyId(agent.agent_id);
    void (async () => {
      try {
        const latestEvents = await loadGatewayTrustEvents(agent.agent_id);
        if (
          !trustEvidenceUnchanged(
            reviewedEvidence,
            latestEvents,
            agent.agent_id,
          )
        ) {
          setTrustReview({
            agentId: agent.agent_id,
            evidence: null,
            error:
              "Trust history changed. Review the updated evidence before continuing.",
            loading: false,
          });
          return;
        }
        const challenge: TrustActionChallenge =
          await prepareGatewayReturnToAmber(agent.agent_id);
        if (
          challenge.action !== "return_to_amber" ||
          challenge.agent_id !== agent.agent_id ||
          challenge.agent_summary.agent_id !== agent.agent_id ||
          challenge.agent_summary.level !== "RED" ||
          !/^sha256:[0-9a-fA-F]{64}$/.test(challenge.action_hash) ||
          Date.parse(challenge.expires_at) <= Date.now()
        )
          throw new Error(
            "Return to Amber challenge changed. Review the current agent state again.",
          );
        setPendingSimulation({
          expiresAt: challenge.expires_at,
          label: `Return ${agent.display_name} from Red to Amber after reviewing ${reviewedEvidence.items.length} recorded trust events and ${reviewedEvidence.legacy_evidence.length} restored legacy records. App: ${challenge.agent_summary.client_app_name ?? agent.client_app_name ?? "legacy identity"}. Key: ${challenge.agent_summary.public_key_preview ?? "see agent record"}. Reason: ${challenge.agent_summary.reason ?? agent.licence.reason}. Flags in 30 days: ${challenge.agent_summary.flags_30d ?? agent.licence.flags_30d}. Failed drills: ${challenge.agent_summary.drills_failed ?? agent.licence.drills_failed}. Evidence IDs: ${challenge.agent_summary.latest_evidence_ids?.join(", ") || "none"}. Exact action hash: ${wrapHash(challenge.action_hash)}. This keeps the history and any separate freeze; it does not approve a payment or promote to Green.`,
          run: () => {
            if (trustActionInFlight.current) return;
            trustActionInFlight.current = true;
            setTrustActionBusyId(agent.agent_id);
            void (async () => {
              try {
                await completeSimulatedGatewayReturnToAmber(
                  agent.agent_id,
                  challenge,
                );
                setTrustReview(null);
                await refreshGateway();
              } catch (error) {
                showError(
                  error instanceof Error
                    ? error.message
                    : "Return to Amber failed.",
                );
              } finally {
                trustActionInFlight.current = false;
                setTrustActionBusyId(null);
              }
            })();
          },
        });
      } catch (error) {
        showError(
          error instanceof Error
            ? error.message
            : "Could not prepare Return to Amber.",
        );
      } finally {
        setTrustActionBusyId(null);
      }
    })();
  };

  const handleDemoFastForwardGreen = (agent: Agent) => {
    if (
      !isLocalDemo ||
      !demoAuthenticated ||
      agent.status !== "active" ||
      agent.licence.level !== "AMBER"
    )
      return showError(
        "The simulated Green control is available only for an active Amber agent in the local owner demo.",
      );
    if (trustActionBusyId || trustActionInFlight.current) return;
    setTrustActionBusyId(agent.agent_id);
    void (async () => {
      try {
        const challenge = await prepareGatewayDemoFastForwardGreen(
          agent.agent_id,
        );
        if (
          challenge.action !== "demo_fast_forward_green" ||
          challenge.agent_id !== agent.agent_id ||
          challenge.agent_summary.agent_id !== agent.agent_id ||
          (challenge.agent_summary.level &&
            challenge.agent_summary.level !== "AMBER") ||
          !/^sha256:[0-9a-fA-F]{64}$/.test(challenge.action_hash) ||
          Date.parse(challenge.expires_at) <= Date.now()
        )
          throw new Error("Demo Green challenge changed or expired.");
        setPendingSimulation({
          expiresAt: challenge.expires_at,
          label: `LOCAL DEMO OVERRIDE: Simulate Green for ${agent.display_name}. Exact action hash: ${wrapHash(challenge.action_hash)}. This records a demo override only. It does not fabricate completed purchases or fire drills, raise your limits, or remove a freeze.`,
          run: () => {
            if (trustActionInFlight.current) return;
            trustActionInFlight.current = true;
            setTrustActionBusyId(agent.agent_id);
            void (async () => {
              try {
                await completeSimulatedGatewayDemoFastForwardGreen(
                  agent.agent_id,
                  challenge,
                );
                await refreshGateway();
              } catch (error) {
                showError(
                  error instanceof Error
                    ? error.message
                    : "Demo Green override failed.",
                );
              } finally {
                trustActionInFlight.current = false;
                setTrustActionBusyId(null);
              }
            })();
          },
        });
      } catch (error) {
        showError(
          error instanceof Error
            ? error.message
            : "Could not prepare demo Green override.",
        );
      } finally {
        setTrustActionBusyId(null);
      }
    })();
  };

  const handleDemoDrill = (action: "start" | "stop") => {
    if (!isLocalDemo || !demoAuthenticated || demoDrillBusy) return;
    setDemoDrillBusy(true);
    void (async () => {
      try {
        const result =
          action === "start"
            ? await startGatewayDemoDrill()
            : await stopGatewayDemoDrill();
        setDemoDrill(result);
        setDemoDrillError("");
      } catch (error) {
        setDemoDrillError(
          error instanceof Error
            ? error.message
            : "Demo drill control unavailable.",
        );
      } finally {
        setDemoDrillBusy(false);
      }
    })();
  };

  const handleDeleteAgent = (agentId: string, name: string) => {
    const run = () => {
      void (async () => {
        try {
          if (isLive) {
            await deleteGatewayAgent(agentId);
            await refreshGateway();
          } else
            setDemo((current) => ({
              ...current,
              agents: current.agents.filter(
                (agent) => agent.agent_id !== agentId,
              ),
            }));
        } catch (error) {
          showError(error instanceof Error ? error.message : "Delete failed");
        }
      })();
    };
    if (Platform.OS === "web") {
      if (
        window.confirm(
          `Delete ${name}? Access will be revoked. Payment and audit history will remain.`,
        )
      )
        run();
    } else
      Alert.alert(
        "Delete agent",
        `Revoke ${name} and remove it from the list? History remains.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Delete agent", style: "destructive", onPress: run },
        ],
      );
  };

  const handleReject = () => {
    if (approvalSubmissionInFlight.current) return;
    if (!selectedApproval) {
      return;
    }
    if (isLive) {
      void (async () => {
        try {
          if (
            livePairing?.approval.approval_id === selectedApproval.approval_id
          ) {
            await denyGatewayPairing(livePairingCode);
            setLivePairing(null);
            setLivePairingCode("");
          } else {
            await rejectGatewayApproval(selectedApproval.approval_id);
          }
          setSelectedApprovalId(null);
          setTab("home");
          await refreshGateway();
        } catch (error) {
          showError(
            error instanceof Error ? error.message : "Rejection failed.",
          );
        }
      })();
      return;
    }
    setDemo((current) => rejectApproval(current, selectedApproval.approval_id));
    setSelectedApprovalId(null);
    setTab("home");
  };

  const title = useMemo(
    () =>
      ({
        home: "Good morning, Lin.",
        wallet: "Agent Wallet",
        approvals: "Approvals",
        agents: "Connected agents",
        history: "Activity",
      })[tab],
    [tab],
  );

  return (
    <View style={styles.outer}>
      <StatusBar barStyle="light-content" />
      <View style={[styles.shell, { width: Math.min(width, 480) }]}>
        <View style={styles.topbar}>
          <View style={styles.brandRow}>
            <View style={styles.brandMark}>
              <View style={styles.brandBarShort} />
              <View style={styles.brandBarTall} />
              <View style={styles.brandBarMid} />
            </View>
            <View>
              <Text style={styles.brandName}>WeBank</Text>
              <Text style={styles.brandSub}>AGENT WALLET</Text>
            </View>
          </View>
          <Badge tone="dark">
            {isLocalDemo
              ? "LOCAL DEMO · SIMULATED"
              : isLive
                ? "GATEWAY PREVIEW"
                : "SIMULATED DEMO"}
          </Badge>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {detail === "pair" ? (
            <>
              <Text style={styles.back} onPress={() => setDetail(null)}>
                ‹ Connected agents
              </Text>
              <SectionTitle kicker="SECURE CONNECTION" title="Pair an agent" />
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Code from your connector</Text>
                <Text style={styles.bodyText}>
                  Open the connector on your Mac and enter its pairing code
                  here. The six-digit request number comes later, on the
                  approval step.
                </Text>
                <TextInput
                  testID="pairing-code-input"
                  style={styles.input}
                  placeholder="XXXX-XXXX"
                  placeholderTextColor="#AAA5AF"
                  autoCapitalize="characters"
                  value={pairingCodeInput}
                  onChangeText={setPairingCodeInput}
                />
                <Button
                  testID="start-pairing"
                  onPress={() => void startPairing()}
                >
                  Continue to consent
                </Button>
              </View>
              <View style={styles.notice}>
                <Text style={styles.noticeTitle}>
                  {isLocalDemo
                    ? "SIMULATED GATEWAY PAIRING"
                    : isLive
                      ? "GATEWAY PAIRING"
                      : "DEMO CONNECTOR"}
                </Text>
                <Text style={styles.noticeText}>
                  {isLocalDemo
                    ? "Consent details come from the loopback Gateway. Approval uses an explicit simulation and never invokes Face ID."
                    : isLive
                      ? "Consent details come from the Gateway. Live approval requires a registered Secure Enclave key and is currently unavailable. You can deny the request."
                      : "The matching demo code is documented outside the app in this package's README. No bank account or real agent is connected."}
                </Text>
              </View>
            </>
          ) : detail === "scan" ? (
            <>
              <Text style={styles.back} onPress={() => setDetail(null)}>
                ‹ Home
              </Text>
              <SectionTitle
                kicker="PAY FROM MAIN ACCOUNT"
                title="Scan a code"
              />
              <View style={styles.card}>
                <Text style={styles.cardTitle}>A QR in a photo or file</Text>
                <Text style={styles.bodyText}>
                  Choose a checkout screenshot, or drop it here in the web and
                  mirrored preview. WeBank checks the signed bill before any
                  payment review opens.
                </Text>
                <View style={styles.twoButtons}>
                  <View style={styles.halfButton}>
                    <Button
                      testID="scan-from-photos"
                      tone="light"
                      onPress={() => void chooseScanPhoto()}
                    >
                      From photos
                    </Button>
                  </View>
                  <View style={styles.halfButton}>
                    <Button
                      testID="scan-from-files"
                      tone="light"
                      onPress={() => void chooseScanFile()}
                    >
                      From files
                    </Button>
                  </View>
                </View>
                {Platform.OS === "web" ? (
                  <View
                    ref={dropZoneRef}
                    testID="scan-drop-zone"
                    style={styles.scanDropZone}
                  >
                    <Text style={styles.scanDropText}>
                      Drop a screenshot here
                    </Text>
                    <Text style={styles.finePrint}>
                      The image stays on this device. Only its QR content is
                      checked by the local Gateway.
                    </Text>
                  </View>
                ) : (
                  <Button
                    testID="scan-with-camera"
                    tone="ghost"
                    onPress={() => void openScanCamera()}
                  >
                    Use camera
                  </Button>
                )}
                {cameraOpen && Platform.OS !== "web" ? (
                  <CameraView
                    style={styles.scanCamera}
                    barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                    onBarcodeScanned={({ data }) =>
                      void handleScannedPayload(data)
                    }
                  />
                ) : null}
              </View>
              {scanStatus ? (
                <View style={styles.notice}>
                  <Text style={styles.noticeText}>{scanStatus}</Text>
                </View>
              ) : null}
              {scanBusy ? <ActivityIndicator color={colors.purple} /> : null}
              {scanReview ? (
                <View style={styles.card}>
                  <Badge>SIMULATED MAIN-ACCOUNT PAYMENT</Badge>
                  <Text style={[styles.cardTitle, { marginTop: 12 }]}>
                    Review this bill
                  </Text>
                  <InfoRow
                    label="Registered merchant"
                    value={scanReview.merchant_legal_name}
                  />
                  <InfoRow label="Legal ID" value={scanReview.merchant_uscc} />
                  <InfoRow label="Order" value={scanReview.order_id} />
                  <InfoRow label="From" value="Main account" />
                  <InfoRow
                    label="Total"
                    value={formatMoney(scanReview.amount.amount)}
                    last
                  />
                  <Button
                    testID="confirm-scanned-payment"
                    disabled={scanBusy || !isLocalDemo || !demoAuthenticated}
                    onPress={confirmScannedPayment}
                  >
                    {isLocalDemo
                      ? "Confirm simulated payment"
                      : "Secure signing unavailable"}
                  </Button>
                  <Text style={styles.finePrint}>
                    This pays from the main account. It does not fund or use the
                    Agent Wallet and creates no mandate. The local web
                    confirmation is simulated; it is not Face ID.
                  </Text>
                </View>
              ) : null}
              {scanReceipt ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>
                    {scanReceipt.status === "completed"
                      ? "Payment confirmed"
                      : "Payment pending reconciliation"}
                  </Text>
                  <InfoRow label="Order" value={scanReceipt.order_id} />
                  <InfoRow label="From" value="Main account" />
                  <InfoRow
                    label="Amount"
                    value={formatMoney(scanReceipt.amount.amount)}
                  />
                  {scanReceipt.chain.tx_hash ? (
                    <InfoRow
                      label="Chain transaction"
                      value={wrapHash(scanReceipt.chain.tx_hash)}
                    />
                  ) : null}
                  <Button
                    testID="refresh-scanned-payment"
                    tone="ghost"
                    onPress={() => {
                      void loadHumanPayment(scanReceipt.confirmation_id).then(
                        (next) => {
                          setScanReceipt(next);
                          if (next.status === "completed")
                            setScanStatus("Payment confirmed on FISCO BCOS.");
                        },
                      );
                    }}
                  >
                    Refresh status
                  </Button>
                </View>
              ) : null}
            </>
          ) : detail === "demo" ? (
            <>
              <Text style={styles.back} onPress={() => setDetail(null)}>
                ‹ Home
              </Text>
              <SectionTitle
                kicker="ON-STAGE SIMULATION"
                title="Demo controls"
              />
              <View style={styles.notice}>
                <Text style={styles.noticeTitle}>LOCAL STATE ONLY</Text>
                <Text style={styles.noticeText}>
                  These controls create sample requests for the walkthrough.
                  They do not contact a shop, move money, or write to FISCO
                  BCOS.
                </Text>
              </View>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>First payment</Text>
                <Text style={styles.bodyText}>
                  Queue a ¥279.00 headphone purchase from the mock Shop A.
                  Claude must be connected and the wallet funded.
                </Text>
                <Button
                  testID="queue-first-payment"
                  disabled={
                    !activeAgent ||
                    demo.walletBalance < 27900 ||
                    demo.perPaymentMax < 27900 ||
                    demo.payments.some(
                      (payment) => payment.payment_id === "pay_first",
                    ) ||
                    demo.frozenAll
                  }
                  onPress={() => {
                    setDemo((current) => queueFirstPayment(current));
                    setDetail(null);
                    setTab("approvals");
                  }}
                >
                  Queue payment request
                </Button>
              </View>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Poisoned listing</Text>
                <Text style={styles.bodyText}>
                  Record a blocked request to an unverified payment link. The
                  wallet balance stays the same.
                </Text>
                <Button
                  testID="simulate-attack"
                  tone="light"
                  disabled={!activeAgent || demo.frozenAll}
                  onPress={() => {
                    setDemo((current) => simulateBlockedAttack(current));
                    setDetail(null);
                    setTab("history");
                  }}
                >
                  Simulate block
                </Button>
              </View>
              <Button
                testID="reset-demo"
                tone="ghost"
                onPress={() => {
                  setDemo(initialDemoState());
                  setDetail(null);
                  setSelectedApprovalId(null);
                  setSelectedPaymentId(null);
                  setTab("home");
                }}
              >
                Reset demo
              </Button>
            </>
          ) : selectedApproval && tab === "approvals" ? (
            <>
              <Text
                style={styles.back}
                onPress={() => {
                  setSelectedApprovalId(null);
                  setNumberInput("");
                }}
              >
                ‹ All approvals
              </Text>
              <SectionTitle
                kicker="VERIFY THIS ACTION"
                title={
                  selectedApproval.kind === "pairing"
                    ? "Connect an agent"
                    : selectedApproval.kind === "payment"
                      ? "Payment request"
                      : "Review request"
                }
              />
              <View style={styles.notice}>
                <Text style={styles.noticeTitle}>
                  {isLocalDemo
                    ? "SIMULATED APPROVAL · NO BIOMETRIC PROOF"
                    : selectedApproval.level === "zero_trust"
                      ? "ZERO TRUST · NUMBER MATCHING"
                      : "FRESH BIOMETRIC REQUIRED"}
                </Text>
                <Text style={styles.noticeText}>
                  {isLocalDemo
                    ? "This loopback test uses a simulated approval proof. Read the card and enter the connector number when required. No Face ID or Secure Enclave signing occurs."
                    : "Read this card yourself. Agent instructions and chat messages cannot authorize this action."}
                </Text>
              </View>
              {selectedApprovalTrust ? (
                <View style={styles.card}>
                  <TrustLight {...selectedApprovalTrust} />
                </View>
              ) : selectedApproval.kind === "payment" ||
                selectedApproval.kind === "mandate" ? (
                <View style={styles.card}>
                  <Text style={styles.feedback}>
                    Trust light is unavailable. Refresh this approval before
                    deciding.
                  </Text>
                </View>
              ) : null}
              {compositeApprovalId ? (
                compositeReviewReady && paymentReview ? (
                  <PaymentReviewCard
                    review={paymentReview}
                    secondsLeft={secondsRemaining(
                      selectedApproval.expires_at,
                      clock,
                    )}
                  />
                ) : (
                  <View style={styles.card} testID="payment-review-unavailable">
                    <Text style={styles.cardTitle}>
                      Verified payment review required
                    </Text>
                    <Text style={styles.bodyText}>
                      {paymentReviewLoading
                        ? "Loading the locked intent and signed order from Gateway..."
                        : paymentReviewError ||
                          "The payment review is missing, changed, or expired. Approval is unavailable."}
                    </Text>
                    {!paymentReviewLoading ? (
                      <Button
                        tone="light"
                        testID="retry-payment-review"
                        onPress={() =>
                          setPaymentReviewRetry((count) => count + 1)
                        }
                      >
                        Reload verified review
                      </Button>
                    ) : null}
                  </View>
                )
              ) : (
                <View style={styles.card} testID="approval-card">
                  <View style={styles.cardTop}>
                    <Badge>{selectedApproval.kind.toUpperCase()}</Badge>
                    <Text style={styles.expiry}>
                      {selectedApproval.kind === "pairing"
                        ? "Pairing code: "
                        : "Expires in "}
                      {secondsRemaining(selectedApproval.expires_at, clock)}s
                    </Text>
                  </View>
                  <Text style={styles.approvalTitle}>
                    {approvalView(selectedApproval).title}
                  </Text>
                  {approvalView(selectedApproval).lines.map((line) => (
                    <View key={line} style={styles.bulletRow}>
                      <Text style={styles.bullet}>•</Text>
                      <Text style={styles.bulletText}>
                        {wrapApprovalLine(line)}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
              {isLive &&
              livePairing?.approval.approval_id ===
                selectedApproval.approval_id ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Connection details</Text>
                  <InfoRow
                    label="App"
                    value={livePairing.pairing.client_name}
                  />
                  <InfoRow
                    label="Provider"
                    value={livePairing.pairing.provider}
                  />
                  <PairingClientScope
                    clientAppName={livePairing.pairing.client_app_name}
                    publicKey={livePairing.public_key}
                  />
                  <InfoRow
                    label="Scopes"
                    value={livePairing.pairing.requested_scopes.join(", ")}
                    last
                  />
                  <Text style={styles.bodyText}>
                    Approval creates a new agent identity with its own wallet
                    limits.
                  </Text>
                </View>
              ) : null}
              {selectedApproval.level === "zero_trust" ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Match the request number</Text>
                  <Text style={styles.bodyText}>
                    Type the six-digit number shown by the connector on your
                    Mac. This app never shows that number.
                  </Text>
                  {isLive && selectedApproval.kind === "pairing" ? (
                    <Text
                      testID="request-number-expiry"
                      style={styles.bodyText}
                    >
                      {selectedPairing?.status !== "pending"
                        ? "This pairing request is closed. Start a new request from the connector."
                        : selectedNumberExpired
                          ? "Request number expired. Ask the connector to refresh and show its current number."
                          : `Request number: ${selectedNumberSeconds}s left. It changes before the pairing code expires.`}
                    </Text>
                  ) : null}
                  <TextInput
                    testID="request-number-input"
                    style={[styles.input, styles.numberInput]}
                    keyboardType="number-pad"
                    maxLength={6}
                    placeholder="••••••"
                    placeholderTextColor="#AAA5AF"
                    value={numberInput}
                    onChangeText={(value) =>
                      setNumberInput(value.replace(/\D/g, ""))
                    }
                  />
                  {numberMessage ? (
                    <Text testID="number-message" style={styles.feedback}>
                      {numberMessage}
                    </Text>
                  ) : null}
                </View>
              ) : null}
              {selectedApproval.level !== "zero_trust" && numberMessage ? (
                <Text testID="approval-message" style={styles.feedback}>
                  {numberMessage}
                </Text>
              ) : null}
              <View style={styles.actionStack}>
                <Button
                  testID="approve-action"
                  disabled={
                    approvalBusy ||
                    !compositeReviewReady ||
                    (isLive && (!isLocalDemo || !demoAuthenticated)) ||
                    selectedApproval.status !== "pending" ||
                    ((selectedApproval.kind === "payment" ||
                      selectedApproval.kind === "mandate") &&
                      !selectedApproval.trust_light) ||
                    selectedApproval.trust_light === "RED" ||
                    Date.parse(selectedApproval.expires_at) <= clock ||
                    (selectedApproval.kind === "pairing" &&
                      (selectedNumberExpired ||
                        !livePairing?.pairing.client_app_name ||
                        selectedPairing?.status !== "pending")) ||
                    (selectedApproval.level === "zero_trust" &&
                      numberInput.length !== 6 &&
                      (isLive ||
                        !demo.matchedApprovals.includes(
                          selectedApproval.approval_id,
                        )))
                  }
                  onPress={handleApprove}
                >
                  {approvalBusy
                    ? "Submitting approval..."
                    : isLocalDemo
                      ? demoAuthenticated
                        ? "Simulate approval"
                        : "Sign in to simulate"
                      : isLive
                        ? "Secure signing not available"
                        : "Approve with biometric check"}
                </Button>
                <Button
                  testID="reject-action"
                  tone="ghost"
                  disabled={approvalBusy}
                  onPress={handleReject}
                >
                  {isLocalDemo ? "Reject simulated request" : "Reject request"}
                </Button>
              </View>
              <Text style={styles.finePrint}>
                {isLocalDemo
                  ? "SIMULATED LOCAL DEMO ONLY. The Gateway test verifier accepts a fixed simulation marker. This is not Face ID and cannot be used by a production Gateway."
                  : isLive
                    ? "Live approval is locked until this phone has a registered biometric-only Secure Enclave signing key. The entered number is not sent without a valid action-bound signature."
                    : "Demo mode verifies a local biometric prompt on a device or an explicit simulation on web. It does not create a Secure Enclave signature."}
              </Text>
            </>
          ) : selectedPayment && tab === "history" ? (
            <>
              <Text
                style={styles.back}
                onPress={() => setSelectedPaymentId(null)}
              >
                ‹ Activity
              </Text>
              <SectionTitle
                kicker={isLive ? "GATEWAY PAYMENT" : "SAMPLE RECEIPT"}
                title={
                  selectedPayment.status === "paid"
                    ? "Payment complete"
                    : selectedPayment.status === "denied"
                      ? "Payment blocked"
                      : "Awaiting your decision"
                }
              />
              <LinearGradient
                colors={
                  selectedPayment.status === "paid"
                    ? ["#2F1F66", "#A24DB8", "#D87AAB"]
                    : ["#29202E", "#7E334D"]
                }
                style={styles.receiptHero}
              >
                <Text style={styles.receiptKicker}>
                  {selectedPayment.status === "paid"
                    ? "PAID"
                    : selectedPayment.status === "denied"
                      ? "DENIED"
                      : "AWAITING USER"}
                  {isLive ? " - GATEWAY" : " - DEMO"}
                </Text>
                <Text style={styles.receiptAmount}>
                  {formatMoney(selectedPayment.amount)}
                </Text>
                <Text style={styles.receiptMerchant}>
                  {selectedPayment.merchant}
                </Text>
              </LinearGradient>
              <View style={styles.card} testID="receipt-detail">
                <InfoRow
                  label="Legal payee"
                  value={
                    isLive
                      ? (livePaymentDetail?.receipt?.merchant_legal_name ??
                        "Pending receipt")
                      : selectedPayment.merchantLegalName
                  }
                />
                {!isLive ? (
                  <InfoRow label="Item" value={selectedPayment.item} />
                ) : null}
                <InfoRow
                  label="When"
                  value={new Date(
                    isLive
                      ? (livePaymentDetail?.receipt?.issued_at ??
                          selectedPayment.at)
                      : selectedPayment.at,
                  ).toLocaleString()}
                />
                <InfoRow
                  label="Decision"
                  value={selectedPayment.status.toUpperCase()}
                />
                {selectedPayment.status === "paid" &&
                selectedPayment.approvalSource ? (
                  <InfoRow
                    label="Approval path"
                    value={
                      selectedPayment.approvalSource === "auto"
                        ? "Auto-paid under Green within your threshold"
                        : "Approved by owner"
                    }
                  />
                ) : null}
                <InfoRow
                  label="Why"
                  value={
                    isLive
                      ? (livePaymentDetail?.decision.user_explanation ??
                        "See Gateway decision")
                      : selectedPayment.reason
                  }
                  last={!isLive || !livePaymentDetail?.receipt}
                />
                {isLive && livePaymentDetail?.receipt ? (
                  <InfoRow
                    label="Audit tx"
                    value={wrapHash(livePaymentDetail.receipt.chain.audit_tx)}
                    last={!livePaymentDetail.receipt.chain.payment_tx}
                  />
                ) : null}
                {isLive && livePaymentDetail?.receipt?.chain.payment_tx ? (
                  <InfoRow
                    label="Payment tx"
                    value={wrapHash(livePaymentDetail.receipt.chain.payment_tx)}
                    last
                  />
                ) : null}
              </View>
              <View style={styles.notice}>
                <Text style={styles.noticeTitle}>
                  {isLive ? "GATEWAY RECORD" : "CHAIN EVIDENCE"}
                </Text>
                <Text style={styles.noticeText}>
                  {isLive
                    ? livePaymentError ||
                      (livePaymentDetail?.receipt
                        ? `Receipt ${livePaymentDetail.receipt.receipt_id} · ${livePaymentDetail.receipt.chain.network}. Signature and chain hashes are displayed as returned by Gateway, not independently verified by this app.`
                        : "Waiting for a signed receipt from Gateway. Status refreshes every three seconds.")
                    : "This is a sample receipt. No real payment or audit transaction was sent to FISCO BCOS from this app flow."}
                </Text>
              </View>
            </>
          ) : (
            <>
              <View style={styles.pageIntro}>
                <Text style={styles.kicker}>
                  {tab === "home"
                    ? "YOUR MONEY, YOUR RULES"
                    : "WE BANK / AGENT SERVICES"}
                </Text>
                <Text style={styles.pageTitle}>{title}</Text>
              </View>
              {gatewayError ? (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>
                    {gatewayError}{" "}
                    {lastSyncedAt
                      ? `Last updated ${new Date(lastSyncedAt).toLocaleTimeString()}.`
                      : "No live data has loaded."}
                  </Text>
                </View>
              ) : null}
              {isLocalDemo && !demoAuthenticated ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>
                    Sign in to the simulated local Gateway
                  </Text>
                  <Text style={styles.bodyText}>
                    Read the private local app token from the file path printed
                    by the launcher. The app sends it to the loopback Gateway
                    for sign-in and clears the input after each attempt.
                  </Text>
                  <TextInput
                    testID="local-demo-token-input"
                    style={styles.input}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="Private local app token"
                    placeholderTextColor="#AAA5AF"
                    value={demoLoginToken}
                    onChangeText={setDemoLoginToken}
                  />
                  <Button
                    testID="local-demo-login"
                    onPress={() => void handleLocalDemoLogin()}
                  >
                    Sign in to simulation
                  </Button>
                </View>
              ) : null}
              {tab === "home" ? (
                <>
                  <LinearGradient
                    colors={["#17141D", "#302144", "#6B398C"]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.mainCard}
                  >
                    <View style={styles.orb} />
                    <Text style={styles.mainCardLabel}>
                      {isLive
                        ? "MAIN ACCOUNT · SIMULATED CHAIN"
                        : "MAIN ACCOUNT · DEMO BALANCE"}
                    </Text>
                    <Text style={styles.mainCardAmount}>
                      {mainBalance === undefined
                        ? "Unavailable"
                        : formatMoney(mainBalance)}
                    </Text>
                    <View style={styles.mainCardFooter}>
                      <Text style={styles.mainCardFooterText}>
                        {isLive ? `Balance ${balanceState}` : "WeBank account"}
                      </Text>
                      <Text style={styles.mainCardFooterText}>
                        {isLive
                          ? liveHome && balanceState === "confirmed"
                            ? `Block ${liveHome.block_number}`
                            : "Chain unavailable"
                          : "•• 0842"}
                      </Text>
                    </View>
                  </LinearGradient>
                  <Button
                    testID="open-scan"
                    tone="light"
                    onPress={() => {
                      setScanStatus("");
                      setScanReview(null);
                      setScanReceipt(null);
                      setCameraOpen(false);
                      setDetail("scan");
                    }}
                  >
                    Scan payment or pairing QR
                  </Button>
                  <SectionTitle
                    kicker="YOUR AGENTS"
                    title="Agent Wallet"
                    right={
                      isLive
                        ? balanceState.toUpperCase()
                        : demo.enabled
                          ? "ACTIVE"
                          : "SETUP"
                    }
                  />
                  <View style={styles.walletPanel}>
                    <View style={styles.walletPanelTop}>
                      <View>
                        <Text style={styles.walletSmall}>
                          SEPARATE SPENDING POT
                        </Text>
                        <Text style={styles.walletAmount}>
                          {walletBalance === undefined
                            ? "Unavailable"
                            : formatMoney(walletBalance)}
                        </Text>
                      </View>
                      <View style={styles.purpleCircle}>
                        <Text style={styles.purpleCircleText}>↗</Text>
                      </View>
                    </View>
                    <Text style={styles.bodyText}>
                      Agents can only request payments from this wallet, within
                      your rules.
                    </Text>
                    {isLive && liveHome && balanceState === "confirmed" ? (
                      <Text style={styles.finePrint}>
                        {formatMoney(liveHome.agent_wallet.reserved.amount)}{" "}
                        reserved ·{" "}
                        {formatMoney(liveHome.agent_wallet.available.amount)}{" "}
                        available
                      </Text>
                    ) : null}
                    {demo.enabled || isLive ? (
                      <Button
                        testID="open-wallet"
                        onPress={() => setTab("wallet")}
                      >
                        View wallet and limits
                      </Button>
                    ) : (
                      <Button
                        testID="enable-wallet"
                        onPress={() =>
                          void securityAction("Enable Agent Wallet", () =>
                            setDemo((current) => enableWallet(current)),
                          )
                        }
                      >
                        Enable Agent Wallet
                      </Button>
                    )}
                  </View>
                  {!isLive && demo.enabled && demo.walletBalance === 0 ? (
                    <View style={styles.actionStack}>
                      <Button
                        testID="fund-wallet-home"
                        tone="light"
                        onPress={() =>
                          setDemo((current) => fundWallet(current, 100000))
                        }
                      >
                        Move ¥1,000.00 into wallet - demo
                      </Button>
                    </View>
                  ) : null}
                  <SectionTitle
                    kicker="NEEDS YOUR ATTENTION"
                    title="Requests"
                    right={`${pendingApprovals.length} PENDING`}
                  />
                  {pendingApprovals.length ? (
                    pendingApprovals.slice(0, 2).map((approval) => (
                      <Pressable
                        testID={`home-approval-${approval.approval_id}`}
                        key={approval.approval_id}
                        onPress={() => openApproval(approval.approval_id)}
                        style={styles.listCard}
                      >
                        <View style={styles.listIcon}>
                          <Text style={styles.listIconText}>!</Text>
                        </View>
                        <View style={styles.listBody}>
                          <Text style={styles.listTitle}>
                            {approvalView(approval).title}
                          </Text>
                          <Text style={styles.listSub}>
                            Review details and confirm yourself
                          </Text>
                        </View>
                        <Text style={styles.chevron}>›</Text>
                      </Pressable>
                    ))
                  ) : (
                    <View style={styles.emptyCard}>
                      <Text style={styles.emptyText}>
                        No approvals waiting right now.
                      </Text>
                    </View>
                  )}
                  <SectionTitle kicker="RECENT" title="Activity" />
                  {latestActivity.length ? (
                    latestActivity.map((payment) => (
                      <PaymentRow
                        key={payment.payment_id}
                        payment={payment}
                        onPress={() => openPayment(payment.payment_id)}
                      />
                    ))
                  ) : (
                    <View style={styles.emptyCard}>
                      <Text style={styles.emptyText}>
                        Payments and blocked attempts will appear here.
                      </Text>
                    </View>
                  )}
                  {!isLive ? (
                    <Pressable
                      testID="open-demo-controls"
                      onPress={() => setDetail("demo")}
                      style={styles.demoLink}
                    >
                      <Text style={styles.demoLinkText}>
                        Open demo controls
                      </Text>
                      <Text style={styles.chevron}>↗</Text>
                    </Pressable>
                  ) : null}
                </>
              ) : null}

              {tab === "wallet" ? (
                <>
                  <LinearGradient
                    colors={["#34227E", "#7541B4", "#D36BB3"]}
                    style={styles.walletHero}
                  >
                    <Text style={styles.walletHeroLabel}>
                      AGENT WALLET · SIMULATED
                    </Text>
                    <Text style={styles.walletHeroAmount}>
                      {walletBalance === undefined
                        ? "Unavailable"
                        : formatMoney(walletBalance)}
                    </Text>
                    <Text style={styles.walletHeroFoot}>
                      Separate from your main account
                    </Text>
                  </LinearGradient>
                  {isLive ? (
                    <>
                      <View style={styles.notice}>
                        <Text style={styles.noticeTitle}>
                          {balanceState === "confirmed"
                            ? "CHAIN CONFIRMED · SIMULATED CNY"
                            : `BALANCE ${balanceState.toUpperCase()}`}
                        </Text>
                        <Text style={styles.noticeText}>
                          {balanceState === "confirmed"
                            ? `Observed at block ${liveHome?.block_number} on ${liveHome?.observed_at}.`
                            : homeError ||
                              "Waiting for a confirmed chain reading. Transfers are unavailable."}
                        </Text>
                      </View>
                      {liveHome && balanceState === "confirmed" ? (
                        <View style={styles.card}>
                          <InfoRow
                            label="Main account"
                            value={formatMoney(
                              liveHome.main_account.balance.amount,
                            )}
                          />
                          <InfoRow
                            label="Agent Wallet balance"
                            value={formatMoney(
                              liveHome.agent_wallet.balance.amount,
                            )}
                          />
                          <InfoRow
                            label="Reserved for mandates"
                            value={formatMoney(
                              liveHome.agent_wallet.reserved.amount,
                            )}
                          />
                          <InfoRow
                            label="Available to use or return"
                            value={formatMoney(
                              liveHome.agent_wallet.available.amount,
                            )}
                            last
                          />
                        </View>
                      ) : null}
                      {homeLoading && !liveHome ? (
                        <ActivityIndicator color={colors.purple} />
                      ) : null}
                      <SectionTitle
                        kicker="MOVE MONEY"
                        title="Transfer between accounts"
                      />
                      <TransferControl
                        direction={transfer.direction}
                        amountInput={transfer.amountInput}
                        sourceBalanceFen={
                          liveBalanceUsable && liveHome
                            ? transfer.direction === "fund"
                              ? liveHome.main_account.balance.amount
                              : liveHome.agent_wallet.available.amount
                            : null
                        }
                        busy={transferActionsBlocked(
                          fundingBusy,
                          fundingInFlight,
                          sweepInFlight,
                        )}
                        reviewDisabled={
                          transfer.direction === "fund" && !isLocalDemo
                        }
                        onReverse={() => {
                          if (
                            transferActionsBlocked(
                              fundingBusy,
                              fundingInFlight,
                              sweepInFlight,
                            )
                          )
                            return;
                          transferEditVersion.current += 1;
                          setTransfer((current) =>
                            reverseTransfer(
                              current,
                              liveBalanceUsable && liveHome
                                ? liveHome.agent_wallet.available.amount
                                : null,
                            ),
                          );
                          setPendingSimulation((pending) =>
                            pending?.fundingId ? null : pending,
                          );
                          setFundingMessage("");
                        }}
                        onAmountChange={(value) => {
                          transferEditVersion.current += 1;
                          setTransfer((current) =>
                            editTransferAmount(current, value),
                          );
                          setPendingSimulation((pending) =>
                            pending?.fundingId ? null : pending,
                          );
                        }}
                        onReview={() =>
                          transfer.direction === "fund"
                            ? void startFundingReview()
                            : startReturnReview()
                        }
                      />
                      {!isLocalDemo && transfer.direction === "fund" ? (
                        <Text style={styles.finePrint}>
                          Funding requires local simulated owner confirmation. A
                          production biometric signing key is not connected.
                        </Text>
                      ) : null}
                      {transfer.direction === "fund" &&
                      transfer.fundingReview ? (
                        <View testID="funding-review" style={styles.card}>
                          <Text style={styles.cardTitle}>Review transfer</Text>
                          <InfoRow label="From" value="WeBank main account" />
                          <InfoRow label="To" value="Agent Wallet" />
                          <Text selectable style={styles.finePrint}>
                            Destination{" "}
                            {
                              transfer.fundingReview.challenge
                                .destination_address
                            }
                          </Text>
                          <InfoRow
                            label="Amount"
                            value={formatMoney(
                              transfer.fundingReview.amountFen,
                            )}
                            last
                          />
                          <Text style={styles.finePrint}>
                            This review expires{" "}
                            {new Date(
                              transfer.fundingReview.challenge.expires_at,
                            ).toLocaleTimeString()}
                            .
                          </Text>
                          <Button
                            testID="confirm-funding"
                            disabled={
                              fundingBusy ||
                              !liveBalanceUsable ||
                              Boolean(fundingInFlight || sweepInFlight) ||
                              Date.parse(
                                transfer.fundingReview.challenge.expires_at,
                              ) <= clock
                            }
                            onPress={confirmFunding}
                          >
                            Confirm with simulated biometric
                          </Button>
                          <Button
                            tone="ghost"
                            onPress={() =>
                              setTransfer((current) => ({
                                ...current,
                                fundingReview: null,
                              }))
                            }
                          >
                            Cancel
                          </Button>
                        </View>
                      ) : null}
                      {transfer.direction === "return" &&
                      transfer.returnReviewFen !== null ? (
                        <View testID="return-review" style={styles.card}>
                          <Text style={styles.cardTitle}>Review return</Text>
                          <InfoRow
                            label="From"
                            value="Agent Wallet available funds"
                          />
                          <InfoRow label="To" value="WeBank main account" />
                          <InfoRow
                            label="Amount"
                            value={formatMoney(transfer.returnReviewFen)}
                            last
                          />
                          <Text style={styles.finePrint}>
                            This reduces the money available to agents. It uses
                            your owner session and needs no biometric proof.
                          </Text>
                          <Button
                            testID="confirm-sweep"
                            disabled={
                              !liveBalanceUsable ||
                              fundingBusy ||
                              Boolean(fundingInFlight || sweepInFlight) ||
                              !liveHome ||
                              transfer.returnReviewFen >
                                liveHome.agent_wallet.available.amount
                            }
                            onPress={() => void confirmSweep()}
                          >
                            Confirm return
                          </Button>
                          <Button
                            tone="ghost"
                            onPress={() =>
                              setTransfer((current) => ({
                                ...current,
                                returnReviewFen: null,
                              }))
                            }
                          >
                            Cancel
                          </Button>
                        </View>
                      ) : null}
                      {fundingMessage ? (
                        <View style={styles.notice}>
                          <Text style={styles.noticeText}>
                            {fundingMessage}
                          </Text>
                        </View>
                      ) : null}
                      {fundingInFlight ? (
                        <Text style={styles.finePrint}>
                          Funding {fundingInFlight}: awaiting confirmed chain
                          evidence or reconciliation.
                        </Text>
                      ) : null}
                      {sweepInFlight ? (
                        <Text style={styles.finePrint}>
                          Return {sweepInFlight}: awaiting confirmed chain
                          evidence or reconciliation.
                        </Text>
                      ) : null}
                      {sweepResult ? (
                        <Text style={styles.finePrint}>
                          Return {sweepResult.sweep_id}: {sweepResult.status}.{" "}
                          {sweepResult.chain.tx_hash ??
                            "Awaiting chain evidence"}
                        </Text>
                      ) : null}
                      <SectionTitle
                        kicker="VERIFIED TRANSFERS"
                        title="Funding history"
                      />
                      {fundingHistory
                        .filter((item) => item.status !== "prepared")
                        .slice()
                        .sort(
                          (a, b) =>
                            Date.parse(b.created_at) - Date.parse(a.created_at),
                        )
                        .slice(0, 5)
                        .map((item) => (
                          <View key={item.funding_id} style={styles.card}>
                            <Text style={styles.cardTitle}>
                              {formatMoney(item.amount.amount)} ·{" "}
                              {item.status.replaceAll("_", " ")}
                            </Text>
                            <Text style={styles.finePrint}>
                              {item.funding_id} ·{" "}
                              {new Date(item.created_at).toLocaleString()}
                            </Text>
                            {item.chain.tx_hash ? (
                              <Text selectable style={styles.finePrint}>
                                Verified chain transaction {item.chain.tx_hash}{" "}
                                · block {item.chain.block_number ?? "pending"}
                              </Text>
                            ) : null}
                          </View>
                        ))}
                      {sweepHistory
                        .slice()
                        .sort(
                          (a, b) =>
                            Date.parse(b.created_at) - Date.parse(a.created_at),
                        )
                        .slice(0, 3)
                        .map((item) => (
                          <View key={item.sweep_id} style={styles.card}>
                            <Text style={styles.cardTitle}>
                              Returned {formatMoney(item.amount.amount)} ·{" "}
                              {item.status.replaceAll("_", " ")}
                            </Text>
                            <Text style={styles.finePrint}>
                              {item.sweep_id} ·{" "}
                              {new Date(item.created_at).toLocaleString()}
                            </Text>
                            {item.chain.tx_hash ? (
                              <Text selectable style={styles.finePrint}>
                                Verified chain transaction {item.chain.tx_hash}{" "}
                                · block {item.chain.block_number ?? "pending"}
                              </Text>
                            ) : null}
                          </View>
                        ))}
                    </>
                  ) : !demo.enabled ? (
                    <Button
                      onPress={() =>
                        void securityAction("Enable Agent Wallet", () =>
                          setDemo((current) => enableWallet(current)),
                        )
                      }
                    >
                      Enable wallet
                    </Button>
                  ) : (
                    <Button
                      testID="fund-wallet"
                      tone="light"
                      onPress={() =>
                        setDemo((current) => fundWallet(current, 100000))
                      }
                    >
                      Move ¥1,000.00 in - demo
                    </Button>
                  )}
                  <SectionTitle
                    kicker="ACCOUNT POLICY"
                    title="Spending limits"
                  />
                  {!isLive ? (
                    <View style={styles.card}>
                      <InfoRow
                        label="Per payment"
                        value={formatMoney(demo.perPaymentMax)}
                      />
                      <InfoRow
                        label="Per day"
                        value={formatMoney(demo.dailyMax)}
                      />
                      <InfoRow
                        label="Auto-approve below"
                        value={formatMoney(demo.autoApproveBelow)}
                        last
                      />
                    </View>
                  ) : (
                    <PolicyLimitsPanel
                      snapshot={livePolicy}
                      error={policyError}
                      message={policyMessage}
                      busy={policyBusy}
                      onRefresh={() => void refreshPolicy()}
                      onSave={handlePolicySave}
                    />
                  )}
                  {!isLive ? (
                    <View style={styles.twoButtons}>
                      <View style={styles.halfButton}>
                        <Button
                          testID="tighten-limit"
                          tone="light"
                          onPress={() =>
                            setDemo((current) => ({
                              ...current,
                              perPaymentMax: Math.max(
                                5000,
                                current.perPaymentMax - 5000,
                              ),
                            }))
                          }
                        >
                          Tighten by ¥50
                        </Button>
                      </View>
                      <View style={styles.halfButton}>
                        <Button
                          testID="loosen-limit"
                          tone="light"
                          onPress={() =>
                            void securityAction(
                              "Raise per-payment limit by ¥50",
                              () =>
                                setDemo((current) => ({
                                  ...current,
                                  perPaymentMax: current.perPaymentMax + 5000,
                                })),
                            )
                          }
                        >
                          Raise by ¥50
                        </Button>
                      </View>
                    </View>
                  ) : null}
                  {!isLive ? (
                    <View style={styles.notice}>
                      <Text style={styles.noticeTitle}>LIMIT CHANGES</Text>
                      <Text style={styles.noticeText}>
                        Tightening takes effect immediately. Raising a limit
                        requires a fresh biometric check. This demo changes
                        local state only.
                      </Text>
                    </View>
                  ) : null}
                  <SectionTitle
                    kicker="PROTECTION"
                    title="Blocked categories"
                  />
                  <View style={styles.tagRow}>
                    {["Gift cards", "Crypto", "Gambling", "Money transfer"].map(
                      (item) => (
                        <Badge key={item}>{item}</Badge>
                      ),
                    )}
                  </View>
                  {!isLive ? (
                    <Button
                      testID="freeze-all"
                      tone="danger"
                      disabled={isLive || demo.frozenAll}
                      onPress={() => setDemo((current) => freezeAll(current))}
                    >
                      {demo.frozenAll
                        ? "All agents frozen"
                        : "Freeze all agents"}
                    </Button>
                  ) : null}
                </>
              ) : null}

              {tab === "approvals" ? (
                <>
                  <View style={styles.notice}>
                    <Text style={styles.noticeTitle}>
                      {isLocalDemo
                        ? "SIMULATED GATEWAY REQUESTS"
                        : "YOU STAY IN CONTROL"}
                    </Text>
                    <Text style={styles.noticeText}>
                      {isLocalDemo
                        ? "These loopback requests can be approved only through the explicit simulated biometric step. No actual biometric proof is created."
                        : "Opening this app never approves a request. Every approval needs its own confirmation."}
                    </Text>
                  </View>
                  {loading ? <ActivityIndicator color={colors.purple} /> : null}
                  {pendingApprovals.length ? (
                    pendingApprovals.map((approval) => (
                      <Pressable
                        testID={`approval-list-${approval.approval_id}`}
                        key={approval.approval_id}
                        onPress={() => openApproval(approval.approval_id)}
                        style={styles.approvalListCard}
                      >
                        <View style={styles.cardTop}>
                          <Badge>
                            {approval.level === "zero_trust"
                              ? "NUMBER MATCH"
                              : "BIOMETRIC"}
                          </Badge>
                          <Text style={styles.expiry}>
                            {secondsRemaining(approval.expires_at, clock)}s left
                          </Text>
                        </View>
                        <Text style={styles.cardTitle}>
                          {approvalView(approval).title}
                        </Text>
                        <Text style={styles.bodyText}>
                          {approvalView(approval).lines[0]}
                        </Text>
                        <ApprovalTrustDisplay approval={approval} />
                        <Text style={styles.inlineAction}>
                          Review request ↗
                        </Text>
                      </Pressable>
                    ))
                  ) : (
                    <View style={styles.emptyTall}>
                      <Text style={styles.emptyGlyph}>✓</Text>
                      <Text style={styles.emptyTitle}>All caught up</Text>
                      <Text style={styles.emptyText}>
                        New payment and connection requests will appear here.
                      </Text>
                    </View>
                  )}
                  {isLive ? (
                    <Button tone="light" onPress={() => void refreshGateway()}>
                      Refresh Gateway requests
                    </Button>
                  ) : null}
                </>
              ) : null}

              {tab === "agents" ? (
                <>
                  {isLive ||
                  !agents.some((agent) => agent.agent_id === "agt_claude") ? (
                    <Button
                      testID="connect-agent"
                      disabled={!isLive && (!demo.enabled || demo.frozenAll)}
                      onPress={() => setDetail("pair")}
                    >
                      {isLive
                        ? "Enter connector pairing code"
                        : "Connect Claude - demo"}
                    </Button>
                  ) : null}
                  {!demo.enabled && !isLive ? (
                    <Text style={styles.finePrint}>
                      Enable the Agent Wallet on Home before pairing.
                    </Text>
                  ) : null}
                  {isLive ? (
                    <Button tone="light" onPress={() => void refreshGateway()}>
                      Refresh connected agents
                    </Button>
                  ) : null}
                  <View style={styles.notice}>
                    <Text style={styles.noticeTitle}>KNOW YOUR AGENT</Text>
                    <Text style={styles.noticeText}>
                      Each connected assistant gets its own identity and can
                      only request actions within your wallet policy.
                    </Text>
                  </View>
                  {isLocalDemo ? (
                    <View style={styles.card} testID="local-demo-drill-control">
                      <Text style={styles.cardTitle}>
                        Local demo fire drill
                      </Text>
                      <Text style={styles.bodyText}>
                        Simulated bank-owned drill. Starting it reveals the mock
                        shop decoy; a request to that decoy is denied and moves
                        the agent to Red.
                      </Text>
                      <Text
                        style={styles.bodyText}
                        testID="local-demo-drill-status"
                      >
                        {demoDrill
                          ? demoDrill.active
                            ? `Active drill ${demoDrill.drill_id}`
                            : "No active drill"
                          : "Checking drill status..."}
                      </Text>
                      {demoDrillError ? (
                        <Text style={styles.feedback}>{demoDrillError}</Text>
                      ) : null}
                      {demoDrill ? (
                        <Button
                          testID={
                            demoDrill.active
                              ? "stop-demo-drill"
                              : "start-demo-drill"
                          }
                          tone="light"
                          disabled={demoDrillBusy}
                          onPress={() =>
                            handleDemoDrill(demoDrill.active ? "stop" : "start")
                          }
                        >
                          {demoDrillBusy
                            ? "Updating drill..."
                            : demoDrill.active
                              ? "Stop simulated drill"
                              : "Start simulated drill"}
                        </Button>
                      ) : (
                        <Button
                          tone="light"
                          testID="refresh-demo-drill"
                          onPress={() => {
                            void loadGatewayDemoDrillStatus()
                              .then((status) => {
                                setDemoDrill(status);
                                setDemoDrillError("");
                              })
                              .catch((error) =>
                                setDemoDrillError(
                                  error instanceof Error
                                    ? error.message
                                    : "Drill status unavailable.",
                                ),
                              );
                          }}
                        >
                          Retry drill status
                        </Button>
                      )}
                    </View>
                  ) : null}
                  {isLive && livePairings.length ? (
                    <View style={styles.card}>
                      <Text style={styles.cardTitle}>Pairing requests</Text>
                      {livePairings.map((pairing) => (
                        <View key={pairing.user_code} style={styles.infoRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.infoValue}>
                              {pairing.client_name} · {pairing.status}
                            </Text>
                            <Text style={styles.infoLabel}>
                              Code {pairing.user_code} ·{" "}
                              {pairing.status === "pending"
                                ? `${pairingCountdown(pairing, clock).code}s for code · ${pairingCountdown(pairing, clock).number}s for number`
                                : "Code closed"}
                            </Text>
                          </View>
                          {pairing.status === "pending" ? (
                            <Button
                              testID={`open-pairing-${pairing.user_code}`}
                              tone="light"
                              onPress={() => {
                                void (async () => {
                                  try {
                                    const consent = await loadPairingConsent(
                                      pairing.user_code,
                                    );
                                    setLivePairing(consent);
                                    setLivePairingCode(pairing.user_code);
                                    openApproval(consent.approval.approval_id);
                                  } catch (error) {
                                    showError(
                                      error instanceof Error
                                        ? error.message
                                        : "Pairing unavailable",
                                    );
                                  }
                                })();
                              }}
                            >
                              Review
                            </Button>
                          ) : null}
                        </View>
                      ))}
                    </View>
                  ) : null}
                  {agents.length ? (
                    agents.map((agent) => (
                      <View
                        testID={`agent-${agent.agent_id}`}
                        key={agent.agent_id}
                        style={styles.agentCard}
                      >
                        <View style={styles.agentHead}>
                          <View style={styles.agentAvatar}>
                            <Text style={styles.agentAvatarText}>C</Text>
                          </View>
                          <View style={styles.agentText}>
                            <Text style={styles.cardTitle}>
                              {agent.display_name}
                            </Text>
                            <Text style={styles.bodyText}>
                              {agent.status === "active"
                                ? agent.reauthorization_required
                                  ? "Idle re-approval required"
                                  : "Connected and active"
                                : agent.status === "frozen"
                                  ? "Access frozen"
                                  : "Access revoked"}
                            </Text>
                          </View>
                        </View>
                        <TrustLight
                          light={agent.licence.level}
                          reason={agent.licence.reason}
                          frozen={agent.status === "frozen"}
                        />
                        <View style={styles.agentStats}>
                          <Text style={styles.statText}>
                            {agent.licence.clean_purchases} clean purchases
                          </Text>
                          <Text style={styles.statText}>
                            {agent.licence.drills_passed} drills passed
                          </Text>
                          <Text style={styles.statText}>
                            {agent.licence.flags_30d} flags in 30 days
                          </Text>
                        </View>
                        {isLive ? (
                          <AgentConnectionInfo
                            agent={agent}
                            now={clock}
                            busy={idleActionBusyId === agent.agent_id}
                            renewalExpiresAt={
                              idleRenewalWindows[agent.agent_id]
                            }
                            onReauthorize={() =>
                              handleIdleReauthorization(agent)
                            }
                          />
                        ) : null}
                        {agent.status === "active" ? (
                          <Button
                            testID={`freeze-agent-${agent.agent_id}`}
                            tone="danger"
                            onPress={() =>
                              void handleFreezeAgent(agent.agent_id)
                            }
                          >
                            Freeze this agent
                          </Button>
                        ) : null}
                        {agent.status === "frozen" ? (
                          <Button
                            testID={`unfreeze-agent-${agent.agent_id}`}
                            tone="light"
                            onPress={() => handleUnfreezeAgent(agent.agent_id)}
                          >
                            Unfreeze this agent
                          </Button>
                        ) : null}
                        {isLive && agent.licence.level === "RED" ? (
                          <>
                            <Button
                              testID={`review-trust-events-${agent.agent_id}`}
                              tone="light"
                              disabled={
                                trustReview?.agentId === agent.agent_id &&
                                trustReview.loading
                              }
                              onPress={() => handleTrustEventReview(agent)}
                            >
                              {trustReview?.agentId === agent.agent_id &&
                              trustReview.loading
                                ? "Loading trust events..."
                                : "Review trust evidence"}
                            </Button>
                            {trustReview?.agentId === agent.agent_id &&
                            trustReview.error ? (
                              <Text style={styles.feedback}>
                                {trustReview.error}
                              </Text>
                            ) : null}
                            {trustReview?.agentId === agent.agent_id &&
                            trustReview.evidence ? (
                              <>
                                <TrustEventReview
                                  events={trustReview.evidence.items}
                                  legacyEvidence={
                                    trustReview.evidence.legacy_evidence
                                  }
                                />
                                {!trustReview.error ? (
                                  <Button
                                    testID={`return-to-amber-${agent.agent_id}`}
                                    tone="light"
                                    disabled={
                                      trustActionBusyId === agent.agent_id
                                    }
                                    onPress={() => handleReturnToAmber(agent)}
                                  >
                                    {trustActionBusyId === agent.agent_id
                                      ? "Preparing owner action..."
                                      : "Return to Amber"}
                                  </Button>
                                ) : null}
                              </>
                            ) : null}
                          </>
                        ) : null}
                        {isLocalDemo &&
                        agent.status === "active" &&
                        agent.licence.level === "AMBER" ? (
                          <Button
                            testID={`demo-fast-forward-green-${agent.agent_id}`}
                            tone="light"
                            disabled={trustActionBusyId === agent.agent_id}
                            onPress={() => handleDemoFastForwardGreen(agent)}
                          >
                            Local demo: simulate Green
                          </Button>
                        ) : null}
                        <Button
                          testID={`delete-agent-${agent.agent_id}`}
                          tone="danger"
                          onPress={() =>
                            handleDeleteAgent(
                              agent.agent_id,
                              agent.display_name,
                            )
                          }
                        >
                          Delete agent
                        </Button>
                      </View>
                    ))
                  ) : (
                    <View style={styles.emptyTall}>
                      <Text style={styles.emptyGlyph}>○</Text>
                      <Text style={styles.emptyTitle}>No agent connected</Text>
                      <Text style={styles.emptyText}>
                        Connect Claude with a pairing code from the connector.
                      </Text>
                    </View>
                  )}
                </>
              ) : null}

              {tab === "history" ? (
                <>
                  <View style={styles.notice}>
                    <Text style={styles.noticeTitle}>
                      EVERY ATTEMPT HAS A REASON
                    </Text>
                    <Text style={styles.noticeText}>
                      Paid and blocked requests appear together. The local demo
                      {isLive
                        ? "Gateway records refresh every three seconds. Open a payment for its decision and signed receipt when available."
                        : "The local demo receipts are samples without chain evidence."}
                    </Text>
                  </View>
                  {paymentRows.length ? (
                    paymentRows.map((payment) => (
                      <PaymentRow
                        key={payment.payment_id}
                        payment={payment}
                        onPress={() => openPayment(payment.payment_id)}
                      />
                    ))
                  ) : (
                    <View style={styles.emptyTall}>
                      <Text style={styles.emptyGlyph}>↗</Text>
                      <Text style={styles.emptyTitle}>Nothing yet</Text>
                      <Text style={styles.emptyText}>
                        Finish the first payment or run a blocked listing
                        scenario.
                      </Text>
                    </View>
                  )}
                </>
              ) : null}
            </>
          )}
          <View style={{ height: 28 }} />
        </ScrollView>

        <View style={styles.nav}>
          {(
            [
              ["home", "⌂", "Home"],
              ["wallet", "◈", "Wallet"],
              ["approvals", "◎", "Approve"],
              ["agents", "♙", "Agents"],
              ["history", "▤", "Activity"],
            ] as const
          ).map(([item, symbol, label]) => (
            <Pressable
              key={item}
              testID={`tab-${item}`}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === item }}
              onPress={() => {
                setTab(item);
                setDetail(null);
                setSelectedApprovalId(null);
                setSelectedPaymentId(null);
              }}
              style={styles.navItem}
            >
              <Text style={[styles.navIcon, tab === item && styles.navActive]}>
                {symbol}
              </Text>
              <Text style={[styles.navLabel, tab === item && styles.navActive]}>
                {label}
              </Text>
              {item === "approvals" && pendingApprovals.length > 0 ? (
                <View style={styles.navDot} />
              ) : null}
            </Pressable>
          ))}
        </View>
      </View>
      {pendingSimulation ? (
        <View style={styles.modalBackdrop}>
          <View style={styles.modal}>
            <Badge>
              {isLocalDemo ? "LOCAL GATEWAY SIMULATION" : "WEB SIMULATION"}
            </Badge>
            <Text style={styles.modalTitle}>Simulated biometric step</Text>
            <ScrollView style={styles.modalDetailsScroll}>
              <Text style={styles.bodyText}>{pendingSimulation.label}</Text>
            </ScrollView>
            {pendingSimulation.expiresAt ? (
              <Text
                style={styles.bodyText}
                testID="simulation-challenge-expiry"
              >
                Challenge expires in{" "}
                {secondsRemaining(pendingSimulation.expiresAt, clock)}s
              </Text>
            ) : null}
            <Text style={styles.modalWarning}>
              No Face ID or Secure Enclave proof is made here. Continue only for
              the explicit local demo simulation.
            </Text>
            <Button
              testID="simulate-biometric"
              disabled={
                Boolean(pendingSimulation.expiresAt) &&
                Date.parse(pendingSimulation.expiresAt ?? "") <= clock
              }
              onPress={() => {
                const action = pendingSimulation.run;
                setPendingSimulation(null);
                action();
              }}
            >
              Simulate biometric
            </Button>
            <Button tone="ghost" onPress={() => setPendingSimulation(null)}>
              Cancel
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function PaymentRow({
  payment,
  onPress,
}: {
  payment: Payment;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={`payment-${payment.payment_id}`}
      onPress={onPress}
      style={styles.listCard}
    >
      <View
        style={[
          styles.listIcon,
          payment.status === "denied" && { backgroundColor: colors.redLight },
        ]}
      >
        <Text
          style={[
            styles.listIconText,
            payment.status === "denied" && { color: colors.red },
          ]}
        >
          {payment.status === "paid"
            ? "↗"
            : payment.status === "denied"
              ? "×"
              : "•"}
        </Text>
      </View>
      <View style={styles.listBody}>
        <Text style={styles.listTitle}>{payment.merchant}</Text>
        <Text style={styles.listSub}>
          {payment.status === "paid"
            ? payment.approvalSource === "auto"
              ? "Auto-paid under Green"
              : "Paid"
            : payment.status === "denied"
              ? "Blocked"
              : "Awaiting user"}{" "}
          · {new Date(payment.at).toLocaleDateString()}
        </Text>
      </View>
      <Text style={styles.listAmount}>{formatMoney(payment.amount)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  outer: { flex: 1, alignItems: "center", backgroundColor: "#EDE9F1" },
  shell: {
    flex: 1,
    backgroundColor: colors.paper,
    shadowColor: "#261731",
    shadowOpacity: 0.12,
    shadowRadius: 25,
  },
  topbar: {
    backgroundColor: colors.ink,
    paddingTop: Platform.OS === "ios" ? 58 : 22,
    paddingBottom: 17,
    paddingHorizontal: 22,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  brandMark: {
    height: 27,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    transform: [{ skewX: "-12deg" }],
  },
  brandBarShort: { width: 5, height: 15, backgroundColor: colors.white },
  brandBarTall: { width: 5, height: 26, backgroundColor: colors.white },
  brandBarMid: { width: 5, height: 20, backgroundColor: colors.white },
  brandName: {
    color: colors.white,
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: -0.8,
  },
  brandSub: {
    color: "#B6AABF",
    fontSize: 7,
    fontWeight: "800",
    letterSpacing: 1.9,
    marginTop: 2,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 22, paddingTop: 28 },
  pageIntro: { marginBottom: 22 },
  kicker: {
    color: colors.purple,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.8,
  },
  pageTitle: {
    color: colors.ink,
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -1.3,
    marginTop: 8,
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    marginTop: 27,
    marginBottom: 14,
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.7,
    marginTop: 6,
  },
  sectionRight: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.6,
    marginBottom: 3,
  },
  mainCard: {
    minHeight: 190,
    borderRadius: 9,
    padding: 22,
    overflow: "hidden",
    justifyContent: "space-between",
  },
  orb: {
    position: "absolute",
    width: 180,
    height: 180,
    borderRadius: 90,
    borderWidth: 25,
    borderColor: "#FFFFFF0F",
    right: -35,
    top: -73,
  },
  mainCardLabel: {
    color: "#D9D1E0",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.5,
  },
  mainCardAmount: {
    color: colors.white,
    fontSize: 37,
    fontWeight: "800",
    letterSpacing: -1.7,
  },
  mainCardFooter: { flexDirection: "row", justifyContent: "space-between" },
  mainCardFooterText: { color: "#D9D1E0", fontSize: 11, fontWeight: "600" },
  walletPanel: {
    backgroundColor: colors.white,
    borderRadius: 9,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.line,
  },
  walletPanelTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  walletSmall: {
    color: colors.muted,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 1.4,
  },
  walletAmount: {
    color: colors.ink,
    fontSize: 29,
    fontWeight: "800",
    letterSpacing: -1.3,
    marginTop: 8,
  },
  purpleCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.purpleLight,
    alignItems: "center",
    justifyContent: "center",
  },
  purpleCircleText: { color: colors.purple, fontSize: 21 },
  bodyText: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 11,
    marginBottom: 16,
  },
  button: {
    minHeight: 47,
    borderRadius: 24,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    marginTop: 10,
  },
  buttonLight: { backgroundColor: colors.purpleLight },
  buttonDanger: { backgroundColor: colors.redLight },
  buttonGhost: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.line,
  },
  buttonText: { color: colors.white, fontSize: 13, fontWeight: "800" },
  buttonTextDark: { color: colors.ink },
  listCard: {
    minHeight: 72,
    backgroundColor: colors.white,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 15,
    marginBottom: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  listIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.purpleLight,
    alignItems: "center",
    justifyContent: "center",
  },
  listIconText: { color: colors.purple, fontSize: 21, fontWeight: "700" },
  listBody: { flex: 1 },
  listTitle: { color: colors.ink, fontWeight: "800", fontSize: 13 },
  listSub: { color: colors.muted, fontSize: 11, marginTop: 5 },
  listAmount: { color: colors.ink, fontWeight: "800", fontSize: 13 },
  chevron: { color: colors.purple, fontSize: 23, fontWeight: "500" },
  emptyCard: {
    backgroundColor: colors.white,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 20,
  },
  emptyText: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  scanDropZone: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.purple,
    borderRadius: 8,
    backgroundColor: colors.purpleLight,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 112,
    marginTop: 16,
    padding: 14,
  },
  scanDropText: { color: colors.purple, fontSize: 13, fontWeight: "800" },
  scanCamera: {
    height: 230,
    borderRadius: 8,
    overflow: "hidden",
    marginTop: 14,
  },
  demoLink: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 16,
    marginTop: 14,
  },
  demoLinkText: { color: colors.purple, fontSize: 12, fontWeight: "800" },
  walletHero: {
    minHeight: 175,
    borderRadius: 9,
    padding: 22,
    justifyContent: "space-between",
  },
  walletHeroLabel: {
    color: "#EADCF2",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.4,
  },
  walletHeroAmount: {
    color: colors.white,
    fontSize: 37,
    fontWeight: "800",
    letterSpacing: -1.6,
  },
  walletHeroFoot: { color: "#F0DDED", fontSize: 11 },
  card: {
    backgroundColor: colors.white,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 18,
    marginBottom: 12,
  },
  cardTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  infoRow: {
    paddingVertical: 13,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  infoRowBorder: { borderBottomWidth: 1, borderBottomColor: colors.line },
  infoLabel: { color: colors.muted, fontSize: 12, flex: 1 },
  infoValue: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: "700",
    textAlign: "right",
    flex: 1.2,
  },
  twoButtons: { flexDirection: "row", gap: 9 },
  halfButton: { flex: 1 },
  notice: {
    backgroundColor: colors.purpleLight,
    borderLeftWidth: 3,
    borderLeftColor: colors.purple,
    borderRadius: 5,
    padding: 15,
    marginBottom: 16,
  },
  noticeTitle: {
    color: colors.purple,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  noticeText: { color: "#554C60", fontSize: 12, lineHeight: 18, marginTop: 6 },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginBottom: 22 },
  badge: {
    backgroundColor: colors.purpleLight,
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 9,
    alignSelf: "flex-start",
  },
  badgeText: {
    color: colors.purple,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  badgeGreen: { backgroundColor: colors.greenLight },
  badgeYellow: { backgroundColor: colors.yellowLight },
  badgeRed: { backgroundColor: colors.redLight },
  badgeDark: { backgroundColor: "#37303D" },
  approvalListCard: {
    backgroundColor: colors.white,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 18,
    marginBottom: 11,
  },
  cardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
  },
  expiry: { color: colors.muted, fontSize: 11, fontWeight: "700" },
  inlineAction: {
    color: colors.purple,
    fontSize: 12,
    fontWeight: "800",
    marginTop: 2,
  },
  emptyTall: {
    backgroundColor: colors.white,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 36,
    alignItems: "center",
  },
  emptyGlyph: { color: colors.purple, fontSize: 43, marginBottom: 12 },
  emptyTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: "800",
    marginBottom: 6,
  },
  agentCard: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 9,
    padding: 18,
    marginBottom: 12,
  },
  agentHead: { flexDirection: "row", alignItems: "center", gap: 11 },
  agentAvatar: {
    width: 43,
    height: 43,
    borderRadius: 8,
    backgroundColor: "#261C40",
    alignItems: "center",
    justifyContent: "center",
  },
  agentAvatarText: { color: colors.white, fontSize: 23, fontWeight: "800" },
  agentText: { flex: 1 },
  agentStats: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: colors.line,
    marginTop: 14,
    paddingTop: 13,
  },
  statText: { color: colors.muted, fontSize: 10, fontWeight: "700" },
  back: {
    color: colors.purple,
    fontSize: 13,
    fontWeight: "800",
    marginBottom: 10,
  },
  approvalTitle: {
    color: colors.ink,
    fontSize: 23,
    fontWeight: "800",
    letterSpacing: -0.6,
    marginBottom: 14,
  },
  bulletRow: { flexDirection: "row", gap: 8, marginBottom: 9 },
  bullet: { color: colors.purple, fontSize: 15 },
  bulletText: { color: "#4E4954", fontSize: 12, lineHeight: 18, flex: 1 },
  input: {
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 7,
    minHeight: 51,
    paddingHorizontal: 15,
    fontSize: 15,
    color: colors.ink,
    marginBottom: 10,
  },
  numberInput: {
    fontSize: 26,
    letterSpacing: 8,
    fontWeight: "700",
    textAlign: "center",
  },
  feedback: {
    color: colors.purple,
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 8,
  },
  actionStack: { marginBottom: 12 },
  finePrint: {
    color: colors.muted,
    fontSize: 10,
    lineHeight: 16,
    marginTop: 10,
  },
  receiptHero: {
    minHeight: 183,
    borderRadius: 9,
    padding: 23,
    justifyContent: "space-between",
    marginBottom: 14,
  },
  receiptKicker: {
    color: "#E8D7ED",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.3,
  },
  receiptAmount: {
    color: colors.white,
    fontSize: 39,
    fontWeight: "800",
    letterSpacing: -1.5,
  },
  receiptMerchant: { color: "#F1E7F2", fontSize: 12, fontWeight: "700" },
  nav: {
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    flexDirection: "row",
    paddingBottom: Platform.OS === "ios" ? 22 : 6,
    paddingTop: 8,
  },
  navItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 53,
  },
  navIcon: { color: "#96909C", fontSize: 21 },
  navLabel: { color: "#96909C", fontSize: 9, fontWeight: "700", marginTop: 2 },
  navActive: { color: colors.purple },
  navDot: {
    position: "absolute",
    top: 3,
    right: 17,
    width: 7,
    height: 7,
    backgroundColor: colors.rose,
    borderRadius: 4,
  },
  modalBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "#120E18A8",
    alignItems: "center",
    justifyContent: "center",
    padding: 25,
  },
  modal: {
    width: "100%",
    maxWidth: 390,
    maxHeight: "90%",
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 23,
  },
  modalDetailsScroll: { flexShrink: 1 },
  modalTitle: {
    color: colors.ink,
    fontSize: 23,
    fontWeight: "800",
    marginTop: 17,
  },
  modalWarning: {
    color: colors.red,
    backgroundColor: colors.redLight,
    padding: 12,
    borderRadius: 6,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 7,
  },
  errorBox: {
    backgroundColor: colors.redLight,
    borderRadius: 7,
    padding: 13,
    marginBottom: 15,
  },
  errorText: { color: colors.red, fontSize: 12, lineHeight: 18 },
});
