#!/usr/bin/env bash
# Export a YouTube cookie jar for the rented box.
#
#   ./export_cookies.sh              # auto-detect the newest Chrome profile
#   ./export_cookies.sh "Profile 33" # or name it explicitly
#
# WHY A SEPARATE PROFILE: a YouTube cookie is account-wide Google access,
# and the jar this writes is going onto someone else's hardware. It must
# come from a throwaway account, which means a Chrome profile that is not
# the one you actually use. This script defaults to the most recently
# touched profile precisely because that is the one you just created and
# logged into.
#
# It prints the account it found so you can CHECK before shipping it.
set -euo pipefail
cd "$(dirname "$0")"
CHROME="$HOME/Library/Application Support/Google/Chrome"

if [ $# -ge 1 ]; then
  PROFILE="$1"
else
  PROFILE=$(ls -dt "$CHROME"/Profile\ * "$CHROME"/Default 2>/dev/null | head -1)
  PROFILE=$(basename "$PROFILE")
  echo "auto-detected most recently used profile: $PROFILE"
fi

NAME=$(python3 - "$CHROME/$PROFILE/Preferences" <<'PY'
import json, sys
try:
    p = json.load(open(sys.argv[1]))
    prof = p.get("profile", {})
    accounts = p.get("account_info", [{}])
    print(f'{prof.get("name","(unnamed)")}  |  {accounts[0].get("email","(not signed in)")}')
except Exception:
    print("(could not read)")
PY
)
echo "profile   : $NAME"

yt-dlp --cookies-from-browser "chrome:$PROFILE" --cookies cookies.txt \
       --simulate --skip-download --quiet \
       "https://www.youtube.com/watch?v=mP9-MWwcFhc" || {
  echo "export failed — is Chrome closed? is that profile signed in?"; exit 1; }

chmod 600 cookies.txt
echo "wrote    : $(pwd)/cookies.txt  ($(grep -c youtube.com cookies.txt) youtube cookies)"
echo
echo "CHECK THE EMAIL ABOVE. If it is your real account, delete cookies.txt"
echo "and rerun against the throwaway profile — this file is going to a"
echo "rented machine."
