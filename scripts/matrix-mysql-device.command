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
  --manifest-sha256 2002cbe0af8a031c13d02024a6086401d8d6b144ff30db4c4a38cebd2216c2ec
