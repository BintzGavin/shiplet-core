interface DocsPage {
  slug: string;
  title: string;
  description: string;
  group: string;
  body: string;
}

// prettier-ignore
const DOCS_PUBLIC_CONTENT_SHA256: Record<string, string> = {
  "introduction": "9663596c77c9da2252b7ca9e73e2b01512fdb489b8a67897d5baf4d911a35c14",
  "why-shiplet":
    "a34409ae0097659bc90a6d30c9ae63733565e418412175f3871993a452735db4",
  "quickstart":
    "7fac82983b1114abc22bbab2132b1f32ffb18f4e3d2a586bc8c1702bf2c682e2",
  "access-control":
    "2f643ec9eb0cdec1a026a9f806b9eb1a3a8a2337494b6e1631ed26a09aa90e79",
  "publishing":
    "30d1d9970f7f8e78f1a4ca50c79aa3bf4f556ba61996972786320cd7e60e61f7",
  "extensions":
    "c834eef088f4ab55ed628fe95cc4b169445c7ca3f77732e8717e5c048fc70d13",
  "review-feedback":
    "6395cd616a18a9148f47a9f639bfc3d0027b663556f1ac0ecbe271040f4b116b",
  "code-mode-mcp":
    "1f4f23f04f0f11d6238515d158ae5f1da6493e2d4da64d343903a5851d5212e3",
  "api-keys":
    "9fb78882f2041ecf900e128ad19c53131617c987bcb347f084d46c871d2ed83a",
  "api-surface":
    "ae7d36eb6be9d7c20c4e9a493540d3b9f3d89ce7d31dbb1de9a25d8ee5f56f95",
  "wordpress": "6d2985eb2714be25e001b9b179ef8f889593488ebdd72cd5986e1269cb42f6b9",
  "security": "5b52e175c0b5cb8630e199c1bfc126895eadaa47e5f0fa3ec19d7878b6e7caa6"
};

const DOCS_PAGES: DocsPage[] = [
  {
    slug: "introduction",
    title: "Introduction",
    description:
      "Prepare an artifact, share a review link, and collect contextual feedback.",
    group: "Start",
    body: `
<p>Shiplet is the review layer for agent-first teams. The artifact remains the work your team reviews, whether it is a build output, standalone file, static export, or public preview URL. Shiplet places that work inside a trusted review experience where people can comment and agents can pick up the resulting tickets.</p>
<p><a href="/">Open the Shiplet app</a> to prepare a review.</p>
<h2>Choose your task</h2>
<ul>
  <li><strong><a href="/docs/quickstart">Publish my first review</a>:</strong> prepare an artifact and open its review link.</li>
  <li><strong><a href="/docs/review-feedback">Collect feedback</a>:</strong> leave contextual comments and work through review tickets.</li>
  <li><strong><a href="/docs/code-mode-mcp">Automate with an agent</a>:</strong> connect through Code Mode MCP or use documented REST operations.</li>
  <li><strong><a href="/docs/access-control">Manage access</a>:</strong> choose who can view or edit each Shiplet.</li>
  <li><strong><a href="/docs/wordpress">Review a WordPress site</a>:</strong> attach the Shiplet review layer to an existing site.</li>
</ul>
<p>Read <a href="/docs/why-shiplet">Why Shiplet</a> for the product idea behind a customizable review room rooted in durable state.</p>
<h2>How Shiplet fits around your work</h2>
<ul>
  <li>The <strong>artifact</strong> is the page, file, build, or URL under review.</li>
  <li>The <strong>Shiplet</strong> owns the stable review link, access policy, and feedback.</li>
  <li>The <strong>review layer</strong> provides the toolbar and trusted controls around the artifact.</li>
</ul>
<p>Artifact code does not receive reviewer credentials or direct access to Shiplet APIs. The trusted host keeps identity and review actions outside the artifact frame.</p>
<h2>Customize the review experience</h2>
<p>The built-in toolbar works for ordinary reviews. Shiplet can attach a custom widget and workflow when a team needs different controls or statuses. Those customizations belong to the review experience, so they do not become part of the work being reviewed. Read <a href="/docs/extensions">The review layer</a> for the boundary.</p>
<h2>Automation</h2>
<p>The public automation paths are Code Mode MCP and direct REST. The <a href="/openapi.json">OpenAPI document</a> is the machine-readable contract for documented public REST operations.</p>
<p><strong>Next:</strong> <a href="/docs/quickstart">prepare your first review artifact</a>.</p>`,
  },
  {
    slug: "why-shiplet",
    title: "Why Shiplet",
    description:
      "Why each review link gets its own interface and durable root.",
    group: "Start",
    body: `
<h2>Every Shiplet gets a root</h2>
<p>Shiplet turns anything you can open in a browser into a review link.</p>
<p>The artifact is the thing under review: a website, prototype, document, or report. Shiplet gives that artifact one link where reviewers can click directly on the work and leave comments in context. When they return, the conversation is waiting in the same place.</p>
<p>The review widget is the toolbar and panel around the artifact. A team can customize it for the work in front of them, and the artifact itself stays unchanged. I want that widget to make every Shiplet feel like its own little product.</p>
<figure class="docs-figure"><img src="/brand/why-shiplet/shiplet-root-hero.webp" alt="An illustrated ShipletRoot station giving one Shiplet its own review interface" width="1672" height="941" loading="eager"><figcaption>A Shiplet wraps the thing under review in a widget that the team can customize.</figcaption></figure>
<p>On a working build, a PM cares about whether each acceptance criterion survives the awkward states. A researcher's prototype carries a different question, because every product claim needs a path back to the observations behind it. The review layer holds that context because it belongs to the work.</p>
<p>Each link is its own review room, so every Shiplet gets a root.</p>
<p>The root remembers which widget the Shiplet uses and keeps its feedback together. It also coordinates who is in the live room.</p>
<p><a href="https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/">Cloudflare Durable Objects</a> give that root a permanent address and storage of its own. One Durable Object belongs to one Shiplet, so every request for that review returns to the same place.</p>
<figure class="docs-figure"><img src="/brand/why-shiplet/shiplet-root-runtime.webp" alt="Shiplet architecture showing the trusted browser host and Platform Worker reaching one ShipletRoot, plus Code Mode running in a disposable Dynamic Worker" width="1280" height="720" loading="lazy"><figcaption>Reviewing and changing a review use the same ShipletRoot. The Dynamic Worker runs Code Mode; the approved widget runs in the browser sandbox.</figcaption></figure>
<h2>The review belongs to the Shiplet</h2>
<p>A Shiplet is the review room around one artifact. Its widget belongs to that room.</p>
<p>The default experience stays small. A trusted host renders the artifact inside an isolated frame, adds the review toolbar, and keeps the reviewer's session outside the artifact. Pins stay attached to the context people were looking at, and comments return to the same review link.</p>
<figure class="docs-figure"><img src="/brand/why-shiplet/default-review-flow.webp" alt="The default Shiplet review flow on a static artifact, with the compact Annotate control and one contextual comment pin" width="1280" height="720" loading="lazy"><figcaption>The default review surface stays out of the way until somebody adds an annotation or opens a thread.</figcaption></figure>
<p>The ShipletRoot owns the layer around that artifact. It knows which widget is active, which changes are waiting in preview, where the current layer came from, and who is in the live room. That gives us room to make a review feel purpose-built without changing the files underneath it.</p>
<p>The widget itself is browser code. Shiplet runs the approved widget in its own sandboxed frame, where it can render controls and react to the reviewer. It never receives the user's session or direct bindings to D1 and R2. The Durable Object stays outside that frame too. When the widget needs to create feedback or record a workflow event, it asks the trusted host through a small, typed operation.</p>
<p>That boundary lets deep customization become a normal product feature with explicit authority.</p>
<h2>The interface can speak the language of the work</h2>
<p>The review toolbar should care about the job in front of it.</p>
<p>A widget can turn a ticket's acceptance criteria into the controls that prove them. When an engineer shares a build for invite recovery, each criterion can open the exact state it names. The PM can pass or block that criterion, and the designer can inspect the mobile state without reconstructing the ticket from memory.</p>
<figure class="docs-figure"><img src="/brand/why-shiplet/ticket-acceptance-runner.webp" alt="An engineer-authored invite recovery build wrapped in a custom release-proof widget that turns acceptance criteria into test controls" width="1280" height="720" loading="lazy"><figcaption>An engineer-authored build carries its own release proof. Reviewers can open the expired-link state and replay a consumed invitation. The mobile criterion opens the flow at 390 pixels before a reviewer attaches evidence.</figcaption></figure>
<p>A research readout needs a different shape. The researcher places the current product claim beside the observations behind it. The evidence board lets a PM mark an observation as support for the claim, and contradictory evidence stays visible beside that support. A designer can flag the assumption that still needs testing without losing the prototype underneath.</p>
<figure class="docs-figure"><img src="/brand/why-shiplet/research-evidence-board.webp" alt="A researcher-authored invite recovery study wrapped in an evidence board that connects product claims to observations and open questions" width="1280" height="720" loading="lazy"><figcaption>The researcher-authored evidence board keeps each claim attached to the observations that shaped it. Reviewers can challenge the synthesis and attach another observation inside the same Shiplet.</figcaption></figure>
<p>These widgets were applied through the review-layer contract used by the product. Shiplet prepared each change as a preview, compiled the layer inside its sandbox constraints, and applied it only after the root confirmed that the base version still matched.</p>
<h2>Code Mode keeps the power behind a narrow door</h2>
<p>An agent can customize the review layer through Shiplet's MCP. It sees two tools: <code>search</code> and <code>execute</code>.</p>
<p><code>search</code> lets the agent find the relevant contract without dumping the whole platform into context. <code>execute</code> accepts a small program, and Shiplet runs that program in a disposable Dynamic Worker. The Worker gets no direct D1, R2, or Durable Object bindings. It can reach only the operations exposed by the trusted host.</p>
<p>The program can read the current review layer and prepare a bounded set of file changes. The result is a preview attached to the root's current version. A person can open that preview, use the proposed widget, and approve it. The root applies the change with a version check, so a stale agent turn cannot overwrite something newer.</p>
<p>The approved widget then runs where the reviewer uses it: inside the browser sandbox. The Dynamic Worker has finished its short job by that point.</p>
<p>Code Mode handles programmable authoring before the browser runs the interface. ShipletRoot remains the authority that makes a change real.</p>
<h2>Durable Objects make the product easier to engineer</h2>
<p>I care about the engineering shape because it lets product benefits keep accumulating inside one clear coordination boundary.</p>
<figure class="docs-figure"><img src="/brand/why-shiplet/durable-object-benefits.webp" alt="ShipletRoot in the center of four Durable Object benefits: ordered changes, local SQLite, hibernation, and natural sharding" width="1280" height="720" loading="lazy"><figcaption>The Shiplet is already the product boundary, so the Durable Object can use the same boundary for correctness, state, operations, and isolation.</figcaption></figure>
<h3>One name gives us one authority</h3>
<p>The Platform Worker resolves the root with <code>getByName(shiplet.id)</code>. Requests for the same Shiplet reach the same logical object, which already has the current review-layer version beside the code that changes it.</p>
<p>Applying a preview is a guarded update inside that object. If the root has moved past the preview's base version, the update fails closed. The guarded update replaces a separate lock service for deciding which review layer won.</p>
<h3>SQLite has the right scope</h3>
<p>Each root gets its own SQLite-backed storage. The active layer, pending previews, provenance, and audit events live with the Shiplet they describe.</p>
<p>That local scope makes the data model easier to reason about. A migration belongs to one product object, and an incident has a local timeline. The root reads the current layer directly from its own durable state, with no global projection in the request path.</p>
<h3>Quiet review rooms can sleep</h3>
<p>ShipletRoot also owns presence for its review link. Cloudflare's <a href="https://developers.cloudflare.com/durable-objects/best-practices/websockets/">WebSocket Hibernation API</a> can keep reviewers connected at the network while an idle object leaves memory, then wake the root when a new message arrives.</p>
<p>The live-room abstraction survives that sleep cycle because durable state was already written beside the root. Cloudflare keeps idle connections at the network, which cuts the application time spent keeping quiet review rooms awake.</p>
<h3>Shiplets shard themselves</h3>
<p>More Shiplets create more roots. Traffic for one review stays with that review, and a broken customization stays inside its browser frame and Shiplet boundary. Other Shiplets keep moving through their own roots.</p>
<p>One unusually hot Shiplet still has the throughput ceiling of one root. That is an honest limit and a useful one for the product we have. If a future Shiplet turns into a stadium, we can add fan-out behind its stable root identity.</p>
<h2>Inheritance copies the useful part</h2>
<p>Once a team has a review setup that works, the next Shiplet can inherit it.</p>
<p>Inheritance takes a snapshot of the source review layer and records its provenance. The child receives its own root and its own version, so changes stay local. A later update to the source can arrive as another preview, where somebody can inspect it before the child changes.</p>
<p>An organization can maintain a house review layer. A team can adapt that layer for its workflow, and a specific Shiplet can take the interface somewhere more specialized. Each step remains a usable review experience with a visible origin.</p>
<p>The snapshot matters because review interfaces can encode real process. A distant template edit has to pass review before it can add a required approval or rename a status in the middle of somebody's work.</p>
<h2>Software should be allowed to wander</h2>
<p>I keep thinking about what it means for software to belong to the people using it. An organization should be able to choose where Shiplet lives: on Shiplet Cloud or in its own Cloudflare account. Moving between those homes should feel ordinary.</p>
<p>Once it is there, local coding agents should be able to reshape it until it fits the organization, while a path back to upstream improvements remains open. I care about that shape before I care about the neat open-source category for it.</p>
<p>Git can move source between developers. Software with live state and local mutations carries a different kind of history. There is something else hiding in that gap. I do not have the name for it yet.</p>
<h2>The rest of the stack can stay boring</h2>
<p>The Platform Worker handles identity, policy, routing, and file delivery. R2 holds immutable artifact bytes. D1 powers the organization directory and views that cross many Shiplets. The root keeps the state that needs agreement inside one Shiplet.</p>
<p>Most artifacts remain static, which keeps publishing fast and gives the thing being reviewed a tiny runtime. A custom review layer leaves the artifact on that path. When an artifact needs its own backend behavior, <a href="https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/">Workers for Platforms</a> gives Shiplet an advanced path with a separate security burden.</p>
<p>Those boundaries also give the product somewhere clean to grow:</p>
<ul><li>Approval stages can live beside the review-layer version they control.</li><li>Subscriptions can listen to the root's ordered events.</li><li>An automation can wake for one Shiplet and produce another reviewable preview.</li></ul>
<p>If we add an agent that stays with a Shiplet, the root already gives it a bounded checkpoint connected to an ordered event stream. A capability boundary controls what the agent can do when it wakes for an approved event. The agent works in a sandbox and writes its result back as another preview, keeping the existing identity system and global coordination boundary.</p>
<p>Each Shiplet can grow into exactly the review room its artifact needs, while the platform stays legible.</p>
<h2>Try the review layer</h2>
<p><a href="/docs/quickstart">Prepare your first review artifact</a>, then open the review link and leave a comment on the work itself.</p>`,
  },
  {
    slug: "quickstart",
    title: "Quickstart",
    description:
      "Upload an artifact and open its review link in a few minutes.",
    group: "Start",
    body: `
<p>The fastest path starts in the browser.</p>
<h2>1. Open the Prepare page</h2>
<p><a href="/">Open the Shiplet app</a> and sign in when asked. A first-time user receives a default workspace and returns to the Prepare page.</p>
<h2>2. Choose the work to review</h2>
<p>Keep <strong>Upload files</strong> selected, then choose supported static files, browser media, documents, archives, source code, structured data, or GIS data. Use <a href="/docs/code-mode-mcp">Code Mode MCP</a> or direct REST when an automated build needs to preserve folder paths. Choose <strong>URL</strong> for an existing public preview.</p>
<p>Name the artifact, choose its review subdomain, and select who can see it. <strong>Organization</strong> is the safe default for an internal review. View access does not grant edit access.</p>
<h2>3. Open the review link</h2>
<p>Shiplet places the artifact inside a sandboxed frame and shows trusted review controls around it. Leave a harmless comment, then find the ticket on the Shiplet detail page or in the global Feedback view.</p>
<p>Read <a href="/docs/review-feedback">Review feedback</a> for ticket work and <a href="/docs/access-control">Access control</a> before sharing the link.</p>
<h2>Optional: automate with MCP</h2>
<pre><code>https://shiplet.cc/api/mcp</code></pre>
<p>The first protected action opens AuthKit in the browser. <a href="/docs/code-mode-mcp">Code Mode MCP</a> includes the complete setup.</p>
<h2>Troubleshooting</h2>
<table class="docs-table" tabindex="0"><thead><tr><th>Problem</th><th>Safe recovery</th></tr></thead><tbody>
  <tr><td>A file is rejected</td><td>Remove the unsupported or oversized file and prepare again.</td></tr>
  <tr><td>The subdomain is unavailable</td><td>Choose another lowercase, hyphenated review name.</td></tr>
  <tr><td>Publishing fails</td><td>Keep the local artifact and retry after the reported problem clears.</td></tr>
  <tr><td>Access is denied</td><td>Sign in with the invited email or ask an owner for the required viewing grant.</td></tr>
</tbody></table>
<p><strong>Next:</strong> <a href="/docs/review-feedback">leave and manage review feedback</a>.</p>`,
  },
  {
    slug: "access-control",
    title: "Access control",
    description:
      "Choose who can view a Shiplet and who can change its review settings.",
    group: "Review",
    body: `
<p>Shiplet evaluates viewing and editing separately through the trusted host. <strong>View access never grants edit access.</strong></p>
<h2>Visibility</h2>
<table class="docs-table" tabindex="0"><thead><tr><th>Visibility</th><th>Who can open it</th></tr></thead><tbody>
  <tr><td><code>private</code></td><td>Administrators, owners, and people with an explicit grant.</td></tr>
  <tr><td><code>organization</code></td><td>Members of the active organization.</td></tr>
  <tr><td><code>unlisted</code></td><td>Anyone with the link.</td></tr>
  <tr><td><code>public</code></td><td>Anonymous visitors, including discovery traffic.</td></tr>
</tbody></table>
<h2>People and teams</h2>
<p>Organizations contain members and teams. A Shiplet can also grant access to an exact invited email address. Invitations become effective for the matching signed-in identity.</p>
<p>Open <strong>Account</strong> at <code>/account</code> to inspect or switch the signed-in identity. Open <strong>Workspace</strong> at <code>/workspace</code> to choose the active organization.</p>
<h2>Agent access</h2>
<p>Interactive MCP uses browser OAuth. A compatible external agent can use a claimed WorkOS <code>service_auth</code> registration when the environment has enabled it. CI and unattended jobs use organization API keys.</p>
<p>A claimed registration retains the stable agent identity separately from the person who completed the claim. It is restricted to the exact organization in the access token, recognized scopes, and that person's current Shiplet membership and grants. Anonymous registrations and durable WorkOS agent API keys are not accepted in this release.</p>
<p>Artifact and custom widget code never receive WorkOS sessions, agent registration credentials, organization API keys, or ambient browser credentials.</p>
<p><strong>Next:</strong> review <a href="/docs/api-keys">API key guidance</a> or <a href="/docs/quickstart">prepare an organization-visible artifact</a>.</p>`,
  },
  {
    slug: "publishing",
    title: "Review artifacts",
    description:
      "Prepare uploaded files or attach an existing public URL for review.",
    group: "Review",
    body: `
<p>The artifact is the work being reviewed. Shiplet supplies the review link and trusted controls around it.</p>
<h2>Uploaded files</h2>
<p>Agents and CI jobs send base64-encoded <code>assets</code>. The browser Prepare page accepts supported files directly. Shiplet serves <code>index.html</code> when present and creates a file review page when it is absent.</p>
<pre><code>{
  "name": "Campaign prototype",
  "subdomain": "campaign-prototype",
  "visibility": "organization",
  "assets": [{ "path": "index.html", "content": "...base64..." }]
}</code></pre>
<h2>Existing public URLs</h2>
<p>Send <code>external_url</code> for an existing staging page or public preview. The proxy allows read-only <code>GET</code> and <code>HEAD</code> requests and rejects private-network destinations, unsafe redirects, and nonstandard ports. HTML and CSS use an 8 MiB in-memory fast path plus private streaming for larger documents, with a 64 MiB actual text-response safety ceiling. Large inlined CSS data, quoted custom-property values, and simple unquoted custom-property identifiers stream through that path. HTML <code>style</code>, <code>srcdoc</code>, and <code>srcset</code> attribute values that themselves exceed 8 MiB fail closed instead of being returned raw. The same per-attribute bound protects the HTML parser; unrelated large attributes within that bound are preserved. Larger binary assets are not subject to text rewriting.</p>
<h2>Trusted review boundary</h2>
<p>The review URL belongs to Shiplet. The artifact runs in a sandboxed frame, and Shiplet renders the review layer outside it. Browser sessions and reviewer authority remain in the trusted host.</p>
<h2>Archive and delete</h2>
<p>Archiving removes a Shiplet from the active list without deleting its feedback or access policy. Permanent delete is an irreversible action for an archived Shiplet and requires trusted confirmation.</p>
<p><strong>Next:</strong> <a href="/docs/quickstart">prepare a review artifact</a>.</p>`,
  },
  {
    slug: "extensions",
    title: "The review layer",
    description:
      "Understand the toolbar around an artifact and how Shiplet keeps its controls separate.",
    group: "Review",
    body: `
<p>The artifact is the work your team reviews. Shiplet provides the review layer around it. The layer owns the toolbar, reviewer actions, and feedback workflow attached to the Shiplet.</p>
<p><strong>The review layer stays separate from the artifact.</strong> Updating its controls does not rewrite the page, file, build, or public URL under review.</p>
<h2>Built-in toolbar</h2>
<p>The default toolbar lets reviewers select a page or visible element, leave a comment, open existing tickets, and update review status when their access allows it.</p>
<h2>Custom review widgets</h2>
<p>A team can attach a custom widget when the built-in controls do not match its process. Shiplet runs the widget in a sandboxed frame beside the artifact and presents protected changes through trusted confirmation.</p>
<p>Custom widget code cannot identify the reviewer or approve its own request. Its files stay inside that Shiplet's review layer.</p>
<ol><li>Use Code Mode to read the current review-layer files and version.</li><li>Send widget-relative changes to the preview endpoint. Shiplet validates them and returns an expiring preview link without changing the live review.</li><li>Apply the preview with the original version and explicit approval.</li></ol>
<p>The API accepts widget files and paths. This workflow does not expose artifact files, and applying a preview leaves the artifact unchanged. Run <code>search</code> in <a href="/docs/code-mode-mcp">Code Mode MCP</a> for the current schemas.</p>
<h2>Browser resource boundary</h2>
<p>The widget sandbox limits origin and authority. It does not impose a separate heap, CPU, or lifetime quota in the browser process. Reload or close a review if custom widget code makes the tab unresponsive, then use the built-in controls until an owner repairs it.</p>
<p><strong>Next:</strong> read <a href="/docs/security">Security and isolation</a>.</p>`,
  },
  {
    slug: "review-feedback",
    title: "Review feedback",
    description: "Leave contextual comments and work through review tickets.",
    group: "Review",
    body: `
<p>Shiplet stores contextual feedback as tickets attached to one review link. A ticket includes its comment, page location, status, reviewer identity, and optional screenshot context.</p>
<h2>Review in the browser</h2>
<ol><li>Open the review link.</li><li>Choose the page or a visible element.</li><li>Leave a comment and submit it through the trusted toolbar.</li><li>Reply, update status, mention a collaborator, or watch the Shiplet from its detail page.</li></ol>
<p>Use <a href="/feedback">Feedback</a> for the global review queue and <a href="/inbox">Inbox</a> for notifications. If live updates stop, reload the trusted review host; persisted feedback remains available.</p>
<h2>Work through MCP</h2>
<p>An authorized agent can read tickets, create replies, and update status through documented API operations. Shiplet records the authenticated agent credential as the actor.</p>
<p><strong>Next:</strong> connect through <a href="/docs/code-mode-mcp">Code Mode MCP</a>.</p>`,
  },
  {
    slug: "code-mode-mcp",
    title: "Code Mode MCP",
    description:
      "Connect an agent, then prepare artifacts and work with feedback.",
    group: "Automation",
    body: `
<p>Shiplet MCP lets an agent discover the supported API and call it through code. Interactive clients authenticate in the browser. A registered external agent can request access to one Shiplet organization when the environment enables agent registration.</p>
<h2>Endpoint</h2>
<pre><code>https://shiplet.cc/api/mcp</code></pre>
<p>OAuth discovery is available at <code>https://shiplet.cc/.well-known/oauth-protected-resource</code>.</p>
<h2>Connect from VS Code</h2>
<pre><code>{
  "servers": {
    "shiplet": {
      "type": "http",
      "url": "https://shiplet.cc/api/mcp"
    }
  }
}</code></pre>
<p>This follows VS Code's <a href="https://code.visualstudio.com/docs/agent-customization/mcp-servers">remote HTTP MCP configuration</a>. Keep credentials out of the file because Shiplet hands sign-in to the trusted browser.</p>
<ol><li>Add the endpoint as a remote HTTP MCP server.</li><li>Complete the first protected request through Shiplet sign-in.</li><li>Call <code>tools/list</code> and confirm <code>search</code> and <code>execute</code>.</li><li>Run <code>search</code> before <code>execute</code>.</li></ol>
<h2 id="agent-registration">Connect an agent to Shiplet</h2>
<pre><code>https://shiplet.cc/auth.md</code></pre>
<p>Shiplet supports registered agents through the Code Mode MCP endpoint. The agent follows the guide, asks you to approve access in the browser, and connects to the Shiplet organization you choose.</p>
<figure class="docs-figure"><img src="/brand/docs/agent-registration-flow.svg?v=2" alt="An agent reads Shiplet auth.md and asks for access. You approve one Shiplet organization, then the agent works with Shiplets and feedback through Code Mode MCP." width="1400" height="760" loading="lazy"><figcaption>You choose the Shiplet organization. Its membership, grants, and permissions bound every agent operation.</figcaption></figure>
<h3>What the agent can do</h3>
<p>The registered agent uses the same <code>search</code> and <code>execute</code> tools as any Code Mode client. It can discover Shiplet operations, publish or update Shiplets, and work with review feedback when its permissions allow those actions.</p>
<p>Shiplet recognizes these agent permissions: <code>mcp</code>, <code>shiplets:read</code>, <code>shiplets:write</code>, <code>feedback:read</code>, and <code>feedback:write</code>. Current organization membership and Shiplet grants still apply to every request.</p>
<h3>Approve access</h3>
<ol><li>Give the agent <code>https://shiplet.cc/auth.md</code>.</li><li>Open the browser approval link it returns, sign in, and choose the Shiplet organization the agent can use.</li><li>Return to the agent after the approval page confirms access. The agent connects to <code>https://shiplet.cc/api/mcp</code>.</li></ol>
<p>The registration remains a distinct agent actor in Shiplet's audit history. Your user identity records who approved it, and the selected organization sets the boundary for its work.</p>
<h3>Check the connection</h3>
<ol><li>Ask the agent to call <code>tools/list</code>. Shiplet returns exactly <code>search</code> and <code>execute</code>.</li><li>Run a harmless authorized read, such as <code>GET /api/shiplets</code> through <code>execute</code>.</li><li>A <code>401</code> means the agent needs to reconnect. A <code>403</code> means its selected organization, current membership, Shiplet grant, or required permission does not authorize the operation.</li></ol>
<p>The agent client owns its connection credentials. Keep those credentials out of Shiplet uploads, review feedback, and custom widgets.</p>
<h2>Core tools</h2>
<ul><li><code>search</code> discovers the public OpenAPI contract.</li><li><code>execute</code> calls supported operations through <code>codemode.request(...)</code>.</li></ul>
<p>Those are the complete top-level tool catalog. Shiplet never adds a third tool from an artifact or custom widget. The JavaScript passed to either tool runs in an isolated Worker without network access or credentials, and API calls return to Shiplet's authenticated host.</p>
<p><code>search</code> builds an authorization-specific OpenAPI view. A broad path search can find the trusted, paginated <code>/api/shiplets/custom-mcp-catalog</code> operation. Call that through <code>execute</code>, choose an accessible active Shiplet, then search its returned literal <code>/api/shiplets/{id}/custom-mcp/</code> prefix. Each operation appears at a concrete revision-fenced path and can run only through <code>execute</code>. The focused request reads only an immutable, digest-bound MCP projection and referenced handlers, not unrelated package files. An operation is omitted when its isolated runtime is unavailable or the active configuration changes.</p>
<p>Shiplet supplies the operation description shown to the model and validates the declared input schema. Configuration-authored prose and handler output stay in quarantine; <code>execute</code> returns only a platform-owned completion notice unless a trusted person explicitly reviews the quarantined content.</p>
<p>Each operation carries an <code>x-shiplet-code-mode</code> marker. Use direct REST or the browser when an operation is outside that surface.</p>
<h2>Prepare an artifact</h2>
<pre><code>async () =&gt; await codemode.request({
  method: "POST",
  path: "/api/shiplets",
  body: { name: "Prototype", subdomain: "prototype", assets: [...] }
})</code></pre>
<h2>Customize the review widget</h2>
<p>Read the current review layer, prepare a preview from widget-relative changes, and apply the preview after a person approves it. The version returned by the first request prevents a stale preview from replacing newer work.</p>
<pre><code>async () =&gt; {
  const layer = await codemode.request({
    method: "GET",
    path: "/api/shiplets/project_123/review-layer"
  });
  return { version: layer.version, paths: layer.files.map(file =&gt; file.path) };
}</code></pre>
<p>Run <code>search</code> for the preview and apply request schemas before writing. These operations only accept review-widget files, so the artifact stays unchanged.</p>
<h2>Read feedback</h2>
<pre><code>async () =&gt; await codemode.request({
  method: "GET",
  path: "/api/projects/project_123/review-feedback"
})</code></pre>
<h2>Authentication and authority</h2>
<p>Browser OAuth identifies an interactive user. A registered agent remains a separate actor in Shiplet's audit history, tied to the user who approved it and the selected organization. Its effective authority combines recognized agent permissions, current Shiplet membership and grants, the selected organization, and the requested operation. Unknown permissions grant nothing.</p>
<p><strong>Next:</strong> connect through browser OAuth, or ask a compatible agent to follow <code>https://shiplet.cc/auth.md</code>, then run <code>search</code>.</p>`,
  },
  {
    slug: "api-keys",
    title: "API keys",
    description:
      "Create narrowly scoped organization credentials for automation.",
    group: "Automation",
    body: `
<p>Browser OAuth is the default for people. Organization API keys are for CI and other automated jobs. Store each key in the automation provider's secret store.</p>
<p>Keep keys out of artifacts, custom widgets, browser scripts, source files, build logs, and screenshots.</p>
<h2>Choose the required scopes</h2>
<table class="docs-table" tabindex="0"><thead><tr><th>Scope</th><th>Allows</th></tr></thead><tbody>
  <tr><td><code>shiplets:read</code></td><td>Read authorized Shiplets.</td></tr>
  <tr><td><code>shiplets:write</code></td><td>Prepare artifacts and perform permitted writes.</td></tr>
  <tr><td><code>shiplets:archive</code></td><td>Archive or restore authorized Shiplets.</td></tr>
  <tr><td><code>feedback:read</code></td><td>Read review feedback.</td></tr>
  <tr><td><code>feedback:write</code></td><td>Create replies and update feedback.</td></tr>
  <tr><td><code>mcp</code></td><td>Use <code>/api/mcp</code>.</td></tr>
</tbody></table>
<p>Choose <strong>Only selected</strong> for a bounded job. A selected-project key cannot create a new Shiplet because the new identity has no pre-existing allow rule.</p>
<p>The retired organization-key alias <code>feedback:manage</code> is rejected for new keys. Existing keys project it to <code>feedback:read</code> plus <code>feedback:write</code> until rotation.</p>
<p><strong>Next:</strong> open <a href="/agents">Agents and API keys</a> or review <a href="/docs/access-control">Access control</a>.</p>`,
  },
  {
    slug: "api-surface",
    title: "API surface and route ledger",
    description: "Know which routes are public automation contracts.",
    group: "Automation",
    body: `
<p>Shiplet's <a href="/openapi.json">OpenAPI document</a> is the public automation contract. Its method, path, authentication, scopes, schemas, and Code Mode marker are supported together.</p>
<p>Browser-only pages, trusted frame protocols, and operator-internal recovery routes stay outside OpenAPI because they depend on cookies, redirects, top-level confirmation, origin-bound messages, or operational authority.</p>
<h2>Choose the supported surface</h2>
<ul><li>Use OpenAPI operations for REST and Code Mode automation.</li><li>Use browser OAuth for interactive MCP.</li><li>Use the first-party browser flow for review, account settings, and protected confirmation.</li></ul>
<p>The executable route ledger requires every registered route to appear in OpenAPI or match exactly one narrow exclusion family. Missing and duplicate classifications fail the documentation gate.</p>
<h2>Verification</h2>
<p><code>api-route-ledger.json</code> classifies routes outside OpenAPI. The check resolves local and relative-imported string constants; a dynamic or unresolvable registration fails the gate.</p>
<p><strong>Next:</strong> read <a href="/docs/api-keys">API keys</a> or <a href="/docs/code-mode-mcp">Code Mode MCP</a>.</p>`,
  },
  {
    slug: "wordpress",
    title: "WordPress",
    description: "Attach Shiplet's review layer to a WordPress site.",
    group: "Integrations and safety",
    body: `
<p>The WordPress plugin adds Shiplet's review layer to one configured site without putting organization API keys in page source.</p>
<h2>Availability</h2>
<p>The plugin is source-checkout-only today. Shiplet does not publish an official public download.</p>
<h2>Connection boundary</h2>
<p>Each installation is bound to one exact origin and stores its installation secret on the server. The browser receives a short-lived review session scoped to that installation and Shiplet.</p>
<p><strong>Next:</strong> verify reviewer access in <a href="/docs/access-control">Access control</a>.</p>`,
  },
  {
    slug: "security",
    title: "Security and isolation",
    description:
      "Understand how Shiplet separates the artifact, review layer, reviewer identity, and agent access.",
    group: "Integrations and safety",
    body: `
<p>Shiplet owns the trusted review host. It authenticates reviewers, checks access, and records feedback outside the artifact being reviewed.</p>
<h2>Browser separation</h2>
<p>Artifact code runs in a sandboxed frame. A custom widget runs in its own sandboxed frame. Neither frame receives Shiplet cookies, browser storage, OAuth credentials, or organization API keys.</p>
<p>The review host accepts bounded messages from the expected frame and page session. It rejects malformed requests, replayed request IDs, mismatched Shiplets, and messages from another source window before an action can run.</p>
<h2>Reviewer actions</h2>
<p>Shiplet derives the actor from the signed-in session or authenticated agent credential. Artifact and widget code cannot claim a reviewer identity. Protected writes require the corresponding scope and trusted confirmation when specified.</p>
<h2>Agent access</h2>
<p>Interactive MCP uses browser OAuth. Claimed external agents use short-lived WorkOS access tokens that preserve a stable registration actor, a distinct delegated user, an exact organization, and recognized operation scopes. Shiplet verifies the token, rechecks current local membership, and stores no bearer or refresh material.</p>
<p>Only the <code>service_auth</code> claim ceremony is supported in this release. Anonymous registrations, durable WorkOS agent API keys, missing scopes, and cross-organization access fail closed. CI and unattended jobs continue to use narrowly scoped organization API keys.</p>
<h2>Network and browser resources</h2>
<p>Artifact frames use a restrictive browser policy. Custom widgets receive a typed channel to the trusted host. The widget sandbox does not impose a separate heap, CPU, or lifetime quota in the browser process, so reload or close a review if custom code makes the tab unresponsive.</p>
<p><strong>Next:</strong> review <a href="/docs/access-control">Access control</a> or connect through <a href="/docs/code-mode-mcp">Code Mode MCP</a>.</p>`,
  },
];

const GROUPS = ["Start", "Review", "Automation", "Integrations and safety"];

export function getDocsPage(slug = "introduction") {
  return DOCS_PAGES.find((page) => page.slug === slug) || null;
}

export function BuildDocsPage(slug = "introduction") {
  const page = getDocsPage(slug) || getDocsPage("introduction")!;
  return buildDocsPage(page);
}

export function BuildDocsNotFoundPage() {
  return buildDocsPage({
    slug: "not-found",
    title: "Documentation page not found",
    description: "That documentation page does not exist or has moved.",
    group: "Help",
    body: `<p>Check the address, or return to the <a href="/docs">Shiplet documentation</a> to choose a current guide.</p><p>The machine-readable API contract remains available as <a href="/openapi.json">OpenAPI JSON</a>.</p>`,
  });
}

function buildDocsPage(page: DocsPage) {
  const nav = GROUPS.map((group) => {
    const links = DOCS_PAGES.filter((item) => item.group === group)
      .map((item) => {
        const href =
          item.slug === "introduction" ? "/docs" : `/docs/${item.slug}`;
        return `<a href="${href}"${item.slug === page.slug ? ' aria-current="page"' : ""}>${item.title}</a>`;
      })
      .join("");
    return `<div class="docs-nav-group"><span>${group}</span>${links}</div>`;
  }).join("");

  return `
<div class="dashboard-shell shiplet-dashboard-stage docs-page">
	<header class="app-page-topbar">
		<div class="app-page-title">
			<span class="success-card-label">Public docs</span>
			<p class="docs-site-title">Shiplet documentation</p>
			<p>Prepare an artifact, share its review link, and bring contextual feedback back to your team or agent.</p>
		</div>
		<div class="dashboard-actions">
			<a class="btn btn-secondary btn-sm" href="/openapi.json">OpenAPI JSON</a>
			<a class="btn btn-primary btn-sm" href="/">Open app</a>
		</div>
	</header>

	<div class="docs-layout">
		<details class="docs-nav-disclosure">
			<summary>Browse documentation</summary>
			<nav class="settings-nav docs-nav" aria-label="Documentation sections">
				${nav}
				<div class="docs-nav-group">
					<span>Reference</span>
					<a href="/openapi.json">OpenAPI JSON</a>
				</div>
			</nav>
		</details>
		<article id="docs-article" tabindex="-1" class="success-card shiplet-panel shiplet-focus-strip docs-article" data-shiplet-docs-page="${page.slug}" data-shiplet-docs-content-sha256="${DOCS_PUBLIC_CONTENT_SHA256[page.slug] || ""}">
			<span class="success-card-label">${page.group}</span>
			<h1>${page.title}</h1>
			<p class="docs-description">${page.description}</p>
			<div class="docs-content">
				${page.body}
			</div>
		</article>
	</div>
</div>`;
}
