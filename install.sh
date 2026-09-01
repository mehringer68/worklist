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

set -euo pipefail

BUNDLE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$(cd "${1:-$PWD}" && pwd)"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
warn() { printf '  note  %s\n' "$*"; }
die()  { printf '\nstopped: %s\n\n' "$*" >&2; exit 1; }

say ""
say "worklist installer"
say "  bundle: $BUNDLE"
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
  else
    cp "$BUNDLE/.claude/skills/worklist/SKILL.md" "$TARGET/.claude/skills/worklist/SKILL.md.new"
    warn "a different SKILL.md is already there. Wrote SKILL.md.new next to it, yours untouched."
  fi
else
  cp "$BUNDLE/.claude/skills/worklist/SKILL.md" "$TARGET/.claude/skills/worklist/SKILL.md"
  ok "skill    -> .claude/skills/worklist/SKILL.md"
fi

# --- the store ------------------------------------------------------------

STORE_INSTALLED=0
if [ -d "$TARGET/worklist" ]; then
  warn "worklist/ already exists, left completely alone. Nothing was overwritten."
  warn "If you meant to reinstall, move it aside first: mv worklist worklist.old"
else
  cp -R "$BUNDLE/worklist" "$TARGET/worklist"
  find "$TARGET/worklist" -name '.DS_Store' -delete 2>/dev/null || true
  # inbox.md is gitignored in the distribution repo, so a fresh clone has none. Create it here:
  # it is the one file a capture appends to, and it must never be committed back to the clone.
  [ -f "$TARGET/worklist/inbox.md" ] || : > "$TARGET/worklist/inbox.md"
  STORE_INSTALLED=1
  ok "store    -> worklist/"
fi

# --- where does this repo push? -------------------------------------------

say ""
REMOTE=""
if command -v git >/dev/null 2>&1 && git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1; then
  REMOTE="$(git -C "$TARGET" remote get-url origin 2>/dev/null || true)"
fi

if [ -n "$REMOTE" ]; then
  say "This repo pushes to:"
  say "  $REMOTE"
  say ""
  say "Your worklist will hold links, quoted threads and reply drafts. If that remote is not"
  say "yours, gitignore the store now and give it its own private repo later:"
  say ""
  say "  echo 'worklist/' >> $TARGET/.gitignore"
else
  say "No git remote found here, so nothing is at risk of being pushed anywhere yet."
  say "Decide before you add one: the store holds links, quoted threads and reply drafts."
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
say "3. Read worklist/README.md, then edit two things for yourself: the Hats list (the work"
say "   modes your day gets batched by) and TRACKS at the top of bin/render.mjs (labels for"
say "   work that has its own calendar block, so it never competes for a band)."
say ""
say "Then start a Claude Code session here and say: stash this <a link>"
say "-------------------------------------------------------------------------"
say ""

if [ "$STORE_INSTALLED" -eq 0 ]; then
  warn "reminder: the store was NOT installed, an existing worklist/ was already there."
  say ""
fi
