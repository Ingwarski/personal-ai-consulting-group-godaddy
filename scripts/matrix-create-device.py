#!/usr/bin/env python3
"""Manual macOS credential handoff; never a local Matrix production runtime.

Run only after the fresh-store preflight succeeds. This performs one password
login for a NEW device, copies its configuration to the macOS clipboard, and
never saves or prints passwords, access tokens, or store passphrases.
"""

import argparse
import getpass
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import ssl
import stat
import subprocess
import sys
import time
import warnings
from dataclasses import dataclass


SHA256 = re.compile(r"[a-f0-9]{64}\Z")
COMMIT = re.compile(r"[a-f0-9]{40}\Z")
MXID = re.compile(r"@[A-Za-z0-9._=+\-/]+:matrix\.org\Z")
ROOM_ID = re.compile(r"![^:\s]{1,220}:matrix\.org\Z")
PRINTABLE = re.compile(r"[\x21-\x7e]+\Z")
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 32 * 1024
MAX_CLIPBOARD_BYTES = 32 * 1024
HOST = "matrix.org"
CONFIRMATION = "CREATE NEW DEVICE"
SIDECAR = "personal-consultant-matrix-sidecar"


class HandoffError(Exception):
    """Messages are static, safe operator guidance; never underlying errors."""


@dataclass(frozen=True, repr=False)
class NewDevice:
    user_id: str
    device_id: str
    access_token: str


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bot-id", required=True)
    parser.add_argument("--owner-id", required=True)
    parser.add_argument("--room-id", required=True)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--store-backend", choices=("sqlite", "mysql"), default="sqlite")
    parser.add_argument("--setup-mode-already-configured", action="store_true",
                        help="Omit MATRIX_SETUP_MODE when Published already has provision; preserve its existing row.")
    return parser.parse_args(argv)


def validate_identity(bot_id, owner_id, room_id):
    if (not MXID.fullmatch(bot_id) or not MXID.fullmatch(owner_id)
            or bot_id == owner_id or not ROOM_ID.fullmatch(room_id)
            or any(len(value.encode("utf-8")) > 255 for value in (bot_id, owner_id, room_id))):
        raise HandoffError("Use distinct bot/owner Matrix.org IDs and the existing Matrix.org room ID.")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def verified_sidecar_hash(manifest_path, expected_sha256):
    """Read one bounded regular manifest and verify the external pin first."""
    if not SHA256.fullmatch(expected_sha256):
        raise HandoffError("The expected release manifest SHA-256 is invalid. No login was attempted.")
    descriptor = None
    try:
        descriptor = os.open(manifest_path, os.O_RDONLY | os.O_NOFOLLOW)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_MANIFEST_BYTES:
            raise ValueError("invalid manifest file")
        chunks = []
        remaining = MAX_MANIFEST_BYTES + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(remaining, 64 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        after = os.fstat(descriptor)
        if (len(data) != before.st_size or (before.st_dev, before.st_ino, before.st_size,
                before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino,
                after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
            raise ValueError("manifest changed")
        if not secrets.compare_digest(hashlib.sha256(data).hexdigest(), expected_sha256):
            raise ValueError("manifest pin mismatch")
        manifest = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object)
        if not isinstance(manifest, dict):
            raise ValueError("manifest object required")
        builder = manifest.get("builder")
        artifacts = manifest.get("artifacts")
        if (type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != 1
                or manifest.get("kind") != "matrix-production-release"
                or type(manifest.get("protocolVersion")) is not int or manifest["protocolVersion"] != 1
                or manifest.get("sidecarVersion") != "0.1.0"
                or not isinstance(manifest.get("sourceCommit"), str)
                or not COMMIT.fullmatch(manifest["sourceCommit"])
                or not isinstance(builder, dict)
                or builder.get("target") != "x86_64-unknown-linux-musl"
                or builder.get("platform") != "linux/amd64"
                or builder.get("rustToolchain") != "1.93.0-x86_64-unknown-linux-musl"
                or not isinstance(builder.get("image"), str)
                or not re.search(r"@sha256:[a-f0-9]{64}\Z", builder["image"])
                or not isinstance(builder.get("imageConfigDigest"), str)
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", builder["imageConfigDigest"])
                or not isinstance(artifacts, list) or not 3 <= len(artifacts) <= 64):
            raise ValueError("wrong release kind or builder")
        names = set()
        sidecar = None
        setup_present = False
        evidence_present = False
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                raise ValueError("invalid artifact")
            name = artifact.get("path")
            checksum = artifact.get("sha256")
            size = artifact.get("sizeBytes")
            if (not isinstance(name, str) or name in names
                    or not re.fullmatch(r"[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*", name)
                    or any(part in (".", "..") for part in name.split("/"))
                    or not isinstance(checksum, str) or not SHA256.fullmatch(checksum)
                    or type(size) is not int or not 0 < size <= 256 * 1024 * 1024):
                raise ValueError("invalid artifact metadata")
            names.add(name)
            if artifact.get("role") == "sidecar" and name == SIDECAR:
                sidecar = checksum
            elif artifact.get("role") == "setup" and name == "personal-consultant-matrix-setup":
                setup_present = True
            elif artifact.get("role") == "evidence" and name not in (SIDECAR, "personal-consultant-matrix-setup"):
                evidence_present = True
            else:
                raise ValueError("invalid artifact role")
        if sidecar is None or not setup_present or not evidence_present:
            raise ValueError("incomplete release")
        return sidecar
    except (OSError, ValueError, TypeError, KeyError):
        raise HandoffError("The pinned production release manifest could not be verified. No login was attempted.") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def create_device(bot_id, password, connection_factory=None):
    """One fixed-host HTTPS request; http.client uses neither proxies nor redirects."""
    if not isinstance(password, str) or not password or len(password.encode("utf-8")) > 4096:
        raise HandoffError("An existing bot password is required. No login was attempted.")
    factory = connection_factory or http.client.HTTPSConnection
    connection = None
    try:
        connection = factory(HOST, timeout=20, context=ssl.create_default_context())
        body = json.dumps({
            "type": "m.login.password",
            "identifier": {"type": "m.id.user", "user": bot_id},
            "password": password,
            "initial_device_display_name": "Personal AI Consulting Group GoDaddy Rust",
            # device_id is intentionally OMITTED: never reuse the verified Safari session.
        }, ensure_ascii=True).encode("utf-8")
        connection.request("POST", "/_matrix/client/v3/login", body=body,
                           headers={"Content-Type": "application/json", "Accept": "application/json"})
        response = connection.getresponse()
        data = response.read(MAX_RESPONSE_BYTES + 1)
        if response.status != 200:
            if response.status >= 500 or 200 <= response.status < 300:
                raise ValueError("uncertain login response")
            raise HandoffError("Matrix did not accept the single login request. No redirect or retry was performed.")
        if len(data) > MAX_RESPONSE_BYTES:
            raise ValueError("oversized response")
        payload = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object)
        if not isinstance(payload, dict):
            raise ValueError("invalid response")
        device_id = payload.get("device_id")
        token = payload.get("access_token")
        if (payload.get("user_id") != bot_id or not isinstance(device_id, str)
                or not 1 <= len(device_id) <= 255 or not PRINTABLE.fullmatch(device_id)
                or not isinstance(token, str) or not 1 <= len(token) <= 4096
                or not PRINTABLE.fullmatch(token)):
            raise ValueError("invalid returned device")
        return NewDevice(bot_id, device_id, token)
    except HandoffError:
        raise
    except Exception:
        raise HandoffError("The login outcome is uncertain: a new bot session may already exist. No retry was made. Do not rerun until the session state is checked.") from None
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass


def dotenv_group(args, sidecar_sha256, device):
    values = {
        "MATRIX_SIDECAR_PATH": f"/app/runtime/matrix/{SIDECAR}",
        "MATRIX_SIDECAR_SHA256": sidecar_sha256,
        "MATRIX_PROTOCOL_VERSION": "1",
        "MATRIX_STORE_DIR": "/app/public/assets/.personal-consultant-matrix-v1/crypto-store",
        "MATRIX_STORE_PASSPHRASE": secrets.token_hex(32),
        "MATRIX_MEDIA_SPOOL_DIR": "/app/public/assets/.personal-consultant-matrix-v1/media-spool",
        "MATRIX_HOMESERVER_URL": "https://matrix.org",
        "MATRIX_ALLOWED_HTTPS_ORIGINS": "https://matrix.org",
        "MATRIX_BOT_MXID": device.user_id,
        "MATRIX_BOT_DEVICE_ID": device.device_id,
        "MATRIX_ACCESS_TOKEN": device.access_token,
        "MATRIX_ROOM_ID": args.room_id,
        "MATRIX_OWNER_MXID": args.owner_id,
        "MATRIX_SETUP_MODE": "provision",
    }
    if args.setup_mode_already_configured:
        del values["MATRIX_SETUP_MODE"]
    if args.store_backend == "mysql":
        values["MATRIX_STORE_BACKEND"] = "mysql"
        del values["MATRIX_STORE_DIR"]
        del values["MATRIX_MEDIA_SPOOL_DIR"]
    # Quote every value so numbers and special token characters stay strings in the importer.
    return ("\n".join(f"{key}={json.dumps(value, ensure_ascii=True)}" for key, value in values.items()) + "\n").encode("utf-8")


class MacClipboard:
    def require_available(self):
        if not all(os.access(path, os.X_OK) for path in ("/usr/bin/pbcopy", "/usr/bin/pbpaste")):
            raise HandoffError("macOS clipboard tools are unavailable. No login was attempted.")

    def copy(self, value):
        subprocess.run(["/usr/bin/pbcopy"], input=value, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=5, check=True)

    def matches(self, expected):
        process = subprocess.Popen(["/usr/bin/pbpaste"], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            chunks = []
            size = 0
            deadline = time.monotonic() + 5
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise TimeoutError("clipboard read timeout")
                    chunk = os.read(process.stdout.fileno(), min(4096, MAX_CLIPBOARD_BYTES + 1 - size))
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_CLIPBOARD_BYTES:
                        return False
                    chunks.append(chunk)
            if process.wait(timeout=1) != 0:
                raise OSError("clipboard read failed")
            return secrets.compare_digest(b"".join(chunks), expected)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=2)
            if process.stdout is not None:
                process.stdout.close()


def main(argv=None, *, input_fn=input, password_fn=getpass.getpass, login_fn=create_device,
         clipboard=None, output=print, platform=None):
    args = arguments(argv)
    clipboard = clipboard if clipboard is not None else MacClipboard()
    copied = False
    payload = None
    try:
        validate_identity(args.bot_id, args.owner_id, args.room_id)
        sidecar_sha256 = verified_sidecar_hash(args.manifest, args.manifest_sha256)
        if (sys.platform if platform is None else platform) != "darwin":
            raise HandoffError("This handoff requires macOS. No login was attempted.")
        clipboard.require_available()
        output("This creates ONE NEW, separate bot session for GoDaddy. Your existing verified Safari session stays intact.")
        if args.store_backend == "mysql":
            output("Use only for explicit fresh MySQL setup. Existing device namespaces and published encryption keys will not be overwritten.")
        else:
            output("Use this only after the EMPTY fresh-store and private-URL preflight succeeded. Do not use it to restore or replace an existing crypto store.")
        output("Do not run it twice. Clipboard history/universal clipboard may retain copied secrets; disable them before proceeding.")
        if args.setup_mode_already_configured:
            output("The import will preserve the existing MATRIX_SETUP_MODE=provision row; it will not add a duplicate.")
        if input_fn(f"Type {CONFIRMATION} to continue: ") != CONFIRMATION:
            output("Cancelled. No login was attempted.")
            return 1
        # getpass must not fall back to echoing input when a secure terminal is unavailable.
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            password = password_fn("Existing Matrix bot password (hidden): ")
        try:
            device = login_fn(args.bot_id, password)
        finally:
            password = None
        payload = dotenv_group(args, sidecar_sha256, device)
        device = None
        try:
            # Even a failed clipboard subprocess may have partially completed its write.
            # Conditional cleanup remains safe because it compares the exact payload.
            copied = True
            clipboard.copy(payload)
        except Exception:
            raise HandoffError("A new bot session was created, but clipboard handoff failed. No retry was made. Do not rerun until the session state is checked.") from None
        output("The complete Matrix secret group is on your clipboard; it was not printed or saved to a file.")
        output("Paste it into this app's GoDaddy Published Secrets using the .env paste option, then save. Do not paste into Preview or chat.")
        input_fn("After GoDaddy has saved the group, press Enter to clear this helper's clipboard payload: ")
        return 0
    except HandoffError as error:
        output(str(error))
        return 1
    except (KeyboardInterrupt, EOFError):
        output("Interrupted. No automatic retry was made; check the bot session before rerunning if login had started.")
        return 130
    except Exception:
        output("The handoff stopped safely. No automatic retry was made; check the bot session before rerunning if login had started.")
        return 1
    finally:
        if copied and payload is not None:
            try:
                if clipboard.matches(payload):
                    clipboard.copy(b"")
                    output("This helper's clipboard payload was cleared.")
                else:
                    output("The clipboard has changed; its current contents were left untouched.")
            except Exception:
                output("Clipboard cleanup could not be confirmed. Clear it manually after saving the GoDaddy secrets.")
        payload = None


if __name__ == "__main__":
    raise SystemExit(main())
