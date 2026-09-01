#!/usr/bin/env bash
# worklist installer.
#
# Clone this repo somewhere it can stay, then run the installer from inside the
# repo you want the worklist in:
#
#   git clone https://github.com/mehringer68/worklist.git ~/src/worklist
#   cd ~/my-repo
#   bash ~/src/worklist/install.sh
#
# Or name the target explicitly:
#
#   bash ~/src/worklist/install.sh ~/my-repo
#
# It installs two things: the skill at .claude/skills/worklist/, and the store at worklist/.
# It never overwrites an existing worklist/ store.
#
# To pick up a later version of the tool without touching your work:
#
#   git -C ~/src/worklist pull
#   bash ~/src/worklist/install.sh --update ~/my-repo
#
# --update overwrites the code (SKILL.md, worklist/bin/, worklist/README.md) and leaves the
# store alone (items/, views/, attachments/, inbox.md, config.json). Without it, an existing
# SKILL.md is never overwritten.

set -euo pipefail

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
warn() { printf '  note  %s\n' "$*"; }
die()  { printf '\nstopped: %s\n\n' "$*" >&2; exit 1; }

BUNDLE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATE=0
TARGET_ARG=""
for arg in "$@"; do
  case "$arg" in
    --update) UPDATE=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $arg" ;;
    *) TARGET_ARG="$arg" ;;
  esac
done
[ -d "${TARGET_ARG:-$PWD}" ] || die "target directory does not exist: $TARGET_ARG"
TARGET="$(cd "${TARGET_ARG:-$PWD}" && pwd)"

say ""
say "worklist installer$([ "$UPDATE" -eq 1 ] && printf ' (update mode)')"
say "  source: $BUNDLE"
say "  target: $TARGET"
say ""

# --- checks ---------------------------------------------------------------

[ "$BUNDLE" != "$TARGET" ] || die "the target is the clone itself. cd into the repo you want it in first, then re-run."
[ -f "$BUNDLE/.claude/skills/worklist/SKILL.md" ] || die "this does not look like the worklist bundle (no .claude/skills/worklist/SKILL.md)."
[ -d "$TARGET" ] || die "target directory does not exist: $TARGET"
[ -w "$TARGET" ] || die "target directory is not writable: $TARGET"

command -v node >/dev/null 2>&1 || die "node is not on PATH. The renderer needs Node 18 or newer."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node $NODE_MAJOR found, need 18 or newer."
ok "node $(node --version)"

# --- the skill ------------------------------------------------------------

mkdir -p "$TARGET/.claude/skills/worklist"
if [ -f "$TARGET/.claude/skills/worklist/SKILL.md" ]; then
  if cmp -s "$BUNDLE/.claude/skills/worklist/SKILL.md" "$TARGET/.claude/skills/worklist/SKILL.md"; then
    ok "skill already installed and identical"
  elif [ "$UPDATE" -eq 1 ]; then
    cp "$BUNDLE/.claude/skills/worklist/SKILL.md" "$TARGET/.claude/skills/worklist/SKILL.md"
    ok "skill    -> .claude/skills/worklist/SKILL.md (overwritten, --update)"
  else
    cp "$BUNDLE/.claude/skills/worklist/SKILL.md" "$TARGET/.claude/skills/worklist/SKILL.md.new"
    warn "a different SKILL.md is already there. Wrote SKILL.md.new next to it, yours untouched."
    warn "Re-run with --update to take this version instead."
  fi
else
  cp "$BUNDLE/.claude/skills/worklist/SKILL.md" "$TARGET/.claude/skills/worklist/SKILL.md"
  ok "skill    -> .claude/skills/worklist/SKILL.md"
fi

# --- the store ------------------------------------------------------------

STORE_INSTALLED=0
if [ -d "$TARGET/worklist" ] && [ "$UPDATE" -eq 1 ]; then
  # Code is replaceable, the store is not. Only these three paths are ever overwritten.
  mkdir -p "$TARGET/worklist/bin"
  cp "$BUNDLE/worklist/bin/render.mjs" "$TARGET/worklist/bin/render.mjs"
  cp "$BUNDLE/worklist/bin/make-fixtures.mjs" "$TARGET/worklist/bin/make-fixtures.mjs"
  cp "$BUNDLE/worklist/README.md" "$TARGET/worklist/README.md"
  ok "code     -> worklist/bin/{render,make-fixtures}.mjs, worklist/README.md"
  warn "store untouched: items/ views/ attachments/ inbox.md config.json"
elif [ -d "$TARGET/worklist" ]; then
  warn "worklist/ already exists, left completely alone. Nothing was overwritten."
  warn "Run with --update to refresh the code and keep your items."
else
  cp -R "$BUNDLE/worklist" "$TARGET/worklist"
  find "$TARGET/worklist" -name '.DS_Store' -delete 2>/dev/null || true
  # inbox.md is gitignored in the distribution repo, so a fresh clone has none. Create it here:
  # it is the one file a capture appends to, and it must never be committed back to the clone.
  [ -f "$TARGET/worklist/inbox.md" ] || : > "$TARGET/worklist/inbox.md"
  STORE_INSTALLED=1
  ok "store    -> worklist/"
fi

# config.json is store, not code: seeded when missing, never overwritten. A store created
# before config.json existed gets the defaults here rather than silently using them.
if [ -d "$TARGET/worklist" ] && [ ! -f "$TARGET/worklist/config.json" ]; then
  cp "$BUNDLE/worklist/config.json" "$TARGET/worklist/config.json"
  ok "config   -> worklist/config.json (caps 1/3/7, overflow enforce-interactive)"
fi

# --- where does this repo push? -------------------------------------------

say ""
REMOTE=""
if command -v git >/dev/null 2>&1 && git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1; then
  REMOTE="$(git -C "$TARGET" remote get-url origin 2>/dev/null || true)"
fi

if git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1; then
  # The store holds links, quoted threads and reply drafts pulled out of other people's
  # systems. Failing safe means not committing that anywhere, so the ignore is written rather
  # than suggested. Undoing it is one line and it is printed below.
  if grep -qE '^/?worklist/?$' "$TARGET/.gitignore" 2>/dev/null; then
    ok "gitignore  worklist/ already ignored"
  else
    [ -s "$TARGET/.gitignore" ] && printf '\n' >> "$TARGET/.gitignore"
    printf '%s\n' '# worklist store: links, quoted threads and reply drafts from other systems.' \
      '# Remove this if the repo is yours and you want the store committed.' \
      'worklist/' >> "$TARGET/.gitignore"
    ok "gitignore  added worklist/ to .gitignore"
  fi
  if [ -n "$REMOTE" ]; then
    say ""
    say "This repo pushes to:"
    say "  $REMOTE"
    say "If that remote is yours and you want the store committed, drop the worklist/ line"
    say "from .gitignore. If it is a client or employer org, leave it and give the store its"
    say "own nested repo with a private remote."
  fi
else
  say "Not a git repo, so nothing is at risk of being pushed anywhere yet."
  say "Decide before you run git init: the store holds links, quoted threads and reply drafts."
fi

# --- next steps -----------------------------------------------------------

say ""
say "-------------------------------------------------------------------------"
say "Installed. Three things left, none of them long."
say ""
say "1. See it working before you trust it with real work:"
say ""
say "     node worklist/bin/make-fixtures.mjs      # 28 fabricated items"
say "     node worklist/bin/render.mjs             # builds the views"
say "     open worklist/views/index.html           # or xdg-open on linux"
say "     node worklist/bin/make-fixtures.mjs --clean"
say ""
say "2. Paste these two paragraphs into this repo's CLAUDE.md. The skill covers a session"
say "   where it has been invoked; these make capture and backfill work in ANY session,"
say "   which is the difference between a habit that sticks and one that does not."
say ""
say '     **Capture shortcut:** when I say "stash this" / "add to later" + link(s), in any'
say '     session, append them one per line to `worklist/inbox.md` and acknowledge with the'
say '     running count. Do **not** fetch or process them; processing happens only on'
say '     "process the inbox".'
say ""
say '     **Backfill shortcut:** when I close or move an item out of `now`/`side`/`next`, in'
say '     any session, even a bare "wNNN is done", refill the freed slot from `later` in the'
say '     same turn, on merit, and report the promotion in one line with the reason.'
say ""
say "3. Open worklist/config.json and decide two things:"
say ""
say "     caps      how many items now/side/next hold. Defaults 1/3/7."
say "     overflow  what happens when a band is full and something new belongs in it:"
say "               tolerated | enforce-interactive | enforce-autonomous"
say ""
say "   Then read worklist/README.md and edit the Hats list to match how your week splits."
say "   Integrations are yours to wire up: the worklist links out to your tools and connects"
say "   to none of them itself."
say ""
say "Then start a Claude Code session here and say: stash this <a link>"
say "-------------------------------------------------------------------------"
say ""

if [ "$STORE_INSTALLED" -eq 0 ]; then
  warn "reminder: the store was NOT installed, an existing worklist/ was already there."
  say ""
fi
