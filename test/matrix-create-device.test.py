"""Synthetic stdlib tests. No real network, credential prompt or clipboard access."""

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import warnings

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("matrix_create_device", Path(__file__).resolve().parents[1] / "scripts" / "matrix-create-device.py")
HELPER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = HELPER
SPEC.loader.exec_module(HELPER)

BOT = "@fixture-bot:matrix.org"
OWNER = "@fixture-owner:matrix.org"
ROOM = "!fixture:matrix.org"
PASSWORD = "synthetic-test-only-password"
TOKEN = "synthetic-test-only-token"


class Clipboard:
    def __init__(self):
        self.current = b"prior unrelated clipboard"
        self.writes = []

    def require_available(self):
        pass

    def copy(self, value):
        self.current = value
        self.writes.append(value)

    def matches(self, expected):
        return self.current == expected


class Response:
    status = 200

    def __init__(self, body=None, status=200):
        self.status = status
        self.body = json.dumps({"user_id": BOT, "device_id": "NEW_DEVICE", "access_token": TOKEN}).encode() if body is None else body

    def read(self, limit):
        if limit != HELPER.MAX_RESPONSE_BYTES + 1:
            raise AssertionError("bounded HTTP read required")
        return self.body[:limit]


class Connection:
    def __init__(self, response=None, failure=False):
        self.response = Response() if response is None else response
        self.failure = failure
        self.calls = []
        self.closed = False

    def request(self, method, path, *, body, headers):
        self.calls.append((method, path, json.loads(body), headers))
        if self.failure:
            raise OSError("synthetic network detail never shown")

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="matrix-device-test-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "release-manifest.json"
        self.manifest = {
            "schemaVersion": 1, "kind": "matrix-production-release", "sourceCommit": "a" * 40,
            "sidecarVersion": "0.1.0", "protocolVersion": 1,
            "builder": {"target": "x86_64-unknown-linux-musl", "platform": "linux/amd64",
                        "rustToolchain": "1.93.0-x86_64-unknown-linux-musl",
                        "image": "fixture@sha256:" + "b" * 64, "imageConfigDigest": "sha256:" + "c" * 64},
            "artifacts": [
                {"path": HELPER.SIDECAR, "role": "sidecar", "sha256": "d" * 64, "sizeBytes": 10},
                {"path": "personal-consultant-matrix-setup", "role": "setup", "sha256": "e" * 64, "sizeBytes": 10},
                {"path": "provenance.json", "role": "evidence", "sha256": "f" * 64, "sizeBytes": 10},
            ],
        }
        self.pin = self.save_manifest()

    def save_manifest(self):
        data = json.dumps(self.manifest).encode()
        self.path.write_bytes(data)
        return hashlib.sha256(data).hexdigest()

    def argv(self, pin=None):
        return ["--bot-id", BOT, "--owner-id", OWNER, "--room-id", ROOM,
                "--manifest", str(self.path), "--manifest-sha256", pin or self.pin]

    def run_main(self, *, input_fn=None, login_fn=None, password_fn=None, clipboard=None, pin=None):
        outputs = []
        password_calls = []
        login_calls = []
        clipboard = clipboard if clipboard is not None else Clipboard()

        def password(prompt):
            password_calls.append(prompt)
            return PASSWORD

        def login(bot_id, supplied_password):
            login_calls.append((bot_id, supplied_password))
            return HELPER.NewDevice(BOT, "NEW_DEVICE", TOKEN)

        answers = iter([HELPER.CONFIRMATION, ""])
        code = HELPER.main(self.argv(pin), input_fn=input_fn or (lambda _: next(answers)),
                           password_fn=password_fn or password, login_fn=login_fn or login,
                           clipboard=clipboard, output=outputs.append, platform="darwin")
        self.assertNotIn(PASSWORD, "\n".join(outputs))
        self.assertNotIn(TOKEN, "\n".join(outputs))
        return code, outputs, password_calls, login_calls, clipboard

    def test_verifies_pinned_release(self):
        self.assertEqual(HELPER.verified_sidecar_hash(self.path, self.pin), "d" * 64)

    def test_invalid_pin_fails_before_password_or_login(self):
        code, _, passwords, logins, clipboard = self.run_main(pin="0" * 64)
        self.assertEqual(code, 1)
        self.assertEqual(passwords, [])
        self.assertEqual(logins, [])
        self.assertEqual(clipboard.writes, [])

    def test_invalid_manifest_shapes_fail_even_with_matching_hash(self):
        mutations = [
            lambda m: m.update(kind="matrix-verification-only"),
            lambda m: m.update(protocolVersion=True),
            lambda m: m["builder"].update(target="aarch64-unknown-linux-musl"),
            lambda m: m["builder"].update(image="fixture:latest"),
            lambda m: m["artifacts"][0].update(path="../escape"),
        ]
        for change in mutations:
            with self.subTest(change=mutations.index(change)):
                original = json.loads(json.dumps(self.manifest))
                change(self.manifest)
                pin = self.save_manifest()
                code, _, passwords, logins, clipboard = self.run_main(pin=pin)
                self.assertEqual(code, 1)
                self.assertEqual(passwords, [])
                self.assertEqual(logins, [])
                self.assertEqual(clipboard.writes, [])
                self.manifest = original

    def test_duplicate_json_and_symlink_manifest_rejected(self):
        data = self.path.read_bytes().replace(b'"schemaVersion": 1', b'"schemaVersion": 1, "schemaVersion": 1')
        self.path.write_bytes(data)
        with self.assertRaises(HELPER.HandoffError):
            HELPER.verified_sidecar_hash(self.path, hashlib.sha256(data).hexdigest())
        target = self.path.with_name("alias.json")
        target.symlink_to(self.path)
        with self.assertRaises(HELPER.HandoffError):
            HELPER.verified_sidecar_hash(target, self.pin)

    def test_confirmation_is_required_before_password(self):
        code, _, passwords, logins, clipboard = self.run_main(input_fn=lambda _: "no")
        self.assertEqual(code, 1)
        self.assertEqual(passwords, [])
        self.assertEqual(logins, [])
        self.assertEqual(clipboard.writes, [])

    def test_echoing_getpass_fallback_is_blocked_before_login(self):
        def insecure_fallback(_):
            warnings.warn("synthetic insecure terminal", HELPER.getpass.GetPassWarning)
            self.fail("getpass fallback must not request echoing input")
        code, _, _, logins, clipboard = self.run_main(password_fn=insecure_fallback)
        self.assertEqual(code, 1)
        self.assertEqual(logins, [])
        self.assertEqual(clipboard.writes, [])

    def test_one_password_login_omits_device_id_and_uses_fixed_host_no_redirects(self):
        connection = Connection()
        factory_calls = []

        def factory(host, *, timeout, context):
            factory_calls.append((host, timeout, context))
            return connection

        with patch.dict(HELPER.os.environ, {"HTTPS_PROXY": "https://must-not-be-used.invalid"}):
            result = HELPER.create_device(BOT, PASSWORD, factory)
        self.assertEqual(len(factory_calls), 1)
        self.assertEqual(factory_calls[0][0:2], ("matrix.org", 20))
        self.assertEqual(len(connection.calls), 1)
        method, path, body, headers = connection.calls[0]
        self.assertEqual((method, path), ("POST", "/_matrix/client/v3/login"))
        self.assertNotIn("device_id", body)
        self.assertEqual(body["type"], "m.login.password")
        self.assertEqual(body["identifier"], {"type": "m.id.user", "user": BOT})
        self.assertEqual(body["password"], PASSWORD)
        self.assertEqual(result.device_id, "NEW_DEVICE")
        self.assertTrue(connection.closed)
        self.assertNotIn(TOKEN, repr(result))

    def test_no_network_retry_and_uncertain_outcome_has_no_raw_error(self):
        connection = Connection(failure=True)
        with self.assertRaises(HELPER.HandoffError) as caught:
            HELPER.create_device(BOT, PASSWORD, lambda *_a, **_k: connection)
        self.assertEqual(len(connection.calls), 1)
        self.assertIn("may already exist", str(caught.exception))
        self.assertNotIn("synthetic network detail", str(caught.exception))
        self.assertTrue(connection.closed)

    def test_server_failures_warn_a_session_may_exist_without_retry(self):
        for status in (500, 502, 503):
            with self.subTest(status=status):
                connection = Connection(Response(body=b"synthetic private upstream detail", status=status))
                with self.assertRaises(HELPER.HandoffError) as caught:
                    HELPER.create_device(BOT, PASSWORD, lambda *_a, **_k: connection)
                self.assertIn("may already exist", str(caught.exception))
                self.assertNotIn("upstream detail", str(caught.exception))
                self.assertEqual(len(connection.calls), 1)

    def test_redirects_malformed_or_oversized_responses_are_not_followed_or_retried(self):
        responses = [Response(status=302), Response(body=b"not JSON"),
                     Response(body=b"x" * (HELPER.MAX_RESPONSE_BYTES + 1)),
                     Response(body=json.dumps({"user_id": OWNER, "device_id": "A", "access_token": TOKEN}).encode()),
                     Response(body=json.dumps({"user_id": BOT, "device_id": "A\nBAD", "access_token": TOKEN}).encode())]
        for response in responses:
            with self.subTest(response=responses.index(response)):
                connection = Connection(response)
                with self.assertRaises(HELPER.HandoffError):
                    HELPER.create_device(BOT, PASSWORD, lambda *_a, **_k: connection)
                self.assertEqual(len(connection.calls), 1)
                self.assertTrue(connection.closed)

    def test_complete_quoted_payload_goes_only_to_clipboard_and_is_cleared(self):
        code, outputs, passwords, logins, clipboard = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual(len(passwords), 1)
        self.assertEqual(len(logins), 1)
        self.assertEqual(len(clipboard.writes), 2)
        self.assertEqual(clipboard.current, b"")
        env = {key: json.loads(value) for key, value in (line.split("=", 1) for line in clipboard.writes[0].decode().splitlines())}
        self.assertEqual(len(env), 14)
        self.assertEqual(env["MATRIX_SETUP_MODE"], "provision")
        self.assertEqual(env["MATRIX_PROTOCOL_VERSION"], "1")
        self.assertEqual(env["MATRIX_SIDECAR_SHA256"], "d" * 64)
        self.assertEqual(env["MATRIX_BOT_DEVICE_ID"], "NEW_DEVICE")
        self.assertEqual(env["MATRIX_ACCESS_TOKEN"], TOKEN)
        self.assertEqual(env["MATRIX_STORE_DIR"], "/app/public/assets/.personal-consultant-matrix-v1/crypto-store")
        self.assertRegex(env["MATRIX_STORE_PASSPHRASE"], r"^[a-f0-9]{64}$")
        self.assertNotIn(env["MATRIX_STORE_PASSPHRASE"], "\n".join(outputs))
        self.assertEqual(list(Path(self.temp.name).iterdir()), [self.path])

    def test_changed_clipboard_is_preserved(self):
        clipboard = Clipboard()
        calls = 0

        def input_fn(_):
            nonlocal calls
            calls += 1
            if calls == 1:
                return HELPER.CONFIRMATION
            clipboard.current = b"unrelated newly copied content"
            return ""

        code, _, _, _, clipboard = self.run_main(input_fn=input_fn, clipboard=clipboard)
        self.assertEqual(code, 0)
        self.assertEqual(clipboard.current, b"unrelated newly copied content")
        self.assertEqual(len(clipboard.writes), 1)

    def test_interruption_after_copy_still_clears_exact_payload(self):
        calls = 0

        def input_fn(_):
            nonlocal calls
            calls += 1
            if calls == 1:
                return HELPER.CONFIRMATION
            raise KeyboardInterrupt

        code, _, _, _, clipboard = self.run_main(input_fn=input_fn)
        self.assertEqual(code, 130)
        self.assertEqual(clipboard.current, b"")

    def test_uncertain_clipboard_write_cleans_only_matching_payload(self):
        class FailedCopy(Clipboard):
            def copy(self, value):
                super().copy(value)
                if value:
                    raise OSError("synthetic clipboard subprocess error")

        code, outputs, _, logins, clipboard = self.run_main(clipboard=FailedCopy())
        self.assertEqual(code, 1)
        self.assertEqual(len(logins), 1)
        self.assertEqual(clipboard.current, b"")
        self.assertIn("A new bot session was created", "\n".join(outputs))

    def test_invalid_identity_and_non_macos_fail_before_password_or_login(self):
        with self.assertRaises(HELPER.HandoffError):
            HELPER.validate_identity(BOT, BOT, ROOM)
        with self.assertRaises(HELPER.HandoffError):
            HELPER.validate_identity("@elsewhere:example.org", OWNER, ROOM)
        calls = []
        code = HELPER.main(self.argv(), platform="linux", clipboard=Clipboard(), output=lambda _: None,
                           input_fn=lambda _: calls.append("input"), password_fn=lambda _: calls.append("password"),
                           login_fn=lambda *_: calls.append("login"))
        self.assertEqual(code, 1)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
