// DESIGN GRILL PROTOTYPE (branch-local, remove before production).
// Styles for the five trace viewer variants. Uses the app's tokens only.
export const GRILL_CSS = String.raw`
.tg-root { position: relative; display: grid; gap: 12px; outline: none; }
.tg-edge { position: fixed; top: 50vh; transform: translateY(-50%); z-index: 40; width: 44px; height: 44px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); color: var(--text-muted); font-size: 24px; line-height: 1; cursor: pointer; opacity: .7; display: grid; place-items: center; }
.tg-edge:hover, .tg-edge:focus-visible { opacity: 1; color: var(--text); border-color: var(--line-strong); }
.tg-stateline { justify-self: end; display: flex; align-items: center; gap: 6px; font-size: var(--type-small); color: var(--text-muted); }
.tg-v { min-width: 0; }
.tg-v :is(.tg-m-transcript, .tg-m-rail, .tg-ch-main, .tg-c-diffs, .tg-subcard-body, .tg-run, .tg-panel) > * { min-width: 0; }
.tg-checks li code { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.tg-eyebrow { display: inline-block; font-family: var(--font-mono); font-size: var(--type-micro); letter-spacing: .08em; text-transform: uppercase; color: var(--text-muted); }
.tg-err-text { color: var(--err); }
.tg-outcome-ok { color: var(--ok); background: var(--ok-surface); }
.tg-outcome-err { color: var(--err); background: var(--err-surface); }
.tg-outcome-none { color: var(--ink-700); background: var(--paper-100); }
.tg-chip { border: 1px solid var(--line); background: transparent; color: var(--text-muted); border-radius: 999px; padding: 3px 10px; font: inherit; font-size: var(--type-small); cursor: pointer; display: inline-flex; gap: 6px; align-items: center; min-height: 30px; }
.tg-chip.is-on { background: var(--text); color: var(--bg); border-color: var(--text); }
.tg-chip-count { font-family: var(--font-mono); font-size: var(--type-micro); opacity: .75; }
.tg-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.tg-filterbar { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: space-between; }
.tg-search { min-width: 200px; flex: 0 1 260px; padding: 6px 10px; border-radius: var(--radius-sm); border: 1px solid var(--line); background: var(--surface-sunken); color: var(--text); font: inherit; font-size: var(--type-small); }
.tg-linklike { background: none; border: 0; padding: 0; margin: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; }
.tg-md { line-height: 1.55; overflow-wrap: anywhere; }
.tg-md p { margin: 0 0 .6em; } .tg-md p:last-child { margin-bottom: 0; }
.tg-md ul { margin: .2em 0 .7em; padding-left: 1.2em; } .tg-md li { margin: .15em 0; }
.tg-md code, .tg-files code, .tg-checks code { font-family: var(--font-mono); font-size: .88em; background: var(--surface-sunken); padding: 1px 4px; border-radius: 4px; }
.tg-code { margin: 6px 0 0; padding: 10px 12px; background: var(--surface-sunken); border: 1px solid var(--line-soft, var(--line)); border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 26em; overflow: auto; }
.tg-result-error { border-color: var(--err); color: var(--err); background: var(--err-surface); }
.tg-hidden-note { margin: 6px 0 0; font-size: var(--type-small); color: var(--text-muted); padding: 6px 10px; border-radius: var(--radius-sm); background: repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in oklab, var(--text-muted) 12%, transparent) 6px 12px); }
.tg-striped { background: repeating-linear-gradient(135deg, transparent 0 5px, color-mix(in oklab, var(--text-muted) 14%, transparent) 5px 10px); border-radius: 4px; padding: 0 6px; color: var(--text-muted); }
.tg-subprompt { margin: 6px 0 0; color: var(--text-soft); font-size: var(--type-small); }
.tg-diff { margin-top: 6px; border: 1px solid var(--line); border-radius: var(--radius-sm); overflow: auto; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.55; background: var(--surface-sunken); max-height: 30em; }
.tg-diff-line { display: grid; grid-template-columns: 22px 1fr; white-space: pre-wrap; overflow-wrap: anywhere; }
.tg-diff-sign { text-align: center; color: var(--text-muted); user-select: none; }
.tg-diff-add { background: color-mix(in oklab, var(--ok) 16%, transparent); } .tg-diff-add .tg-diff-sign { color: var(--ok); }
.tg-diff-del { background: color-mix(in oklab, var(--err) 14%, transparent); } .tg-diff-del .tg-diff-sign { color: var(--err); }
.tg-diffstat { display: inline-flex; gap: 6px; font-family: var(--font-mono); font-size: var(--type-micro); font-weight: 600; white-space: nowrap; }
.tg-add { color: var(--ok); } .tg-del { color: var(--err); }
.tg-new { font-family: var(--font-mono); font-size: var(--type-micro); text-transform: uppercase; color: var(--harbor-700); background: var(--harbor-100); border-radius: 4px; padding: 0 5px; }
.tg-st { font-family: var(--font-mono); font-size: var(--type-micro); color: var(--text-muted); white-space: nowrap; text-transform: uppercase; letter-spacing: .04em; }
.tg-st-err { color: var(--err); } .tg-st-ok { color: var(--ok); }
.tg-dot { display: inline-block; width: 9px; height: 9px; border-radius: 99px; flex: none; background: var(--text-muted); }
.tg-dot-ok { background: var(--ok); } .tg-dot-err { background: var(--err); } .tg-dot-unknown { background: transparent; border: 1.5px solid var(--text-muted); }
.tg-checks h3, .tg-files h3 { font-size: var(--type-small); margin: 14px 0 6px; color: var(--text-muted); font-weight: 600; }
.tg-checks ol, .tg-files ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.tg-checks li, .tg-files li { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--type-small); }
.tg-files li code { overflow-wrap: anywhere; }
.tg-facts { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin: 10px 0; } .tg-facts dt { color: var(--text-muted); } .tg-facts dd { margin: 0; font-weight: 600; }
.tg-summary-only { padding: 18px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.tg-ribbon { margin: 0; padding: 10px 14px; border-radius: var(--radius-sm); font-size: var(--type-small); color: var(--text-soft); border: 1px dashed var(--line-strong); background: repeating-linear-gradient(135deg, transparent 0 8px, color-mix(in oklab, var(--text-muted) 8%, transparent) 8px 16px); }
.tg-panel { padding: 16px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.tg-flash { animation: tg-flash 1.4s var(--ease-out, ease-out); }
@keyframes tg-flash { 0%, 30% { box-shadow: 0 0 0 3px var(--harbor-600); } 100% { box-shadow: 0 0 0 3px transparent; } }
@media (prefers-reduced-motion: reduce) { .tg-flash { animation: none; outline: 3px solid var(--harbor-600); } }
.tg-g-read, .tg-g-search { color: var(--text-muted); } .tg-g-edit { color: var(--harbor-600); } .tg-g-shell { color: var(--buoy-600); } .tg-g-agent, .tg-g-reply { color: var(--harbor-600); } .tg-g-mcp { color: var(--flag-700, var(--buoy-700)); } .tg-g-prompt { color: var(--buoy-600); }
.tg-step-glyph, .tg-log-glyph { font-family: var(--font-mono); font-weight: 700; font-size: 12px; width: 18px; height: 18px; display: inline-grid; place-items: center; border: 1px solid currentColor; border-radius: 4px; flex: none; }
.tg-step-kind { font-family: var(--font-mono); font-size: var(--type-micro); text-transform: uppercase; letter-spacing: .06em; color: var(--harbor-700); background: var(--harbor-100); border-radius: 4px; padding: 1px 6px; }
.tg-step-meta, .tg-ch-meta { color: var(--text-muted); font-size: var(--type-small); margin-left: 8px; }
.tg-step-head { display: flex; align-items: center; gap: 8px; width: 100%; background: none; border: 0; padding: 4px 0; color: inherit; font: inherit; text-align: left; cursor: pointer; min-width: 0; }
.tg-step-name { font-family: var(--font-mono); font-weight: 600; font-size: var(--type-small); white-space: nowrap; }
.tg-step-label { font-family: var(--font-mono); font-size: var(--type-small); color: var(--text-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }

/* 1. Ship's log */
.tg-ledger { display: grid; gap: 12px; }
.tg-l-head { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: flex-end; justify-content: space-between; padding: 18px 20px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.tg-l-head h1 { margin: 4px 0 6px; font-size: clamp(22px, 2.4vw, 30px); line-height: 1.15; }
.tg-l-facts { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: center; font-family: var(--font-mono); font-size: var(--type-small); color: var(--text-muted); }
.tg-l-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.tg-l-share { max-width: 560px; justify-self: end; }
.tg-l-sticky { position: sticky; top: 0; z-index: 5; display: grid; gap: 8px; padding: 10px 12px; background: color-mix(in oklab, var(--bg) 92%, transparent); backdrop-filter: blur(6px); border-bottom: 1px solid var(--line); }
.tg-l-levelnote { margin: 0; font-size: var(--type-small); color: var(--text-muted); }
.tg-log { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
.tg-log .tg-log { border: 0; border-radius: 0; background: transparent; }
.tg-log-row { display: grid; grid-template-columns: 48px 22px 150px minmax(0, 1fr) auto; gap: 10px; align-items: baseline; padding: 4px 14px 4px calc(14px + var(--depth, 0) * 22px); border-top: 1px solid var(--line-soft, transparent); font-size: var(--type-small); min-height: 28px; }
.tg-log-time { font-family: var(--font-mono); font-size: var(--type-micro); color: var(--text-muted); text-align: right; }
.tg-log-name { font-family: var(--font-mono); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tg-log-text { min-width: 0; overflow-wrap: anywhere; }
.tg-log-label { font-family: var(--font-mono); color: var(--text-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.is-clamped { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.tg-log-reply .tg-log-text { color: var(--text); font-size: var(--type-body); }
.tg-log-reply.is-final { background: color-mix(in oklab, var(--harbor-600) 7%, transparent); padding-block: 12px; }
.tg-log-muted { color: var(--text-muted); }
.tg-log-tool.is-error { background: color-mix(in oklab, var(--err) 9%, transparent); }
.tg-log-tool.is-error .tg-log-name { color: var(--err); }
.tg-log-tool:hover { background: color-mix(in oklab, var(--text) 4%, transparent); }
.tg-log-detail { padding: 0 14px 12px calc(14px + 48px + 22px + 20px + var(--depth, 0) * 22px); }
.tg-log-sub { padding: 0 0 0 calc(var(--depth, 1) * 22px); border-top: 1px solid var(--line-soft, transparent); }
.tg-log-sub > details > summary { cursor: pointer; padding: 6px 14px 6px 84px; font-size: var(--type-small); color: var(--harbor-700); font-family: var(--font-mono); }
.tg-log-sub > details { border-left: 3px solid var(--harbor-600); margin-left: 74px; }
.tg-log-sub > details > summary { padding-left: 10px; }
.tg-log-prompt { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 10px; padding: 16px 14px; background: color-mix(in oklab, var(--buoy-600) 10%, var(--surface)); border-top: 2px solid var(--buoy-600); font-size: var(--type-body); }

/* 2. Turn by turn */
.tg-chapters { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 28px; align-items: start; }
.tg-ch-rail { position: sticky; top: 16px; display: grid; gap: 10px; }
.tg-ch-toc { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.tg-ch-toc button { display: grid; grid-template-columns: 22px 1fr; gap: 2px 8px; text-align: left; width: 100%; background: none; border: 0; border-left: 2px solid var(--line); padding: 6px 8px; color: inherit; font: inherit; cursor: pointer; }
.tg-ch-toc button:hover { border-left-color: var(--buoy-600); background: color-mix(in oklab, var(--text) 4%, transparent); }
.tg-ch-num { font-family: var(--font-mono); color: var(--text-muted); font-size: var(--type-small); }
.tg-ch-q { font-size: var(--type-small); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.tg-ch-toc .tg-ch-meta { grid-column: 2; margin: 0; font-size: var(--type-micro); }
.tg-ch-access { display: grid; gap: 8px; padding-top: 12px; border-top: 1px dashed var(--line); font-size: var(--type-small); }
.tg-ch-access p { margin: 0; }
.tg-ch-main { display: grid; gap: 22px; min-width: 0; max-width: 820px; }
.tg-ch-head h1 { margin: 6px 0; font-size: clamp(30px, 3.6vw, 46px); line-height: 1.05; }
.tg-ch-facts { margin: 0; color: var(--text-muted); display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.tg-result { padding: 20px 22px; border-radius: var(--radius); border: 1px solid var(--line); background: var(--surface); box-shadow: inset 4px 0 0 var(--ok); }
.tg-result-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.tg-result-head .tg-linklike { color: var(--harbor-600); font-size: var(--type-small); }
.tg-result-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0 24px; margin-top: 6px; }
.tg-turn { display: grid; gap: 12px; padding-top: 18px; border-top: 1px solid var(--line); scroll-margin-top: 16px; }
.tg-turn-prompt { padding: 14px 18px; border-radius: var(--radius); background: color-mix(in oklab, var(--buoy-600) 10%, var(--surface)); font-size: 17px; }
.tg-work { border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface-sunken); }
.tg-work-bar { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 14px; background: none; border: 0; color: var(--text-soft); font: inherit; font-size: var(--type-small); text-align: left; cursor: pointer; }
.tg-work-caret { color: var(--text-muted); }
.tg-work-checks { margin-left: auto; display: inline-flex; gap: 4px; }
.tg-steps { list-style: none; margin: 0; padding: 4px 14px 12px; display: grid; gap: 2px; }
.tg-steps .tg-steps { padding-left: 12px; border-left: 2px solid var(--harbor-600); }
.tg-step.is-error .tg-step-name { color: var(--err); }
.tg-step-note { padding: 6px 0 6px 26px; color: var(--text); font-size: var(--type-small); }
.tg-step-think { padding: 4px 0 4px 26px; color: var(--text-muted); font-size: var(--type-small); font-style: italic; }
.tg-step-sub { padding: 6px 0; } .tg-step-sub summary { cursor: pointer; font-size: var(--type-small); }
.tg-step-subresult { margin: 6px 0 0 26px; padding: 8px 12px; border-left: 2px solid var(--harbor-600); font-size: var(--type-small); color: var(--text-soft); }
.tg-turn-reply { padding: 4px 2px; font-size: 16px; }
.tg-ch-share { max-width: 620px; }

/* 3. What changed */
.tg-changes { display: grid; gap: 14px; }
.tg-c-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; align-items: flex-end; }
.tg-c-head h1 { margin: 4px 0; font-size: clamp(24px, 2.8vw, 34px); line-height: 1.1; }
.tg-c-facts { margin: 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; color: var(--text-muted); font-size: var(--type-small); }
.tg-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); overflow-x: auto; }
.tg-tab { background: none; border: 0; border-bottom: 2px solid transparent; padding: 10px 14px; font: inherit; font-size: var(--type-small); color: var(--text-muted); cursor: pointer; white-space: nowrap; }
.tg-tab.is-on { color: var(--text); border-bottom-color: var(--buoy-600); font-weight: 600; }
.tg-c-grid { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 20px; align-items: start; }
.tg-c-files { position: sticky; top: 12px; display: grid; gap: 2px; }
.tg-c-file { display: flex; gap: 8px; align-items: center; justify-content: space-between; background: none; border: 0; border-radius: var(--radius-sm); padding: 6px 8px; color: inherit; font: inherit; font-size: var(--type-small); text-align: left; cursor: pointer; }
.tg-c-file.is-on { background: color-mix(in oklab, var(--text) 8%, transparent); }
.tg-c-file.is-read { color: var(--text-muted); cursor: default; }
.tg-c-path { font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; direction: rtl; text-align: left; }
.tg-c-readhead { margin: 12px 8px 2px; }
.tg-c-diffs { display: grid; gap: 16px; min-width: 0; }
.tg-c-filecard { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
.tg-c-filecard > header { display: flex; gap: 10px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); background: var(--surface-sunken); }
.tg-c-filecard > header code { font-weight: 600; }
.tg-c-editcount { margin-left: auto; color: var(--text-muted); font-size: var(--type-small); }
.tg-c-edit { padding: 10px 14px; border-top: 1px dashed var(--line); }
.tg-c-edit:first-of-type { border-top: 0; }
.tg-c-edit.is-error { background: color-mix(in oklab, var(--err) 6%, transparent); }
.tg-c-why { margin: 0; display: flex; gap: 8px; align-items: baseline; font-size: var(--type-small); color: var(--text-soft); }
.tg-c-time { font-family: var(--font-mono); font-size: var(--type-micro); color: var(--text-muted); }
.tg-c-convo, .tg-c-checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; max-width: 860px; }
.tg-c-prompt { padding: 12px 16px; border-radius: var(--radius); background: color-mix(in oklab, var(--buoy-600) 10%, var(--surface)); }
.tg-c-reply { padding: 4px 16px; }
.tg-c-tool { display: flex; gap: 8px; align-items: center; padding: 2px 16px; font-family: var(--font-mono); font-size: var(--type-small); }
.tg-c-tool.is-error { color: var(--err); }
.tg-c-checks li { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px 14px; background: var(--surface); }
.tg-c-checks li.is-error { border-color: var(--err); }
.tg-c-checks header { display: flex; gap: 10px; align-items: center; }
.tg-c-share { max-width: 620px; }

/* 4. Session map */
.tg-lanes { display: grid; gap: 14px; }
.tg-m-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 12px; }
.tg-m-head h1 { margin: 4px 0 0; font-size: clamp(24px, 2.8vw, 34px); line-height: 1.1; }
.tg-map { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 14px 16px 10px; display: grid; gap: 10px; }
.tg-map-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; font-size: var(--type-small); color: var(--text-muted); }
.tg-map-keys { display: inline-flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; font-size: var(--type-micro); }
.tg-k { display: inline-block; width: 3px; height: 12px; border-radius: 1px; margin-left: 6px; }
.tg-k-dot { width: 9px; height: 9px; border-radius: 99px; }
.tg-map-body { display: grid; gap: 4px; }
.tg-lane, .tg-axis { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 12px; align-items: center; }
.tg-lane-label { font-family: var(--font-mono); font-size: var(--type-micro); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tg-lane-track { position: relative; height: 26px; border-bottom: 1px dashed var(--line); }
.tg-axis .tg-lane-track { height: 16px; border: 0; }
.tg-axis-tick { position: absolute; top: 0; transform: translateX(-50%); font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); }
.tg-lane-span { position: absolute; top: 4px; bottom: 4px; background: color-mix(in oklab, var(--harbor-600) 18%, transparent); border-radius: 4px; }
.tg-m-tick { position: absolute; top: 5px; width: 3px; height: 16px; border-radius: 1px; border: 0; padding: 0; transform: translateX(-50%); cursor: pointer; background: var(--text-muted); }
.tg-m-tick:hover, .tg-m-tick:focus-visible { outline: 2px solid var(--text); outline-offset: 1px; z-index: 2; }
.tg-m-read, .tg-m-search, .tg-m-plan, .tg-m-other { background: color-mix(in oklab, var(--text-muted) 70%, transparent); }
.tg-m-edit { background: var(--harbor-600); height: 20px; top: 3px; }
.tg-m-shell, .tg-m-web, .tg-m-mcp { background: var(--buoy-600); }
.tg-m-agent { background: var(--signal-600, var(--harbor-600)); }
.tg-m-err { background: var(--err); height: 24px; top: 1px; width: 4px; }
.tg-m-check, .tg-m-check-ok, .tg-m-check-err { width: 11px; height: 11px; top: 7px; border-radius: 99px; }
.tg-m-check-ok { background: var(--ok); } .tg-m-check-err { background: var(--err); } .tg-m-check { background: transparent; border: 2px solid var(--text-muted); }
.tg-m-tick.is-hollow:not(.tg-m-check) { background: transparent; box-shadow: inset 0 0 0 1px var(--text-muted); }
.tg-m-prompt { position: absolute; top: -2px; bottom: -4px; width: 0; border: 0; border-left: 2px solid var(--buoy-600); padding: 0; cursor: pointer; background: none; }
.tg-m-prompt::before { content: ""; position: absolute; top: 0; left: 0; border-left: 9px solid var(--buoy-600); border-top: 5px solid transparent; border-bottom: 5px solid transparent; }
.tg-m-reply { position: absolute; top: 9px; width: 8px; height: 8px; border-radius: 2px; transform: translateX(-50%) rotate(45deg); border: 0; padding: 0; background: var(--text); opacity: .65; cursor: pointer; }
.tg-m-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 18px; align-items: start; }
.tg-m-transcript { display: grid; gap: 8px; min-width: 0; }
.tg-m-rail { display: grid; gap: 14px; position: sticky; top: 12px; }
.tg-mi-prompt { padding: 14px 16px; border-radius: var(--radius); background: color-mix(in oklab, var(--buoy-600) 10%, var(--surface)); border-left: 4px solid var(--buoy-600); scroll-margin-top: 80px; }
.tg-mi-reply { padding: 4px 4px 4px 16px; border-left: 2px solid var(--harbor-600); }
.tg-mi-reply.is-final { padding: 14px 16px; border: 1px solid var(--line); border-left: 4px solid var(--ok); border-radius: var(--radius); background: var(--surface); }
.tg-mi-think { font-size: var(--type-small); color: var(--text-muted); padding-left: 16px; } .tg-mi-think summary { cursor: pointer; }
.tg-mi-tool { padding: 2px 10px; border-radius: var(--radius-sm); }
.tg-mi-tool.is-error { background: color-mix(in oklab, var(--err) 9%, transparent); }
.tg-run { border-radius: var(--radius-sm); }
.tg-run-bar { width: 100%; display: flex; gap: 8px; background: none; border: 1px dashed var(--line); border-radius: var(--radius-sm); padding: 6px 10px; color: var(--text-muted); font: inherit; font-family: var(--font-mono); font-size: var(--type-small); cursor: pointer; text-align: left; }
.tg-run-time { margin-left: auto; font-size: var(--type-micro); }
.tg-subcard { border: 1px solid var(--line); border-left: 4px solid var(--harbor-600); border-radius: var(--radius-sm); background: var(--surface); }
.tg-subcard > summary { padding: 10px 12px; cursor: pointer; font-size: var(--type-small); }
.tg-subcard-body { display: grid; gap: 6px; padding: 0 12px 12px; }

/* 5. Inspector */
.tg-inspector { display: grid; gap: 12px; }
.tg-i-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 20px; align-items: end; }
.tg-i-head h1 { margin: 2px 0 0; font-size: 24px; line-height: 1.15; }
.tg-i-facts { margin: 0; grid-column: 1; display: flex; gap: 8px; align-items: center; color: var(--text-muted); font-size: var(--type-small); }
.tg-i-head .trace-actions { grid-column: 2; grid-row: 1 / span 2; margin: 0; }
.tg-i-split { display: grid; grid-template-columns: minmax(340px, 420px) minmax(0, 1fr); border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); height: calc(100vh - 150px); min-height: 520px; overflow: hidden; }
.tg-i-listpane { display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 8px; padding: 12px 0 0; border-right: 1px solid var(--line); min-height: 0; }
.tg-i-listpane .tg-filterbar { padding: 0 12px; }
.tg-i-listpane .tg-search { flex: 1 1 100%; }
.tg-i-level { margin: 0; padding: 0 12px; font-size: var(--type-small); color: var(--text-muted); display: flex; gap: 8px; align-items: center; }
.tg-i-list { list-style: none; margin: 0; padding: 0 0 12px; overflow: auto; outline: none; }
.tg-i-row { display: grid; grid-template-columns: 40px 20px minmax(0, 1fr) auto; gap: 8px; align-items: center; width: 100%; padding: 5px 12px 5px calc(12px + var(--depth, 0) * 16px); background: none; border: 0; border-left: 3px solid transparent; color: inherit; font: inherit; font-size: var(--type-small); text-align: left; cursor: pointer; }
.tg-i-row:hover { background: color-mix(in oklab, var(--text) 4%, transparent); }
.tg-i-row.is-on { background: color-mix(in oklab, var(--harbor-600) 16%, transparent); border-left-color: var(--harbor-600); }
.tg-i-row.is-error .tg-i-title { color: var(--err); }
.tg-i-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tg-i-prompt .tg-i-title { font-weight: 700; }
.tg-i-tool .tg-i-title, .tg-i-reasoning .tg-i-title { font-family: var(--font-mono); font-size: 12px; color: var(--text-soft); }
.tg-i-overview { grid-template-columns: 1fr; font-weight: 600; }
.tg-i-detail { overflow: auto; padding: 16px 22px; min-width: 0; }
.tg-i-nav { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; position: sticky; top: -16px; padding: 8px 0; background: var(--surface); z-index: 2; }
.tg-i-pos { margin-left: auto; color: var(--text-muted); font-family: var(--font-mono); font-size: var(--type-micro); }
.tg-i-meta { margin: 0 0 6px; display: flex; gap: 8px; align-items: center; color: var(--text-muted); font-family: var(--font-mono); font-size: var(--type-micro); text-transform: uppercase; letter-spacing: .05em; }
.tg-i-h { margin: 0 0 8px; font-family: var(--font-mono); font-size: 16px; overflow-wrap: anywhere; }
.tg-i-overviewpane { display: grid; gap: 14px; }
.tg-i-turns { margin: 0; padding-left: 0; list-style: none; display: grid; gap: 8px; }
.tg-i-turns li { display: grid; gap: 2px; }
.tg-i-turns .tg-ch-meta { margin: 0; }

@media (max-width: 900px) {
  .tg-chapters, .tg-c-grid, .tg-m-grid, .tg-i-split { grid-template-columns: 1fr; }
  .tg-ch-rail, .tg-c-files, .tg-m-rail { position: static; }
  .tg-i-split { height: auto; }
  .tg-i-list { max-height: 50vh; }
  .tg-log-row { grid-template-columns: 40px 20px minmax(0, 1fr) auto; }
  .tg-log-row .tg-log-name { display: none; }
  .tg-lane, .tg-axis { grid-template-columns: 90px minmax(0, 1fr); }
  .tg-edge { top: auto; bottom: 12px; transform: none; }
}
`;
