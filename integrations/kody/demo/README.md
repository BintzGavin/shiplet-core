# Field Notes review demo

The example is a self-contained, fictional trail guide. Version one has an
ambiguous call to action and no route essentials. A reviewer asks for a specific
CTA plus walking time and elevation; the revision makes those changes visible.
No external images, fonts, paid services, or navigation data are required.

From the provider checkout:

```sh
npm ci
npm run test:kody
npm run test:mutation:kody
npm run demo:kody
```

The browser demo starts an isolated local Wrangler service on port 8794 and
D1/R2 state under `/private/tmp/shiplet-kody-local-state`. It creates synthetic
accounts, publishes via actual MCP, uses the browser to annotate and confirm a
real ticket, prepares an immutable revision, checks its content, and approves
promotion through the actual owner form. It verifies the original review link
shows the revision, while the ticket remains New and tied to its source revision.
A local Chrome installation is required by the checked-in Playwright config.

Screenshots and a JSON receipt are written outside the repository under
`/private/tmp/shiplet-kody-evidence`. Each invocation creates a fresh Shiplet; the
receipts are local demo state, never production deployment records. The tests
keep generated fixture credentials in memory and disable trace/video recording.

| Evidence | What it establishes |
| --- | --- |
| `01-review.png` | Version one served inside the real trusted review host |
| `02-feedback.png` | Browser-created contextual ticket visible in review |
| `03-revision-preview.png` | Candidate-specific preview before promotion |
| `04-active-review.png` | Same review link after owner-approved activation |
| `05-mobile-review.png` | Responsive artifact and review host at 390px |
| `receipt.json` | Project/source/candidate identity and per-ticket content checks |

Boundary: Kody's per-user remote MCP bridge is represented by the test adapter.
Shiplet's MCP parser, handlers, database, artifact storage, browser annotation,
and trusted approval path are real local code. This does not prove hosted OAuth
consent, installed Kody package invocation, or production deployment.
