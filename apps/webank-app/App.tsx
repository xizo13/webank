import { LinearGradient } from "expo-linear-gradient";
import * as LocalAuthentication from "expo-local-authentication";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
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
import { presentApproval } from "./src/approvalPresentation";
import {
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
import {
  approveLocalDemo,
  denyGatewayPairing,
  freezeGatewayAgent,
  GatewayRequestError,
  gatewayUrl,
  type LivePayment,
  type LivePaymentDetail,
  loadGatewayPayment,
  loadGatewaySnapshot,
  loadPairingConsent,
  localDemoConfigured,
  loginLocalDemo,
  type PairingConsent,
  rejectGatewayApproval,
} from "./src/gateway";

type Tab = "home" | "wallet" | "approvals" | "agents" | "history";
type Detail = "pair" | "demo" | null;
type PendingSimulation = { label: string; run: () => void } | null;

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
  tone?: "purple" | "green" | "red" | "dark";
}) {
  return (
    <View
      style={[
        styles.badge,
        tone === "green" && styles.badgeGreen,
        tone === "red" && styles.badgeRed,
        tone === "dark" && styles.badgeDark,
      ]}
    >
      <Text
        style={[
          styles.badgeText,
          tone === "green" && { color: colors.green },
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

function secondsRemaining(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

function wrapHash(hash: string): string {
  return hash.match(/.{1,16}/g)?.join("\n") ?? hash;
}

function wrapApprovalLine(line: string): string {
  return line.replace(
    /\S{24,}/g,
    (token) => token.match(/.{1,16}/g)?.join("\u200b") ?? token,
  );
}

export default function App() {
  const { width } = useWindowDimensions();
  const [tab, setTab] = useState<Tab>("home");
  const [detail, setDetail] = useState<Detail>(null);
  const [demo, setDemo] = useState<DemoState>(initialDemoState);
  const [liveAgents, setLiveAgents] = useState<DemoState["agents"]>([]);
  const [liveApprovals, setLiveApprovals] = useState<Approval[]>([]);
  const [livePayments, setLivePayments] = useState<LivePayment[]>([]);
  const [livePaymentDetail, setLivePaymentDetail] =
    useState<LivePaymentDetail | null>(null);
  const [livePaymentError, setLivePaymentError] = useState("");
  const [livePairing, setLivePairing] = useState<PairingConsent | null>(null);
  const [livePairingCode, setLivePairingCode] = useState("");
  const [gatewayError, setGatewayError] = useState("");
  const [demoLoginToken, setDemoLoginToken] = useState("");
  const [demoAuthenticated, setDemoAuthenticated] = useState(false);
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

  const refreshGateway = useCallback(async () => {
    if (!isLive) return;
    if (!lastSyncedAt) setLoading(true);
    try {
      const snapshot = await loadGatewaySnapshot();
      setLiveAgents(snapshot.agents);
      setLiveApprovals(snapshot.approvals);
      setLivePayments(snapshot.payments);
      setGatewayError("");
      if (isLocalDemo) setDemoAuthenticated(true);
      setLastSyncedAt(Date.now());
    } catch (error) {
      if (
        isLocalDemo &&
        error instanceof GatewayRequestError &&
        error.status === 401
      )
        setDemoAuthenticated(false);
      setGatewayError(
        error instanceof Error ? error.message : "Gateway unavailable",
      );
    } finally {
      setLoading(false);
    }
  }, [isLive, isLocalDemo, lastSyncedAt]);

  useEffect(() => {
    void refreshGateway();
    const timer = setInterval(() => setClock(Date.now()), 1000);
    const poller = isLive
      ? setInterval(() => void refreshGateway(), 3000)
      : null;
    return () => {
      clearInterval(timer);
      if (poller) clearInterval(poller);
    };
  }, [refreshGateway, isLive]);

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
    ? [
        ...liveApprovals,
        ...(livePairing &&
        !liveApprovals.some(
          (item) => item.approval_id === livePairing.approval.approval_id,
        )
          ? [livePairing.approval]
          : []),
      ]
    : demo.approvals;
  const pendingApprovals = approvals.filter(
    (approval) =>
      approval.status === "pending" && Date.parse(approval.expires_at) > clock,
  );
  const selectedApproval =
    approvals.find((approval) => approval.approval_id === selectedApprovalId) ??
    null;
  const approvalView = (approval: Approval) =>
    presentApproval(
      approval,
      isLive
        ? livePayments.find(
            (payment) => payment.payment_id === approval.subject_id,
          )
        : undefined,
    );
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
    }));
  const paymentRows = isLive ? livePaymentRows : demo.payments;
  const selectedPayment =
    paymentRows.find((payment) => payment.payment_id === selectedPaymentId) ??
    null;
  const activeAgent = agents.find((agent) => agent.status === "active");
  const latestActivity = paymentRows.slice(0, 2);

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
    if (isLive && !isLocalDemo) {
      showError(
        "A live Secure Enclave approval signature is not available yet.",
      );
      return;
    }
    if (isLocalDemo) {
      if (!demoAuthenticated)
        return showError("Enter the one-time local demo login token first.");
      if (
        selectedApproval.status !== "pending" ||
        Date.parse(selectedApproval.expires_at) <= Date.now()
      )
        return showError("This approval has expired. Start a new request.");
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
                await refreshGateway();
                if (failures >= 3)
                  setGatewayError(
                    "Three incorrect numbers cancelled the simulated request. Start again from the connector.",
                  );
              } else {
                setNumberMessage(
                  error instanceof Error
                    ? error.message
                    : "Simulated approval failed.",
                );
              }
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
      setDemoAuthenticated(true);
      setGatewayError("");
      await refreshGateway();
    } catch (error) {
      setDemoAuthenticated(false);
      setGatewayError(
        error instanceof Error ? error.message : "Local demo login failed.",
      );
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

  const handleReject = () => {
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
              <View style={styles.card} testID="approval-card">
                <View style={styles.cardTop}>
                  <Badge>{selectedApproval.kind.toUpperCase()}</Badge>
                  <Text style={styles.expiry}>
                    Expires in{" "}
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
              {isLive &&
              livePairing?.approval.approval_id ===
                selectedApproval.approval_id ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Connection details</Text>
                  <InfoRow label="App" value={livePairing.client_name} />
                  <InfoRow label="Provider" value={livePairing.provider} />
                  <InfoRow
                    label="Scopes"
                    value={livePairing.requested_scopes.join(", ")}
                    last
                  />
                </View>
              ) : null}
              {selectedApproval.level === "zero_trust" ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Match the request number</Text>
                  <Text style={styles.bodyText}>
                    Type the six-digit number shown by the connector on your
                    Mac. This app never shows that number.
                  </Text>
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
              <View style={styles.actionStack}>
                <Button
                  testID="approve-action"
                  disabled={
                    (isLive && (!isLocalDemo || !demoAuthenticated)) ||
                    selectedApproval.status !== "pending" ||
                    Date.parse(selectedApproval.expires_at) <= clock ||
                    (selectedApproval.level === "zero_trust" &&
                      numberInput.length !== 6 &&
                      (isLive ||
                        !demo.matchedApprovals.includes(
                          selectedApproval.approval_id,
                        )))
                  }
                  onPress={handleApprove}
                >
                  {isLocalDemo
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
                    Enter the one-time app token printed by the loopback
                    Gateway. The token stays in this screen only and is cleared
                    after each attempt.
                  </Text>
                  <TextInput
                    testID="local-demo-token-input"
                    style={styles.input}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="One-time local token"
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
                      MAIN ACCOUNT · DEMO BALANCE
                    </Text>
                    <Text style={styles.mainCardAmount}>
                      {formatMoney(demo.mainBalance)}
                    </Text>
                    <View style={styles.mainCardFooter}>
                      <Text style={styles.mainCardFooterText}>
                        WeBank account
                      </Text>
                      <Text style={styles.mainCardFooterText}>•• 0842</Text>
                    </View>
                  </LinearGradient>
                  <SectionTitle
                    kicker="YOUR AGENTS"
                    title="Agent Wallet"
                    right={
                      isLive ? "SIMULATED" : demo.enabled ? "ACTIVE" : "SETUP"
                    }
                  />
                  <View style={styles.walletPanel}>
                    <View style={styles.walletPanelTop}>
                      <View>
                        <Text style={styles.walletSmall}>
                          SEPARATE SPENDING POT
                        </Text>
                        <Text style={styles.walletAmount}>
                          {formatMoney(demo.walletBalance)}
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
                      {formatMoney(demo.walletBalance)}
                    </Text>
                    <Text style={styles.walletHeroFoot}>
                      Separate from your main account
                    </Text>
                  </LinearGradient>
                  {isLive ? (
                    <View style={styles.notice}>
                      <Text style={styles.noticeTitle}>SIMULATED WALLET</Text>
                      <Text style={styles.noticeText}>
                        Balance and limits on this screen are design examples.
                        Gateway wallet and policy read routes are not connected.
                      </Text>
                    </View>
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
                  <View style={styles.notice}>
                    <Text style={styles.noticeTitle}>KNOW YOUR AGENT</Text>
                    <Text style={styles.noticeText}>
                      Each connected assistant gets its own identity and can
                      only request actions within your wallet policy.
                    </Text>
                  </View>
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
                                ? "Connected and active"
                                : "Access frozen"}
                            </Text>
                          </View>
                          <Badge
                            tone={agent.status === "active" ? "purple" : "red"}
                          >
                            {agent.status === "active"
                              ? `${agent.licence.level}-PLATE`
                              : "FROZEN"}
                          </Badge>
                        </View>
                        <View style={styles.agentStats}>
                          <Text style={styles.statText}>
                            {agent.licence.clean_purchases} clean purchases
                          </Text>
                          <Text style={styles.statText}>
                            {agent.licence.drills_passed} drills passed
                          </Text>
                        </View>
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
            <Text style={styles.bodyText}>{pendingSimulation.label}</Text>
            <Text style={styles.modalWarning}>
              No Face ID or Secure Enclave proof is made here. Continue only for
              the explicit local demo simulation.
            </Text>
            <Button
              testID="simulate-biometric"
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
            ? "Paid"
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
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 23,
  },
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
