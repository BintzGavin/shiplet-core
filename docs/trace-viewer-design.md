# Trace viewer design

The trace viewer at `/shiplets/<id>/traces/<trace>` (spec: [traces-spec.md](./traces-spec.md)
D15) was chosen over four rounds of live prototypes in the product, each
comparing five designs on a 150-event session with three subagents and four
failed steps, read at Full and at Conversation. This file records what was
decided and why, so later changes start from the same reasons.

## Decisions

1. **A chat transcript, not a log.** Each prompt is a bubble on the right and
   the agent's final reply sits under it. Everything the agent did in between
   is one click away, never on the page by default. Rejected: a one-line-per-event
   log, a card per tool call, a session map with lanes, and a master-detail
   inspector. All of them made a long session hard to read top to bottom.
2. **The work lives in tabs on the reply.** Each reply has Answer, Steps,
   Changes, and Checks. Answer is open by default. The Steps tab badge counts
   failed steps. A reply to a prompt that used no tools has no tabs. Rejected:
   an inline "worked for 3m" line that unfolds, a side panel, one global
   detail switch, and an always-visible timeline under each prompt.
3. **Steps has a sticky activity bar.** One thin bar above the step list, one
   segment per step, as wide as the time the step took, coloured by kind (edit,
   failure, passed check). Subagents are named pills on the bar. The bar lights
   the step being read as the list scrolls, and picking a segment jumps the list
   to it. The bar lives only in the Steps tab. Rejected: evenly spaced dots, a
   bar above the tabs or in the tab row, and a one-step-at-a-time reader.
4. **A quiet header.** The harness label, the title, and one line: duration,
   prompts, files changed, outcome. Below Full it adds "Shared as
   Conversation" (or Summary) with an info button that lists what the level
   leaves out and keeps. Owners get a Share button that opens the sharing
   controls in a side sheet. Rejected: an outcome card before the first prompt,
   a Summary / Conversation / Full scale, locks on the tabs, and an "About this
   session" sheet. No model names or version numbers appear anywhere.
5. **Continue from a sticky bar.** Where a chat app keeps its composer, the
   viewer keeps "Copy prompt for your agent", "Copy CLI command", and the link
   back to the Shiplet (or "Open full page" when embedded).
6. **Check results survive every level.** The manifest summary keeps each
   check's command and pass or fail at every level, and the viewer matches
   those to the check steps in order, using the server's own `isCheckCommand`
   rule. A Conversation reader sees which checks failed and passed, in the bar,
   the step list, the tab badge, and the Checks tab, without any output.
   Errors from steps that are not checks stay hidden below Full.

## Behaviour

- **Loading.** The viewer reads every segment, one after another, and the
  transcript fills in as they arrive. Turns are built from the whole session,
  so a prompt's final reply is the last reply before the next prompt.
- **Hidden content** is marked where it would be: an eye-off icon on a step
  whose output was left out, "Reasoning hidden at Conversation" in the step
  list, and a note above the file list in Changes.
- **Attachments** render inline at the event that carried them. Any the
  session's events never reference are listed after the conversation.
- **Keyboard.** Tabs follow the ARIA tab pattern (Left, Right, Home, End). The
  activity bar is a listbox with one tab stop; arrow keys move along it.
- **Motion.** Jumping to a step scrolls smoothly and flashes the row, unless
  the reader prefers reduced motion.
- **Narrow screens.** The prompt bubble widens, the tab row scrolls
  sideways, and the Share button wraps under the title.

## Open questions

- Very long sessions (hundreds of steps in one prompt) make the activity bar's
  segments thin. Zooming the bar or grouping quiet stretches may help.
- Changes lists every edit in order. Grouping edits by file was the next
  question to test and was not settled.
