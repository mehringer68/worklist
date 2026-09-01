#!/usr/bin/env node
// Generates FABRICATED items so the design can be reviewed at realistic volume.
// Nothing here is pulled from a real system. Every generated item carries `fixture: true`.
//
//   node worklist/bin/make-fixtures.mjs           generate
//   node worklist/bin/make-fixtures.mjs --clean   remove every fixture, leave real items

import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ITEMS = join(dirname(fileURLToPath(import.meta.url)), '..', 'items');
const ago = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const ahead = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

if (process.argv.includes('--clean')) {
  let n = 0;
  for (const f of readdirSync(ITEMS).filter((f) => f.endsWith('.md'))) {
    if (/^fixture:\s*true$/m.test(readFileSync(join(ITEMS, f), 'utf8'))) {
      unlinkSync(join(ITEMS, f));
      n++;
    }
  }
  console.log(`removed ${n} fixtures`);
  process.exit(0);
}

// [slug, title, status, hat, impact, effort, dueOffset|null, dueSource, owner, waiting_on,
//  labels, artifactCount, createdDaysAgo, why, next]
const SPECS = [
  ['checkout-502s', 'Investigate intermittent 502s on the checkout pod during peak hours', 'side', 'investigate', 3, 'M', null, 'none', 'you', '', ['checkout', 'reliability'], 4, 12,
    'Sporadic 502s clustered around 11:00-13:00 on weekdays. No pattern established yet; could be pod eviction, upstream timeout, or connection-pool exhaustion.',
    'Pull a week of ingress logs and bucket by upstream status to separate origin failures from gateway timeouts.'],

  ['tenant-onboard-checklist', 'Write the go-live checklist for the next white-label tenant', 'next', 'pm', 2, 'M', 21, 'external', 'you', '', ['tenant', 'process'], 2, 30,
    'Every tenant launch rediscovers the same eight steps. A checklist turns tribal knowledge into something another person can run.',
    'Reconstruct the last two launches from ticket history and turn the common path into a checklist.'],
  ['search-facet-audit', 'Audit search facet configuration across all tenants', 'next', 'investigate', 2, 'L', null, 'none', '', '', ['search', 'performance'], 3, 45,
    'Facet counts have grown organically per tenant and nobody has looked at the aggregate cost.',
    'Export facet config per tenant, count faceted fields, and rank by query cost.'],
  ['dead-letter-queue', 'Add a dead-letter path to the job dispatcher so failed jobs stop re-dispatching forever', 'next', 'infra', 3, 'M', null, 'none', 'you', '', ['jobs', 'resilience'], 5, 60,
    'Failed jobs currently re-dispatch without an attempt cap. One poisoned job can occupy a worker indefinitely.',
    'Add attempt counting and a dead-letter table, then alert on non-empty.'],
  ['image-cdn-costs', 'Review image CDN egress costs against the contracted allowance', 'next', 'infra', 2, 'S', 10, 'committed', 'you', '', ['cost', 'cdn'], 2, 18,
    'Egress has grown roughly 30% quarter over quarter with no corresponding traffic growth, which suggests cache misses rather than demand.',
    'Pull three months of egress by cache status and identify the miss sources.'],
  ['a11y-keyboard-nav', 'Fix keyboard navigation traps in the product filter drawer', 'next', 'review', 2, 'S', null, 'none', '', '', ['accessibility', 'frontend'], 1, 25,
    'Focus is trapped inside the drawer once opened and Escape does not close it. Fails basic keyboard operability.',
    'Reproduce with keyboard only, add a focus trap release and Escape handler.'],
  ['stale-feature-flags', 'Remove feature flags that have been fully rolled out for more than six months', 'next', 'tooling', 1, 'M', null, 'none', '', '', ['tech-debt', 'flags'], 0, 90,
    'Roughly forty flags are permanently on. Each is a branch in the code that nobody tests the false side of.',
    'List flags by last toggle date and delete the ones on for six months or more.'],
  ['runbook-db-failover', 'Write a runbook for database failover so it is not a single-person operation', 'next', 'infra', 3, 'M', null, 'none', 'you', '', ['runbook', 'resilience', 'bus-factor'], 2, 40,
    'An unrehearsed failover is a bus factor of one on the most consequential operation there is.',
    'Document the sequence from the last failover and have someone else dry-run it.'],
  ['quarterly-cost-summary', 'Produce the quarterly infrastructure cost summary for the finance review', 'next', 'analysis', 2, 'M', 14, 'external', 'you', '', ['cost', 'reporting'], 3, 8,
    'Finance needs a breakdown by environment and tenant ahead of the quarterly review. Last quarter this was assembled the night before.',
    'Extend the existing breakdown script to emit the finance-facing rollup.'],

  ['upgrade-node-runtime', 'Upgrade the service runtime to the current LTS before the old one drops out of support', 'waiting', 'infra', 2, 'L', 60, 'external', 'you', 'Sam', ['upgrade', 'security'], 2, 22,
    'The current runtime leaves security support in a few months. The upgrade itself is mechanical; the risk is in the dependency tree.',
    'Blocked on Sam confirming the staging window.'],
  ['vendor-sso-rollout', 'Enable SSO on the monitoring vendor so access reviews stop being manual', 'waiting', 'admin', 1, 'S', null, 'none', 'you', 'Priya', ['sso', 'access'], 1, 35,
    'Per-user logins with no SSO leave offboarding to a manual checklist. SSO removes an entire class of mistake.',
    'Waiting on Priya for the identity provider metadata.'],
  ['contract-renewal-terms', 'Get the revised terms for the search vendor renewal', 'waiting', 'admin', 2, 'S', 30, 'external', 'you', 'Jonas', ['vendor', 'contract'], 2, 14,
    'Renewal lands next quarter and the current query allowance no longer matches actual usage.',
    'Waiting on Jonas for the revised commercial terms.'],
  ['design-tokens-handoff', 'Receive the design token export so the component library can be aligned', 'waiting', 'review', 1, 'M', null, 'none', '', 'Nina', ['design-system'], 1, 9,
    'Component colours have drifted from the design source. A token export closes the gap permanently rather than per-component.',
    'Waiting on Nina for the export.'],
  ['legal-dpa-review', 'Get the data processing addendum reviewed before the new subprocessor goes live', 'waiting', 'admin', 3, 'S', 7, 'external', 'you', 'Alex', ['legal', 'compliance'], 1, 20,
    'The subprocessor cannot be enabled until the addendum is signed. Go-live is gated on it.',
    'Waiting on Alex in legal.'],

  ['perf-budget-frontend', 'Set a performance budget for the storefront and fail CI when it is exceeded', 'later', 'tooling', 2, 'M', null, 'none', '', '', ['performance', 'ci'], 1, 70,
    'Bundle size grows monotonically because nothing objects to it. A budget makes the tradeoff explicit at review time.',
    'Pick the metric and threshold, then wire it into the existing pipeline.'],
  ['archive-old-tenants', 'Archive configuration for tenants that never went live', 'later', 'admin', 1, 'S', null, 'none', '', '', ['cleanup'], 0, 110,
    'Configuration for tenants that never launched is carried through every migration for no reason.',
    'Confirm with the account side, then archive.'],
  ['loadtest-harness', 'Build a repeatable load-test harness so capacity questions stop being guesses', 'later', 'tooling', 2, 'L', null, 'none', 'you', '', ['testing', 'capacity'], 2, 55,
    'Every capacity question is currently answered by reasoning about past incidents rather than by measurement.',
    'Pick a tool, model one realistic journey, get a baseline.'],
  ['docs-site-refresh', 'Refresh the internal docs site — half the pages describe a system that no longer exists', 'later', 'tooling', 1, 'L', null, 'none', '', '', ['docs', 'tech-debt'], 1, 130,
    'Stale docs are worse than no docs because people act on them.',
    'Audit pages by last-modified, delete rather than update where the system is gone.'],

  ['security-training', 'Complete the annual security training module', 'later', 'admin', 1, 'S', null, 'none', 'you', ahead(45), ['mandatory'], 1, 5,
    'Annual compliance requirement. Not due until the autumn window opens.',
    'Nothing until the window opens.'],
  ['budget-planning-cycle', 'Prepare infrastructure input for the next budget planning cycle', 'later', 'analysis', 2, 'M', null, 'none', 'you', ahead(70), ['planning', 'cost'], 1, 15,
    'Planning input is requested each cycle. Preparing it early is wasted work because the numbers move.',
    'Nothing until the cycle opens.'],

  ['ticket-template-rollout', 'Roll out the standard ticket template across the board', 'done', 'pm', 2, 'S', null, 'none', 'you', '', ['process'], 2, 40,
    'Tickets arrived in inconsistent shapes, which made triage slow.',
    'Done — template applied and adopted.'],
  ['redis-memory-alert', 'Add an alert for Redis memory approaching the eviction threshold', 'done', 'infra', 3, 'S', null, 'none', 'you', '', ['alerting', 'redis'], 3, 52,
    'Memory pressure was previously only discovered after eviction caused visible failures.',
    'Done — alert live and has fired once correctly.'],
  ['pr-review-rotation', 'Set up a review rotation so PRs stop waiting on one person', 'done', 'review', 2, 'S', null, 'none', 'you', '', ['process', 'review'], 1, 65,
    'Review latency was dominated by a single reviewer being the default.',
    'Done — rotation in place.'],
  ['staging-data-refresh', 'Automate the staging data refresh instead of doing it by hand each month', 'done', 'tooling', 2, 'M', null, 'none', 'you', '', ['staging', 'automation'], 2, 80,
    'The manual refresh took half a day and was skipped whenever things were busy, which is when it mattered most.',
    'Done — scheduled and running.'],
  ['incident-comms-template', 'Write the incident communication template so status updates are not improvised', 'done', 'incident', 2, 'S', null, 'none', 'you', '', ['incident', 'process'], 1, 95,
    'Status updates during incidents were written from scratch under pressure and varied wildly in quality.',
    'Done — template in use for the last two incidents.'],

  ['rewrite-in-rust', 'Rewrite the import pipeline in a faster language', 'dropped', 'infra', 1, 'L', null, 'none', '', '', ['rejected'], 0, 150,
    'Considered and rejected. The pipeline is IO-bound, so the language is not the constraint. Kept as a record so it is not re-proposed.',
    'Dropped — not the bottleneck.'],
  ['custom-dashboard-tool', 'Build an in-house dashboard tool instead of using the vendor one', 'dropped', 'tooling', 1, 'L', null, 'none', '', '', ['rejected'], 1, 120,
    'Rejected on maintenance cost. The vendor tool is adequate and the build would need permanent ownership.',
    'Dropped — buy over build.'],
];

const ART = [
  'jira:DEMO-101 | DEMO-101 example ticket | https://example.invalid/browse/DEMO-101',
  'slack:C0DEMO:1750000000.0001 | thread in #demo-channel | https://example.invalid/archives/C0DEMO',
  'pr:demo/repo#42 | PR #42 example change | https://example.invalid/pull/42',
  'email:<demo-001@example.invalid> | Re: example thread — 3 replies | readdle-spark://message/demo-001',
  'web:demo-dashboard | dashboard panel | https://example.invalid/d/demo',
  'claude:00000000-0000-0000-0000-000000000001 | earlier session — resume with `claude --resume 00000000-0000-0000-0000-000000000001` | ',
  'file:repo | notes/demo-analysis.md | ./notes/demo-analysis.md',
  'web:confluence | background page | https://example.invalid/wiki/demo',
];

let n = 0;
for (const [slug, title, status, hat, impact, effort, dueOff, dueSrc, owner, waitOn, labels, arts, created, why, next] of SPECS) {
  const id = `f${String(++n).padStart(3, '0')}`;
  const fm = [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    'fixture: true',
    `status: ${status}`,
    `hat: ${hat}`,
    `impact: ${impact}`,
    `effort: ${effort}`,
    `due: ${dueOff === null ? '' : ahead(dueOff)}`,
    `due_source: ${dueSrc}`,
    `owner: ${owner}`,
    `waiting_on: ${waitOn}`,
    'labels:',
    ...labels.map((l) => `  - ${l}`),
    'visibility: private',
    `created: ${ago(created)}`,
    'artifacts:',
    ...ART.slice(0, arts).map((a) => `  - "${a}"`),
    '---',
  ].join('\n');

  const body = `\n## Why this matters\n\n${why}\n\n## Next action\n\n${next}\n\n## Log\n\n- ${ago(created)} captured\n\n## Captured\n`;
  writeFileSync(join(ITEMS, `${id}-${slug}.md`), fm + body);
}

// One deliberately overdue fixture, so the overdue path is visible.
writeFileSync(
  join(ITEMS, 'f900-overdue-capacity-note.md'),
  `---
id: f900
title: Send the capacity note that was promised at the last planning session
fixture: true
status: side
hat: pm
impact: 2
effort: S
due: ${ago(45)}
due_source: committed
owner: you
waiting_on:
labels:
  - capacity
  - overdue-demo
visibility: private
created: ${ago(60)}
artifacts:
  - "${ART[3]}"
---

## Why this matters

Promised at planning and never sent. Demonstrates a long-overdue item with a *committed*
due source, which is the kind the system should surface loudest.

## Next action

Write it or renegotiate the commitment. Both are fine; silence is not.

## Log

- ${ago(60)} promised

## Captured
`
);

console.log(`generated ${n + 1} fixtures`);
