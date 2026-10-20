export const bankConsoleHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WeBank Bank Console - local demo</title>
<style>
  :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #111018; color: #ece8f1; min-width: 280px; }
  header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 12px; background: #1c1828; border-bottom: 1px solid #403451; padding: 10px 14px; }
  h1 { margin: 0; font-size: 14px; letter-spacing: .01em; }
  .badge { white-space: nowrap; color: #d7b8ff; background: #3a2851; padding: 4px 7px; border-radius: 99px; font-size: 9px; font-weight: 800; }
  #status { color: #a49bab; font-size: 10px; padding: 6px 14px 0; min-height: 21px; }
  #feed { height: calc(100vh - 76px); overflow-y: auto; padding: 5px 10px 16px; }
  .group { margin: 8px 0; border: 1px solid #393247; border-left: 3px solid #8558c7; border-radius: 7px; background: #1b1923; overflow: hidden; }
  .group.denied { border-left-color: #f16a7c; }
  .group.paid { border-left-color: #60d8a1; }
  .group.simulation { border-left-color: #f1b958; }
  .line { display: grid; grid-template-columns: 15px minmax(0, 1fr); gap: 7px; padding: 4px 9px; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
  .line:first-child { padding-top: 8px; }
  .line:last-child { padding-bottom: 8px; }
  .glyph { font-weight: 900; color: #a88bcb; }
  .pass .glyph, .paid .glyph { color: #60d8a1; }
  .deny .glyph, .denied .glyph { color: #f16a7c; }
  .step_up .glyph, .simulation .glyph { color: #f1b958; }
  .skipped { color: #968da0; }
  .muted { color: #b6adbf; }
  .sub { color: #a49bab; }
  .empty { color: #a49bab; font-size: 11px; padding: 14px; }
  @media (max-width: 480px) { header { padding: 9px 11px; } h1 { font-size: 12px; } #feed { padding: 5px 7px 14px; } .line { font-size: 10px; } }
</style>
</head>
<body>
<header><h1>WeBank <span class="muted">/</span> Bank Console</h1><span class="badge">LOCAL DEMO · READ ONLY</span></header>
<div id="status" role="status">Connecting to local Gateway…</div>
<main id="feed" aria-live="polite" aria-label="Bank verification feed"><div id="empty" class="empty">Waiting for bank activity.</div></main>
<script>
(() => {
  "use strict";
  const feed = document.getElementById("feed");
  const status = document.getElementById("status");
  const groups = new Map();
  let cursor = 0;
  let polling = false;
  const yuan = (fen) => Number.isSafeInteger(fen) ? "¥" + (fen / 100).toFixed(2) : "amount unavailable";
  const glyph = (result) => result === "pass" || result === "paid" ? "✔" : result === "deny" || result === "denied" ? "✖" : result === "skipped" ? "·" : "…";
  const addLine = (group, result, words) => {
    const row = document.createElement("div");
    row.className = "line " + (result || "");
    const icon = document.createElement("span");
    icon.className = "glyph";
    icon.textContent = glyph(result);
    const text = document.createElement("span");
    text.textContent = words;
    row.append(icon, text);
    group.appendChild(row);
  };
  const groupFor = (subject, type) => {
    const key = subject || "misc-" + groups.size;
    let group = groups.get(key);
    if (!group) {
      group = document.createElement("section");
      group.className = "group " + (type || "");
      group.setAttribute("aria-label", type === "simulation" ? "Simulated Treasurer scene" : "Bank activity " + key);
      groups.set(key, group);
      feed.appendChild(group);
    }
    return group;
  };
  const checkLabels = { agent_auth: "agent identity", rail_validation: "real merchant", mandate: "mandate", policy_licence: "limits", risk: "risk" };
  const show = (event) => {
    const empty = document.getElementById("empty");
    if (empty) empty.remove();
    const group = groupFor(event.subject, event.kind === "simulation" ? "simulation" : "");
    if (event.kind === "pairing") {
      addLine(group, "pass", (event.app || "Connected app") + " connected · Amber");
      addLine(group, "pass", "request number matched · biometric " + (event.biometric || "unavailable") + (event.biometric === "simulated" ? " in web demo" : ""));
    } else if (event.kind === "mandate_lock") {
      addLine(group, "pass", (event.subject || "mandate") + " · mandate locked");
      addLine(group, "pass", (event.model || "Product unavailable") + " · " + (event.variant || "Unavailable") + " · GTIN " + (event.gtin_preview || "Unavailable") + " · max " + yuan(event.max_fen));
    } else if (event.kind === "payment") {
      addLine(group, "", (event.subject || "payment") + "  → " + (event.merchant || "Payee unavailable") + (Number.isSafeInteger(event.amount_fen) ? "  " + yuan(event.amount_fen) : ""));
      if (event.light) addLine(group, "pass", "agent identity · " + event.light.charAt(0) + event.light.slice(1).toLowerCase());
    } else if (event.kind === "check") {
      addLine(group, event.result, (checkLabels[event.check] || "bank check") + " · " + (event.result || "unavailable") + (event.reason ? " · " + event.reason : ""));
    } else if (event.kind === "precheck_denial") {
      addLine(group, "deny", "request rejected before full checks · " + (event.reason || "invalid request"));
    } else if (event.kind === "guardian") {
      const source = event.source === "Hermes" ? "Hermes" : "source unavailable";
      const elapsed = Number.isSafeInteger(event.elapsed_ms) ? (event.elapsed_ms / 1000).toFixed(1) + "s" : "time unavailable";
      addLine(group, event.result, "Guardian · " + source + " · " + (event.result || "unavailable") + " · " + elapsed);
    } else if (event.kind === "owner_approval") {
      addLine(group, "pass", "approved by you · " + (event.request_number_matched ? "request number matched · " : "") + "biometric " + (event.biometric || "unavailable") + (event.biometric === "simulated" ? " in web demo" : ""));
    } else if (event.kind === "settlement") {
      if (event.status === "waiting") addLine(group, "step_up", "waiting for you");
      else if (event.status === "paid") {
        group.classList.add("paid");
        addLine(group, "paid", (event.approval_source === "auto" ? "Green · auto-paid" : "paid on FISCO") + " · tx " + (event.tx_preview || "unavailable") + " · block " + (event.block_number || "unavailable"));
      } else if (event.status === "denied") {
        group.classList.add("denied");
        addLine(group, "denied", "refused · no payment settled");
      } else addLine(group, "step_up", "settlement uncertain · reconciliation required");
    } else if (event.kind === "simulation") {
      const labels = {
        treasurer_renewal_reserved: "Treasurer renewal amount reserved (simulation)",
        treasurer_renewal_paid: "Treasurer renewal shown as paid (simulation only)",
        treasurer_topup_blocked: "Treasurer top-up blocked and frozen (simulation)"
      };
      addLine(group, event.scene === "treasurer_topup_blocked" ? "deny" : "step_up", "SIMULATION · " + (labels[event.scene] || "Treasurer scene") + (Number.isSafeInteger(event.amount_fen) ? " · " + yuan(event.amount_fen) : ""));
    }
    feed.scrollTop = feed.scrollHeight;
  };
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const response = await fetch("/v1/demo/console/events?after=" + cursor, { cache: "no-store", credentials: "omit" });
      if (!response.ok) throw new Error("Gateway unavailable");
      const data = await response.json();
      if (data.schema !== "bank_console_feed.v1" || !Array.isArray(data.events)) throw new Error("Invalid feed");
      data.events.forEach(show);
      if (Number.isSafeInteger(data.next_cursor)) cursor = data.next_cursor;
      status.textContent = "Live bank checks · local Gateway";
    } catch {
      status.textContent = "Feed unavailable · checking again";
    } finally {
      polling = false;
    }
  };
  poll();
  setInterval(poll, 1000);
})();
</script>
</body>
</html>`;
