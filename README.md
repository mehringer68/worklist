# worklist

A Claude Code skill plus a plain-Node renderer. One store for everything that needs doing:
you paste links, an agent resolves them into self-contained items, and a deterministic script
renders the views. Judgment at write time, determinism at read time. An LLM never writes a
view, so if a view is ever wrong you re-render it instead of arguing with a model.

The load-bearing design decision is the caps: **now 1, side 3, next 7** by default, and whether
going over them is allowed at all. Everything else in the system exists to keep those three bands
honest. Success condition: one thing in your head and nineteen on a list.

No dependencies. Node 18 or newer, stdlib only. Nothing calls out to a network at render time.

## Install

Clone this repo somewhere it can stay, then run the installer from inside the repo you want
the worklist in:

```bash
git clone https://github.com/mehringer68/worklist.git ~/src/worklist
cd ~/my-repo
bash ~/src/worklist/install.sh
```

Or name the target explicitly instead of cd-ing:

```bash
bash ~/src/worklist/install.sh ~/my-repo
```

It installs two directories and touches nothing else. It never overwrites an existing
`worklist/` store, and if a different `SKILL.md` is already there it writes `SKILL.md.new`
alongside rather than clobbering yours. Everything it does is a file copy, so uninstalling is
deleting the two directories.

The installer prints the next three steps when it finishes. They are also written out below.

To pick up later fixes, `git pull` in the clone and run the installer again. It will tell you
if the skill changed and leave your store alone.

## What gets installed

```
.claude/skills/worklist/SKILL.md   the skill: how the agent captures, files and bands work
worklist/README.md                 the item contract (frontmatter fields, body sections)
worklist/bin/render.mjs            deterministic renderer, builds views/
worklist/bin/make-fixtures.mjs     fabricated demo items, so you can see it populated
worklist/config.json               band caps + overflow policy, the only tunable file
worklist/{items,views,attachments} empty; items/ is the only source of truth
worklist/inbox.md                  raw captures, one line, zero decisions
```

The scripts resolve paths relative to themselves, so `worklist/` can live anywhere as long as
`bin/`, `items/` and `views/` stay siblings.

One thing the renderer writes outside the repo: a `session:` artifact becomes a Warp tab config
in `~/.warp/tab_configs/`, so the link can reopen the Claude session it points at. That is the
only path outside `worklist/` that either script touches. Delete the directory to opt out.

## See it working before you put real work in it

```bash
node worklist/bin/make-fixtures.mjs           # 28 fabricated items
node worklist/bin/render.mjs                  # builds views/
open worklist/views/index.html                # xdg-open on linux
node worklist/bin/make-fixtures.mjs --clean   # deletes only fixture:true items
```

## Two paragraphs to add to your CLAUDE.md

The skill covers a session where it has been invoked. These two shortcuts are what make
capture and backfill work in *any* session, which is the difference between a habit that
sticks and one that does not.

```markdown
**Capture shortcut:** when I say "stash this" / "add to later" + link(s), in any session,
append them one per line to `worklist/inbox.md` and acknowledge with the running count. Do
**not** fetch or process them; processing happens only on "process the inbox".

**Backfill shortcut:** when I close or move an item out of `now`/`side`/`next`, in any
session, even a bare "wNNN is done", refill the freed slot from `later` in the same turn, on
merit, and report the promotion in one line with the reason.
```

## Set these for yourself

Everything tunable is in `worklist/config.json`:

```json
{
  "caps": { "now": 1, "side": 3, "next": 7 },
  "overflow": "enforce-interactive",
  "tracks": []
}
```

- **`caps`** — how many items each live band holds. The defaults are the ones the whole design
  argues for, but they are yours to change.
- **`overflow`** — what happens when a band is at cap and something new belongs in it, which is
  most of the time, because the bands are meant to be full. `tolerated` lets a band run over.
  `enforce-interactive` means something must leave, and the agent asks you when the call is close.
  `enforce-autonomous` means the same but it decides without asking. An item you have marked
  `started` is protected only while it is in `now`, where nothing displaces it silently; in `side`
  and `next` it is an ordinary candidate that begun work weighs in favour of keeping.
- **`tracks`** — labels for work that has its own recurring calendar block, so it sits in `later`
  permanently and never competes for a band. Empty unless your week works that way.

One thing lives outside the config: **Hats** (`worklist/README.md`, "Hats"), the closed list of
work modes your day gets batched by. The shipped list is `incident investigate review pm analysis
infra tooling admin`. Edit it to match how your week actually splits.

## Where to keep the store

Your worklist will hold links, quoted threads and reply drafts. If the repo you install into
pushes to a client or employer org, gitignore `worklist/` and give it its own nested repo with
a private remote. If the repo is yours, committing it is fine. The installer tells you which
remote it found; the decision is yours.

## What is not in here

- Capture from a browser hotkey or a Slack reaction. The README mentions both as intended;
  neither is built. Capture today is typing "stash this" in a session.
- **Integrations of any kind.** There is no mail client, no tracker, no chat connector in here.
  The skill names Jira, Slack, Confluence and Gmail as an example stack, and the agent will use
  whatever tools you actually have connected instead. Hooking those up (MCP servers, CLIs,
  whatever your setup uses) is your step, not something the installer does. Same for deep links:
  if you want an `email:` artifact to open in your mail client, put that client's URL scheme in
  the link slot yourself. The rule that matters is resolving a link with a tool that reads the
  whole thing rather than a preview.

## Status

A POC that has been in daily use, not a product. Item ids are `wNNN`, sequential and never
reused. The renderer has no tests.

## License

MIT. See [LICENSE](LICENSE).
