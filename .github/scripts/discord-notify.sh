#!/usr/bin/env bash
set -euo pipefail

site="https://herobrinetv.github.io/SpE-ItemDisplay-Releases/"

case "$EVENT" in
  voting-started)
    [[ "$VOTING_ID" =~ ^[0-9]+$ ]] || { echo "Invalid voting id"; exit 1; }
    text="A new Challenge Voting has been started"
    link="${site}?voting=${VOTING_ID}"
    ;;
  day-poll-started)
    [[ "$POLL_ID" =~ ^[0-9]+$ ]] || { echo "Invalid poll id"; exit 1; }
    [[ "$POLL_DATE" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})$ ]] || { echo "Invalid date"; exit 1; }
    text="A new Day Voting has been started for ${BASH_REMATCH[3]}.${BASH_REMATCH[2]}.${BASH_REMATCH[1]}"
    link="${site}?poll=${POLL_ID}"
    ;;
  *)
    echo "Unknown event $EVENT"
    exit 1
    ;;
esac

jq -n --arg text "$text" --arg link "$link" \
  '{content: ("@everyone " + $text + "\n" + $link), allowed_mentions: {parse: ["everyone"]}}' \
  | if [[ "${DRY_RUN:-}" == "1" ]]; then cat; else curl -fsS -H "Content-Type: application/json" -d @- "$DISCORD_WEBHOOK_URL"; fi
