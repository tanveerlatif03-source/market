/**
 * The human's window on the room.
 *
 * One self-contained page — no build step, no CDN, nothing to install. It is
 * built from DOM nodes rather than HTML strings, so text written by an agent is
 * never interpreted as markup.
 */
export function dashboardHtml(): string {
  return PAGE;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark light" />
<title>Agora</title>
<style>
/* ---------------------------------------------------------------- tokens */
:root {
  --bg: #f4f5f8;
  --surface: #ffffff;
  --sunken: #f4f6f9;
  --line: #dfe3ea;
  --hairline: #eaedf2;
  --ink: #15171c;
  --ink-2: #5a616e;
  --ink-3: #9097a5;
  --accent: #2f6fd0;
  --accent-wash: rgba(47, 111, 208, 0.09);
  --good: #169163;
  --good-wash: rgba(22, 145, 99, 0.1);
  --warn: #a97708;
  --warn-wash: rgba(169, 119, 8, 0.1);
  --bad: #c2483d;
  --bad-wash: rgba(194, 72, 61, 0.09);
  --shadow: 0 1px 2px rgba(16, 20, 28, 0.05), 0 8px 24px -14px rgba(16, 20, 28, 0.18);
  --radius: 14px;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
:root[data-theme="dark"], :root:not([data-theme="light"]) {
  --bg: #0a0b0e;
  --surface: #111318;
  --sunken: #0d0f13;
  --line: #21242c;
  --hairline: #191c22;
  --ink: #e9ebef;
  --ink-2: #a2a9b6;
  --ink-3: #6c7382;
  --accent: #74a9ff;
  --accent-wash: rgba(116, 169, 255, 0.11);
  --good: #57cf98;
  --good-wash: rgba(87, 207, 152, 0.12);
  --warn: #f0b64c;
  --warn-wash: rgba(240, 182, 76, 0.12);
  --bad: #f2786b;
  --bad-wash: rgba(242, 120, 107, 0.12);
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 12px 32px -18px rgba(0, 0, 0, 0.8);
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg: #f4f5f8;
    --surface: #ffffff;
    --sunken: #f4f6f9;
    --line: #dfe3ea;
    --hairline: #eaedf2;
    --ink: #15171c;
    --ink-2: #5a616e;
    --ink-3: #9097a5;
    --accent: #2f6fd0;
    --accent-wash: rgba(47, 111, 208, 0.09);
    --good: #169163;
    --good-wash: rgba(22, 145, 99, 0.1);
    --warn: #a97708;
    --warn-wash: rgba(169, 119, 8, 0.1);
    --bad: #c2483d;
    --bad-wash: rgba(194, 72, 61, 0.09);
    --shadow: 0 1px 2px rgba(16, 20, 28, 0.05), 0 8px 24px -14px rgba(16, 20, 28, 0.18);
  }
}

/* ----------------------------------------------------------------- reset */
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 400 14px/1.6 var(--sans);
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
}
button, input, select { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
::selection { background: var(--accent-wash); }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }

/* -------------------------------------------------------------- primitives */
.mono { font-family: var(--mono); font-size: 12px; letter-spacing: -0.01em; }
.muted { color: var(--ink-2); }
.faint { color: var(--ink-3); }
.hide { display: none !important; }

.chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: var(--mono); font-size: 11px; line-height: 1;
  padding: 4px 8px; border-radius: 999px;
  background: var(--sunken); color: var(--ink-2);
  border: 1px solid var(--hairline); white-space: nowrap;
}
.chip--accent { background: var(--accent-wash); color: var(--accent); border-color: transparent; }
.chip--good   { background: var(--good-wash);   color: var(--good);   border-color: transparent; }
.chip--warn   { background: var(--warn-wash);   color: var(--warn);   border-color: transparent; }
.chip--bad    { background: var(--bad-wash);    color: var(--bad);    border-color: transparent; }

.btn {
  padding: 6px 12px; border-radius: 8px; cursor: pointer;
  background: var(--surface); border: 1px solid var(--line); color: var(--ink-2);
  font-size: 13px; transition: border-color .15s, color .15s, background .15s, transform .1s;
}
.btn:hover { color: var(--ink); border-color: var(--ink-3); }
.btn:active { transform: translateY(1px); }
.btn--primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 500; }
.btn--primary:hover { color: #fff; filter: brightness(1.08); }
.btn--quiet { background: transparent; border-color: transparent; padding: 6px 9px; }
.btn--quiet:hover { background: var(--sunken); border-color: var(--hairline); }
.btn--danger:hover { color: var(--bad); border-color: var(--bad); }

select.btn { padding-right: 8px; }

.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); flex: none; }
.dot--live { background: var(--good); box-shadow: 0 0 0 0 var(--good-wash); animation: pulse 2.4s ease-out infinite; }
.dot--warn { background: var(--warn); }
.dot--bad  { background: var(--bad); }
@keyframes pulse {
  0%   { box-shadow: 0 0 0 0 var(--good-wash); }
  70%  { box-shadow: 0 0 0 7px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}

.avatar {
  width: 26px; height: 26px; border-radius: 8px; flex: none;
  display: grid; place-items: center;
  font-family: var(--mono); font-size: 12px; font-weight: 600; color: #fff;
}

/* ------------------------------------------------------------------ shell */
.topbar {
  position: sticky; top: 0; z-index: 20;
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter: saturate(180%) blur(12px);
  border-bottom: 1px solid var(--hairline);
}
.topbar__inner {
  max-width: 1240px; margin: 0 auto; padding: 14px 24px;
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
}
.topbar__title { font-size: 17px; font-weight: 600; letter-spacing: -0.02em; margin: 0; }
.topbar__goal { color: var(--ink-2); font-size: 13px; margin: 1px 0 0; }
.spacer { flex: 1 1 auto; }

.wrap { max-width: 1240px; margin: 0 auto; padding: 22px 24px 96px; }
.columns { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 20px; align-items: start; }
.rail { position: sticky; top: 78px; }
@media (max-width: 980px) {
  .columns { grid-template-columns: minmax(0, 1fr); }
  .rail { position: static; }
}

.card {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom: 20px;
}
.card__head {
  display: flex; align-items: center; gap: 10px;
  padding: 13px 18px; border-bottom: 1px solid var(--hairline);
}
.card__title {
  margin: 0; font-size: 11px; font-weight: 600;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3);
}
.card__count { margin-left: auto; }
.card__body { padding: 6px 18px 14px; }
.empty { color: var(--ink-3); padding: 18px 0; text-align: center; font-size: 13px; }

.rows > * + * { border-top: 1px solid var(--hairline); }
.row { padding: 14px 0; }

/* -------------------------------------------------------------------- red */
/* Q17: a half-landed contract is the worst state this system can produce, so
   it is the loudest thing on the page and does not scroll away. */
.red {
  background: color-mix(in oklab, var(--bad) 12%, var(--surface));
  border: 1px solid color-mix(in oklab, var(--bad) 45%, transparent);
}
.red .card__title { color: var(--bad); }
.red__detail { font-size: 13px; line-height: 1.55; }
.red__what { margin-top: 10px; font-family: var(--mono); font-size: 11.5px; color: var(--ink-3); }
.red__actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }

/* ------------------------------------------------------------------- grid */
/* Q19: repetitive work is genuinely grid-shaped. One cell per row, so forty
   files read as one thing rather than forty. */
.sweep + .sweep { margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--line); }
.sweep__head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.sweep__title { font-weight: 600; font-size: 14px; }
.sweep__what { color: var(--ink-3); font-size: 12.5px; margin-top: 3px; }
.sweep__cells { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 12px; }
.cell {
  width: 15px; height: 15px; border-radius: 3px; flex: none;
  background: var(--surface-2); border: 1px solid var(--line);
}
.cell--done { background: var(--good); border-color: var(--good); }
.cell--skipped { background: color-mix(in oklab, var(--ink-3) 40%, transparent); border-color: transparent; }
.cell--stuck { background: var(--bad); border-color: var(--bad); }
.cell--taken { background: color-mix(in oklab, var(--accent) 55%, transparent); border-color: var(--accent); }
.sweep__key { display: flex; gap: 14px; margin-top: 10px; flex-wrap: wrap; color: var(--ink-3); font-size: 11.5px; }
.sweep__keyitem { display: flex; align-items: center; gap: 5px; }
.sweep__findings { margin-top: 12px; }
.sweep__finding { display: flex; gap: 10px; padding: 5px 0; font-size: 12.5px; align-items: baseline; }
.sweep__count { font-family: var(--mono); font-size: 11.5px; color: var(--ink-3); flex: none; min-width: 42px; }

/* ----------------------------------------------------------------- ledger */
.ledger { width: 100%; border-collapse: collapse; font-size: 13px; }
.ledger th, .ledger td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
.ledger th { font-weight: 600; color: var(--ink-3); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; cursor: pointer; user-select: none; white-space: nowrap; }
.ledger th:hover { color: var(--ink-1); }
.ledger th[aria-sort]::after { content: "\\2191"; margin-left: 4px; opacity: .7; }
.ledger th[aria-sort="descending"]::after { content: "\\2193"; }
.ledger tbody tr:last-child td { border-bottom: 0; }
.ledger__why { color: var(--ink-3); font-size: 12px; padding-top: 2px; }
.ledger__scroll { overflow-x: auto; }
.ledger__cost { color: var(--ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.health { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.health--needs-a-person { background: color-mix(in oklab, var(--bad) 16%, transparent); color: var(--bad); }
.health--idle { background: var(--surface-2); color: var(--ink-3); }
.health--working { background: color-mix(in oklab, var(--accent) 16%, transparent); color: var(--accent); }
.health--waiting { background: color-mix(in oklab, var(--warn) 18%, transparent); color: var(--warn); }
.health--ready { background: color-mix(in oklab, var(--good) 16%, transparent); color: var(--good); }
.health--done { background: var(--surface-2); color: var(--ink-3); }

/* -------------------------------------------------------------- attention */
.attention {
  border-color: color-mix(in srgb, var(--warn) 34%, transparent);
  background: linear-gradient(to bottom right, var(--warn-wash), transparent 60%), var(--surface);
}
.attention ul { margin: 0; padding: 0; list-style: none; }
.attention li { display: flex; gap: 10px; align-items: baseline; padding: 4px 0; }
.attention li::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--warn); flex: none; transform: translateY(-3px); }
.attention__actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }

/* ------------------------------------------------------------------ tasks */
.task { padding: 16px 0; }
.task__top { display: flex; align-items: flex-start; gap: 12px; }
.task__id {
  font-family: var(--mono); font-size: 12px; font-weight: 600;
  color: var(--accent); background: var(--accent-wash);
  padding: 3px 8px; border-radius: 7px; flex: none;
}
.task__title { font-weight: 550; letter-spacing: -0.01em; }
.task__desc { color: var(--ink-2); font-size: 13px; margin-top: 2px; }
.task__lane { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.lane {
  font-family: var(--mono); font-size: 11.5px; color: var(--ink-2);
  background: var(--sunken); border: 1px solid var(--hairline);
  padding: 3px 7px; border-radius: 6px;
}
.task__meta { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 11px; }
.owner { display: flex; align-items: center; gap: 7px; font-size: 13px; }
.owner--none { color: var(--ink-3); font-style: italic; }

.meter { display: flex; align-items: center; gap: 8px; }
.meter__track { width: 92px; height: 4px; border-radius: 3px; background: var(--sunken); overflow: hidden; }
.meter__fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width .3s ease; }
.meter--warn .meter__fill { background: var(--warn); }
.meter--full .meter__fill { background: var(--bad); }
.meter__label { font-family: var(--mono); font-size: 11px; color: var(--ink-3); }

.task__last {
  margin-top: 11px; padding: 9px 12px; border-radius: 9px;
  background: var(--sunken); border: 1px solid var(--hairline);
  font-size: 12.5px; color: var(--ink-2);
}
.task__last--bad {
  color: var(--bad); background: var(--bad-wash);
  border-color: color-mix(in srgb, var(--bad) 26%, transparent);
}
.task__actions {
  display: flex; gap: 7px; margin-top: 12px; flex-wrap: wrap;
  opacity: .62; transition: opacity .16s;
}
.task:hover .task__actions, .task:focus-within .task__actions { opacity: 1; }
@media (hover: none) { .task__actions { opacity: 1; } }

/* ----------------------------------------------------------------- agents */
.agent { padding: 15px 0; }
.agent__top { display: flex; align-items: center; gap: 10px; }
.agent__name { font-weight: 550; letter-spacing: -0.01em; }
.agent__sub { font-family: var(--mono); font-size: 11.5px; color: var(--ink-3); }
.agent__state { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-2); margin-left: auto; }
.agent__note {
  margin-top: 10px; padding: 9px 12px; border-radius: 9px;
  background: var(--sunken); border-left: 2px solid var(--accent);
  font-size: 12.5px; color: var(--ink-2);
}
.agent__paused {
  margin-top: 8px; font-size: 12.5px; color: var(--bad);
  display: flex; gap: 7px; align-items: baseline;
}
.agent__foot { display: flex; align-items: center; gap: 8px; margin-top: 11px; }

/* ------------------------------------------------------------------- feed */
.feed {
  max-height: 420px; overflow-y: auto; margin: 0 -6px; padding: 4px 6px; scrollbar-width: thin;
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent);
          mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent);
}
.feed__row {
  display: grid; grid-template-columns: 58px 1fr; gap: 10px;
  padding: 6px 8px; border-radius: 8px; font-size: 12.5px;
  animation: slide .25s ease-out;
}
.feed__row:hover { background: var(--sunken); }
.feed__time { font-family: var(--mono); font-size: 11px; color: var(--ink-3); padding-top: 1px; }
.feed__text { color: var(--ink-2); min-width: 0; overflow-wrap: anywhere; }
@keyframes slide { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

/* ------------------------------------------------------------------ seams */
.decision { padding: 16px 0; }
.decision__head { display: flex; align-items: center; gap: 10px; }
.decision__title { font-weight: 550; letter-spacing: -0.01em; }
.decision__body { color: var(--ink-2); font-size: 13px; margin-top: 4px; white-space: pre-wrap; }
.seam {
  margin-top: 12px; border: 1px solid var(--line); border-radius: 11px;
  background: var(--sunken); overflow: hidden;
}
.seam__bar {
  display: flex; align-items: center; justify-content: center; gap: 12px;
  padding: 9px 12px; border-bottom: 1px solid var(--hairline);
}
.seam__link { color: var(--ink-3); font-size: 13px; }
.seam__grid { display: grid; grid-template-columns: 1fr 1fr; }
@media (max-width: 720px) { .seam__grid { grid-template-columns: 1fr; } }
.seam__side { padding: 13px 15px; }
.seam__side + .seam__side { border-left: 1px solid var(--hairline); }
@media (max-width: 720px) { .seam__side + .seam__side { border-left: 0; border-top: 1px solid var(--hairline); } }
.seam__label {
  font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--ink-3); margin: 10px 0 3px; font-weight: 600;
}
.seam__label:first-of-type { margin-top: 11px; }
.seam__text { font-size: 12.5px; color: var(--ink-2); }

/* ---------------------------------------------------------------- threads */
.thread { padding: 16px 0; }
.thread__head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.thread__subject { font-weight: 550; letter-spacing: -0.01em; }
.thread__who { margin-left: auto; }
.msg { display: flex; gap: 10px; margin-top: 11px; }
.msg__body {
  background: var(--sunken); border: 1px solid var(--hairline);
  border-radius: 11px; border-top-left-radius: 3px;
  padding: 9px 12px; font-size: 13px; min-width: 0; overflow-wrap: anywhere;
}
.msg__from { display: flex; align-items: center; gap: 7px; margin-bottom: 4px; }
.msg__name { font-family: var(--mono); font-size: 11.5px; color: var(--ink-3); }
.reply { display: flex; gap: 8px; margin-top: 12px; }
.reply input {
  flex: 1; padding: 9px 13px; border-radius: 10px;
  background: var(--surface); border: 1px solid var(--line); color: var(--ink);
}
.reply input::placeholder { color: var(--ink-3); }
.reply input:focus { border-color: var(--accent); outline: none; }

/* ------------------------------------------------------------------ risks */
.risk { display: flex; align-items: baseline; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); }
.risk:last-of-type { border-bottom: 0; }
.risk__label { font-weight: 600; font-size: 13px; }
.risk__paths { font-family: var(--mono); font-size: 11.5px; color: var(--ink-3); overflow-wrap: anywhere; }
.risk__grow { flex: 1; min-width: 0; }
.risk__add { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.risk__add input {
  padding: 8px 12px; border-radius: 10px; min-width: 0; flex: 1;
  background: var(--surface); border: 1px solid var(--line); color: var(--ink); font-size: 13px;
}
.risk__add input::placeholder { color: var(--ink-3); }
.risk__add input:focus { border-color: var(--accent); outline: none; }
.risk__note { color: var(--ink-3); font-size: 12px; margin-top: 10px; }

/* ------------------------------------------------------------------- gate */
.gate { min-height: 78vh; display: grid; place-items: center; padding: 24px; }
.gate__card {
  width: 100%; max-width: 380px; background: var(--surface);
  border: 1px solid var(--line); border-radius: 18px; box-shadow: var(--shadow);
  padding: 30px 28px;
}
.gate__mark {
  width: 34px; height: 34px; border-radius: 10px; margin-bottom: 16px;
  background: var(--accent); display: grid; place-items: center;
  color: #fff; font-weight: 700; font-size: 16px;
}
.gate__title { margin: 0 0 4px; font-size: 19px; letter-spacing: -0.02em; }
.gate__sub { margin: 0 0 20px; color: var(--ink-2); font-size: 13px; }
.gate input {
  width: 100%; padding: 10px 13px; border-radius: 10px;
  background: var(--sunken); border: 1px solid var(--line); color: var(--ink);
  font-family: var(--mono); font-size: 13px;
}
.gate input:focus { border-color: var(--accent); outline: none; }
.gate__err { color: var(--bad); font-size: 12.5px; min-height: 18px; margin: 10px 0 0; }
.gate .btn--primary { width: 100%; margin-top: 12px; padding: 10px; }

.toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  background: var(--ink); color: var(--bg); padding: 10px 16px;
  border-radius: 10px; font-size: 13px; z-index: 60; max-width: min(92vw, 460px);
  box-shadow: var(--shadow); animation: rise .2s ease-out;
}
.toast--bad { background: var(--bad); color: #fff; }
@keyframes rise { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
</style>
</head>
<body>

<div id="gate" class="gate">
  <div class="gate__card">
    <div class="gate__mark">M</div>
    <h1 class="gate__title">Agora</h1>
    <p class="gate__sub">One room, every agent, one human watching.</p>
    <input id="token" type="password" placeholder="Supervisor token" autocomplete="off" spellcheck="false" />
    <p id="gate-err" class="gate__err"></p>
    <button id="enter" class="btn btn--primary">Watch the room</button>
  </div>
</div>

<div id="app" class="hide">
  <header class="topbar">
    <div class="topbar__inner">
      <div>
        <h1 class="topbar__title" id="room-name"></h1>
        <p class="topbar__goal" id="room-goal"></p>
      </div>
      <div class="spacer"></div>
      <span id="plan-chip" class="chip"></span>
      <button id="theme" class="btn btn--quiet" aria-label="Switch colour theme" title="Switch colour theme">◐</button>
      <button id="sign-out" class="btn btn--quiet">Sign out</button>
    </div>
  </header>

  <main class="wrap">
    <section id="red" class="card red hide">
      <div class="card__head"><h2 class="card__title">This room is red</h2></div>
      <div class="card__body">
        <div id="red-detail" class="red__detail"></div>
        <div id="red-what" class="red__what"></div>
        <div class="red__actions">
          <span class="red__detail">Finish it or put it back — <code>agora land --resume</code> / <code>agora land --rollback</code>.</span>
        </div>
      </div>
    </section>

    <section id="attention" class="card attention hide">
      <div class="card__head"><h2 class="card__title">Needs you</h2></div>
      <div class="card__body">
        <ul id="attention-list"></ul>
        <div id="plan-actions" class="attention__actions hide">
          <button id="approve" class="btn btn--primary">Approve the plan</button>
          <button id="reject" class="btn btn--danger">Reject</button>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card__head">
        <h2 class="card__title">Ledger</h2>
        <span id="ledger-count" class="chip card__count"></span>
      </div>
      <div class="card__body">
        <div class="ledger__scroll"><table class="ledger">
          <thead><tr id="ledger-head"></tr></thead>
          <tbody id="ledger-body"></tbody>
        </table></div>
        <div id="ledger-cost" class="ledger__why" style="margin-top:12px"></div>
      </div>
    </section>

    <section id="sweeps-card" class="card hide">
      <div class="card__head">
        <h2 class="card__title">Sweeps</h2>
        <span id="sweep-count" class="chip card__count"></span>
      </div>
      <div class="card__body"><div id="sweeps"></div></div>
    </section>

    <div class="columns">
      <div>
        <section class="card">
          <div class="card__head">
            <h2 class="card__title">Task board</h2>
            <span id="task-count" class="chip card__count"></span>
          </div>
          <div class="card__body"><div id="tasks" class="rows"></div></div>
        </section>
      </div>

      <div class="rail">
        <section class="card">
          <div class="card__head">
            <h2 class="card__title">Agents</h2>
            <span id="agent-count" class="chip card__count"></span>
          </div>
          <div class="card__body"><div id="agents" class="rows"></div></div>
        </section>

        <section class="card">
          <div class="card__head">
            <h2 class="card__title">Risk list</h2>
            <span id="risk-count" class="chip card__count"></span>
          </div>
          <div class="card__body">
            <div id="risks"></div>
            <div class="risk__add">
              <input id="risk-label" placeholder="Surface, e.g. Payments" aria-label="What this surface is" />
              <input id="risk-paths" placeholder="**/billing/**, **/*.sql" aria-label="Paths, comma separated" />
              <button id="risk-add" class="btn">Add</button>
            </div>
            <div class="risk__note">
              Cross-review is a bet that the agent across a contract catches what matters.
              This is where you decline to take it. Everything here waits for a person.
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card__head">
            <h2 class="card__title">Live</h2>
            <span class="card__count"><span id="live-dot" class="dot"></span></span>
          </div>
          <div class="card__body"><div id="feed" class="feed"></div></div>
        </section>
      </div>
    </div>

    <section class="card">
      <div class="card__head">
        <h2 class="card__title">Decisions &amp; seams</h2>
        <span id="decision-count" class="chip card__count"></span>
      </div>
      <div class="card__body"><div id="decisions" class="rows"></div></div>
    </section>

    <section class="card">
      <div class="card__head">
        <h2 class="card__title">Threads</h2>
        <span id="thread-count" class="chip card__count"></span>
      </div>
      <div class="card__body"><div id="threads" class="rows"></div></div>
    </section>
  </main>
</div>

<script>
(function () {
  "use strict";

  // ------------------------------------------------------------ DOM helpers
  // Everything is built from nodes, so text an agent wrote is text, never markup.
  function h(tag, props) {
    var node = document.createElement(tag);
    var opts = props || {};
    if (opts.class) node.className = opts.class;
    if (opts.text != null) node.textContent = String(opts.text);
    if (opts.title) node.title = opts.title;
    if (opts.style) node.setAttribute("style", opts.style);
    if (opts.attrs) for (var key in opts.attrs) node.setAttribute(key, opts.attrs[key]);
    if (opts.on) for (var evt in opts.on) node.addEventListener(evt, opts.on[evt]);
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child == null || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }
  function $(id) { return document.getElementById(id); }
  function fill(id, nodes, emptyText) {
    var host = $(id);
    host.replaceChildren();
    if (!nodes.length) { host.appendChild(h("div", { class: "empty", text: emptyText })); return; }
    nodes.forEach(function (node) { host.appendChild(node); });
  }

  // --------------------------------------------------------------- identity
  var HUMAN = "human";
  function hue(id) {
    var total = 0;
    for (var i = 0; i < id.length; i++) total = (total * 31 + id.charCodeAt(i)) % 360;
    return total;
  }
  function avatar(id) {
    var background = id === HUMAN ? "var(--ink-3)" : "hsl(" + hue(id) + " 52% 48%)";
    return h("span", {
      class: "avatar",
      style: "background:" + background,
      text: id.slice(0, 1).toUpperCase() + id.slice(1, 2),
      title: id === HUMAN ? "the human" : id
    });
  }
  function plural(count, noun) {
    return count + " " + noun + (count === 1 ? "" : "s");
  }

  // ----------------------------------------------------------------- status
  var TASK_TONE = {
    draft: "", open: "chip--accent", claimed: "chip--warn",
    submitted: "chip--warn", accepted: "chip--good", blocked: "chip--bad"
  };
  var PLAN_TONE = {
    none: "", proposed: "chip--warn", approved: "chip--good", rejected: "chip--bad"
  };
  var STATE_DOT = {
    working: "dot--live", waiting: "dot--warn", blocked: "dot--bad", done: "dot--live", idle: ""
  };

  // ------------------------------------------------------------------- data
  var token = "";
  try { token = sessionStorage.getItem("agora-token") || ""; } catch (e) { token = ""; }
  var stream = null;
  var drafts = {};      // thread id -> half-typed reply, kept across re-renders
  var seenEvents = {};

  function api(path, body) {
    return fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) {
          var err = payload && payload.error ? payload.error : {};
          throw new Error(err.remedy ? err.message + " " + err.remedy : err.message || response.statusText);
        }
        return payload;
      });
    });
  }

  var toastTimer = null;
  function toast(message, bad) {
    var existing = document.querySelector(".toast");
    if (existing) existing.remove();
    var node = h("div", { class: bad ? "toast toast--bad" : "toast", text: message });
    document.body.appendChild(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.remove(); }, bad ? 6000 : 2600);
  }
  function act(promise) {
    return promise.then(refresh).catch(function (error) { toast(error.message, true); });
  }

  // ------------------------------------------------------------------ risks
  // Q13: default light. A team that will not take the bet sets a rule to "**".
  function riskRow(rule, rules) {
    return h("div", { class: "risk" },
      h("div", { class: "risk__grow" },
        h("div", { class: "risk__label", text: rule.label }),
        h("div", { class: "risk__paths", text: rule.paths.join("  ") }),
        rule.why ? h("div", { class: "risk__note", text: rule.why }) : null),
      h("button", {
        class: "btn btn--quiet", text: "Remove",
        title: "Stop pulling a person onto " + rule.label,
        on: { click: function () {
          act(api("/api/risks", { rules: rules.filter(function (other) { return other.id !== rule.id; }) }));
        } }
      })
    );
  }

  function renderRisks(rules) {
    $("risk-count").textContent = rules.length === 0
      ? "nothing flagged"
      : plural(rules.length, "surface");
    fill("risks", rules.map(function (rule) { return riskRow(rule, rules); }),
      "Nothing pulls a person in automatically. Every lane rests on cross-review alone.");
    $("risk-add").onclick = function () {
      var label = $("risk-label").value.trim();
      var paths = $("risk-paths").value.split(",").map(function (entry) { return entry.trim(); })
        .filter(function (entry) { return entry !== ""; });
      if (!label || paths.length === 0) {
        toast("A surface needs a name and at least one path.", true);
        return;
      }
      var id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      act(api("/api/risks", { rules: rules.concat([{
        id: id, label: label, paths: paths,
        why: "Added here, so a person looks before anything on this surface lands."
      }]) })).then(function () {
        $("risk-label").value = "";
        $("risk-paths").value = "";
      });
    };
  }

  // ------------------------------------------------------------------- grid
  // Q19 parked a formula language, not the shape. Forty rows read as one
  // picture; the findings underneath are collapsed, so a person reads the
  // distinct answers rather than forty repetitions of one.
  function sweepCard(entry) {
    var batch = entry.batch;
    var progress = entry.progress;
    var verdict = entry.verdict;

    var cells = h("div", { class: "sweep__cells" });
    batch.rows.forEach(function (row) {
      cells.appendChild(h("span", {
        class: "cell cell--" + row.state,
        title: row.subject + " — " + row.state + (row.finding ? ": " + row.finding : "")
      }));
    });

    var key = h("div", { class: "sweep__key" });
    [["done", "changed"], ["skipped", "left alone"], ["stuck", "stuck"], ["taken", "in hand"], ["pending", "not taken"]]
      .forEach(function (pair) {
        var count = progress[pair[0]];
        if (!count) return;
        key.appendChild(h("span", { class: "sweep__keyitem" },
          h("span", { class: "cell cell--" + pair[0], style: "width:10px;height:10px" }),
          h("span", { text: count + " " + pair[1] })));
      });

    var findings = h("div", { class: "sweep__findings" });
    (verdict.findings || []).forEach(function (finding) {
      findings.appendChild(h("div", { class: "sweep__finding" },
        h("span", { class: "sweep__count", text: finding.subjects.length + " ×" }),
        h("span", { text: finding.finding })));
    });

    return h("div", { class: "sweep" },
      h("div", { class: "sweep__head" },
        h("span", { class: "sweep__title", text: batch.title }),
        h("span", { class: "chip" + (verdict.kind === "finished" ? " chip--good" : verdict.kind === "working" ? "" : " chip--warn"), text: progress.summary })),
      h("div", { class: "sweep__what", text: batch.instruction }),
      cells,
      key,
      verdict.kind === "working" || verdict.kind === "finished"
        ? null
        : h("div", { class: "sweep__what", style: "margin-top:12px", text: verdict.detail }),
      findings
    );
  }

  function loadSweeps() {
    return api("/api/sweeps").then(function (payload) {
      var sweeps = payload.sweeps || [];
      $("sweeps-card").classList.toggle("hide", sweeps.length === 0);
      if (sweeps.length === 0) return;
      $("sweep-count").textContent = plural(sweeps.length, "sweep");
      fill("sweeps", sweeps.map(sweepCard), "");
    }).catch(function () {});
  }

  // ----------------------------------------------------------------- ledger
  // Q19: a table, not a formula language. Worst first, because the first thing
  // a person walking in needs is which lane is stuck and why.
  var LEDGER_COLUMNS = [
    { key: "laneId", label: "Lane" },
    { key: "health", label: "State" },
    { key: "agent", label: "Agent" },
    { key: "human", label: "Person" },
    { key: "evidence", label: "Evidence" },
    { key: "review", label: "Review" },
    { key: "risksOpen", label: "Risk" },
    { key: "actionsUsed", label: "Actions" },
    { key: "updatedAt", label: "Moved" }
  ];
  var ledgerSort = { column: "health", direction: "asc" };

  function ledgerHead() {
    return LEDGER_COLUMNS.map(function (column) {
      var active = ledgerSort.column === column.key;
      var cell = h("th", {
        text: column.label,
        title: "Sort by " + column.label.toLowerCase(),
        on: { click: function () {
          ledgerSort = active
            ? { column: column.key, direction: ledgerSort.direction === "asc" ? "desc" : "asc" }
            : { column: column.key, direction: "asc" };
          loadLedger();
        } }
      });
      if (active) {
        cell.setAttribute("aria-sort", ledgerSort.direction === "asc" ? "ascending" : "descending");
      }
      return cell;
    });
  }

  function ledgerRow(row) {
    var moved = new Date(row.updatedAt).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
    var body = h("tr", {},
      h("td", {}, h("strong", { text: row.laneId }), h("div", { class: "ledger__why", text: row.title })),
      h("td", {}, h("span", { class: "health health--" + row.health, text: row.health.replace(/-/g, " ") })),
      h("td", { text: row.agent || "\u2014" }),
      h("td", { text: row.human || "room" }),
      h("td", { text: row.evidence.replace(/-/g, " ") }),
      h("td", { text: row.review === "not-applicable" ? "\u2014" : row.review }),
      h("td", { text: row.risksOpen === 0 ? "\u2014" : String(row.risksOpen) }),
      h("td", { class: "ledger__cost", text: row.actionsUsed + "/" + row.actionBudget }),
      h("td", { class: "ledger__cost", text: moved })
    );
    var why = h("tr", {}, h("td", {
      attrs: { colspan: String(LEDGER_COLUMNS.length) },
      class: "ledger__why",
      text: row.blockedOn + (row.costSummary === "not counted" ? "" : "  \u00b7  " + row.costSummary)
    }));
    // The lane and its "what is in the way" line are one row to the eye, so the
    // rule goes under the pair rather than between them.
    for (var i = 0; i < body.childNodes.length; i++) body.childNodes[i].style.borderBottom = "0";
    return [body, why];
  }

  function loadLedger() {
    return api("/api/ledger?sort=" + ledgerSort.column + "&dir=" + ledgerSort.direction)
      .then(function (payload) {
        fill("ledger-head", ledgerHead(), "");
        var nodes = [];
        payload.rows.forEach(function (row) { ledgerRow(row).forEach(function (n) { nodes.push(n); }); });
        fill("ledger-body", nodes, "");
        var stuck = payload.rows.filter(function (row) { return row.health === "needs-a-person"; }).length;
        $("ledger-count").textContent = stuck === 0
          ? plural(payload.rows.length, "lane")
          : stuck + " needing you \u00b7 " + plural(payload.rows.length, "lane");
        // Q15: three kinds of fact, never one number.
        $("ledger-cost").textContent = payload.cost.lines.length === 0
          ? payload.cost.caveat
          : payload.cost.lines.map(function (line) {
              return line.provenance === "quota" && line.limit != null
                ? line.amount + "/" + line.limit + " " + line.unit + " (quota)"
                : line.amount + " " + line.unit + " (" + line.provenance + ")";
            }).join("   \u00b7   ") + "   \u2014   " + payload.cost.caveat;
      })
      .catch(function () {});
  }

  // ------------------------------------------------------------------ parts
  function meter(used, budget, halted) {
    var ratio = budget === 0 ? 1 : Math.min(1, used / budget);
    var tone = halted || used >= budget ? " meter--full" : ratio >= 0.75 ? " meter--warn" : "";
    return h("span", { class: "meter" + tone, title: used + " of " + budget + " messages spent" },
      h("span", { class: "meter__track" },
        h("span", { class: "meter__fill", style: "width:" + Math.round(ratio * 100) + "%" })),
      h("span", { class: "meter__label", text: used + "/" + budget })
    );
  }

  function taskRow(task, agents) {
    var owner = task.owner
      ? h("span", { class: "owner" }, avatar(task.owner), h("span", { text: task.owner }))
      : h("span", { class: "owner owner--none", text: task.suggestedOwner
          ? task.suggestedOwner + " suggested" : "unclaimed" });

    var lanes = task.paths.length
      ? task.paths.map(function (path) { return h("span", { class: "lane", text: path }); })
      : [h("span", { class: "lane faint", text: "no declared paths" })];

    var actions = [];
    if (task.status === "submitted") {
      actions.push(h("button", { class: "btn btn--primary", text: "Accept",
        on: { click: function () { act(api("/api/tasks/" + encodeURIComponent(task.id) + "/accept", {})); } } }));
    }
    actions.push(h("button", { class: "btn", text: "Raise budget", on: { click: function () {
      var next = prompt("New message budget for \\"" + task.id + "\\"", String(Math.max(task.actionBudget, task.actionsUsed) + 20));
      if (next === null) return;
      var value = Number(next);
      if (!Number.isFinite(value)) { toast("That is not a number.", true); return; }
      act(api("/api/tasks/" + encodeURIComponent(task.id) + "/budget", { actionBudget: value }));
    } } }));
    actions.push(h("button", { class: "btn", text: "Reopen",
      on: { click: function () { act(api("/api/tasks/" + encodeURIComponent(task.id) + "/reopen", {})); } } }));

    var picker = h("select", { class: "btn", attrs: { "aria-label": "Reassign " + task.id },
      on: { change: function (event) {
        var value = event.target.value;
        event.target.value = "";
        if (value) act(api("/api/tasks/" + encodeURIComponent(task.id) + "/assign", { agentId: value }));
      } } },
      h("option", { text: "Reassign to…", attrs: { value: "" } }));
    agents.forEach(function (agent) {
      if (agent.id === task.owner) return;
      picker.appendChild(h("option", { text: agent.displayName, attrs: { value: agent.id } }));
    });
    actions.push(picker);

    var last = task.submissions.length ? task.submissions[task.submissions.length - 1] : null;

    return h("div", { class: "task" },
      h("div", { class: "task__top" },
        h("span", { class: "task__id", text: task.id }),
        h("div", { style: "min-width:0;flex:1" },
          h("div", { class: "task__title", text: task.title }),
          task.description ? h("div", { class: "task__desc", text: task.description }) : null,
          h("div", { class: "task__lane" }, ...lanes)),
        h("span", { class: "chip " + (TASK_TONE[task.status] || ""), text: task.status })),
      h("div", { class: "task__meta" },
        owner,
        task.seams.length
          ? h("span", { class: "chip chip--accent", text: plural(task.seams.length, "seam") })
          : null,
        meter(task.actionsUsed, task.actionBudget, task.budgetHaltedAt),
        task.budgetHaltedAt ? h("span", { class: "chip chip--bad", text: "stopped on budget" }) : null),
      task.blockedReason
        ? h("div", { class: "task__last task__last--bad" },
            h("span", { class: "chip chip--bad", text: "blocked" }),
            h("span", { text: " " + task.blockedReason }))
        : null,
      // A blocked task already showed its reason; the summary is the same text.
      last && last.summary !== task.blockedReason
        ? h("div", { class: "task__last", text: last.summary })
        : null,
      h("div", { class: "task__actions" }, ...actions)
    );
  }

  function agentRow(agent) {
    var status = agent.status || { state: "idle", note: "" };
    var toggle = agent.paused
      ? h("button", { class: "btn btn--primary", text: "Resume",
          on: { click: function () { act(api("/api/agents/" + encodeURIComponent(agent.id) + "/resume", {})); } } })
      : h("button", { class: "btn btn--danger", text: "Pause",
          on: { click: function () {
            var reason = prompt("Why pause " + agent.displayName + "?", "Holding while I look at this.");
            if (reason === null) return;
            act(api("/api/agents/" + encodeURIComponent(agent.id) + "/pause", { reason: reason }));
          } } });

    return h("div", { class: "agent" },
      h("div", { class: "agent__top" },
        avatar(agent.id),
        h("div", { style: "min-width:0" },
          h("div", { class: "agent__name", text: agent.displayName }),
          h("div", { class: "agent__sub", text: agent.provider + " · " + agent.role })),
        h("span", { class: "agent__state" },
          h("span", { class: "dot " + (agent.paused ? "dot--bad" : STATE_DOT[status.state] || "") }),
          h("span", { text: agent.paused ? "paused" : status.state }))),
      status.note ? h("div", { class: "agent__note", text: status.note }) : null,
      agent.paused && agent.pausedReason
        ? h("div", { class: "agent__paused" }, h("span", { text: agent.pausedReason })) : null,
      h("div", { class: "agent__foot" },
        h("span", {
          class: "chip",
          title: "Which tasks this agent may claim and submit against",
          text: agent.scope.writeTasks.indexOf("*") >= 0
            ? "writes any task"
            : "writes " + (agent.scope.writeTasks.join(", ") || "nothing")
        }),
        h("span", { class: "spacer" }), toggle)
    );
  }

  function decisionRow(decision) {
    var seam = null;
    if (decision.seam) {
      var grid = h("div", { class: "seam__grid" });
      decision.seam.contract.forEach(function (side) {
        grid.appendChild(h("div", { class: "seam__side" },
          h("span", { class: "task__id", text: side.taskId }),
          h("div", { class: "seam__label", text: "provides" }),
          h("div", { class: "seam__text", text: side.provides }),
          h("div", { class: "seam__label", text: "expects" }),
          h("div", { class: "seam__text", text: side.expects })));
      });
      seam = h("div", { class: "seam" },
        h("div", { class: "seam__bar" },
          h("span", { class: "task__id", text: decision.seam.betweenTasks[0] }),
          h("span", { class: "seam__link", text: "↔" }),
          h("span", { class: "task__id", text: decision.seam.betweenTasks[1] })),
        grid);
    }
    return h("div", { class: "decision" },
      h("div", { class: "decision__head" },
        h("span", { class: "decision__title", text: decision.title }),
        h("span", { class: "spacer" }),
        h("span", { class: "chip " + (decision.kind === "seam" ? "chip--accent" : ""), text: decision.kind })),
      decision.body ? h("div", { class: "decision__body", text: decision.body }) : null,
      seam,
      h("div", { class: "mono faint", style: "margin-top:8px", text: decision.id })
    );
  }

  function threadRow(thread) {
    var box = h("input", {
      attrs: { placeholder: "Answer or redirect…", "aria-label": "Reply on " + thread.subject, value: drafts[thread.id] || "" },
      on: {
        input: function (event) { drafts[thread.id] = event.target.value; },
        keydown: function (event) { if (event.key === "Enter") send(); }
      }
    });
    function send() {
      var body = box.value.trim();
      if (!body) return;
      act(api("/api/tasks/" + encodeURIComponent(thread.taskId) + "/message",
        { threadId: thread.id, body: body, kind: "answer" }));
      delete drafts[thread.id];
      box.value = "";
    }

    var node = h("div", { class: "thread" },
      h("div", { class: "thread__head" },
        h("span", { class: "thread__subject", text: thread.subject }),
        h("span", { class: "chip thread__who", text: thread.taskId + " · " + thread.participants.join(", ") })));

    thread.messages.forEach(function (message) {
      node.appendChild(h("div", { class: "msg" },
        avatar(message.from),
        h("div", { class: "msg__body" },
          h("div", { class: "msg__from" },
            h("span", { class: "msg__name", text: message.from }),
            h("span", { class: "chip", text: message.kind })),
          h("div", { text: message.body }))));
    });

    node.appendChild(h("div", { class: "reply" }, box,
      h("button", { class: "btn", text: "Send", on: { click: send } })));
    return node;
  }

  // ----------------------------------------------------------------- render
  function render(view) {
    var room = view.room;
    $("room-name").textContent = room.name;
    $("room-goal").textContent = room.goal;

    var chip = $("plan-chip");
    if (room.status === "red") {
      chip.className = "chip chip--bad";
      chip.textContent = "RED · half-landed";
      chip.title = "A change is in one repository and not another.";
    } else if (room.status === "closed") {
      chip.className = "chip";
      chip.textContent = "closed · " + (room.closedBy || "someone");
      chip.title = room.closeNote || "This room is finished.";
    } else {
      chip.className = "chip " + (PLAN_TONE[room.plan.status] || "");
      chip.textContent = "plan · " + room.plan.status;
      chip.title = "";
    }

    // Q17: one repository has a change another does not. Nothing about this is
    // allowed to be quiet, so it sits above everything else.
    var partial = room.partialLanding;
    $("red").classList.toggle("hide", room.status !== "red" || !partial);
    if (partial) {
      var ahead = partial.landed.map(function (step) { return step.repoId; }).join(", ");
      var behind = partial.pending.map(function (step) { return step.repoId; }).join(", ");
      $("red-detail").textContent =
        ahead + " has this change and " + behind + " does not. " + partial.reason +
        " Until that is fixed, the two sides of a contract disagree in production.";
      $("red-what").textContent =
        "lane " + partial.laneId +
        (partial.conflicts.length ? "  ·  conflicts: " + partial.conflicts.join(", ") : "");
    }

    $("attention").classList.toggle("hide", view.attention.length === 0);
    fill("attention-list", view.attention.map(function (item) { return h("li", { text: item }); }), "");
    $("plan-actions").classList.toggle("hide", room.plan.status !== "proposed");

    var open = room.tasks.filter(function (task) { return task.status !== "accepted"; }).length;
    $("task-count").textContent = open + " open · " + room.tasks.length + " total";
    $("agent-count").textContent = plural(room.agents.length, "agent");
    $("decision-count").textContent =
      plural(room.decisions.filter(function (d) { return d.kind === "seam"; }).length, "seam");
    $("thread-count").textContent = plural(room.threads.length, "thread");

    fill("tasks", room.tasks.map(function (task) { return taskRow(task, room.agents); }), "No tasks yet.");
    fill("agents", room.agents.map(agentRow), "No agents have joined.");
    fill("decisions", room.decisions.map(decisionRow),
      "Nothing decided yet. The lead proposes the split and the seams.");
    fill("threads", room.threads.map(threadRow), "No one has needed to ask anything yet.");
    renderRisks(room.riskList || []);
  }

  function pushEvent(event) {
    if (seenEvents[event.seq]) return;
    seenEvents[event.seq] = true;
    var feed = $("feed");
    var time = new Date(event.at).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    feed.prepend(h("div", { class: "feed__row" },
      h("span", { class: "feed__time", text: time }),
      h("span", { class: "feed__text", text: event.summary })));
    while (feed.childNodes.length > 150) feed.lastChild.remove();
  }

  function refresh() {
    return api("/api/room").then(render).then(loadLedger).then(loadSweeps);
  }

  function connect() {
    if (stream) stream.close();
    stream = new EventSource("/api/events?since=0&access_token=" + encodeURIComponent(token));
    stream.onopen = function () { $("live-dot").className = "dot dot--live"; };
    stream.onerror = function () { $("live-dot").className = "dot dot--bad"; };
    stream.onmessage = function (message) {
      var event = JSON.parse(message.data);
      pushEvent(event);
      refresh().catch(function () {});
    };
  }

  // ------------------------------------------------------------------ theme
  var theme = null;
  try { theme = localStorage.getItem("agora-theme"); } catch (e) { theme = null; }
  if (theme) document.documentElement.setAttribute("data-theme", theme);
  $("theme").addEventListener("click", function () {
    var current = document.documentElement.getAttribute("data-theme");
    if (!current) {
      current = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    var next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("agora-theme", next); } catch (e) {}
  });

  // ------------------------------------------------------------------ plan
  $("approve").addEventListener("click", function () {
    var note = prompt("A note for the room (optional)", "");
    if (note === null) return;
    act(api("/api/plan/approve", { note: note || null }));
  });
  $("reject").addEventListener("click", function () {
    var note = prompt("What needs to change?");
    if (!note) return;
    act(api("/api/plan/reject", { note: note }));
  });

  // ------------------------------------------------------------------ gate
  function start() {
    return refresh().then(function () {
      $("gate").classList.add("hide");
      $("app").classList.remove("hide");
      try { sessionStorage.setItem("agora-token", token); } catch (e) {}
      connect();
    });
  }
  $("enter").addEventListener("click", function () {
    token = $("token").value.trim();
    $("gate-err").textContent = "";
    start().catch(function (error) { $("gate-err").textContent = error.message; });
  });
  $("token").addEventListener("keydown", function (event) {
    if (event.key === "Enter") $("enter").click();
  });
  $("sign-out").addEventListener("click", function () {
    try { sessionStorage.removeItem("agora-token"); } catch (e) {}
    location.reload();
  });

  if (token) start().catch(function (error) { $("gate-err").textContent = error.message; });
})();
</script>
</body>
</html>
`;
