---
name: worklist
description: The user's single work store. Use for "stash this", "add to later", "file this now", "process the inbox", "what's on my list", "what am I working on", or any paste of links meant to become work items. Captures from any source, resolves them into self-contained items, and renders the Now/Side/Next views.
---

# Worklist

One store for everything that needs doing, replacing browser tabs, Slack saved items, unread
mail and open Claude sessions as places where work hides.

Store: `worklist/` at this repo's root. **Read `worklist/README.md` first** — it holds the
item contract (frontmatter fields, allowed values, body sections). Do not duplicate it here;
it is the authority.

**Then read `worklist/config.json`.** It sets the band caps and the overflow policy, and both
are binding on every banding decision you make. Never assume 1/3/7 — read the numbers.

Success condition: *one thing in your head and nineteen on a list.*

## Verbs

| They say | You do |
|---|---|
| "stash this" / "add to later" + links | Append raw to `worklist/inbox.md`. **No fetching, no decisions.** Reply with the running count and nothing else. |
| "file this" / "process this now" + links | Run **Filing** on those lines immediately. Do not touch the inbox. |
| "process the inbox" | Run **Filing** on every line in `inbox.md`, then delete the processed lines from it. |
| "what's on my list" / "what now" | `node worklist/bin/render.mjs`, then relay `worklist/views/today.md`. |
| "wNNN is done" / anything that closes or moves an item | Set the status, then **backfill the freed slot** (see below). |

Stash must stay instant. If stashing ever involves reading a link, it has stopped being
stash and the capture habit dies.

## Input grammar

**One line is one item** — any number of links plus any free-text thought on the same line.
Next line is the next item. Blank lines ignored. There is no other syntax.

The free text is not decoration. It is an instruction, and it usually carries the deadline,
the ask, or a pointer to something you must go and find.

**Their grouping is binding.** Links on one line are one item, always. A connection you spot
that they did not make is recorded as `possible duplicate of wNNN` in the Log — never merged.

## Filing

For each line:

**1. Fetch the primary sources.**
- Slack permalink `…/archives/<CHANNEL>/p<DIGITS>` → channel is the path segment (`C…` public/private, `D…` DM, `G…` group); ts is the digits with a decimal before the last six: `p1784105024967379` → `1784105024.967379`. Use the Slack MCP's thread read for the thread, the channel read for surrounding context.
- Jira → the Jira MCP. GitHub → `gh pr view` / `gh issue view`. Confluence → the Confluence MCP. Mail → the Gmail MCP. Anything else → WebFetch.

Adapt this list to whatever tools are actually connected. The rule that matters is: resolve
the link with the tool that can read the *whole* thing, not a preview of it.

**2. Follow every link you find, transitively.** A thread linking another thread, a PR, a
doc, a dashboard: fetch those too, and the links inside those. Depth 3 is usually enough;
stop when a hop stops adding information. This is the point of the whole system — the item
must stand alone. If opening it sends them somewhere else to understand it, filing failed.

**3. Chase what the note tells you to.** "There should be an email where she argued against
the report" is an instruction to go and search mail and Slack until you find it.

**4. Dedupe.** Exact artifact key match against an existing item → attach to that item.
Otherwise create new. When torn, **create new and flag** — a visible duplicate costs one
word, a wrong merge silently buries a commitment.

**5. Write the item** into `worklist/items/wNNN-slug.md`. Ids are sequential, never reused;
take max existing + 1 across `items/` and any archive. Fill every frontmatter field:

- `owner` — **empty by default.** Only their name when it is unambiguously theirs. Assigning it to them is a decision, not a default.
- `impact` 1-3; a 3 requires a falsifiable consequence written in *Why this matters*.
- `effort` S (<1h) / M (a few hours) / L (multi-day).
- `due` only if a real date exists. `due_source`: `external` (someone else's date), `committed` (they promised it), `self`, `none`.
- `waiting_on` — a person when the ball is with them. Only ever a person.
- `until` — a date to keep the item invisible until then. Only ever a date.
- `hat` — closed list in the README. It decides how the day gets batched.
- Capture enough content in the body that Slack, the tracker and the mailbox never need reopening.

**5b. Size it.** A big topic is **one item** with the context and a checklist in the body,
not a scatter of fragments. Split a step out (`parent: wNNN`, one level only) only when it
needs its own status, owner or date, or when someone else could take it. Test: *same sitting
→ same item.* Splitting eagerly is what makes `next` unreadable.

State dependencies with `blocked_by: wNNN` — it gates the item out of the live bands until
the blocker closes, exactly like `until`. **Only gate on dependencies they stated.** One
you inferred gets recorded and displayed but must not gate, because a wrong dependency hides
work silently.

**6. Band — you fill all three.** After filing, **`now`, `side` and `next` must be full to
their caps** if there are enough live items. Read the caps from `worklist/config.json`; the
shipped defaults are `now` 1, `side` 3, `next` 7. Do not leave a band short and do not hand the
choice back: proposing the order is the job. They review and correct.

- **`now`** — the most time-critical thing with a real action they can take. Something with a deadline of *today* outranks a bigger item with no date.
- **`side`** — lighter things to pick up while `now` is blocked. Prefer S/M; never put an L in `side` when `now` is also L.
- **`next`** — the promote-from queue.
- Everything beyond the three bands goes to `later`, `waiting` (ball genuinely with someone else) or an `until` date gate, and only shows under **all**.

**6a. When a band is already at its cap.** An empty slot is a filing failure, so the bands will
normally be full, which means most new items arrive at a band that has no room. What you do then
is set by `overflow` in `config.json`:

| `overflow` | A band is at cap and something new belongs in it |
|---|---|
| `tolerated` | Put it in. Exceeding the cap is allowed; the renderer reports the count without treating it as a fault. |
| `enforce-interactive` | Something must leave. If one candidate is clearly weakest, displace it, say so in one line, and move on. If the call is close, name the candidates and **ask**. |
| `enforce-autonomous` | Something must leave. Choose it yourself, never ask, and report the swap in one line with the reason. |

Under either `enforce-` mode a band must never end a turn over its cap. Displacement means a
demotion to `next` or `later`, never a deletion, and it is written to the displaced item's Log.

"Clearly weakest" is the same merit test as backfill: no date, blocking nobody, and a smaller
consequence than the item arriving. Two candidates that are close is not clear — that is the
case `enforce-interactive` exists to ask about.

**The started-`now` rule outranks the policy, and only there.** A `started:` item sitting in
**`now`** is never displaced silently, `enforce-autonomous` included: say what would move and ask.
In `side` and `next`, `started:` is not a veto. It weighs against displacing that item, because
work already begun is worth finishing, but under `enforce-autonomous` you displace it and report
it like any other, and under `enforce-interactive` it is an ordinary candidate.

**6b. Backfill on close, every time, unprompted.** Whenever an item leaves `now`, `side` or
`next` for any reason (done, parked, moved), refill the gap in the same turn. This is
not part of Filing, it applies in **any** session where an item closes, including a one-line
"wNNN is done".

- Refill top down: `now` takes the strongest candidate from `side`, `next` or `later`; the band
  that lost it refills from below; `later` feeds the bottom gap.
- Pick on merit, not rank order: what is time-critical, what has a date this week, what unblocks
  other people. The same judgment as step 6.
- Respect the band's character. `side` is for lighter S/M work they can pick up while `now` is
  blocked, so do not park an undated L there just because a slot opened.
- **Report the move in one line with the reason.** They are delegating the choice precisely so
  they do not have to read the whole list, so the one line is what makes it correctable. They
  overrule freely and that is the intended use, not a failure.
- Log the promotion on the item (`later → side on <date>, because ...`).

**Band by the action, not the topic.** If someone else owes the underlying thing but *they*
have a reply to send today, that is `now`, not `waiting`.

**Tracks: work with reserved time elsewhere.** Work that has its own recurring calendar block
gets a track label (`labels: [oss]` in the shipped example) and **status `later`, always**.
Because the time is already reserved, it must never enter `now`/`side`/`next` and must never
be chosen as a backfill candidate — it is not competing for the same hours. Ranking it on
merit would bury it anyway: track work is self-dated, never overdue, and never unblocks
anyone on the main job. They pick the top track item at the start of a block; anything not
finished in one becomes a new track item in `later`. `TRACKS` in `render.mjs` gives the label
its own chip so the bucket is one click at block start. Change `TRACKS` to whatever labels
have their own calendar block, or set it to `[]` if none do.

**Never displace a started `now` without asking.** They tell you when they start something and
it gets `started: YYYY-MM-DD`. If a new item outranks a started `now`, say so and ask —
swapping is fine, doing it silently is not. An unstarted `now` you may re-rank freely.

**7. Reply draft.** Where the next action is replying to someone, write `## Reply draft` in
the item: plain text they can paste. **Never create an actual draft in Slack or Gmail.**

**8.** Remove processed lines from `inbox.md`, run `node worklist/bin/render.mjs`.

**9. Report** one line per item: id, title, band, plus anything unresolved — a link you could
not reach, a possible duplicate, a missing deadline. Say what you could not do; silent gaps
destroy the trust the list exists to create.

## Hard rules

- **Never pull from the tracker, Slack, mail or anywhere else beyond resolving the lines they gave you.** No broad sweeps unless asked.
- **Never delete an item.** Status changes and archiving only. The whole premise is "I can't lose things."
- `views/` is generated. Never hand-edit it; change `items/` and re-render.
- **Check where this repo pushes before committing anything.** If the remote is not yours, keep `worklist/` gitignored and never `git add` it from here.
