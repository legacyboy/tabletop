#!/usr/bin/env bash
#
# Interactive tabletop player via the HTTP API (curl).
#
# Usage:
#   bash scripts/play-tabletop.sh [base_url] [model]
#
#   base_url  default http://localhost:11434/v1 (local Ollama)
#   model     default gemma3:4b
#
# Requires the API server running:  npm start
#
# You play the executive team. Type any action, then enter a D20 roll (1-20).
# The DM (LLM) adjudicates and updates state. Ends on an end condition or
# timeout, then prints the closing report.
set -euo pipefail

API="${1:-http://localhost:8000}"
BASE_URL="${2:-http://localhost:11434/v1}"
MODEL="${3:-gemma3:4b}"

echo "== Executive Tabletop D20 (curl player) =="
echo "API: $API | DM: $MODEL @ $BASE_URL"
echo ""

# Pick a scenario
echo "Available scenarios:"
curl -s "$API/api/scenarios" | python3 -c "import sys,json; [print('  ', s['id'], '-', s['title']) for s in json.load(sys.stdin)['scenarios']]"
echo ""
read -rp "Scenario id [bramble_badger_deepfake]: " SCEN
SCEN="${SCEN:-bramble_badger_deepfake}"

# Create session
echo ""
echo "Creating session..."
SESS=$(curl -s -X POST "$API/api/session" -H 'Content-Type: application/json' \
  -d "{\"scenario_id\":\"$SCEN\",\"base_url\":\"$BASE_URL\",\"model\":\"$MODEL\"}")
SID=$(echo "$SESS" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Session: $SID"
echo ""

# Show intro
curl -s "$API/api/scenarios/$SCEN" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('=== ' + d['title'] + ' ===')
print(d['intro']['narrative'])
print()
print('Opening state:', d['opening_state'])
"
echo ""

# Play loop
while true; do
  echo "----------------------------------------"
  read -rp "What does the group do? (or 'report' / 'quit'): " ACTION
  if [ "$ACTION" = "quit" ]; then echo "Bye."; exit 0; fi
  if [ "$ACTION" = "report" ]; then
    curl -s "$API/api/session/$SID/report" | python3 -m json.tool
    exit 0
  fi
  read -rp "D20 roll (1-20): " ROLL
  echo ""
  echo "DM is considering..."
  RES=$(curl -s -X POST "$API/api/session/$SID/turn" -H 'Content-Type: application/json' \
    -d "{\"action\":\"$ACTION\",\"roll\":$ROLL}")
  echo "$RES" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if 'error' in d:
    print('ERROR:', d['error']); sys.exit(0)
print()
print('--- DM (roll ' + str(d['roll']) + ') ---')
print(d['narrative'])
if d.get('fate'): print('[FATE]', d['fate'])
print()
print('State:', d['state'])
if d.get('end_condition'):
    print()
    print('*** END:', d['end_condition'], '***')
    print('Fetching report...')
"
  # If ended, print report and exit
  if echo "$RES" | grep -q '"ended": true'; then
    curl -s "$API/api/session/$SID/report" | python3 -m json.tool
    exit 0
  fi
  echo ""
done
