"""Pure launcher deployment-proof checks; never starts services or submits a transaction."""

import copy
import hashlib
import importlib.util
import io
import json
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


spec = importlib.util.spec_from_file_location("local_demo", Path(__file__).with_name("local-demo.py"))
assert spec and spec.loader
local_demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local_demo)
chain_spec = importlib.util.spec_from_file_location("chain_manage", Path(__file__).with_name("chain") / "manage.py")
assert chain_spec and chain_spec.loader
chain_manage = importlib.util.module_from_spec(chain_spec)
chain_spec.loader.exec_module(chain_manage)
treasurer_spec = importlib.util.spec_from_file_location("treasurer_simulation", Path(__file__).with_name("treasurer-simulation.py"))
assert treasurer_spec and treasurer_spec.loader
treasurer_simulation = importlib.util.module_from_spec(treasurer_spec)
treasurer_spec.loader.exec_module(treasurer_simulation)


def address(letter: str) -> str:
    return "0x" + letter * 40


def tx(letter: str) -> str:
    return "0x" + letter * 64


def receipt(hash_value: str, *, to=None, deployed=None, logs=None) -> dict:
    return {
        "status": "0x1",
        "transactionHash": hash_value,
        "blockNumber": "0x20",
        "to": to,
        "contractAddress": deployed,
        "logs": logs or [],
    }


class LauncherProcessIdentityTests(unittest.TestCase):
    def test_launcher_selects_node_22_and_places_it_before_other_nodes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            newer = root / "newer"
            compatible = root / "compatible"
            newer.mkdir()
            compatible.mkdir()
            for path in (newer / "node", compatible / "node"):
                path.write_text("fixture")
                path.chmod(0o700)

            def version(command, **_kwargs):
                value = "v26.8.1" if Path(command[0]).parent == newer else "v22.15.0"
                return types.SimpleNamespace(returncode=0, stdout=value + "\n")

            with mock.patch.dict(os.environ, {"PATH": f"{newer}:{compatible}"}, clear=True), \
                 mock.patch.object(local_demo.subprocess, "run", side_effect=version):
                selected = local_demo.project_node()
            self.assertEqual(selected, str(compatible / "node"))
            with mock.patch.object(local_demo, "NODE", selected):
                child_env = local_demo.runtime_env({"PATH": f"{newer}:{compatible}"})
            self.assertEqual(child_env["PATH"].split(os.pathsep)[0], str(compatible))

    def test_recorded_listener_and_cwd_verify_without_ps_title_or_date(self):
        record = {"pid": 55385, "started": "Thu Oct 15 22:20:20 2026"}
        uid = 501
        listener = f"p55385\ncnode\nu{uid}\nf24\nn127.0.0.1:3002\n"
        cwd = f"p55385\ncnode\nu{uid}\nfcwd\nn{local_demo.GATEWAY}\n"
        with mock.patch.object(local_demo.os, "getpgid", return_value=55385), \
             mock.patch.object(local_demo.os, "getuid", return_value=uid), \
             mock.patch.object(local_demo.subprocess, "run", side_effect=[
                 types.SimpleNamespace(returncode=0, stdout=listener),
                 types.SimpleNamespace(returncode=0, stdout=cwd),
             ]):
            self.assertTrue(local_demo.owned(record, "gateway"))

    def test_listener_identity_rejects_wrong_cwd_and_port(self):
        record = {"pid": 55385, "started": "old locale format"}
        uid = 501
        for listener_name, cwd_name in (
            ("127.0.0.1:9999", str(local_demo.GATEWAY)),
            ("127.0.0.1:3002", str(local_demo.SHOP)),
        ):
            with self.subTest(listener=listener_name, cwd=cwd_name), \
                 mock.patch.object(local_demo.os, "getpgid", return_value=55385), \
                 mock.patch.object(local_demo.os, "getuid", return_value=uid), \
                 mock.patch.object(local_demo.subprocess, "run", side_effect=[
                     types.SimpleNamespace(returncode=0, stdout=f"p55385\ncnode\nu{uid}\nf24\nn{listener_name}\n"),
                     types.SimpleNamespace(returncode=0, stdout=f"p55385\ncnode\nu{uid}\nfcwd\nn{cwd_name}\n"),
                 ]):
                self.assertFalse(local_demo.owned(record, "gateway"))

    def test_down_preserves_chain_when_any_child_cannot_be_verified(self):
        state = {"children": {"app": {"pid": 100, "started": "old"}}, "chain_pids": {"node0": 200}}
        with mock.patch.object(local_demo, "stop_child", return_value=False), \
             mock.patch.object(local_demo, "stop_chain") as stop_chain:
            self.assertFalse(local_demo.down(state))
            stop_chain.assert_not_called()


class GuardianPrivateEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = Path(self.temp.name)
        self.path = self.runtime / "guardian-hermes.env"
        patcher = mock.patch.object(local_demo, "RUNTIME", self.runtime)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_config(self, content: str | None = None):
        self.path.write_text(content or (
            "WEBANK_GUARDIAN_HERMES_URL=http://127.0.0.1:8643\n"
            f"WEBANK_GUARDIAN_HERMES_KEY={'a' * 64}\n"
            "WEBANK_GUARDIAN_HERMES_PROFILE_VERIFIED=1\n"
        ))
        self.path.chmod(0o600)

    def test_optional_private_config_is_parsed_without_shell_and_ambient_values_are_scrubbed(self):
        self.assertEqual(local_demo.read_guardian_env(), {})
        self.write_config()
        values = local_demo.read_guardian_env()
        self.assertEqual(values["WEBANK_GUARDIAN_HERMES_URL"], "http://127.0.0.1:8643")
        self.assertEqual(values["WEBANK_GUARDIAN_HERMES_KEY"], "a" * 64)
        self.assertEqual(values["WEBANK_GUARDIAN_HERMES_PROFILE_VERIFIED"], "1")
        inherited = local_demo.runtime_env({
            "PATH": "/usr/bin",
            "WEBANK_GUARDIAN_HERMES_KEY": "ambient-secret",
            "WEBANK_GUARDIAN_HERMES_PROFILE_VERIFIED": "1",
            "SHOP_INTERNAL_TOKEN": "shop-only",
        })
        self.assertNotIn("WEBANK_GUARDIAN_HERMES_KEY", inherited)
        self.assertNotIn("WEBANK_GUARDIAN_HERMES_PROFILE_VERIFIED", inherited)
        self.assertEqual(inherited["SHOP_INTERNAL_TOKEN"], "shop-only")

    def test_rejects_unsafe_file_identity_and_permissions(self):
        self.write_config()
        self.path.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, "unsafe ownership or permissions"):
            local_demo.read_guardian_env()
        self.path.chmod(0o600)
        with mock.patch.object(local_demo.os, "getuid", return_value=os.getuid() + 1):
            with self.assertRaisesRegex(RuntimeError, "unsafe ownership or permissions"):
                local_demo.read_guardian_env()
        self.path.unlink()
        self.path.symlink_to(self.runtime / "other.env")
        with self.assertRaisesRegex(RuntimeError, "unsafe or unreadable"):
            local_demo.read_guardian_env()

    def test_rejects_extra_duplicate_or_malformed_values(self):
        self.write_config()
        valid = self.path.read_text()
        for changed in (
            valid + "UNRECOGNIZED_KEY=value\n",
            valid + "WEBANK_GUARDIAN_HERMES_KEY=another\n",
            valid.replace("http://127.0.0.1:8643", "$(touch /tmp/unsafe)"),
            valid.replace("PROFILE_VERIFIED=1", "PROFILE_VERIFIED=0"),
            valid.replace("KEY=" + "a" * 64, "KEY=not-a-key"),
        ):
            with self.subTest(changed=changed.splitlines()[-1]):
                self.write_config(changed)
                with self.assertRaises(RuntimeError):
                    local_demo.read_guardian_env()


class BuildFreshnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.shop = self.root / "apps/shops"
        self.app = self.root / "apps/webank-app"
        self.runtime = self.root / "scripts/local-demo-runtime"
        self.runtime.mkdir(parents=True)
        self.outputs = {}
        for name, relative in (
            ("contracts", "packages/contracts"),
            ("chain", "packages/chain"),
            ("guardian", "services/guardian"),
            ("connector-mcp", "agents/connector-mcp"),
        ):
            package = self.root / relative
            (package / "src").mkdir(parents=True)
            (package / "src/index.ts").write_text("export const value = 1;\n")
            (package / "package.json").write_text("{}\n")
            (package / "tsconfig.json").write_text("{}\n")
            output = package / "dist/index.js"
            output.parent.mkdir()
            output.write_text("compiled\n")
            self.outputs[name] = output
        (self.root / "tsconfig.base.json").write_text("{}\n")
        (self.root / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n")
        for path in (self.shop / "app", self.shop / "lib", self.app / "src", self.shop / ".next"):
            path.mkdir(parents=True)
        for path in (self.shop / "package.json", self.app / "package.json", self.app / "App.tsx", self.app / "app.json", self.app / "index.ts"):
            path.write_text("fixture\n")
        (self.shop / ".next/BUILD_ID").write_text("fixture\n")
        (self.app / "dist").mkdir()
        (self.app / "dist/index.html").write_text("fixture\n")
        self.patches = [
            mock.patch.object(local_demo, "ROOT", self.root),
            mock.patch.object(local_demo, "SHOP", self.shop),
            mock.patch.object(local_demo, "APP", self.app),
            mock.patch.object(local_demo, "RUNTIME", self.runtime),
            mock.patch.object(local_demo, "NODE", "node22"),
            mock.patch.object(local_demo, "COREPACK", "corepack"),
        ]
        for patcher in self.patches:
            patcher.start()
        self.addCleanup(lambda: [patcher.stop() for patcher in reversed(self.patches)])
        (self.runtime / "shop-build.sha256").write_text(local_demo.fingerprint([self.shop / "app", self.shop / "lib", self.shop / "package.json"]) + "\n")
        (self.runtime / "app-export.sha256").write_text(local_demo.fingerprint(
            [self.app / "App.tsx", self.app / "src", self.app / "app.json", self.app / "index.ts", self.app / "package.json"],
            ["http://127.0.0.1:3002", "1"],
        ) + "\n")
        self.built = []

        def fake_build(name, *_args):
            self.built.append(name)
            if name == "app":
                (self.app / "dist").mkdir(exist_ok=True)
                (self.app / "dist/index.html").write_text("built\n")
            elif name == "shop":
                (self.shop / ".next/BUILD_ID").write_text("built\n")
            else:
                self.outputs[name].write_text("built\n")

        self.build_patch = mock.patch.object(local_demo, "run_build", side_effect=fake_build)
        self.build_patch.start()
        self.addCleanup(self.build_patch.stop)

    def test_source_edits_rebuild_shared_packages_and_connector(self):
        local_demo.prepare_builds()
        self.assertIn("contracts", self.built)
        self.assertIn("chain", self.built)
        self.assertIn("connector-mcp", self.built)
        self.built.clear()
        for name, relative in (("contracts", "packages/contracts"), ("chain", "packages/chain"), ("connector-mcp", "agents/connector-mcp")):
            (self.root / relative / "src/index.ts").write_text("export const value = 2;\n")
        local_demo.prepare_builds()
        self.assertIn("contracts", self.built)
        self.assertIn("chain", self.built)
        self.assertIn("connector-mcp", self.built)

    def test_unchanged_builds_are_skipped_and_missing_connector_output_rebuilds(self):
        local_demo.prepare_builds()
        self.built.clear()
        local_demo.prepare_builds()
        self.assertEqual(self.built, [])
        self.outputs["connector-mcp"].unlink()
        local_demo.prepare_builds()
        self.assertEqual(self.built, ["connector-mcp"])

    def test_contract_change_refreshes_dependent_builds(self):
        local_demo.prepare_builds()
        self.built.clear()
        (self.root / "packages/contracts/src/index.ts").write_text("export const value = 3;\n")
        local_demo.prepare_builds()
        self.assertEqual(self.built, ["contracts", "guardian", "connector-mcp", "shop"])


class DeploymentFundingProofTests(unittest.TestCase):
    def setUp(self):
        self.stage = {
            "chainId": 20200,
            "rpcUrl": "http://127.0.0.1:8545",
            "bank": address("a"),
            "gateway": address("b"),
            "ecnySim": address("c"),
            "agentWallet": address("d"),
            "merchantRegistry": address("e"),
            "licenceRegistry": address("f"),
            "auditAnchor": address("1"),
            "deploymentFingerprint": "2" * 64,
            "txHashes": {
                "deployECnySim": tx("1"),
                "deployAgentWallet": tx("2"),
                "openingMint": tx("3"),
                "configureAgentWallet": tx("4"),
            },
            "migration": {
                "state": "staged",
                "priorAddresses": {"ecnySim": address("3"), "agentWallet": address("4")},
                "priorDeploymentFingerprint": "5" * 64,
                "priorReceiptHash": tx("5"),
            },
        }
        self.active = copy.deepcopy(self.stage)
        self.active["migration"]["state"] = "active"
        bank_topic = "0x" + ("a" * 40).rjust(64, "0")
        wallet_topic = "0x" + ("d" * 40).rjust(64, "0")
        prior_wallet_topic = "0x" + ("4" * 40).rjust(64, "0")
        payout_topic = "0x" + ("6" * 40).rjust(64, "0")
        self.receipts = {
            tx("1"): receipt(tx("1"), deployed=address("c")),
            tx("2"): receipt(tx("2"), deployed=address("d")),
            tx("3"): receipt(tx("3"), to=address("c"), logs=[{
                "address": address("c"),
                "topics": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + "0" * 64, bank_topic],
                "data": "0x" + format(866000, "064x"),
            }]),
            tx("4"): receipt(tx("4"), to=address("c"), logs=[{
                "address": address("c"),
                "topics": ["0xc5b405b8d912cd7016aa0318c05febe7708ec672827c4c970534d75d1bad4a48", wallet_topic],
            }]),
            tx("5"): receipt(tx("5"), to=address("4"), logs=[{
                "address": address("4"),
                "topics": ["0xbb4b659a1c76dc81c196c5d5bfd8cf796faffb9bdd4ec7f14f59a27ee28cd311", tx("7"), tx("8"), payout_topic],
                "data": "0x" + format(27900, "064x"),
            }, {
                "address": address("3"),
                "topics": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", prior_wallet_topic, payout_topic],
                "data": "0x" + format(27900, "064x"),
            }]),
        }

    def verify(self, active=None, stage=None):
        local_demo.verify_deployment_funding(
            self.active if active is None else active,
            self.stage if stage is None else stage,
            self.receipts.get,
        )

    def test_active_migration_with_complete_chain_proof(self):
        self.verify()

    def fresh(self):
        fresh = copy.deepcopy(self.active)
        fresh.pop("migration")
        for name, letter, field in (
            ("deployMerchantRegistry", "6", "merchantRegistry"),
            ("deployLicenceRegistry", "8", "licenceRegistry"),
            ("deployAuditAnchor", "9", "auditAnchor"),
        ):
            fresh["txHashes"][name] = tx(letter)
            self.receipts[tx(letter)] = receipt(tx(letter), deployed=fresh[field])
        return fresh

    def test_native_funded_fresh_and_ordinary_restart(self):
        fresh = self.fresh()
        self.verify(fresh, None)
        self.verify(copy.deepcopy(fresh), None)

    def test_native_funded_fresh_rejects_incomplete_or_false_proof(self):
        fresh = self.fresh()
        for change in (
            lambda value: value["txHashes"].pop("openingMint"),
            lambda value: value.update(chainId=1),
            lambda value: value.update(deploymentFingerprint="bad"),
            lambda value: value["txHashes"].update(fundWallet=tx("a")),
        ):
            with self.subTest(change=change):
                changed = copy.deepcopy(fresh)
                change(changed)
                with self.assertRaises(RuntimeError):
                    self.verify(changed, None)
        original = copy.deepcopy(self.receipts[tx("3")])
        self.receipts[tx("3")]["logs"] = []
        with self.assertRaises(RuntimeError):
            self.verify(fresh, None)
        self.receipts[tx("3")] = original

    def test_legacy_prefunded_wallet(self):
        legacy = {
            "bank": address("a"), "ecnySim": address("c"), "agentWallet": address("d"),
            "txHashes": {"fundWallet": tx("6")},
        }
        self.receipts[tx("6")] = receipt(tx("6"), to=address("c"), logs=[{
            "address": address("c"),
            "topics": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + ("a" * 40).rjust(64, "0"), "0x" + ("d" * 40).rjust(64, "0")],
            "data": "0x" + format(100000, "064x"),
        }])
        self.verify(legacy, {})
        self.receipts[tx("6")]["status"] = "0x0"
        with self.assertRaises(RuntimeError):
            self.verify(legacy, {})
        self.receipts[tx("6")]["status"] = "0x1"
        self.receipts[tx("6")]["logs"] = []
        with self.assertRaises(RuntimeError):
            self.verify(legacy, {})

    def test_incomplete_or_mismatched_migration_fails_closed(self):
        for change in (
            lambda active: active["txHashes"].pop("openingMint"),
            lambda active: active["migration"].update(state="staged"),
            lambda active: active.update(bank=address("9")),
            lambda active: active["migration"].update(priorReceiptHash=tx("9")),
        ):
            with self.subTest(change=change):
                active = copy.deepcopy(self.active)
                change(active)
                with self.assertRaises(RuntimeError):
                    self.verify(active)

    def test_failed_or_wrong_receipt_fails_closed(self):
        for field, value in (("status", "0x0"), ("contractAddress", address("9"))):
            with self.subTest(field=field):
                changed = copy.deepcopy(self.receipts[tx("1")])
                changed[field] = value
                self.receipts[tx("1")] = changed
                with self.assertRaises(RuntimeError):
                    self.verify()
                self.receipts[tx("1")] = receipt(tx("1"), deployed=address("c"))

    def test_paid_topic_without_matching_token_transfer_fails_closed(self):
        original = copy.deepcopy(self.receipts[tx("5")])
        for logs in (original["logs"][:1], [original["logs"][0], {**original["logs"][1], "data": "0x" + format(27901, "064x")}], [original["logs"][0], {**original["logs"][1], "address": address("9")}]):
            with self.subTest(logs=logs):
                self.receipts[tx("5")]["logs"] = logs
                with self.assertRaises(RuntimeError):
                    self.verify()
        self.receipts[tx("5")] = original


class FreshResetJournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        runtime = root / "runtime"
        runtime.mkdir(mode=0o700)
        self.patches = [
            mock.patch.object(local_demo, "RUNTIME", runtime),
            mock.patch.object(local_demo, "CONSOLE_SIMULATION", runtime / "console-simulation.jsonl"),
            mock.patch.object(local_demo, "SHOP_OPERATOR_TOKEN", runtime / "shop-operator-token"),
            mock.patch.object(local_demo, "FRESH_RESET", runtime / "fresh-reset.json"),
            mock.patch.object(local_demo, "GATEWAY_STATE", runtime / "gateway-state.json"),
            mock.patch.object(local_demo, "ADDRESSES", root / "addresses.json"),
            mock.patch.object(local_demo, "SHOP_STATE", root / "shop-state.json"),
            mock.patch.object(local_demo, "FRESH_PENDING", root / "fresh-deployment-pending.json"),
        ]
        for patcher in self.patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def source(self, path, content):
        path.write_text(content)
        path.chmod(0o600)

    def populate(self, migrated):
        prior = {
            "agentWallet": address("d"),
            "deploymentFingerprint": "2" * 64,
            "migration": {"state": "active"} if migrated else None,
        }
        self.source(local_demo.ADDRESSES, json.dumps(prior))
        payload = {"replacingAgents": [], "mandates": [], "approvals": [], "pairings": [], "payments": [], "fundingRecords": [], "sweepRecords": [], "humanPaymentRecords": []}
        digest = hashlib.sha256(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        self.source(local_demo.GATEWAY_STATE, json.dumps({"version": 1, "payload": payload, "sha256": digest}))
        for name in ("gateway-initialized", "gateway-identity", "gateway-identity-initialized"):
            self.source(local_demo.reset_sources()[name], name)
        self.source(local_demo.SHOP_STATE, "shop orders")

    def test_unresolved_gateway_work_blocks_before_journal(self):
        self.populate(True)
        for field, value in (
            ("mandates", {"status": "active"}),
            ("pairings", {"status": "pending"}),
            ("payments", {"status": "reconciliation_required"}),
            ("fundingRecords", {"status": "settling"}),
            ("sweepRecords", {"status": "settling"}),
            ("humanPaymentRecords", {"status": "prepared"}),
        ):
            with self.subTest(field=field):
                payload = {"replacingAgents": [], "mandates": [], "approvals": [], "pairings": [], "payments": [], "fundingRecords": [], "sweepRecords": [], "humanPaymentRecords": []}
                payload[field].append(value)
                digest = hashlib.sha256(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
                self.source(local_demo.GATEWAY_STATE, json.dumps({"version": 1, "payload": payload, "sha256": digest}))
                with self.assertRaises(RuntimeError):
                    local_demo.fresh_reset_journal()
                self.assertFalse(local_demo.FRESH_RESET.exists())

    def test_expired_pairing_is_quiescent_but_live_pairing_blocks(self):
        self.populate(True)
        raw = json.loads(local_demo.GATEWAY_STATE.read_text())
        for expires_at, blocked in ((0, False), (int(local_demo.time.time() * 1000) + 60_000, True)):
            payload = {**raw["payload"], "pairings": [{"status": "pending", "expiresAt": expires_at}]}
            digest = hashlib.sha256(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
            self.source(local_demo.GATEWAY_STATE, json.dumps({"version": 1, "payload": payload, "sha256": digest}))
            if blocked:
                with self.assertRaisesRegex(RuntimeError, "Resolve pairings status pending"):
                    local_demo.verify_reset_quiescent(local_demo.GATEWAY_STATE)
            else:
                local_demo.verify_reset_quiescent(local_demo.GATEWAY_STATE)

    def test_console_simulation_is_archived_without_touching_chain_or_signers(self):
        self.populate(True)
        self.source(local_demo.CONSOLE_SIMULATION, '{"schema":"console_simulation.v1"}\n')
        journal = local_demo.fresh_reset_journal()
        archive = local_demo.archive_fresh_inputs(journal)
        self.assertEqual((archive / "console-simulation").read_text(), '{"schema":"console_simulation.v1"}\n')
        self.assertFalse(local_demo.CONSOLE_SIMULATION.exists())
        self.assertEqual(json.loads((archive / "addresses").read_text())["agentWallet"], address("d"))

    def test_shop_operator_token_is_private_and_reset_uses_protected_route(self):
        local_demo.write_private_token(local_demo.SHOP_OPERATOR_TOKEN, "x" * 43)
        self.assertEqual(local_demo.SHOP_OPERATOR_TOKEN.stat().st_mode & 0o777, 0o600)
        calls = []
        def fake_request(url, *, payload=None, headers=None):
            calls.append((url, payload, headers))
            return 200, b'{"ok":true,"reset":true,"attack":false,"coffee_price":8800}'
        with mock.patch.object(local_demo, "request", side_effect=fake_request):
            local_demo.recording_shop_reset()
        self.assertEqual(calls[0][0], "http://127.0.0.1:3001/internal/demo-control")
        self.assertEqual(calls[0][1], {"operation": "reset"})
        self.assertEqual(calls[0][2]["Authorization"], "Bearer " + "x" * 43)
        with mock.patch.object(local_demo, "request", return_value=(409, b'{}')):
            with self.assertRaisesRegex(RuntimeError, "stop the bank drill"):
                local_demo.recording_shop_reset()

    def test_recording_readback_uses_private_owner_token_and_actual_session_cookie(self):
        token_file = local_demo.RUNTIME / "app-login-token"
        self.source(token_file, "x" * 32 + "\n")
        login = mock.MagicMock()
        login.__enter__.return_value.headers.get.return_value = (
            "webank_local_demo_session=session-value; HttpOnly; SameSite=Lax"
        )
        status = mock.MagicMock()
        status.__enter__.return_value.read.return_value = b'{"agent_wallet":{"enabled":false}}'
        with mock.patch.object(local_demo, "TOKEN", token_file), \
             mock.patch.object(local_demo.urllib.request, "urlopen", side_effect=[login, status]) as opened:
            result = local_demo.recording_owner_readback("/v1/app/home")
        self.assertFalse(result["agent_wallet"]["enabled"])
        login_request = opened.call_args_list[0].args[0]
        self.assertEqual(login_request.get_header("Authorization"), "Bearer " + "x" * 32)
        self.assertEqual(login_request.get_header("Content-type"), "application/json")
        self.assertEqual(login_request.data, b"{}")
        self.assertEqual(opened.call_args_list[1].args[0].get_header("Cookie"), "webank_local_demo_session=session-value")

    def test_recording_home_readback_waits_for_transient_chain_unavailable(self):
        token_file = local_demo.RUNTIME / "app-login-token"
        self.source(token_file, "x" * 32 + "\n")
        login = mock.MagicMock()
        login.__enter__.return_value.headers.get.return_value = "webank_local_demo_session=session-value; HttpOnly"
        home = mock.MagicMock()
        home.__enter__.return_value.read.return_value = b'{"agent_wallet":{"enabled":false}}'
        transient = local_demo.urllib.error.HTTPError(
            "http://127.0.0.1:3002/v1/app/home", 503, "Unavailable", {},
            io.BytesIO(b'{"error":{"code":"chain_unavailable"}}'),
        )
        with mock.patch.object(local_demo, "TOKEN", token_file), \
             mock.patch.object(local_demo.urllib.request, "urlopen", side_effect=[login, transient, home]) as opened, \
             mock.patch.object(local_demo.time, "sleep") as slept:
            result = local_demo.recording_owner_readback("/v1/app/home")
        self.assertFalse(result["agent_wallet"]["enabled"])
        self.assertEqual(opened.call_count, 3)
        slept.assert_called_once()

    def test_recording_home_readback_exhausts_transient_retry_without_secrets(self):
        token_file = local_demo.RUNTIME / "app-login-token"
        self.source(token_file, "x" * 32 + "\n")
        login = mock.MagicMock()
        login.__enter__.return_value.headers.get.return_value = "webank_local_demo_session=session-value; HttpOnly"
        def opened(request, **_kwargs):
            if request.full_url.endswith("/demo/login"):
                return login
            raise local_demo.urllib.error.HTTPError(
                request.full_url, 503, "Unavailable", {},
                io.BytesIO(b'{"error":{"code":"chain_unavailable","message":"private diagnostic"}}'),
            )
        with mock.patch.object(local_demo, "TOKEN", token_file), \
             mock.patch.object(local_demo.urllib.request, "urlopen", side_effect=opened) as urlopen, \
             mock.patch.object(local_demo.time, "sleep") as slept:
            with self.assertRaisesRegex(RuntimeError, "HTTP 503 chain_unavailable after .* attempts") as error:
                local_demo.recording_owner_readback("/v1/app/home")
        self.assertNotIn("private diagnostic", str(error.exception))
        self.assertNotIn("x" * 32, str(error.exception))
        self.assertGreater(urlopen.call_count, 2)
        self.assertEqual(slept.call_count, urlopen.call_count - 2)

    def test_recording_readback_does_not_retry_non_chain_errors(self):
        token_file = local_demo.RUNTIME / "app-login-token"
        self.source(token_file, "x" * 32 + "\n")
        for path, code, body in (
            ("/v1/app/home", 403, b'{"error":{"code":"unauthorized"}}'),
            ("/v1/app/home", 503, b'{"error":{"code":"policy_unavailable"}}'),
            ("/v1/app/policy", 503, b'{"error":{"code":"chain_unavailable"}}'),
        ):
            with self.subTest(path=path, code=code, body=body):
                login = mock.MagicMock()
                login.__enter__.return_value.headers.get.return_value = "webank_local_demo_session=session-value; HttpOnly"
                problem = local_demo.urllib.error.HTTPError(
                    f"http://127.0.0.1:3002{path}", code, "Failure", {}, io.BytesIO(body),
                )
                with mock.patch.object(local_demo, "TOKEN", token_file), \
                     mock.patch.object(local_demo.urllib.request, "urlopen", side_effect=[login, problem]) as opened, \
                     mock.patch.object(local_demo.time, "sleep") as slept:
                    with self.assertRaisesRegex(RuntimeError, f"HTTP {code}"):
                        local_demo.recording_owner_readback(path)
                self.assertEqual(opened.call_count, 2)
                slept.assert_not_called()

    def test_stage_status_is_read_only_and_blocks_running_demo(self):
        self.populate(False)
        state = local_demo.RUNTIME / "state.json"
        with mock.patch.object(local_demo, "STATE", state), \
             mock.patch.object(local_demo, "FUNDING_CUTOVER", local_demo.RUNTIME / "funding-cutover.json"), \
             mock.patch.object(local_demo, "chain_pids", return_value={}), \
             mock.patch.object(local_demo, "port_busy", return_value=False):
            self.assertEqual(local_demo.recording_stage_issues(), [])
            self.assertFalse(local_demo.FRESH_RESET.exists())
            self.assertFalse(local_demo.SHOP_OPERATOR_TOKEN.exists())
            self.source(state, "owned")
            self.assertIn("Stop the launcher-owned demo with local-demo-down.sh first", local_demo.recording_stage_issues())

    def test_stage_execute_stops_owned_demo_before_fresh_setup_and_readback(self):
        state = local_demo.RUNTIME / "state.json"
        self.source(state, json.dumps({"version": 1, "children": {}}))
        calls = []
        with mock.patch.object(local_demo, "STATE", state), \
             mock.patch.object(local_demo, "recording_stage_issues", side_effect=[[], []]), \
             mock.patch.object(local_demo, "down", side_effect=lambda _state: calls.append("down") or True), \
             mock.patch.object(local_demo, "up", side_effect=lambda fresh: calls.append(("up", fresh))), \
             mock.patch.object(local_demo, "recording_shop_reset", side_effect=lambda: calls.append("shop-reset")), \
             mock.patch.object(local_demo, "verify_recording_stage", side_effect=lambda: calls.append("readback")):
            local_demo.stage_recording(True)
        self.assertEqual(calls, ["down", ("up", True), "shop-reset", "readback"])

    def test_stage_refuses_reset_when_launcher_cannot_verify_stop(self):
        state = local_demo.RUNTIME / "state.json"
        self.source(state, json.dumps({"version": 1, "children": {}}))
        with mock.patch.object(local_demo, "STATE", state), \
             mock.patch.object(local_demo, "recording_stage_issues", return_value=[]), \
             mock.patch.object(local_demo, "down", return_value=False), \
             mock.patch.object(local_demo, "up") as fresh_up:
            with self.assertRaisesRegex(RuntimeError, "could not be stopped safely"):
                local_demo.stage_recording(True)
            fresh_up.assert_not_called()


    def test_unknown_status_and_missing_core_field_fail_closed(self):
        self.populate(False)
        raw = json.loads(local_demo.GATEWAY_STATE.read_text())
        for payload in (
            {**raw["payload"], "payments": [{"status": "paying"}]},
            {key: value for key, value in raw["payload"].items() if key != "payments"},
        ):
            digest = hashlib.sha256(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
            self.source(local_demo.GATEWAY_STATE, json.dumps({"version": 1, "payload": payload, "sha256": digest}))
            with self.assertRaises(RuntimeError):
                local_demo.fresh_reset_journal()
        self.assertFalse(local_demo.FRESH_RESET.exists())

    def test_reset_writer_lock_excludes_gateway_and_releases(self):
        self.populate(False)
        owned = local_demo.acquire_reset_writer_lock()
        try:
            with self.assertRaisesRegex(RuntimeError, "writer lock"):
                local_demo.acquire_reset_writer_lock()
            local_demo.fresh_reset_journal(owns_writer_lock=True)
        finally:
            local_demo.release_reset_writer_lock(owned)
        self.assertFalse(owned[0].exists())

    def test_migrated_and_legacy_inputs_archive_then_resume_forward(self):
        for migrated in (False, True):
            with self.subTest(migrated=migrated):
                self.populate(migrated)
                journal = local_demo.fresh_reset_journal()
                self.assertEqual(journal["phase"], "prepared")
                self.assertEqual(local_demo.FRESH_RESET.stat().st_mode & 0o077, 0)
                archive = local_demo.archive_fresh_inputs(journal)
                self.assertEqual(journal["phase"], "archived")
                self.assertEqual(len(list(archive.iterdir())), 6)
                self.assertFalse(local_demo.ADDRESSES.exists())
                self.assertFalse(local_demo.SHOP_STATE.exists())
                self.source(local_demo.ADDRESSES, json.dumps({"agentWallet": address("e")}))
                resumed = local_demo.fresh_reset_journal()
                self.assertEqual(resumed["phase"], "archived")
                self.assertEqual(local_demo.archive_fresh_inputs(resumed), archive)
                self.assertEqual(json.loads((archive / "addresses").read_text())["agentWallet"], address("d"))
                local_demo.ADDRESSES.unlink()
                local_demo.FRESH_RESET.unlink()

    def test_interrupted_archive_resumes_and_corruption_fails_closed(self):
        self.populate(True)
        journal = local_demo.fresh_reset_journal()
        archive = local_demo.RUNTIME / "fresh-reset-archives" / journal["id"]
        archive.mkdir(mode=0o700, parents=True)
        local_demo.ADDRESSES.replace(archive / "addresses")
        recovered = local_demo.fresh_reset_journal()
        local_demo.archive_fresh_inputs(recovered)
        self.assertEqual(recovered["phase"], "archived")
        (archive / "addresses").write_text("tampered")
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            local_demo.archive_fresh_inputs(local_demo.fresh_reset_journal())

    def test_changed_prepared_source_fails_without_overwriting_archive(self):
        self.populate(False)
        journal = local_demo.fresh_reset_journal()
        self.source(local_demo.SHOP_STATE, "changed")
        with self.assertRaisesRegex(RuntimeError, "changed or disappeared"):
            local_demo.archive_fresh_inputs(journal)
        self.assertTrue(local_demo.FRESH_RESET.is_file())

    def test_orphan_pending_manifest_blocks_new_reset(self):
        self.populate(False)
        self.source(local_demo.FRESH_PENDING, "orphan")
        with self.assertRaisesRegex(RuntimeError, "Orphan pending"):
            local_demo.fresh_reset_journal()
        self.assertFalse(local_demo.FRESH_RESET.exists())


class TreasurerSimulationTests(unittest.TestCase):
    def test_renewal_and_poisoned_topup_are_display_only_owner_files(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            runtime.chmod(0o700)
            first = treasurer_simulation.events("renewal", 4900, "2026-10-20T00:00:00Z")
            second = treasurer_simulation.events("poisoned-topup", None, "2026-10-20T00:00:01Z")
            self.assertEqual([item["scene"] for item in first + second], [
                "treasurer_renewal_reserved", "treasurer_renewal_paid", "treasurer_topup_blocked",
            ])
            treasurer_simulation.append_events(runtime, first + second)
            path = runtime / "console-simulation.jsonl"
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual([json.loads(line) for line in path.read_text().splitlines()], first + second)
            self.assertEqual(second[0]["amount_fen"], 200000)
            with self.assertRaises(ValueError):
                treasurer_simulation.events("renewal", None, "2026-10-20T00:00:00Z")
            with self.assertRaises(ValueError):
                treasurer_simulation.events("poisoned-topup", 1, "2026-10-20T00:00:00Z")

    def test_simulation_rejects_symlink_target(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            runtime.chmod(0o700)
            target = runtime / "target"
            target.write_text("unchanged")
            (runtime / "console-simulation.jsonl").symlink_to(target)
            with self.assertRaises(OSError):
                treasurer_simulation.append_events(runtime, treasurer_simulation.events("poisoned-topup", None, "2026-10-20T00:00:00Z"))
            self.assertEqual(target.read_text(), "unchanged")


class FreshLauncherFlowTests(FreshResetJournalTests):
    def test_fresh_gateway_start_failure_then_forward_resume(self):
        for migrated in (False, True):
            with self.subTest(migrated=migrated):
                self.populate(migrated)
                root = Path(self.temp.name)
                (root / "onchain/node_modules/solc").mkdir(parents=True, exist_ok=True)
                fixture_state = local_demo.RUNTIME / "state.json"
                fixture_addresses = local_demo.ADDRESSES
                fixture_archive_root = local_demo.RUNTIME / "fresh-reset-archives"
                guardian_config = local_demo.RUNTIME / "guardian-hermes.env"
                guardian_config.write_text(
                    "WEBANK_GUARDIAN_HERMES_URL=http://127.0.0.1:8643\n"
                    f"WEBANK_GUARDIAN_HERMES_KEY={'b' * 64}\n"
                    "WEBANK_GUARDIAN_HERMES_PROFILE_VERIFIED=1\n"
                )
                guardian_config.chmod(0o600)
                chain = root / "chain"
                shop = root / "shop"
                app = root / "app"
                chain.mkdir(exist_ok=True)
                shop.mkdir(exist_ok=True)
                app.mkdir(exist_ok=True)
                for name in ("fisco-bcos-v3.17.1-macOS-arm.tar.gz", "build_chain.sh", "home/.fisco/tassl-1.1.1b", "home/.fisco/get_account.sh"):
                    path = chain / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.touch()
                (chain / "nodes").mkdir(exist_ok=True)
                for path in (shop / "node_modules/next/dist/bin/next", app / "node_modules/expo/bin/cli"):
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.touch()
                proof = DeploymentFundingProofTests()
                proof.setUp()
                fresh = proof.fresh()
                fresh["agentWallet"] = address("7")
                proof.receipts[tx("2")]["contractAddress"] = address("7")
                proof.receipts[tx("4")]["logs"][0]["topics"][1] = "0x" + ("7" * 40).rjust(64, "0")
                verify_funding = local_demo.verify_deployment_funding
                started = {"chain": False, "attempt": 0, "child_envs": {}}

                def fake_chain_pids():
                    return {f"node{i}": i + 1 for i in range(4)} if started["chain"] else {}

                def fake_run(*_args, **_kwargs):
                    started["chain"] = True
                    if not local_demo.ADDRESSES.exists():
                        self.source(local_demo.ADDRESSES, json.dumps(fresh))
                    return type("Result", (), {"returncode": 0})()

                def fake_down(_state):
                    started["chain"] = False
                    local_demo.STATE.unlink(missing_ok=True)
                    return True

                def fake_start(name, _command, _cwd, child_env, state):
                    started["child_envs"][name] = child_env.copy()
                    state["children"][name] = {"pid": 1, "started": "fixture"}
                    local_demo.write_state(state)
                    return object()

                def fake_ready(name, *_args, **_kwargs):
                    if name == "gateway" and started["attempt"] == 0:
                        raise RuntimeError("simulated Gateway startup failure")

                patches = [
                    mock.patch.object(local_demo, "ROOT", root),
                    mock.patch.object(local_demo, "CHAIN", chain),
                    mock.patch.object(local_demo, "SHOP", shop),
                    mock.patch.object(local_demo, "APP", app),
                    mock.patch.object(local_demo, "STATE", local_demo.RUNTIME / "state.json"),
                    mock.patch.object(local_demo, "TOKEN", local_demo.RUNTIME / "app-login-token"),
                    mock.patch.object(local_demo, "SHOP_OPERATOR_TOKEN", local_demo.RUNTIME / "shop-operator-token"),
                    mock.patch.object(local_demo, "FUNDING_CUTOVER", local_demo.RUNTIME / "funding-cutover.json"),
                    mock.patch.object(local_demo, "FUNDING_STAGE", chain / "funding-stage.json"),
                    mock.patch.object(local_demo, "SHOP_KEYS", shop / "merchant-keys.json"),
                    mock.patch.object(local_demo, "prepare_builds", lambda: None),
                    mock.patch.object(local_demo, "deployment_source_fingerprint", lambda: "a" * 64),
                    mock.patch.object(local_demo, "port_busy", lambda _port: False),
                    mock.patch.object(local_demo, "chain_pids", fake_chain_pids),
                    mock.patch.object(local_demo.subprocess, "run", fake_run),
                    mock.patch.object(local_demo, "down", fake_down),
                    mock.patch.object(local_demo, "start", fake_start),
                    mock.patch.object(local_demo, "wait_ready", fake_ready),
                    mock.patch.object(local_demo, "read_gateway_env", lambda: {}),
                    mock.patch.dict(os.environ, {
                        "WEBANK_GUARDIAN_HERMES_KEY": "ambient-should-not-leak",
                        "WEBANK_GUARDIAN_HERMES_URL": "http://127.0.0.1:9999",
                    }),
                    mock.patch.object(local_demo, "request", lambda *_args, **_kwargs: (200, b'{"result":"0x4ee8"}')),
                    mock.patch.object(local_demo, "verify_deployment_funding", lambda addresses, staged=None: verify_funding(addresses, staged, proof.receipts.get)),
                ]
                for patcher in patches:
                    patcher.start()
                try:
                    with self.assertRaisesRegex(RuntimeError, "simulated Gateway startup failure"):
                        local_demo.up(True)
                    self.assertTrue(local_demo.FRESH_RESET.is_file())
                    self.assertFalse(local_demo.STATE.exists())
                    self.assertEqual(json.loads(local_demo.ADDRESSES.read_text())["agentWallet"], fresh["agentWallet"])
                    self.assertFalse(local_demo.SHOP_STATE.exists())
                    with self.assertRaisesRegex(RuntimeError, "Fresh reset is incomplete"):
                        local_demo.up(False)
                    started["attempt"] = 1
                    local_demo.up(True)
                    self.assertEqual(
                        started["child_envs"]["gateway"]["WEBANK_GUARDIAN_HERMES_KEY"],
                        "b" * 64,
                    )
                    self.assertEqual(
                        started["child_envs"]["gateway"]["WEBANK_GUARDIAN_HERMES_PROFILE_VERIFIED"],
                        "1",
                    )
                    for role in ("shop", "app"):
                        self.assertFalse(
                            any(name.startswith("WEBANK_GUARDIAN_HERMES_") for name in started["child_envs"][role])
                        )
                    self.assertFalse(local_demo.FRESH_RESET.exists())
                    self.assertTrue(local_demo.STATE.exists())
                    archives = list((local_demo.RUNTIME / "fresh-reset-archives").iterdir())
                    self.assertEqual(len(archives), 1)
                    self.assertEqual((archives[0] / "shop-state").read_text(), "shop orders")
                finally:
                    for patcher in reversed(patches):
                        patcher.stop()
                    fixture_state.unlink(missing_ok=True)
                    fixture_addresses.unlink(missing_ok=True)
                    local_demo.FRESH_RESET.unlink(missing_ok=True)
                    guardian_config.unlink(missing_ok=True)
                    for archive in fixture_archive_root.glob("*"):
                        import shutil
                        shutil.rmtree(archive)


class PendingFreshDeploymentTests(DeploymentFundingProofTests):
    def test_completed_deploy_output_resumes_after_interruption(self):
        fresh = self.fresh()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            active = root / "addresses.json"
            pending = root / "fresh-deployment-pending.json"
            journal = root / "fresh-reset.json"
            journal.write_text(json.dumps({"version": 1, "phase": "archived", "sourceFingerprint": "2" * 64, "priorAgentWallet": address("9")}))
            journal.chmod(0o600)
            attempts = []

            def fake_deploy(*_args, **_kwargs):
                attempts.append(1)
                pending.write_text(json.dumps({key: value for key, value in fresh.items() if key != "deploymentFingerprint"}))
                pending.chmod(0o600)
                raise RuntimeError("interrupted after deploy output")

            verifier = types.SimpleNamespace(
                NATIVE_FUNDED_TXS=local_demo.NATIVE_FUNDED_TXS,
                verify_deployment_funding=lambda addresses: local_demo.verify_deployment_funding(addresses, None, self.receipts.get),
            )
            loader = types.SimpleNamespace(exec_module=lambda _module: None)
            fake_spec = types.SimpleNamespace(loader=loader)
            patches = [
                mock.patch.object(chain_manage, "ADDRESSES", active),
                mock.patch.object(chain_manage, "PENDING_FRESH", pending),
                mock.patch.object(chain_manage, "FRESH_RESET", journal),
                mock.patch.object(chain_manage, "deployment_fingerprint", lambda: "2" * 64),
                mock.patch.object(chain_manage.subprocess, "run", fake_deploy),
                mock.patch.object(chain_manage.subprocess, "check_output", lambda *_args, **_kwargs: address("a")),
                mock.patch.object(chain_manage.importlib.util, "spec_from_file_location", lambda *_args, **_kwargs: fake_spec),
                mock.patch.object(chain_manage.importlib.util, "module_from_spec", lambda _spec: verifier),
            ]
            for patcher in patches:
                patcher.start()
            try:
                with self.assertRaisesRegex(RuntimeError, "interrupted after deploy output"):
                    chain_manage.deploy_and_seed("ignored fixture key", address("b"), None)
                self.assertFalse(active.exists())
                self.assertTrue(pending.exists())
                valid_pending = pending.read_text()
                malformed = json.loads(valid_pending)
                malformed["txHashes"].pop("openingMint")
                pending.write_text(json.dumps(malformed))
                with self.assertRaisesRegex(RuntimeError, "native funded transaction evidence"):
                    chain_manage.deploy_and_seed("ignored fixture key", address("b"), None)
                self.assertFalse(active.exists())
                pending.write_text(valid_pending)
                chain_manage.deploy_and_seed("ignored fixture key", address("b"), None)
                self.assertEqual(len(attempts), 1)
                self.assertFalse(pending.exists())
                self.assertEqual(json.loads(active.read_text()), fresh)
                self.assertEqual(active.stat().st_mode & 0o077, 0)
            finally:
                for patcher in reversed(patches):
                    patcher.stop()


if __name__ == "__main__":
    unittest.main()
