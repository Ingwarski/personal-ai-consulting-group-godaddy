#!/bin/bash
set -euo pipefail
task_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
read -r -p 'Matrix BOT ID (@name:matrix.org): ' task_bot
read -r -p 'Matrix OWNER ID (@name:matrix.org): ' task_owner
read -r -p 'Existing room ID (!identifier:matrix.org): ' task_room
exec python3 "$task_script_dir/matrix-create-device.py" \
  --bot-id "$task_bot" --owner-id "$task_owner" --room-id "$task_room" \
  --store-backend mysql \
  --manifest "$task_script_dir/../runtime-release/matrix/release-manifest.json" \
  --manifest-sha256 81dd73e672ccfc65c3dd3e5e86d1c7939d2c3f5a67a26d1d863cfe5ac878c8f1
