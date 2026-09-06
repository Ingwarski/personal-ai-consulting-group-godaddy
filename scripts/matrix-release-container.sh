#!/bin/sh
# Runs only inside the digest-pinned release image. No credentials are passed in.
set -eu
cd /source
test "$(rustc --version | cut -d ' ' -f 2)" = "1.93.0"
test "$(rustc -vV | sed -n 's/^host: //p')" = "x86_64-unknown-linux-musl"
test -r /test/fixtures/matrix-invalid-media.json
case "${1:-}" in
  fetch)
    # The only network-enabled phase. Cargo verifies registry checksums from Cargo.lock.
    cargo fetch --locked --target x86_64-unknown-linux-musl
    ;;
  build)
    # The caller mounts a distinct empty target directory for each build.
    cargo build --release --locked --frozen --target x86_64-unknown-linux-musl
    cargo metadata --format-version 1 --locked --frozen --filter-platform x86_64-unknown-linux-musl > /build/cargo-metadata.json
    rustc -vV > /build/rustc.txt
    cc --version > /build/cc.txt
    ;;
  test)
    cargo test --locked --frozen --all-targets --target x86_64-unknown-linux-musl
    ;;
  *)
    echo 'Unknown release builder phase.' >&2
    exit 2
    ;;
esac
