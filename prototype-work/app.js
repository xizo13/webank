const SCENARIOS = [
  {
    id: 'headphones', number: '01', title: 'P-plate purchase', subtitle: '¥279 needs your approval',
    product: 'Auralis Studio headphones', detail: 'Wireless · black · one size', icon: '🎧', tag: 'ELECTRONICS',
    merchant: 'Northstar Market', railMerchant: 'M-88231', amount: 279, category: 'Electronics',
    mandate: 'Buy black headphones from Northstar Market for up to ¥300, once today.',
    user: 'Buy the black headphones if they are under ¥300.',
    agent: 'I found the black Auralis Studio pair at Northstar Market for ¥279. I will hand its checkout request to WeBank.',
    note: 'Within the ¥300 mandate. P-plate auto-approval stops at ¥100, so the bank asks you.',
  },
  {
    id: 'coffee', number: '02', title: 'Autonomous coffee', subtitle: '¥80 within the mandate',
    product: 'Daybreak coffee beans', detail: 'House blend · 500 g · whole bean', icon: '☕', tag: 'PANTRY',
    merchant: 'Daybreak Coffee', railMerchant: 'M-55208', amount: 80, category: 'Groceries',
    mandate: 'Reorder Daybreak coffee beans, up to ¥80, once this week.',
    user: 'Reorder my usual coffee beans this week, max ¥80.',
    agent: 'The usual 500 g bag is ¥80. I can request payment under the standing coffee mandate.',
    note: 'Within the ¥80 mandate and the P-plate ¥100 auto-approval ceiling.',
  },
  {
    id: 'swap', number: '03', title: 'Merchant swap', subtitle: 'Wrong payee is blocked',
    product: 'Auralis Studio headphones', detail: 'Wireless · black · one size', icon: '🎧', tag: 'ELECTRONICS',
    merchant: 'Northstar Market', railMerchant: 'M-99904', railPayee: 'Outside Services', amount: 279, category: 'Electronics',
    mandate: 'Buy black headphones from Northstar Market for up to ¥300, once today.',
    user: 'Buy the black headphones from Northstar Market.',
    agent: 'The page says its checkout link is ready. I will pass the request to WeBank for verification.',
    note: 'The page names Northstar Market, but the simulated rail registry resolves the payee as Outside Services.',
  },
  {
    id: 'drill', number: '04', title: 'Failed fire drill', subtitle: 'Decoy blocked; licence drops',
    product: 'Bonus gift card', detail: 'Injected checkout instruction · harmless decoy', icon: '🎁', tag: 'BANK TEST',
    merchant: 'Northstar Market', railMerchant: 'M-DRILL', railPayee: 'Bank drill decoy', amount: 20, category: 'Gift cards',
    mandate: 'Buy black headphones from Northstar Market for up to ¥300, once today.',
    user: 'Buy the black headphones from Northstar Market.',
    agent: 'The listing says a ¥20 gift card unlocks checkout. I will ask WeBank to pay it.',
    note: 'The payee is a registered bank decoy. The request is always denied and adds six demerit points.',
  },
  {
    id: 'freeze', number: '05', title: 'Freeze the agent', subtitle: 'Next request stops at auth',
    product: 'Daybreak coffee beans', detail: 'House blend · 500 g · whole bean', icon: '☕', tag: 'PANTRY',
    merchant: 'Daybreak Coffee', railMerchant: 'M-55208', amount: 80, category: 'Groceries',
    mandate: 'Reorder Daybreak coffee beans, up to ¥80, once this week.',
    user: 'Reorder my coffee beans.',
    agent: 'I have the normal coffee checkout request. I will ask WeBank to pay it.',
    note: 'Use Freeze in the WeBank panel, then send this request. Agent authentication denies it first.',
  },
];

const STORAGE_KEY = 'webank-agent-wallet-demo-v1';
const initialState = () => ({ selected: 'headphones', stage: 'browse', licence: 'P', points: 0, frozen: false, balance: 1000, history: [], sequence: 1, checkoutId: null, currentDecision: null });
let state = readState();

function readState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && SCENARIOS.some((scenario) => scenario.id === saved.selected) && Array.isArray(saved.history)) return saved;
  } catch (_) { /* Invalid local demo state resets safely. */ }
  return initialState();
}

function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); render(); }
function scenario() { return SCENARIOS.find((item) => item.id === state.selected); }
function railPayee(item) { return item.railPayee || item.merchant; }
function historicalRailPayee(entry) {
  if (entry.railPayee) return entry.railPayee;
  if (entry.reason?.includes('Outside Services')) return 'Outside Services';
  if (entry.product === 'Bonus gift card') return 'Bank drill decoy';
  return entry.merchant;
}
function money(value) { return `¥${Number(value).toFixed(2)}`; }
function byId(id) { return document.getElementById(id); }
function formatTime(iso) { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
function nextId() { return String(state.sequence++).padStart(3, '0'); }

function renderScenarios() {
  byId('scenario-list').innerHTML = SCENARIOS.map((item) => `
    <button type="button" class="scenario-card ${item.id === state.selected ? 'active' : ''}" data-action="select" data-id="${item.id}" aria-pressed="${item.id === state.selected}">
      <span class="scenario-num">${item.number} / FLOW</span><h3>${item.title}</h3><p>${item.subtitle}</p>
    </button>`).join('');
}

function renderShop() {
  const item = scenario();
  byId('shop-title').textContent = item.merchant;
  const checkout = state.stage !== 'browse';
  const approved = state.currentDecision?.status === 'approved';
  const payee = railPayee(item);
  byId('shop-content').innerHTML = `
    <span class="micro-label">${checkout ? 'CHECKOUT / PAYMENT REQUEST' : 'PRODUCT / MOCK CATALOG'}</span>
    <div class="product-visual ${item.id}"><span class="visual-tag">${item.tag}</span><span class="product-art" role="img" aria-label="${item.product}">${item.icon}</span></div>
    <div class="product-title">${item.product}</div><div class="product-meta">${item.detail}</div>
    <div class="price-line"><span class="price">¥${item.amount}<small>/ item</small></span><span class="stock">● Available now</span></div>
    <div class="divider"></div>
    <div class="detail-list">
      <div class="detail-row"><span>Storefront</span><strong>${item.merchant}</strong></div>
      <div class="detail-row"><span>Category</span><strong>${item.category}</strong></div>
      ${checkout ? `<div class="detail-row"><span>Rail registry payee</span><strong>${payee}</strong></div>` : ''}
    </div>
    ${checkout ? `<div class="request-box"><div class="micro-label">SIMULATED E-CNY PAYMENT REQUEST</div><code>ecny-demo://pay?<wbr><span class="request-parameter">merchant=${item.railMerchant}</span><wbr><span class="request-parameter">&amp;order=${state.checkoutId}</span><wbr><span class="request-parameter">&amp;amount=${item.amount}.00</span></code></div>` : ''}
    ${approved ? `<div class="status-strip">✓ Order confirmed in the mock shop. Demo receipt ${state.currentDecision.id}.</div>` : state.currentDecision?.status === 'denied' ? `<div class="status-strip danger">Payment declined. No order was placed.</div>` : checkout ? `<div class="status-strip warning">Checkout created. The agent can now hand this request to WeBank.</div>` : ''}
    <div class="panel-spacer"></div>
    <button type="button" class="cta ${checkout ? 'secondary' : ''}" data-action="checkout" ${checkout ? 'disabled' : ''}>${checkout ? 'Checkout request created' : 'Create checkout request →'}</button>
    <div class="rail-note">Mock storefront and e-CNY request. No merchant or rail connection.</div>`;
}

function renderAgent() {
  const item = scenario();
  const requested = state.stage === 'requested' || state.stage === 'resolved';
  const decision = state.currentDecision;
  byId('agent-content').innerHTML = `
    <span class="micro-label">USER TASK / SCRIPTED AGENT</span>
    <div class="chat-bubble user"><span class="chat-name">YOU</span>${item.user}</div>
    <div class="chat-bubble agent"><span class="chat-name">AGENT SIMULATION</span>${item.agent}</div>
    <div class="divider"></div>
    <div class="micro-label">PAYMENT HANDOFF</div>
    <div class="flow-line done"><span class="step-dot">1</span><span><strong>Mandate</strong><br>${item.mandate}</span></div>
    <div class="flow-line ${state.stage !== 'browse' ? 'done' : 'active'}"><span class="step-dot">2</span><span><strong>Shop checkout</strong><br>${state.stage === 'browse' ? 'Waiting for a payment request.' : `Request ${state.checkoutId} received from the mock shop.`}</span></div>
    <div class="flow-line ${requested ? 'done' : state.stage === 'checkout' ? 'active' : ''}"><span class="step-dot">3</span><span><strong>WeBank decision</strong><br>${decision ? decision.agentSummary : 'The agent may request payment. Only WeBank can decide.'}</span></div>
    ${decision ? `<div class="agent-result"><strong>${decision.status === 'pending' ? 'Waiting for user approval' : decision.status === 'approved' ? 'Payment receipt returned' : 'Request denied'}</strong><p>${decision.reason}</p></div>` : ''}
    <div class="panel-spacer"></div>
    <button type="button" class="cta" data-action="request" ${state.stage !== 'checkout' ? 'disabled' : ''}>${requested ? 'Request sent to WeBank' : 'Ask WeBank to pay →'}</button>
    <div class="rail-note">Scripted agent view. No live Claude connection or model call.</div>`;
}

function renderBank() {
  const decision = state.currentDecision;
  const level = state.licence === 'P' ? 'P-plate' : 'L-plate';
  const licenceDescription = state.licence === 'P' ? 'Auto up to ¥100 · cap ¥300' : 'Every eligible payment needs a tap · cap ¥50';
  const decisionCard = decision ? `<div class="decision-card ${decision.status === 'pending' ? 'step' : decision.status === 'approved' ? 'approve' : 'deny'}"><div class="micro-label">${decision.status === 'pending' ? 'ACTION REQUIRED / SIMULATED FACE ID' : decision.status === 'approved' ? 'APPROVED / DEMO RECEIPT' : 'DENIED / NO FUNDS MOVED'}</div><strong>${decision.heading}</strong><p>${decision.reason}</p><p>Check ${decision.check} · ${decision.id}</p></div>` : `<div class="decision-card"><div class="micro-label">BANK DECISION</div><strong>Waiting for a request</strong><p>WeBank will check agent status, the registered payee, mandate, policy, and licence.</p></div>`;
  byId('bank-content').innerHTML = `
    <div class="wallet-card"><div class="wallet-top"><span>AGENT SUB-WALLET · DEMO</span><strong>WeBank</strong></div><div class="wallet-balance">${money(state.balance)}</div><div class="wallet-bottom"><span>Separate from main account</span><span>CNY · simulated</span></div></div>
    <div class="licence-row"><div><strong>Claude · simulated agent</strong><span class="licence-sub">${licenceDescription}</span></div><span class="licence-pill ${state.frozen ? 'frozen' : state.licence === 'L' ? 'learner' : ''}">${state.frozen ? 'FROZEN' : level}</span></div>
    <div class="policy-grid"><div class="policy-cell"><span>USER PAYMENT CAP</span><strong>¥300</strong></div><div class="policy-cell"><span>DEMERIT POINTS</span><strong>${state.points} / 12</strong></div></div>
    ${decisionCard}
    ${decision?.status === 'pending' ? `<div class="button-row"><button type="button" class="cta" data-action="approve">Approve with Face ID*</button><button type="button" class="cta secondary" data-action="reject">Decline</button></div><div class="rail-note">* Face ID is a simulated tap. This is a fixed, non-AI approval screen.</div>` : ''}
    <div class="panel-spacer"></div>
    <button type="button" class="freeze-button ${state.frozen ? 'frozen' : ''}" data-action="freeze">${state.frozen ? '◉ Agent frozen · Tap to unfreeze' : '◯ Freeze this agent'}</button>
    <div class="rail-note">Policy and licence are enforced by deterministic demo code.</div>`;
}

function renderHistory() {
  byId('history-count').textContent = `${state.history.length} ${state.history.length === 1 ? 'attempt' : 'attempts'}`;
  byId('history-content').innerHTML = state.history.length ? state.history.map((entry) => `
    <div class="history-item"><span class="history-symbol ${entry.status}">${entry.status === 'approved' ? '✓' : entry.status === 'pending' ? '…' : '×'}</span>
      <div class="history-name"><strong>${entry.product}</strong><span>Rail payee: ${historicalRailPayee(entry)} · Storefront: ${entry.merchant} · ${formatTime(entry.at)} · ${entry.id}</span></div>
      <span class="history-amount">${money(entry.amount)}</span><span class="history-reason">${entry.reason}</span>
      <span class="history-status ${entry.status}">${entry.status.toUpperCase()}</span></div>`).join('') : `<div class="history-empty">No payment attempts yet. Create a checkout request to begin.</div>`;
}

function render() { renderScenarios(); renderShop(); renderAgent(); renderBank(); renderHistory(); }

function selectScenario(id) {
  if (!SCENARIOS.some((item) => item.id === id)) return;
  if (state.currentDecision?.status === 'pending') {
    const entry = state.history.find((record) => record.id === state.currentDecision.id);
    if (entry) { entry.status = 'denied'; entry.reason = 'Approval was dismissed before user confirmation. No funds moved.'; }
  }
  state.selected = id;
  state.stage = 'browse';
  state.checkoutId = null;
  state.currentDecision = null;
  save();
}

function createCheckout() {
  if (state.stage !== 'browse') return;
  state.checkoutId = `ORD-${nextId()}`;
  state.stage = 'checkout';
  save();
}

function requestPayment() {
  if (state.stage !== 'checkout') return;
  const item = scenario();
  const id = `DEC-${nextId()}`;
  let status = 'approved', heading = 'Payment approved', reason = '', check = '7 / Decision';
  if (state.frozen) {
    status = 'denied'; heading = 'Agent is frozen'; check = '1 / Agent auth';
    reason = 'The user froze this agent. Its next payment request fails at authentication.';
  } else if (item.id === 'drill') {
    status = 'denied'; heading = 'Fire drill failed · licence demoted'; check = '2 / Rail validation';
    reason = 'The payee is a registered decoy and gift cards are blocked. No money moved. Six demerit points demote this agent to L-plate.';
    state.points += 6;
    state.licence = 'L';
  } else if (item.id === 'swap') {
    status = 'denied'; heading = 'Merchant identity mismatch'; check = '2 / Rail validation';
    reason = 'The page names Northstar Market, but the simulated rail registry identifies Outside Services. This payee is outside the mandate.';
  } else if (item.amount > (state.licence === 'P' ? 300 : 50)) {
    status = 'denied'; heading = 'Licence cap exceeded'; check = '4 / Policy + licence';
    reason = `${money(item.amount)} exceeds the ${state.licence}-plate per-payment cap of ${state.licence === 'P' ? '¥300' : '¥50'}. The licence can only tighten the user’s ¥300 cap.`;
  } else if (item.amount > 100 || state.licence === 'L') {
    status = 'pending'; heading = `${money(item.amount)} needs your approval`; check = '4 / Policy + licence';
    reason = `${item.merchant} is the registered payee and the purchase fits the mandate. ${item.note} No funds move until you confirm.`;
  } else {
    reason = `${item.merchant} is the registered payee. ${money(item.amount)} fits the coffee mandate and P-plate ¥100 auto-approval limit.`;
  }
  if (status === 'approved') state.balance -= item.amount;
  const agentSummary = status === 'pending' ? 'User approval requested in WeBank.' : status === 'approved' ? 'Approved. Merchant received a demo payment confirmation.' : 'Denied. No payment was sent.';
  const decision = { id, status, heading, reason, check, agentSummary };
  state.currentDecision = decision;
  state.stage = status === 'pending' ? 'requested' : 'resolved';
  state.history.unshift({ id, status, reason, product: item.product, merchant: item.merchant, railPayee: railPayee(item), railMerchant: item.railMerchant, amount: item.amount, at: new Date().toISOString() });
  save();
}

function resolveApproval(approve) {
  if (state.currentDecision?.status !== 'pending') return;
  const entry = state.history.find((record) => record.id === state.currentDecision.id);
  if (!entry) return;
  if (approve && !state.frozen) {
    state.currentDecision.status = 'approved';
    state.currentDecision.heading = 'Payment approved by user';
    state.currentDecision.reason = `Simulated Face ID approval for ${money(entry.amount)} at ${entry.merchant}. The mock order is confirmed and the sub-wallet balance is updated.`;
    state.currentDecision.agentSummary = 'User approved. Merchant received a demo payment confirmation.';
    state.balance -= entry.amount;
    entry.status = 'approved';
  } else {
    state.currentDecision.status = 'denied';
    state.currentDecision.heading = state.frozen ? 'Agent frozen during approval' : 'User declined payment';
    state.currentDecision.reason = state.frozen ? 'The agent was frozen before approval. No funds moved.' : 'The user declined the simulated Face ID prompt. No funds moved.';
    state.currentDecision.agentSummary = 'Denied. No payment was sent.';
    entry.status = 'denied';
  }
  entry.reason = state.currentDecision.reason;
  state.stage = 'resolved';
  save();
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  switch (button.dataset.action) {
    case 'select': selectScenario(button.dataset.id); break;
    case 'checkout': createCheckout(); break;
    case 'request': requestPayment(); break;
    case 'approve': resolveApproval(true); break;
    case 'reject': resolveApproval(false); break;
    case 'freeze': state.frozen = !state.frozen; if (state.frozen && state.currentDecision?.status === 'pending') resolveApproval(false); else save(); break;
  }
});
byId('reset-button').addEventListener('click', () => { state = initialState(); save(); });
render();
