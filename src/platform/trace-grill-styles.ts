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

// Native chat-transcript variants (AI Elements look, app tokens).
export const CHAT_CSS = String.raw`
.tc { --tc-secondary: color-mix(in oklab, var(--text) 9%, var(--surface)); --tc-muted: color-mix(in oklab, var(--text) 5%, var(--bg)); display: grid; gap: 16px; max-width: 820px; margin: 0 auto; width: 100%; font-size: 15px; grid-template-columns: minmax(0, 1fr); }
.tc > *, .tc-conversation > *, .tc-task-body > *, .tc-tool-body > * { min-width: 0; }
.tc-icon { flex: none; vertical-align: -3px; transition: transform .15s var(--ease-out, ease-out); }
.tc-icon.is-open { transform: rotate(180deg); }
.tc-muted { color: var(--text-muted); }
.tc-topbar { display: flex; flex-wrap: wrap; gap: 10px 20px; align-items: flex-end; justify-content: space-between; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
.tc-topbar h1 { margin: 4px 0; font-size: 24px; line-height: 1.2; letter-spacing: -0.01em; }
.tc-topbar-kind { display: inline-flex; gap: 6px; align-items: center; color: var(--text-muted); font-size: 13px; }
.tc-topbar-meta { margin: 0; color: var(--text-muted); font-size: 13px; }
.tc-outcome-ok { color: var(--ok); } .tc-outcome-err { color: var(--err); }
.tc-topbar-actions { display: flex; gap: 8px; align-items: center; }
.tc-sharebtn { display: inline-flex; gap: 6px; align-items: center; }
.tc-levelpill { font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line); color: var(--text-muted); }
.tc-levelpill-full { color: var(--buoy-700); background: var(--buoy-100); border-color: transparent; }
.tc-levelpill-conversation { color: var(--harbor-700); background: var(--harbor-100); border-color: transparent; }
.tc-levelbanner { display: flex; gap: 10px; align-items: flex-start; padding: 10px 14px; border-radius: 10px; background: var(--tc-secondary); color: var(--text-soft); font-size: 13px; }
.tc-conversation { display: flex; flex-direction: column; gap: 22px; padding: 8px 0 24px; }
.tc-msg { display: flex; flex-direction: column; gap: 8px; max-width: 95%; min-width: 0; }
.tc-msg-user { margin-left: auto; align-items: flex-end; max-width: 80%; }
.tc-bubble { border-radius: 14px; background: var(--tc-secondary); padding: 12px 16px; line-height: 1.55; }
.tc-msg-agent { line-height: 1.65; }
.tc-msg-agent .tg-md code, .tc-bubble .tg-md code { background: var(--tc-muted); border: 1px solid var(--line); }
.tc-agentname { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; color: var(--text-muted); font-weight: 600; }
.tc-msgactions { display: flex; gap: 6px; align-items: center; color: var(--text-muted); }
.tc-msgtime { font-size: 12px; font-family: var(--font-mono); }
.tc-iconbtn { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; }
.tc-iconbtn:hover { background: var(--tc-secondary); color: var(--text); }
.tc-note { margin: 0; color: var(--text-muted); font-size: 13px; }
.tc-reasoning-trigger { display: inline-flex; gap: 8px; align-items: center; background: none; border: 0; padding: 0; color: var(--text-muted); font: inherit; font-size: 14px; cursor: pointer; margin: 0; }
.tc-reasoning-trigger:hover:not(.is-static) { color: var(--text); }
.tc-reasoning-body { margin-top: 10px; padding-left: 24px; color: var(--text-muted); font-size: 14px; line-height: 1.6; }
.tc-tool { border: 1px solid var(--line); border-radius: 8px; background: var(--surface); overflow: hidden; }
.tc-tool.is-error { border-color: color-mix(in oklab, var(--err) 55%, var(--line)); }
.tc-tool-head { display: flex; width: 100%; align-items: center; gap: 12px; padding: 10px 12px; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.tc-tool-name { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.tc-tool-title { font-weight: 600; font-size: 14px; white-space: nowrap; }
.tc-tool-label { font-family: var(--font-mono); font-size: 12.5px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.tc-tool-body { display: grid; gap: 14px; padding: 4px 14px 14px; }
.tc-tool-h { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); font-weight: 600; }
.tc-badge { display: inline-flex; gap: 5px; align-items: center; border-radius: 999px; padding: 2px 9px; font-size: 12px; background: var(--tc-secondary); color: var(--text-soft); white-space: nowrap; }
.tc-badge-ok .tc-icon { color: var(--ok); } .tc-badge-err { color: var(--err); background: color-mix(in oklab, var(--err) 12%, transparent); }
.tc-badge-hidden { color: var(--text-muted); }
.tc-output { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--tc-muted); font-family: var(--font-mono); font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 22em; overflow: auto; }
.tc-output.is-error { background: color-mix(in oklab, var(--err) 10%, transparent); color: var(--err); }
.tc-hidden { margin: 0; display: flex; gap: 8px; align-items: center; color: var(--text-muted); font-size: 13px; }
.tc-code { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--tc-muted); }
.tc-code-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 4px 4px 12px; border-bottom: 1px solid var(--line); background: var(--tc-secondary); color: var(--text-muted); font-size: 12px; }
.tc-code-title { display: inline-flex; gap: 8px; align-items: center; font-family: var(--font-mono); min-width: 0; }
.tc-code-body { margin: 0; padding: 12px 0; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.6; overflow: auto; max-height: 28em; white-space: pre; }
.tc-code-body:not(:has(.tc-line)) { padding: 12px 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.tc-line { padding: 0 14px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.tc-sign { display: inline-block; width: 28px; text-align: center; color: var(--text-muted); user-select: none; }
.tc-line-add { background: color-mix(in oklab, var(--ok) 14%, transparent); } .tc-line-add .tc-sign { color: var(--ok); }
.tc-line-del { background: color-mix(in oklab, var(--err) 12%, transparent); } .tc-line-del .tc-sign { color: var(--err); }
.tc-diffstat { display: inline-flex; gap: 6px; font-family: var(--font-mono); font-size: 12px; font-weight: 600; }
.tc-add { color: var(--ok); } .tc-del { color: var(--err); }
.tc-task { display: grid; gap: 10px; }
.tc-task-trigger { display: flex; gap: 8px; align-items: center; background: none; border: 0; padding: 0; color: var(--text-muted); font: inherit; font-size: 14px; cursor: pointer; text-align: left; }
.tc-task-trigger:hover { color: var(--text); }
.tc-task-trigger > span:first-of-type { color: var(--text); font-weight: 500; }
.tc-task-meta { font-size: 13px; }
.tc-task-files, .tc-chips { display: flex; flex-wrap: wrap; gap: 6px; padding-left: 24px; margin: 0; list-style: none; }
.tc-chips { padding-left: 0; }
.tc-filechip { display: inline-flex; gap: 4px; align-items: center; border: 1px solid var(--line); border-radius: 6px; background: var(--tc-secondary); padding: 2px 7px; font-family: var(--font-mono); font-size: 12px; }
.tc-task-body, .tc-task-result { margin-left: 7px; padding-left: 16px; border-left: 2px solid var(--line); display: grid; gap: 10px; color: var(--text-soft); font-size: 14px; }
.tc-task-reply { font-size: 14px; }
.tc-queue { border: 1px solid var(--line); border-radius: 12px; padding: 8px 12px 10px; background: var(--surface); }
.tc-queue-head { display: flex; gap: 8px; align-items: center; color: var(--text-muted); font-size: 13px; font-weight: 600; padding: 4px 0 6px; }
.tc-queue ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.tc-todo { display: flex; gap: 10px; align-items: center; font-size: 14px; padding: 3px 4px; color: var(--text-soft); }
.tc-todo-dot { width: 10px; height: 10px; border-radius: 99px; border: 1.5px solid var(--text-muted); flex: none; }
.tc-todo-completed { color: var(--text-muted); text-decoration: line-through; }
.tc-todo-completed .tc-todo-dot { background: var(--text-muted); opacity: .5; }
.tc-todo-in_progress .tc-todo-dot { border-color: var(--harbor-600); background: color-mix(in oklab, var(--harbor-600) 35%, transparent); }
.tc-todo-now { font-size: 11px; color: var(--harbor-600); text-transform: uppercase; letter-spacing: .06em; }
.tc-work { display: grid; gap: 10px; }
.tc-work-trigger { display: inline-flex; gap: 8px; align-items: center; width: fit-content; max-width: 100%; background: none; border: 0; padding: 0; color: var(--text-muted); font: inherit; font-size: 14px; cursor: pointer; text-align: left; }
.tc-work-trigger:hover { color: var(--text); }
.tc-work-time { font-size: 12px; font-family: var(--font-mono); }
.tc-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; position: relative; }
.tc-steps.is-nested { margin-top: 8px; }
.tc-step { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 8px; position: relative; padding-bottom: 10px; }
.tc-step::before { content: ""; position: absolute; left: 12px; top: 26px; bottom: 0; width: 1px; background: var(--line); }
.tc-step:last-child::before { display: none; }
.tc-step-icon { width: 26px; height: 26px; border-radius: 99px; display: grid; place-items: center; background: var(--tc-secondary); color: var(--text-muted); }
.tc-step-icon.is-error { color: var(--err); background: color-mix(in oklab, var(--err) 14%, transparent); }
.tc-step-main { min-width: 0; padding-top: 3px; display: grid; gap: 6px; font-size: 14px; }
.tc-step-line { display: flex; gap: 8px; align-items: center; background: none; border: 0; padding: 0; color: var(--text-soft); font: inherit; font-size: 14px; text-align: left; cursor: pointer; min-width: 0; }
.tc-step-line:disabled { cursor: default; }
.tc-step-line:hover:not(:disabled) .tc-step-text { color: var(--text); text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px; }
.tc-step-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-step.is-error .tc-step-text { color: var(--err); }
.tc-step-desc { margin: 0; color: var(--text-muted); font-size: 13px; }
.tc-step-hidden { color: var(--text-muted); display: inline-flex; }
.tc-step-thoughttext { margin: 0; color: var(--text-muted); font-style: italic; }
.tc-step-say .tg-md { color: var(--text); }
.tc-continue { position: sticky; bottom: 12px; z-index: 6; display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; padding: 10px; border: 1px solid var(--line); border-radius: 16px; background: color-mix(in oklab, var(--surface) 92%, transparent); backdrop-filter: blur(8px); box-shadow: 0 8px 24px color-mix(in oklab, black 22%, transparent); }
.tc-scrollend { position: fixed; left: 50%; bottom: 92px; transform: translateX(-50%); z-index: 7; width: 36px; height: 36px; border-radius: 99px; border: 1px solid var(--line); background: var(--surface); color: var(--text); display: grid; place-items: center; cursor: pointer; }
.tc-sheet-backdrop { position: fixed; inset: 0; z-index: 50; background: color-mix(in oklab, black 40%, transparent); display: flex; justify-content: flex-end; }
.tc-sheet { width: min(440px, 100%); height: 100%; overflow: auto; background: var(--bg); padding: 12px; border-left: 1px solid var(--line); position: relative; }
.tc-sheet-close { position: absolute; top: 18px; right: 18px; z-index: 1; }
.tc-summaryonly { padding: 16px; border-radius: 12px; background: var(--tc-secondary); display: grid; gap: 12px; }
.tc-summaryonly p { margin: 0; }
@media (max-width: 640px) { .tc-msg-user { max-width: 92%; } .tc-tool-label { display: none; } }
`;

// Round 2: ways into the work under a prompt → reply chat.
export const R2_CSS = String.raw`
.r2 { transition: max-width .2s var(--ease-out, ease-out); }
.r2.r2-wide { max-width: 1320px; }
.r2-muted { color: var(--text-muted); font-size: 13px; }
.r2-empty { margin: 0; color: var(--text-muted); font-size: 14px; }
.r2-stack { display: grid; gap: 10px; min-width: 0; }
.r2-turn { display: flex; flex-direction: column; gap: 14px; scroll-margin-top: 16px; }
.r2-turn + .r2-turn { padding-top: 10px; }
.r2-workline { display: inline-flex; flex-wrap: wrap; gap: 8px; align-items: center; width: fit-content; max-width: 100%; background: none; border: 0; padding: 4px 0; color: var(--text-muted); font: inherit; font-size: 14px; cursor: pointer; text-align: left; }
.r2-workline:hover, .r2-workline.is-open { color: var(--text); }
.r2-unfold { display: grid; gap: 8px; }
.r2-unfold-body { margin-left: 6px; padding: 6px 0 4px 16px; border-left: 2px solid var(--line); }
.r2-chip { display: inline-flex; gap: 8px; align-items: center; width: fit-content; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--text-soft); padding: 5px 12px; font: inherit; font-size: 13px; cursor: pointer; }
.r2-chip:hover { border-color: var(--line-strong); color: var(--text); }
.r2-chip.is-on { background: var(--text); color: var(--bg); border-color: var(--text); }
.r2-split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 28px; align-items: start; }
.r2-split.is-open { grid-template-columns: minmax(0, 1fr) minmax(380px, 520px); }
.r2-split > * { min-width: 0; }
.r2-panel { position: sticky; top: 12px; max-height: calc(100vh - 24px); display: grid; grid-template-rows: auto auto minmax(0, 1fr); border: 1px solid var(--line); border-radius: 12px; background: var(--surface); overflow: hidden; box-shadow: 0 10px 30px color-mix(in oklab, black 20%, transparent); }
.r2-panel-head { display: flex; justify-content: space-between; gap: 10px; padding: 12px 12px 8px 16px; border-bottom: 1px solid var(--line); background: var(--tc-secondary); }
.r2-panel-title { font-weight: 600; font-size: 14px; }
.r2-panel-q { margin: 4px 0 0; color: var(--text-muted); font-size: 13px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.r2-panel-body { overflow: auto; padding: 14px 16px; }
.r2-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); padding: 0 8px; overflow-x: auto; }
.r2-tab { background: none; border: 0; border-bottom: 2px solid transparent; padding: 9px 10px; color: var(--text-muted); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; display: inline-flex; gap: 6px; align-items: center; }
.r2-tab.is-on { color: var(--text); border-bottom-color: var(--text); font-weight: 600; }
.r2-tab-err { min-width: 18px; height: 18px; border-radius: 99px; background: color-mix(in oklab, var(--err) 18%, transparent); color: var(--err); font-size: 11px; display: inline-grid; place-items: center; padding: 0 5px; }
.r2-tabbed { display: grid; gap: 14px; }
.r2-tabbed .r2-tabs { padding: 0; }
.r2-checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.r2-check-line { display: flex; gap: 10px; align-items: center; width: 100%; background: none; border: 0; padding: 6px 0; color: inherit; font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
.r2-check-line code { font-family: var(--font-mono); font-size: 12.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.r2-check-icon { display: inline-grid; }
.r2-ok { color: var(--ok); } .r2-err { color: var(--err); } .r2-unknown { color: var(--text-muted); }
.r2-timeline { display: grid; gap: 6px; padding: 10px 14px 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.r2-tl-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; color: var(--text-muted); font-size: 13px; }
.r2-link { margin-left: auto; background: none; border: 0; padding: 0; color: var(--text-muted); font: inherit; font-size: 13px; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line-strong); }
.r2-link:hover { color: var(--text); }
.r2-tl-track { position: relative; height: 30px; margin: 4px 6px 0; }
.r2-tl-rail { position: absolute; left: 0; right: 0; top: 50%; height: 2px; margin-top: -1px; background: var(--line); border-radius: 2px; }
.r2-tl-dot { position: absolute; top: 50%; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 99px; border: 2px solid var(--surface); background: color-mix(in oklab, var(--text-muted) 75%, transparent); padding: 0; cursor: pointer; box-sizing: content-box; transition: transform .1s; }
.r2-tl-dot:hover, .r2-tl-dot:focus-visible { transform: scale(1.35); outline: none; }
.r2-tl-dot.is-on { box-shadow: 0 0 0 3px var(--text); }
.r2-tl-edit { background: var(--harbor-600); }
.r2-tl-err { background: var(--err); }
.r2-tl-ok { background: var(--ok); }
.r2-tl-unknown { background: var(--surface); box-shadow: inset 0 0 0 2px var(--text-muted); }
.r2-tl-dot.is-check { width: 12px; height: 12px; margin: -6px 0 0 -6px; }
.r2-tl-sub { position: absolute; top: 50%; height: 20px; margin-top: -10px; border-radius: 99px; border: 1px solid color-mix(in oklab, var(--harbor-600) 60%, transparent); background: color-mix(in oklab, var(--harbor-600) 18%, var(--surface)); color: var(--text-soft); font: inherit; font-size: 11px; cursor: pointer; padding: 0 8px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.r2-tl-sub.is-on { box-shadow: 0 0 0 2px var(--text); }
.r2-tl-ends { display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); margin: 0 2px; }
.r2-tl-detail { display: grid; gap: 10px; margin-top: 6px; padding-top: 12px; border-top: 1px solid var(--line); }
.r2-tl-detail header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 14px; }
.r2-tl-nav { margin-left: auto; display: inline-flex; gap: 2px; }
.r2-rot90 { transform: rotate(90deg); } .r2-rotm90 { transform: rotate(-90deg); }
.r2-tl-note { margin: 0; color: var(--text-soft); font-size: 14px; }
.r2-depth { position: sticky; top: 10px; z-index: 6; justify-self: center; display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--line); border-radius: 999px; background: color-mix(in oklab, var(--surface) 92%, transparent); backdrop-filter: blur(8px); }
.r2-depth-opt { border: 0; background: none; color: var(--text-muted); border-radius: 999px; padding: 6px 14px; font: inherit; font-size: 13px; cursor: pointer; min-height: 32px; }
.r2-depth-opt.is-on { background: var(--text); color: var(--bg); }
@media (max-width: 900px) { .r2-split.is-open { grid-template-columns: minmax(0, 1fr); } .r2-panel { position: static; max-height: none; } }
`;

export const R3_CSS = String.raw`
.r3-strip { position: relative; display: flex; align-items: center; gap: 0; min-width: 0; }
.r3-strip-dots { height: 24px; }
.r3-strip-dots::before { content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: var(--line); }
.r3-mark { position: relative; min-width: 0; height: 24px; padding: 0; border: 0; background: none; cursor: pointer; display: grid; place-items: center; border-radius: 6px; }
.r3-mark:focus-visible { outline: 2px solid var(--text); outline-offset: 1px; }
.r3-strip-dots .r3-pip { width: 7px; height: 7px; border-radius: 99px; background: color-mix(in oklab, var(--text-muted) 55%, var(--surface)); box-shadow: 0 0 0 2px var(--surface); transition: transform .1s; }
.r3-strip-dots .r3-mark:hover .r3-pip { transform: scale(1.5); }
.r3-strip-dots .r3-edit .r3-pip { background: var(--harbor-600); }
.r3-strip-dots .r3-err .r3-pip, .r3-strip-dots .r3-sub-err .r3-pip { background: var(--err); }
.r3-strip-dots .r3-ok .r3-pip { background: var(--ok); }
.r3-strip-dots .r3-unknown .r3-pip { background: var(--surface); box-shadow: inset 0 0 0 1.5px var(--text-muted), 0 0 0 2px var(--surface); }
.r3-strip-dots .r3-mark.is-on .r3-pip { transform: scale(1.5); box-shadow: 0 0 0 2px var(--surface), 0 0 0 3.5px var(--text); }
.r3-strip-dots .is-sub { padding: 0 2px; }
.r3-strip-dots .is-sub .r3-pip { position: absolute; inset: 5px 2px; width: auto; height: auto; border-radius: 99px; background: color-mix(in oklab, var(--harbor-600) 16%, var(--surface)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--harbor-600) 55%, transparent); transform: none !important; }
.r3-strip-dots .is-sub.r3-sub-err .r3-pip { box-shadow: inset 0 0 0 1px var(--err); }
.r3-strip-dots .is-sub.is-on .r3-pip { box-shadow: inset 0 0 0 1.5px var(--text); }
.r3-sub-label { position: relative; font-size: 10.5px; color: var(--text-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; padding: 0 6px; }
.r3-strip-bar { height: 22px; gap: 1px; flex: 1; }
.r3-strip-bar .r3-mark { height: 22px; border-radius: 0; }
.r3-strip-bar .r3-pip { width: 100%; height: 6px; background: color-mix(in oklab, var(--text-muted) 35%, var(--surface)); transition: height .1s; }
.r3-strip-bar .r3-mark:first-child .r3-pip { border-radius: 99px 0 0 99px; }
.r3-strip-bar .r3-mark:last-child .r3-pip { border-radius: 0 99px 99px 0; }
.r3-strip-bar .r3-mark:hover .r3-pip, .r3-strip-bar .r3-mark.is-on .r3-pip { height: 12px; }
.r3-strip-bar .r3-edit .r3-pip { background: var(--harbor-600); }
.r3-strip-bar .r3-err .r3-pip, .r3-strip-bar .r3-sub-err .r3-pip { background: var(--err); }
.r3-strip-bar .r3-ok .r3-pip { background: var(--ok); }
.r3-strip-bar .r3-unknown .r3-pip { background: var(--text-muted); }
.r3-strip-bar .r3-sub .r3-pip { background: color-mix(in oklab, var(--harbor-600) 40%, var(--surface)); }
.r3-strip-bar .r3-mark.is-on .r3-pip { outline: 1.5px solid var(--text); outline-offset: 1px; }
.r3-barline { display: flex; gap: 10px; align-items: center; }
.r3-bar-time { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); white-space: nowrap; }
.r3-above { margin: 0 2px -8px; }
.r3-tabrow { display: flex; align-items: flex-end; gap: 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.r3-tabrow .r3-tabs { border-bottom: 0; flex: none; }
.r3-inrow { flex: 1 1 200px; margin-bottom: 7px; }
@media (max-width: 640px) { .r3-inrow { flex-basis: 100%; order: -1; margin: 4px 0 0; } }
.r3-reader { display: grid; gap: 8px; }
.r3-reader-ends { display: flex; justify-content: space-between; align-items: center; font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); }
.r3-reader-ends .r2-link { margin: 0 auto; font-family: var(--font-body); font-size: 13px; }
.r3-reader-card { margin-top: 0; }
.r3-sync { display: grid; gap: 12px; }
.r3-sync-bar { position: sticky; top: 8px; z-index: 4; display: grid; gap: 2px; padding: 6px 10px 8px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg); box-shadow: 0 6px 16px -8px rgb(0 0 0 / .35); }
.r3-sync-meta { display: flex; justify-content: space-between; font-size: 12px; color: var(--text-muted); }
.tc-step.is-active > .tc-step-icon { box-shadow: 0 0 0 2px var(--text); }
.tc-step.is-focus { animation: r3-focus 1.6s ease-out; border-radius: 8px; }
@keyframes r3-focus { 0%, 35% { background: color-mix(in oklab, var(--harbor-600) 12%, transparent); } 100% { background: transparent; } }
@media (prefers-reduced-motion: reduce) { .tc-step.is-focus { animation: none; background: color-mix(in oklab, var(--harbor-600) 10%, transparent); } }
`;
