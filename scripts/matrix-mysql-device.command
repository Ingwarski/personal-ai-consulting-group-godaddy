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
  --manifest-sha256 025366d7ac8c5e081bdbc973ceb387d77d6f2f2e77ce2138276180046c2a83a5
