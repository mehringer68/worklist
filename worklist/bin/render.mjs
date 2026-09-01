#!/usr/bin/env node
// Deterministic renderer. No LLM, no dependencies.
// Every view is a pure projection of items/. Never hand-edit views/.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ITEMS = join(ROOT, 'items');
const VIEWS = join(ROOT, 'views');

// ---------- config ----------
// `worklist/config.json` is the one place a store is tuned, and both this script and the skill
// read it. It is optional; the defaults below are the shipped ones. A malformed config stops
// the render instead of falling back silently, because a cap the user did not choose is worse
// than no render at all.
const CONFIG_PATH = join(ROOT, 'config.json');
const DEFAULTS = {
  // Cascading WIP limits. One thing in your head; three light things to pick up when that one
  // is blocked; seven to promote from. Everything else is deliberately out of sight.
  caps: { now: 1, side: 3, next: 7 },
  // What happens when a band is at cap and something new belongs in it. This script only
  // reports; the agent is what enforces. See .claude/skills/worklist/SKILL.md.
  //   tolerated            going over cap is fine, the count is reported without alarm
  //   enforce-interactive  something must leave; the agent asks when the choice is not obvious
  //   enforce-autonomous   something must leave; the agent decides and never asks
  overflow: 'enforce-interactive',
  // Labels for work with reserved time elsewhere (a calendar block). Track items sit in
  // `later` permanently, never compete for a band, and get their own chip. Empty by default.
  tracks: [],
};
const OVERFLOW_MODES = ['tolerated', 'enforce-interactive', 'enforce-autonomous'];

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return DEFAULTS;
  let raw;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`config.json is not valid JSON: ${e.message}`);
  }
  const caps = { ...DEFAULTS.caps, ...(raw.caps || {}) };
  for (const k of ['now', 'side', 'next']) {
    if (!Number.isInteger(caps[k]) || caps[k] < 1)
      throw new Error(`config.json: caps.${k} must be a whole number of 1 or more, got ${JSON.stringify(caps[k])}`);
  }
  const overflow = raw.overflow ?? DEFAULTS.overflow;
  if (!OVERFLOW_MODES.includes(overflow))
    throw new Error(`config.json: overflow must be one of ${OVERFLOW_MODES.join(' | ')}, got ${JSON.stringify(overflow)}`);
  const tracks = raw.tracks ?? DEFAULTS.tracks;
  if (!Array.isArray(tracks) || tracks.some((t) => typeof t !== 'string'))
    throw new Error('config.json: tracks must be an array of label strings');
  return { caps, overflow, tracks };
}

const CONFIG = loadConfig();
const CAPS = CONFIG.caps;
const TRACKS = CONFIG.tracks;
// Only the enforce- modes treat over-cap as a fault. Under `tolerated` the count is still shown,
// just without the warning, because the number is useful even when exceeding it is allowed.
const ENFORCED = CONFIG.overflow !== 'tolerated';
const NAG_DAYS = 3;
const BANDS = ['now', 'side', 'next', 'waiting', 'later', 'done', 'dropped'];
const WEIGHT = { S: 1, M: 2, L: 3 };
// A closed item cannot be late. Dates on done and dropped items are history, not obligations.
const CLOSED = new Set(['done', 'dropped']);

const today = new Date(new Date().toISOString().slice(0, 10));
const days = (a, b) => Math.round((a - b) / 86400000);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test((s || '').trim());

// ---------- parse ----------

function stripQuotes(s) {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

function parseItem(file) {
  const raw = readFileSync(join(ITEMS, file), 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: no frontmatter`);

  const fm = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const scalar = line.match(/^([A-Za-z_]\w*):\s*(.*)$/);
    if (scalar) {
      key = scalar[1];
      fm[key] = scalar[2].trim() === '' ? '' : stripQuotes(scalar[2]);
      continue;
    }
    const entry = line.match(/^\s+-\s*(.*)$/);
    if (entry && key) {
      if (!Array.isArray(fm[key])) fm[key] = [];
      fm[key].push(stripQuotes(entry[1]));
    }
  }

  const sections = {};
  for (const chunk of m[2].split(/^## /m).slice(1)) {
    const nl = chunk.indexOf('\n');
    sections[chunk.slice(0, nl).trim().toLowerCase()] = chunk.slice(nl + 1).trim();
  }

  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const it = {
    ...fm,
    file,
    labels: arr(fm.labels),
    impact: Number(fm.impact) || 1,
    artifacts: arr(fm.artifacts).map((a) => {
      const [ref, label, url] = a.split('|').map((x) => x.trim());
      return { kind: ref.split(':')[0], ref, label: label || ref, url: url || '' };
    }),
    body: sections,
  };

  it.age = fm.created ? days(today, new Date(fm.created)) : 0;
  it.dueIn = isDate(fm.due) ? days(new Date(fm.due), today) : null;
  it.overdue = it.dueIn !== null && it.dueIn < 0 && !CLOSED.has(fm.status);
  it.gate = isDate(fm.waiting_on) ? new Date(fm.waiting_on) : null;
  it.parked = it.gate !== null && it.gate > today;
  it.chaseDue =
    fm.status === 'waiting' && !it.gate && it.age > NAG_DAYS ? it.age : null;
  return it;
}

// ---------- rank ----------
// No stored priority. Order is computed, so there is no number to inflate.
// overdue first, then impact, then due proximity, then age.
function rank(a, b) {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  if (a.impact !== b.impact) return b.impact - a.impact;
  if (a.dueIn !== b.dueIn) {
    if (a.dueIn === null) return 1;
    if (b.dueIn === null) return -1;
    return a.dueIn - b.dueIn;
  }
  return b.age - a.age;
}

const items = readdirSync(ITEMS).filter((f) => f.endsWith('.md')).map(parseItem);
const fixtures = items.filter((i) => i.fixture === 'true');

// Gates: an item comes back on its own either when a date arrives (waiting_on: <date>)
// or when the item it waits on closes (blocked_by: wNNN). Same mechanism, two triggers.
const byId = Object.fromEntries(items.map((i) => [i.id, i]));
for (const i of items) {
  i.blockers = String(i.blocked_by || '').split(/[,\s]+/).filter(Boolean)
    .filter((id) => byId[id] && !CLOSED.has(byId[id].status));
  i.blocked = i.blockers.length > 0;
  if (i.blocked && !CLOSED.has(i.status)) i.parked = true;
  i.kids = [];
}
for (const i of items) if (i.parent && byId[i.parent]) byId[i.parent].kids.push(i);
const band = (s) => items.filter((i) => i.status === s && !i.parked).sort(rank);
const parked = items.filter((i) => i.parked).sort(rank);

// ---------- md views ----------

const pad = (s, n) => String(s).padEnd(n).slice(0, n);

function line(i) {
  const meta = [];
  if (i.overdue) meta.push(`OVERDUE ${-i.dueIn}d`);
  else if (i.dueIn !== null) meta.push(`due ${i.due}`);
  if (i.waiting_on && !i.gate) meta.push(`waiting: ${i.waiting_on}`);
  if (i.gate) meta.push(`gated to ${i.waiting_on}`);
  if (i.blocked) meta.push(`blocked by ${i.blockers.join(',')}`);
  if (i.started) meta.push('IN PROGRESS');
  if (i.kids.length) meta.push(`${i.kids.length} sub`);
  if (!i.owner) meta.push('UNOWNED');
  meta.push(`${i.artifacts.length}a`, `${i.age}d`);
  if (i.fixture === 'true') meta.push('fx');
  return `${pad(i.id, 5)} ${i.impact}/${pad(i.effort, 1)} ${pad(i.hat, 11)} ${pad(i.title, 62)} ${meta.join('  ')}`;
}

let index = `# worklist — ${items.length} items (${fixtures.length} fixtures, marked \`fx\`)\n\nGenerated by bin/render.mjs. Do not edit.\n`;
for (const s of BANDS) {
  const b = band(s);
  if (!b.length) continue;
  const cap = CAPS[s] && b.length > CAPS[s]
    ? (ENFORCED ? `  ⚠ OVER CAP of ${CAPS[s]}` : `  (over the tolerated cap of ${CAPS[s]})`)
    : '';
  index += `\n## ${s} (${b.length})${cap}\n\n\`\`\`\n${b.map(line).join('\n')}\n\`\`\`\n`;
}
if (parked.length) {
  index += `\n## parked — auto-resurface on their gate date (${parked.length})\n\n\`\`\`\n${parked.map(line).join('\n')}\n\`\`\`\n`;
}

const nowB = band('now');
const sideB = band('side');
const nextB = band('next');
const overdue = items.filter((i) => i.overdue && !i.parked);
const chases = items.filter((i) => i.chaseDue);

const oneLine = (s) => (s || '').split('\n\n')[0].replace(/\n/g, ' ').trim();
const brief = (i) =>
  `- \`${i.id}\` **${i.title}** · ${i.hat} · ${i.effort}${i.overdue ? ` · **${-i.dueIn}d over**` : ''}`;

let todayMd = `# today — ${today.toISOString().slice(0, 10)}\n\n## NOW\n\n`;
todayMd += nowB.length
  ? `**${nowB[0].title}**\n\`${nowB[0].id}\` · ${nowB[0].hat} · effort ${nowB[0].effort} · impact ${nowB[0].impact}\n\n→ ${oneLine(nowB[0].body['next action'])}`
  : '_Nothing in now. Promote one from next._';
if (nowB.length > CAPS.now)
  todayMd += `\n\n> ⚠ ${nowB.length} items in \`now\`. The cap is ${CAPS.now}.`;

todayMd += `\n\n## SIDE — for when NOW is blocked (${sideB.length}/${CAPS.side})\n\n`;
todayMd += sideB.length ? sideB.map(brief).join('\n') : '_empty_';
const heavy = nowB[0] && WEIGHT[nowB[0].effort] === 3 ? sideB.filter((i) => WEIGHT[i.effort] === 3) : [];
if (heavy.length)
  todayMd += `\n\n> ⚠ NOW is effort L and so are ${heavy.map((i) => i.id).join(', ')}. Side work should be lighter than the thing it fills the gaps in.`;

todayMd += `\n\n## NEXT — promote from here when NOW closes (${nextB.length}/${CAPS.next})\n\n`;
todayMd += nextB.length ? nextB.map(brief).join('\n') : '_empty_';
if (overdue.length) {
  todayMd += `\n\n## Past their date (${overdue.length})\n\n`;
  todayMd += overdue.map((i) => `- \`${i.id}\` ${i.title} — ${-i.dueIn}d over, source: ${i.due_source}`).join('\n');
}
if (chases.length) {
  todayMd += `\n\n## Chase these (${chases.length})\n\n`;
  todayMd += chases.map((i) => `- ${i.waiting_on} on **${i.title}** — ${i.age}d, no movement`).join('\n');
}

const waitingMd =
  `# waiting on other people\n\n` +
  items
    .filter((i) => i.status === 'waiting' && !i.gate)
    .sort(rank)
    .map((i) => `## ${i.waiting_on} — ${i.title}\n\n\`${i.id}\` · ${i.age}d\n\n> Hi ${i.waiting_on}, anything on ${i.title.toLowerCase()}? Happy to take it back if it is not yours.\n`)
    .join('\n');

// ---------- html ----------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hats = [...new Set(items.map((i) => i.hat))].sort();

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const fmt = (s) => { const d = new Date(s); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const niceDate = `${DAY[today.getUTCDay()]}, ${today.getUTCDate()} ${MON[today.getUTCMonth()]}`;
const first = (s) => (s || '').split('\n\n')[0].replace(/\n/g, ' ').trim();

// Local paths must become real file:// URLs — `~/` and `./` resolve against the page otherwise.
const HOME = process.env.HOME || '';
const REPO = join(ROOT, '..');
const toUrl = (u) => {
  if (!u) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  if (u.startsWith('~/')) return 'file://' + HOME + u.slice(1);
  if (u.startsWith('./')) return 'file://' + join(REPO, u.slice(2));
  if (u.startsWith('/')) return 'file://' + u;
  return u;
};

// ---------- session: artifacts -> Warp tab configs ----------
// A `session:` artifact is a resumable Claude Code conversation, so the source link should put
// you back in it. Warp will NOT run a command from warp://action/new_tab (open request #5859),
// but a Tab Config will, so generate one per session and link to that. warp://tab_config/<stem>
// matches case-insensitively on the file stem. Verified against Warp 0.2026.07.08.
// `claude --resume <key>`: a session id resumes directly, a name opens the picker filtered to it.
const TAB_CONFIGS = HOME ? join(HOME, '.warp', 'tab_configs') : '';
const stemOf = (id, key) =>
  `worklist-${id}-${key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
let tabConfigs = 0;
if (TAB_CONFIGS) {
  mkdirSync(TAB_CONFIGS, { recursive: true });
  for (const i of items) {
    for (const a of i.artifacts) {
      if (a.kind !== 'session') continue;
      const key = a.ref.slice(a.ref.indexOf(':') + 1).trim();
      // Allowlist, not a denylist: `key` and `cwd` are interpolated into a double-quoted shell
      // command that Warp runs on tab open, and inside double quotes $(...) and backticks still
      // expand. Item files are written from fetched content, so this string is not fully ours.
      if (!key || !/^[A-Za-z0-9._-]+$/.test(key)) continue;
      // Sessions are stored per project directory (~/.claude/projects/<cwd-slug>/), so resuming
      // from the wrong cwd finds nothing. Default to this repo; the url slot overrides it with an
      // absolute or ~/ path for sessions started elsewhere (e.g. another project's repo).
      const raw = (a.url || '').trim();
      const cwd = raw.startsWith('/') ? raw : raw.startsWith('~/') ? HOME + raw.slice(1) : REPO;
      if (!/^[A-Za-z0-9 ._\/-]+$/.test(cwd)) continue;
      const stem = stemOf(i.id, key);
      // Tab title comes from the label, not the key — the key is usually an opaque session id.
      const nice =
        (a.label || key).replace(/["\\\n]/g, '').split('—')[0].trim().slice(0, 60) || key;
      writeFileSync(
        join(TAB_CONFIGS, `${stem}.toml`),
        `# generated by worklist/bin/render.mjs — do not edit\n` +
          `name = "${i.id} · ${nice}"\ncolor = "magenta"\n\n` +
          `[[panes]]\nid = "root"\ntype = "terminal"\ndirectory = "${cwd}"\n` +
          // cd as well as directory: a Warp tab can inherit a cwd from wherever you were last,
          // and the wrong cwd silently means "no such session".
          `commands = ["cd \\"${cwd}\\" && claude --resume \\"${key}\\""]\nis_focused = true\n`
      );
      a.url = `warp://tab_config/${stem}`;
      tabConfigs++;
    }
  }
}

const HAT_COLOR = {
  incident: '#c0442b', investigate: '#7c5cbf', review: '#2f6fb0', pm: '#b07407',
  analysis: '#10787a', infra: '#3f8043', tooling: '#8a5a2b', admin: '#6b6257',
};
const hatCss = Object.entries(HAT_COLOR).map(([h, c]) =>
  `.h-${h}{--hc:${c}}`).join('');

const dots = (n) => `<span class="imp" title="impact ${n}">${[1, 2, 3].map((i) => `<i${i <= n ? ' class="on"' : ''}></i>`).join('')}</span>`;

const flags = (i) => [
  i.overdue ? `<b class="f od">${-i.dueIn}d over</b>` : i.dueIn !== null ? `<b class="f due">${fmt(i.due)}</b>` : '',
  i.waiting_on && !i.gate ? `<b class="f wt">${esc(i.waiting_on)}</b>` : '',
  i.gate ? `<b class="f gt">${fmt(i.waiting_on)}</b>` : '',
  i.blocked ? `<b class="f bl">blocked by ${i.blockers.join(', ')}</b>` : '',
  i.kids.length ? `<b class="f kd">${i.kids.length} sub</b>` : '',
  i.started ? '<b class="f st">in progress</b>' : '',
  !i.owner ? '<b class="f un">unowned</b>' : '',
  i.fixture === 'true' ? '<b class="f fx">fixture</b>' : '',
].filter(Boolean).join('');

const attrs = (i) =>
  `data-id="${i.id}" data-status="${i.status}" data-hat="${i.hat}" data-labels="${esc(i.labels.join(' '))}" data-real="${i.fixture === 'true' ? 'no' : 'yes'}"`;

const hero = (i) => `
<article class="item hero h-${i.hat}" ${attrs(i)}>
  <div class="eyebrow"><code>${i.id}</code><span class="hchip">${esc(i.hat)}</span>${dots(i.impact)}<span class="eff">${esc(i.effort)}</span>${flags(i)}</div>
  <h3>${esc(i.title)}</h3>
  <p class="na">${esc(first(i.body['next action']))}</p>
  <p class="more">Open full detail &rarr;</p>
</article>`;

const row = (i) => `
<div class="item h-${i.hat}" ${attrs(i)}>
  <code class="id">${i.id}</code>
  ${dots(i.impact)}
  <span class="hat">${esc(i.hat)}</span>
  <span class="title">${esc(i.title)}</span>
  <span class="meta">${flags(i)}<span class="eff">${esc(i.effort)}</span><span class="dim">${i.age}d</span></span>
</div>`;

const BAND_DESC = {
  now: 'the one thing', side: 'pick up when now is blocked', next: 'promote from here',
  waiting: 'owed to you by someone else', later: 'deliberately not now',
  done: 'finished', dropped: 'kept as a record so it is not re-proposed',
};
const OPEN_BY_DEFAULT = ['now', 'side', 'next', 'waiting'];

const section = (key, list, desc, open) => list.length ? `
<details class="band" data-band="${key}" data-default-open="${open ? 1 : 0}" ${open ? 'open' : ''}>
  <summary class="bandhead">
    <span class="bname">${key}</span><span class="bdesc">${desc}</span>
    <span class="bcount${ENFORCED && CAPS[key] && list.length > CAPS[key] ? ' over' : ''}" data-total="${list.length}" data-full="${list.length}${CAPS[key] ? '/' + CAPS[key] : ''}">${list.length}${CAPS[key] ? '/' + CAPS[key] : ''}</span>
  </summary>
  <div class="rows">${list.map(key === 'now' ? hero : row).join('')}</div>
</details>` : '';

const sections =
  BANDS.map((s) => section(s, band(s), BAND_DESC[s], OPEN_BY_DEFAULT.includes(s))).join('') +
  section('parked', parked, 'out of sight until its gate opens — a date, or the item it waits on', false);

const payload = items.map((i) => ({
  id: i.id, title: i.title, status: i.status, hat: i.hat, impact: i.impact, effort: i.effort,
  due: i.due || '', due_source: i.due_source || '', owner: i.owner || '', waiting_on: i.waiting_on || '',
  labels: i.labels, visibility: i.visibility || '', created: i.created || '', age: i.age,
  dueIn: i.dueIn, overdue: i.overdue, gated: !!i.gate, fixture: i.fixture === 'true',
  blockers: i.blockers.map((id) => ({ id, title: byId[id].title })),
  parent: i.parent && byId[i.parent] ? { id: i.parent, title: byId[i.parent].title } : null,
  kids: i.kids.map((k) => ({ id: k.id, title: k.title, status: k.status })),
  artifacts: i.artifacts.map((a) => ({ kind: a.kind, label: a.label, url: toUrl(a.url) })),
  body: {
    why: i.body['why this matters'] || '', next: i.body['next action'] || '',
    reply: i.body['reply draft'] || '',
    log: i.body['log'] || '', captured: i.body['captured'] || '',
  },
}));

const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#e8834a"/><path d="M9 16.8l4.6 4.6L23 11.4" stroke="#fff" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>');

const html = `<title>Worklist</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="${FAVICON}">
<style>
:root{
  --bg:#fdfaf5;--panel:#fff;--fg:#2b241c;--dim:#7b6f61;--faint:#aa9d8c;
  --line:#ece2d3;--hair:#f5efe5;--accent:#1f7a5c;--soft:rgba(31,122,92,.10);
  --brand:#e8834a;--od:#c0442b;--ods:rgba(192,68,43,.10);--wt:#a97008;
  --shadow:0 1px 2px rgba(90,60,20,.05),0 14px 34px -20px rgba(90,60,20,.28);
  --r:14px;
}
@media(prefers-color-scheme:dark){:root{
  --bg:#17140f;--panel:#211d16;--fg:#f1e9dd;--dim:#a2968a;--faint:#776c5e;
  --line:#332b21;--hair:#262019;--accent:#5cc79f;--soft:rgba(92,199,159,.13);
  --brand:#f0995f;--od:#ef9078;--ods:rgba(239,144,120,.13);--wt:#dfae55;
  --shadow:0 1px 2px rgba(0,0,0,.4);
}}
${hatCss}
@media(prefers-color-scheme:dark){${Object.entries(HAT_COLOR).map(([h, c]) => `.h-${h}{--hc:color-mix(in srgb,${c} 52%,#fff)}`).join('')}}
*{box-sizing:border-box}
html{-webkit-font-smoothing:antialiased}
body{margin:0;background:var(--bg);color:var(--fg);
  font:14.5px/1.55 ui-sans-serif,-apple-system,"SF Pro Text","Segoe UI",sans-serif;padding-bottom:6rem}
.wrap{max-width:1000px;margin:0 auto;padding:0 1.5rem}
code{font-family:ui-monospace,"SF Mono",Menlo,monospace}
button{font:inherit;cursor:pointer}

/* header */
header{padding:2.5rem 0 1.5rem}
.brand{display:flex;align-items:center;gap:.6rem;font-size:26px;font-weight:680;letter-spacing:-.025em}
.brand svg{width:26px;height:26px;flex:none;border-radius:8px}
.today{color:var(--dim);font-size:13.5px;margin:.3rem 0 0 2.15rem}

/* controls */
.controls{display:flex;flex-wrap:wrap;align-items:center;gap:.55rem;padding-bottom:1.6rem}
.seg{display:inline-flex;background:var(--hair);border:1px solid var(--line);
  border-radius:999px;padding:3px;gap:2px;flex-wrap:wrap}
.seg button{border:0;background:transparent;color:var(--dim);border-radius:999px;
  padding:.32rem .78rem;font-size:12.5px;font-weight:520;transition:.14s;white-space:nowrap}
.seg button:hover{color:var(--fg)}
.seg button em{font-style:normal;opacity:.55;margin-left:.32rem;font-variant-numeric:tabular-nums}
.seg button.on{background:var(--panel);color:var(--fg);box-shadow:0 1px 2px rgba(90,60,20,.10);font-weight:620}
.seg button.on em{opacity:.7}
.hats{display:inline-flex;flex-wrap:wrap;gap:.3rem;margin-left:.3rem}
.hats button{border:1px solid transparent;background:color-mix(in srgb,var(--hc) 11%,transparent);
  color:var(--hc);border-radius:999px;padding:.26rem .68rem;font-size:11.5px;font-weight:600;
  letter-spacing:.01em;transition:.14s}
.hats button:hover{border-color:color-mix(in srgb,var(--hc) 45%,transparent)}
.hats button.on{background:var(--hc);color:var(--bg)}
.tracks{display:inline-flex;flex-wrap:wrap;gap:.3rem;margin-left:.3rem}
.tracks button{border:1px solid color-mix(in srgb,var(--brand) 34%,transparent);
  background:color-mix(in srgb,var(--brand) 9%,transparent);color:var(--brand);
  border-radius:999px;padding:.26rem .68rem;font-size:11.5px;font-weight:600;transition:.14s}
.tracks button em{font-style:normal;opacity:.55;margin-left:.3rem;font-variant-numeric:tabular-nums}
.tracks button:hover{border-color:var(--brand)}
.tracks button.on{background:var(--brand);border-color:var(--brand);color:#fff}
.toggle{margin-left:auto;border:1px solid var(--line);background:var(--panel);color:var(--dim);
  border-radius:999px;padding:.3rem .78rem;font-size:12px}
.toggle.on{background:var(--fg);border-color:var(--fg);color:var(--bg)}

/* stats — only shown on All */
.stats{display:flex;flex-wrap:wrap;gap:1.6rem;padding:0 0 1.75rem}
.stats div{font-size:12.5px;color:var(--dim)}
.stats b{display:block;font-size:24px;font-weight:640;color:var(--fg);letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;margin-bottom:.05rem}
.stats .alert b{color:var(--od)}
.stats[hidden]{display:none}

/* bands */
.band{margin-bottom:1.7rem}
.band[hidden]{display:none}
.bandhead{display:flex;align-items:baseline;gap:.7rem;cursor:pointer;list-style:none;
  padding:.2rem 0 .5rem;border-bottom:1px solid var(--line);margin-bottom:.4rem}
.bandhead::-webkit-details-marker{display:none}
.bname{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.15em}
.bdesc{font-size:12.5px;color:var(--faint);margin-right:auto}
.bcount{font-size:11.5px;color:var(--faint);font-variant-numeric:tabular-nums}
.bcount.over{color:var(--od);font-weight:700}
.band:not([open]) .bandhead{opacity:.5;border-bottom-color:var(--hair)}

/* rows */
/* !important because the row layout rule below is a more specific selector than any plain
   [hidden] rule can be, so without it a filtered-out row keeps its display:grid and stays on
   screen. That made every row-level filter (hats, tracks) look broken: the bands hid, the rows
   inside them did not. Do not weaken this to a specificity trick — the next display rule added
   here would silently break filtering again. */
.item[hidden]{display:none!important}
.rows>.item:not(.hero){display:grid;grid-template-columns:2.5rem 1.8rem 5.6rem minmax(0,1fr) auto;
  gap:.85rem;align-items:center;padding:.62rem .75rem;border-radius:10px;cursor:pointer;
  border-bottom:1px solid var(--hair);transition:background .13s}
.rows>.item:not(.hero):hover{background:var(--panel);border-bottom-color:transparent;
  box-shadow:0 1px 2px rgba(90,60,20,.06)}
.id{font-size:11px;color:var(--faint)}
.imp{display:inline-flex;gap:2.5px}
.imp i{width:5px;height:5px;border-radius:50%;background:var(--line);display:block}
.imp i.on{background:var(--hc,var(--dim))}
.hat{font-size:10.5px;color:var(--hc,var(--faint));text-transform:uppercase;letter-spacing:.09em;
  font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.title{font-weight:460;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{display:flex;align-items:center;gap:.4rem;white-space:nowrap;font-size:11px;color:var(--faint)}
.eff{border:1px solid var(--line);border-radius:5px;padding:0 .32rem;font-size:10px;
  color:var(--dim);font-weight:700}
.f{font-size:10.5px;font-weight:650;padding:.11rem .42rem;border-radius:5px}
.f.od{color:var(--od);background:var(--ods)}
.f.due{color:var(--dim);background:var(--hair)}
.f.wt{color:var(--wt);background:color-mix(in srgb,var(--wt) 13%,transparent)}
.f.gt,.f.fx,.f.kd{color:var(--faint);background:var(--hair);font-weight:520}
.f.bl{color:var(--wt);background:color-mix(in srgb,var(--wt) 13%,transparent)}
.f.st{color:var(--bg);background:var(--accent)}
.rel{margin:.1rem 0 .9rem;font-size:12.5px;color:var(--dim)}
.rel a{color:var(--accent);text-decoration:none;font-weight:560}
.rel a:hover{text-decoration:underline}
.rel.blockedby{color:var(--wt)}
.rel.blockedby a{color:var(--wt)}
.kids{display:flex;flex-direction:column;gap:.35rem}
.kid{display:flex;align-items:center;gap:.6rem;font-size:13px;text-decoration:none;color:var(--fg);
  background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:.5rem .7rem}
.kid:hover{border-color:var(--accent);color:var(--accent)}
.kid.isdone{opacity:.5;text-decoration:line-through}
.kst{font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);
  background:var(--hair);padding:.15rem .4rem;border-radius:4px;flex:none;min-width:3.6rem;text-align:center}
.f.un{color:var(--accent);background:var(--soft)}
.dim{font-variant-numeric:tabular-nums;min-width:2rem;text-align:right}

/* hero */
.hero{border:1px solid var(--line);border-left:4px solid var(--hc,var(--accent));background:var(--panel);
  border-radius:var(--r);box-shadow:var(--shadow);padding:1.4rem 1.5rem 1.25rem;cursor:pointer;
  transition:.15s}
.hero:hover{box-shadow:0 2px 4px rgba(90,60,20,.07),0 18px 40px -22px rgba(90,60,20,.4);
  transform:translateY(-1px)}
.eyebrow{display:flex;align-items:center;gap:.55rem;flex-wrap:wrap;margin-bottom:.7rem}
.eyebrow code{font-size:11px;color:var(--faint)}
.hchip{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;
  color:var(--hc);background:color-mix(in srgb,var(--hc) 12%,transparent);
  padding:.15rem .5rem;border-radius:5px}
.hero h3{margin:0 0 .7rem;font-size:22px;line-height:1.28;font-weight:650;letter-spacing:-.02em}
.hero .na{margin:0;color:var(--dim);font-size:14px;line-height:1.6;
  padding-left:.95rem;border-left:2px solid color-mix(in srgb,var(--hc) 30%,transparent)}
.hero .more{margin:.9rem 0 0;font-size:12px;color:var(--accent);font-weight:600;opacity:.75}
.hero:hover .more{opacity:1}

/* empty */
.empty{background:var(--panel);border:1px dashed var(--line);border-radius:var(--r);
  padding:2rem;text-align:center;color:var(--dim)}
.empty b{display:block;font-size:17px;color:var(--fg);margin-bottom:.3rem}

/* modal */
.modal{position:fixed;inset:0;z-index:50;display:flex;align-items:flex-start;justify-content:center;
  padding:4vh 1.25rem;overflow:auto;background:color-mix(in srgb,var(--fg) 32%,transparent);
  backdrop-filter:blur(3px)}
.modal[hidden]{display:none}
.sheet{background:var(--bg);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);
  width:min(760px,100%);padding:2rem 2.1rem 2.2rem;position:relative}
.x{position:absolute;top:1rem;right:1rem;border:0;background:var(--hair);color:var(--dim);
  width:30px;height:30px;border-radius:50%;font-size:17px;line-height:1}
.x:hover{background:var(--line);color:var(--fg)}
.sheet h2{margin:.55rem 0 1.1rem;font-size:25px;line-height:1.25;font-weight:660;letter-spacing:-.022em;
  padding-right:2rem}
.block{margin-bottom:1.5rem}
.block h4{margin:0 0 .45rem;font-size:10.5px;font-weight:750;text-transform:uppercase;
  letter-spacing:.14em;color:var(--faint)}
.block p{margin:0 0 .6rem;line-height:1.65;color:var(--fg)}
.block ul{margin:0;padding-left:1.15rem;color:var(--dim)}
.block li{margin-bottom:.25rem}
.block li.ck{color:var(--dim);text-decoration:line-through;opacity:.65}
.block code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;
  background:var(--hair);border-radius:4px;padding:.06em .32em;word-break:break-word}
.block strong{color:var(--fg);font-weight:640}
.block table{border-collapse:collapse;width:100%;margin:.2rem 0 .7rem;font-size:13px;display:block;overflow-x:auto}
.block th{text-align:left;font-size:10px;font-weight:750;text-transform:uppercase;letter-spacing:.06em;
  color:var(--dim);border-bottom:1px solid var(--line);padding:.3rem .55rem .3rem 0;white-space:nowrap}
.block td{border-bottom:1px solid var(--hair);padding:.4rem .55rem .4rem 0;vertical-align:top;line-height:1.5}
.nextbox{background:var(--soft);border-left:3px solid var(--accent);border-radius:0 10px 10px 0;
  padding:.85rem 1rem}
.nextbox p{margin:0;color:var(--fg)}
.replybox{background:var(--hair);border:1px solid var(--line);border-radius:10px;padding:.9rem 1.05rem}
.replybox p{margin:0 0 .55rem}
.replybox p:last-child{margin-bottom:0}
.sources{border-top:1px solid var(--line);padding-top:1.2rem;margin-bottom:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:.9rem 1.2rem}
.grid dt{font-size:10.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--faint);
  font-weight:700;margin-bottom:.15rem}
.grid dd{margin:0;font-size:13.5px}
.arts{display:flex;flex-direction:column;gap:.4rem}
.art{display:flex;align-items:center;gap:.6rem;font-size:12.5px;text-decoration:none;color:var(--fg);
  background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:.5rem .7rem;min-width:0}
a.art:hover{border-color:var(--accent);color:var(--accent)}
.art .k{font-family:ui-monospace,monospace;font-size:9.5px;text-transform:uppercase;letter-spacing:.07em;
  color:var(--faint);background:var(--hair);padding:.15rem .4rem;border-radius:4px;flex:none}
.art .l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tags span{display:inline-block;font-size:11.5px;color:var(--dim);background:var(--hair);
  border-radius:5px;padding:.1rem .45rem;margin:0 .3rem .3rem 0}
.tags span::before{content:"#";opacity:.5}

@media(max-width:760px){
  .rows>.item:not(.hero){grid-template-columns:2.4rem 1.8rem minmax(0,1fr);row-gap:.2rem}
  .hat{grid-column:1/3}.meta{grid-column:3;justify-content:flex-end}
  .sheet{padding:1.5rem 1.25rem 1.75rem}
}
</style>

<div class="wrap">
<header>
  <div class="brand"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="var(--brand)"/><path d="M9 16.8l4.6 4.6L23 11.4" stroke="#fff" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>Worklist</div>
  <p class="today">${niceDate}</p>
</header>

<div class="controls">
  <div class="seg">
    ${BANDS.filter((s) => band(s).length).map((s) => `<button data-f="status:${s}"${s === 'now' ? ' class="on"' : ''}>${s}<em>${band(s).length}</em></button>`).join('')}
    ${parked.length ? `<button data-f="status:__parked">parked<em>${parked.length}</em></button>` : ''}
    <button data-f="all">all<em>${items.length}</em></button>
  </div>
  <div class="hats">
    ${hats.map((h) => `<button class="h-${h}" data-f="hat:${h}">${h}</button>`).join('')}
  </div>
  <div class="tracks">
    ${TRACKS.map((t) => [t, items.filter((i) => i.labels.includes(t) && !CLOSED.has(i.status)).length])
      .filter(([, n]) => n)
      .map(([t, n]) => `<button data-f="label:${t}">${t}<em>${n}</em></button>`).join('')}
  </div>
  ${fixtures.length ? '<button class="toggle" id="fxtoggle">hide fixtures</button>' : ''}
</div>

<div class="stats" id="stats" hidden>
  <div><b>${items.length}</b>items</div>
  <div class="${overdue.length ? 'alert' : ''}"><b>${overdue.length}</b>past their date</div>
  <div class="${chases.length ? 'alert' : ''}"><b>${chases.length}</b>waiting on someone</div>
  <div><b>${parked.length}</b>parked</div>
  ${fixtures.length ? `<div><b>${fixtures.length}</b>fabricated fixtures</div>` : ''}
</div>

${sections}
<div class="empty" id="empty" hidden>${items.length
  ? '<b>Nothing in this view.</b>Pick another band above.'
  : '<b>Clean slate.</b>Paste links into the session and they get filed here.'}</div>
</div>

<div class="modal" id="modal" hidden><div class="sheet" role="dialog" aria-modal="true">
  <button class="x" id="close" aria-label="Close">&times;</button>
  <div id="sheetbody"></div>
</div></div>

<script id="data" type="application/json">${JSON.stringify(payload).replace(/</g, '\\u003c')}</script>
<script>
var DATA={};JSON.parse(document.getElementById('data').textContent).forEach(function(o){DATA[o.id]=o});
// Bands, hats and tracks are ONE radio set, never a combination: you are looking at a band, or
// at a hat, or at a track. Combining them was the bug — a hat left selected silently narrowed
// every later view, and a track landed you in the band filter's default where the band holding
// the items (later) is collapsed, so the click looked like it did nothing.
var chips=[].slice.call(document.querySelectorAll('.controls [data-f]')),
    rows=[].slice.call(document.querySelectorAll('.item')),
    bands=[].slice.call(document.querySelectorAll('.band')),
    stats=document.getElementById('stats'),
    empty=document.getElementById('empty'),
    fxBtn=document.getElementById('fxtoggle'),
    HOME='status:now', sel=HOME, hideFx=false;

function match(r){
  if(hideFx&&r.dataset.real==='no')return false;
  if(sel==='all')return true;
  var p=sel.split(':'), v=p[1];
  if(p[0]==='hat')return r.dataset.hat===v;
  if(p[0]==='label')return (' '+(r.dataset.labels||'')+' ').indexOf(' '+v+' ')>-1;
  if(v==='__parked')return r.closest('[data-band=parked]')!==null;
  return r.dataset.status===v&&r.closest('[data-band=parked]')===null;
}
function apply(){
  var any=false;
  rows.forEach(function(r){r.hidden=!match(r);if(!r.hidden)any=true});
  bands.forEach(function(b){
    var hits=[].slice.call(b.querySelectorAll('.item')).filter(function(r){return !r.hidden}),
        vis=hits.length>0, c=b.querySelector('.bcount');
    // Show the filtered count, not the band total: "later 38" above a single row reads as a
    // filter that did not work. Keep the x/CAP form whenever nothing is filtered out of this
    // band, so the WIP caps stay visible in the band views.
    if(c)c.textContent = hits.length===+c.dataset.total ? c.dataset.full : hits.length;
    b.hidden=!vis;
    // A hat or a track spans bands, so open every band that has a hit. Only the unfiltered
    // "all" view keeps the collapsed-by-default shape.
    b.open = sel==='all' ? b.dataset.defaultOpen==='1' : vis;
  });
  // The stats row counts every item, so it only tells the truth in the unfiltered view.
  stats.hidden = sel!=='all';
  empty.hidden = any;
  chips.forEach(function(c){c.classList.toggle('on',c.dataset.f===sel)});
}
// Clicking the active chip returns to the default band view, so one click always gets you home.
chips.forEach(function(c){c.onclick=function(){
  sel=(sel===c.dataset.f&&c.dataset.f!==HOME)?HOME:c.dataset.f;apply()}});
if(fxBtn)fxBtn.onclick=function(){hideFx=!hideFx;fxBtn.classList.toggle('on',hideFx);apply()};

// Item bodies are markdown written by an agent and land here via innerHTML, so they MUST be
// escaped first. Unescaped, a body that quotes a tag (<Script id="x">) opens an element the
// parser never closes and silently swallows every block after it — the item looks empty.
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function inline(s){
  return esc(s)
    .replace(/\`([^\`]+)\`/g,'<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
}
function cells(l){return l.replace(/^\\s*\\|/,'').replace(/\\|\\s*$/,'').split('|')}
// A wrapped bullet ("- long text\\n      continued") is one item, not two lines, else the whole
// block fails the all-bullets test and collapses into a paragraph.
function fold(ls){
  var out=[];
  ls.forEach(function(l){
    if(out.length&&/^\\s{2,}(?!-\\s)\\S/.test(l)&&/^\\s*-\\s/.test(out[out.length-1]))out[out.length-1]+=' '+l.trim();
    else out.push(l);
  });
  return out;
}
function para(t){
  if(!t)return '';
  return t.split(/\\n\\s*\\n/).map(function(p){
    var lines=fold(p.split('\\n'));
    if(lines.length>1&&lines.every(function(l){return /^\\s*\\|/.test(l)})){
      var rows=lines.filter(function(l){return !/^[\\s|:-]+$/.test(l)});
      return '<table>'+rows.map(function(l,n){
        var tag=n===0?'th':'td';
        return '<tr>'+cells(l).map(function(c){
          return '<'+tag+'>'+inline(c.trim())+'</'+tag+'>'}).join('')+'</tr>';
      }).join('')+'</table>';
    }
    if(lines.every(function(l){return /^\\s*-\\s/.test(l)})){
      var h='',depth=0;
      lines.forEach(function(l){
        var d=l.match(/^\\s*/)[0].length>=2?1:0;
        while(depth<d){h+='<ul>';depth++}
        while(depth>d){h+='</ul>';depth--}
        h+='<li'+(/^\\s*-\\s*\\[x\\]/i.test(l)?' class="ck"':'')+'>'+
          inline(l.replace(/^\\s*-\\s*(\\[[ x]\\]\\s*)?/i,''))+'</li>';
      });
      while(depth>0){h+='</ul>';depth--}
      return '<ul>'+h+'</ul>';
    }
    return '<p>'+inline(p).replace(/\\n/g,' ')+'</p>';
  }).join('');
}
function field(k,v){return v?'<div><dt>'+k+'</dt><dd>'+v+'</dd></div>':''}

var modal=document.getElementById('modal'),sheet=document.getElementById('sheetbody');
function open(id){
  var o=DATA[id];if(!o)return;
  var h='<div class="eyebrow h-'+o.hat+'"><code>'+o.id+'</code>'+
    '<span class="hchip">'+o.hat+'</span><span class="eff">'+o.effort+'</span>'+
    (o.overdue?'<b class="f od">'+(-o.dueIn)+'d over</b>':'')+
    (o.fixture?'<b class="f fx">fixture</b>':'')+'</div>'+
    '<h2>'+o.title+'</h2>';
  if(o.parent)h+='<p class="rel">Part of <a href="#" data-go="'+o.parent.id+'">'+o.parent.id+' &middot; '+o.parent.title+'</a></p>';
  if(o.blockers.length)h+='<p class="rel blockedby">Blocked by '+o.blockers.map(function(b){
    return '<a href="#" data-go="'+b.id+'">'+b.id+' &middot; '+b.title+'</a>'}).join(', ')+'</p>';
  if(o.body.next)h+='<div class="block nextbox"><h4>Next action</h4>'+para(o.body.next)+'</div>';
  if(o.kids.length)h+='<div class="block"><h4>Sub-items ('+o.kids.length+')</h4><div class="kids">'+
    o.kids.map(function(k){return '<a href="#" data-go="'+k.id+'" class="kid'+
      (k.status==='done'?' isdone':'')+'"><span class="kst">'+k.status+'</span>'+k.title+'</a>'}).join('')+'</div></div>';
  h+='<div class="block"><h4>Details</h4><dl class="grid">'+
    field('Status',o.status)+field('Impact',o.impact+' of 3')+field('Effort',o.effort)+
    field('Owner',o.owner||'<span style="color:var(--accent)">unowned</span>')+
    field('Due',o.due?o.due+' <span style="color:var(--faint)">('+o.due_source+')</span>':'')+
    field(o.gated?'Gated until':'Waiting on',o.waiting_on)+
    field('Created',o.created+' <span style="color:var(--faint)">('+o.age+'d ago)</span>')+
    field('Visibility',o.visibility)+'</dl></div>';
  if(o.body.why)h+='<div class="block"><h4>Why this matters</h4>'+para(o.body.why)+'</div>';
  if(o.body.reply)h+='<div class="block"><h4>Reply draft &mdash; paste and send</h4>'+
    '<div class="replybox">'+para(o.body.reply)+'</div></div>';
  if(o.body.captured)h+='<div class="block"><h4>Captured content</h4>'+para(o.body.captured)+'</div>';
  if(o.body.log)h+='<div class="block"><h4>Log</h4>'+para(o.body.log)+'</div>';
  if(o.labels.length)h+='<div class="block"><h4>Labels</h4><p class="tags">'+
    o.labels.map(function(l){return '<span>'+l+'</span>'}).join('')+'</p></div>';
  if(o.artifacts.length)h+='<div class="block sources"><h4>Sources ('+o.artifacts.length+')</h4><div class="arts">'+
    o.artifacts.map(function(a){
      var inner='<span class="k">'+a.kind+'</span><span class="l">'+a.label+'</span>';
      return a.url?'<a class="art" href="'+a.url+'">'+inner+'</a>':'<span class="art">'+inner+'</span>';
    }).join('')+'</div></div>';
  sheet.innerHTML=h;modal.hidden=false;document.body.style.overflow='hidden';
  [].slice.call(sheet.querySelectorAll('[data-go]')).forEach(function(a){
    a.onclick=function(e){e.preventDefault();open(a.dataset.go)}});
}
function close(){modal.hidden=true;document.body.style.overflow=''}
rows.forEach(function(r){r.onclick=function(){open(r.dataset.id)}});
document.getElementById('close').onclick=close;
modal.onclick=function(e){if(e.target===modal)close()};
document.addEventListener('keydown',function(e){if(e.key==='Escape')close()});
apply();
</script>`;

// ---------- write ----------

mkdirSync(VIEWS, { recursive: true });
writeFileSync(join(VIEWS, 'index.md'), index);
writeFileSync(join(VIEWS, 'today.md'), todayMd + '\n');
writeFileSync(join(VIEWS, 'waiting.md'), waitingMd);
writeFileSync(join(VIEWS, 'index.html'), html);

console.log(`rendered ${items.length} items -> views/{index.md,today.md,waiting.md,index.html}`);
console.log(`  now ${nowB.length}/${CAPS.now} · side ${sideB.length}/${CAPS.side} · next ${nextB.length}/${CAPS.next}`);
console.log(`  overdue ${overdue.length} · chases ${chases.length} · parked ${parked.length}`);
const LIVE_BANDS = { now: nowB, side: sideB, next: nextB };
const over = Object.keys(LIVE_BANDS).filter((s) => LIVE_BANDS[s].length > CAPS[s]);
const under = Object.keys(LIVE_BANDS).filter((s) => LIVE_BANDS[s].length < CAPS[s]);
const fmtBands = (ks) => ks.map((s) => `${s} ${LIVE_BANDS[s].length}/${CAPS[s]}`).join(', ');
console.log(`  overflow: ${CONFIG.overflow}`);
if (over.length) console.log(`  ${ENFORCED ? '⚠ OVER CAP' : 'over tolerated cap'}: ${fmtBands(over)}`);
// Under-full is a filing gap, not an overflow fault, so it is reported in every mode: a band
// with a free slot means something in `later` should have been promoted into it.
if (under.length) console.log(`  under-full, promote from later: ${fmtBands(under)}`);
if (tabConfigs) console.log(`  ${tabConfigs} warp tab config(s) -> ${TAB_CONFIGS}`);
