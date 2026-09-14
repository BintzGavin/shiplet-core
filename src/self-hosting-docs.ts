// Keep this public guide aligned with docs/self-hosting.mdx.
export const SELF_HOSTING_DOCS_HTML = `
<p>Static-first is the supported default. It gives you the Shiplet application, trusted review host, identity and access, static and public-URL reviews, feedback, revisions, and REST API without Workers for Platforms.</p>
<h2>What the wizard installs</h2>
<pre><code>Your Cloudflare account
└── Shiplet main Worker
    ├── D1: application and review state
    ├── R2: artifact assets
    ├── R2: trusted review assets
    ├── Durable Object: sandbox sessions
    └── Durable Object: per-Shiplet coordination

Optional and absent by default
├── Worker Loader / Code Mode execution
├── control-plane support Worker
├── managed-runtime support Worker
├── deny-egress support Worker
└── Workers for Platforms dispatch namespaces</code></pre>
<p>The application detects those optional bindings and keeps static reviews working when advanced infrastructure is absent.</p>
<h2>Prerequisites</h2>
<ul>
<li>Node.js 22.12.0 or newer.</li>
<li>A Cloudflare account that can create Workers, D1 databases, R2 buckets, and Durable Objects.</li>
<li>A WorkOS AuthKit application for this deployment.</li>
<li>An HTTPS application origin. The first run can use the <code>workers.dev</code> URL printed by Wrangler. Attach a custom domain later if needed.</li>
</ul>
<p>WorkOS production applications require an HTTPS redirect URI. In the WorkOS Dashboard, add <code>&lt;your-origin&gt;/auth/callback</code> to the application's Redirects tab. Each WorkOS application has its own client ID, redirect URIs, and API credentials. See <a href="https://workos.com/docs/authkit/applications">WorkOS Applications</a> and the <a href="https://workos.com/docs/reference/authkit/authentication/get-authorization-url#redirect-uri">redirect URI requirements</a>.</p>
<h2>Run the setup</h2>
<p>From a clean checkout:</p>
<pre><code>npm ci
npm run setup:self-host</code></pre>
<p>The eight stages are:</p>
<ol>
<li>Check local tools and choose a deployment name.</li>
<li>Authenticate Wrangler to the Cloudflare account that will own the resources.</li>
<li>Confirm and create one D1 database and two private R2 buckets.</li>
<li>Dry-run and deploy the bootstrap Worker, then capture its HTTPS origin.</li>
<li>Configure the WorkOS redirect and capture the public client ID and AuthKit issuer.</li>
<li>Enter the WorkOS API key through hidden input and install all three Worker secrets directly in Cloudflare.</li>
<li>Dry-run and deploy the final configuration.</li>
<li>Check the application shell and OpenAPI document, write the capability report, and ask you to complete a browser sign-in smoke test.</li>
</ol>
<p>The wizard asks before every remote provisioning or deployment action. It does not delete resources after a partial run. Re-run it with the same deployment name to reuse an existing generated config.</p>
<h2>Values and destinations</h2>
<table class="docs-table" tabindex="0"><thead><tr><th>Value</th><th>Obtained from</th><th>Destination</th><th>Classification</th></tr></thead><tbody>
<tr><td>Deployment name</td><td>You choose it</td><td>Generated Wrangler config</td><td>Public</td></tr>
<tr><td>D1 database ID</td><td>Wrangler create output</td><td>Generated Wrangler config</td><td>Public resource identifier</td></tr>
<tr><td>R2 bucket names</td><td>Derived from the deployment name</td><td>Generated Wrangler config</td><td>Public resource identifiers</td></tr>
<tr><td>Application origin</td><td>First deploy or an attached custom domain</td><td>Generated Wrangler config</td><td>Public</td></tr>
<tr><td>AuthKit issuer</td><td>WorkOS environment</td><td>Generated Wrangler config</td><td>Public</td></tr>
<tr><td>WorkOS client ID</td><td>WorkOS application</td><td>Cloudflare Worker secret store</td><td>Public identifier stored privately</td></tr>
<tr><td>WorkOS API key</td><td>WorkOS application credentials</td><td>Cloudflare Worker secret store</td><td>Secret</td></tr>
<tr><td>Review signing key</td><td>Generated in memory</td><td>Cloudflare Worker secret store</td><td>Secret</td></tr>
</tbody></table>
<p>Generated public state is written to:</p>
<pre><code>.shiplet-self-host/&lt;deployment-name&gt;/
├── wrangler.jsonc       # operator-owned config and live resource identifiers
└── capabilities.json    # configured and optional-unavailable capabilities</code></pre>
<p>The directory is ignored by Git. No WorkOS key or review signing key is written to it, to <code>.env</code>, or to a command argument. Secrets travel over standard input to <code>wrangler secret put</code>.</p>
<h2>Verify and operate it</h2>
<p>The wizard verifies <code>/</code> and <code>/openapi.json</code>. Finish the human smoke test by signing in through WorkOS, creating one static Shiplet, opening the review link, and leaving feedback.</p>
<p>The main D1 schema initializes on the first request, so the static profile has no separate SQL migration command. Durable Object migrations remain part of the generated Wrangler config.</p>
<p>Useful operator commands:</p>
<pre><code># Recheck the generated config without contacting Cloudflare
npm run self-host:capabilities -- \\
  --main-config .shiplet-self-host/&lt;name&gt;/wrangler.jsonc

# Validate and bundle without uploading
npx wrangler deploy --dry-run \\
  --config .shiplet-self-host/&lt;name&gt;/wrangler.jsonc

# Roll back the main Worker to a prior Cloudflare version
npx wrangler rollback \\
  --config .shiplet-self-host/&lt;name&gt;/wrangler.jsonc</code></pre>
<p>Back up D1 and the two R2 buckets according to your recovery requirements. The wizard does not create backups or delete a partially provisioned deployment.</p>
<h2>Understand the capability report</h2>
<table class="docs-table" tabindex="0"><thead><tr><th>Capability</th><th>Static profile</th><th>Becomes configured when</th></tr></thead><tbody>
<tr><td>Static review</td><td>Available</td><td>Main D1, both R2 bindings, and both Durable Objects are present</td></tr>
<tr><td>Code Mode MCP execution</td><td>Optional unavailable</td><td>The main Worker has <code>CODE_MODE_LOADER</code></td></tr>
<tr><td>Managed Workers for Platforms</td><td>Optional unavailable</td><td>All three support Workers, support D1 databases, Worker Loaders, service bindings, dispatch namespaces, and enabled post-smoke readiness are present</td></tr>
<tr><td>Customer-owned artifact deployment</td><td>Optional unavailable</td><td>The control and runtime support contracts, required main service bindings, and enabled post-smoke OAuth readiness are present</td></tr>
<tr><td>Temporary preview and claim</td><td>Optional unavailable</td><td>The control and runtime support contracts, required main service bindings, and enabled post-smoke temporary-account readiness are present</td></tr>
</tbody></table>
<p>“Configured” is not a remote health claim. The inspector reads the supplied configs and readiness values without accessing your Cloudflare account. At runtime, Shiplet also verifies support-service contracts and health before an advanced operation. An incomplete or stale topology still fails closed.</p>
<h2>Upgrade to Workers for Platforms</h2>
<p>Stay on the static profile unless you need to execute artifact-owned Worker code or custom MCP handlers. Workers for Platforms is a separate paid Cloudflare product. Check <a href="https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/">current pricing</a> before provisioning it.</p>
<p>The public source includes the advanced implementation and example topology:</p>
<pre><code>workers/
├── cloudflare-control-plane/   # OAuth grants, vault, recovery, broker
├── deny-egress/                # fail-closed outbound boundary
└── managed-runtime-gateway/    # Worker Loader and dispatch namespaces</code></pre>
<p>An operator-owned upgrade must provide real configs and resources, apply the control and runtime D1 migrations, and deploy dependencies before consumers:</p>
<pre><code>control plane → deny egress → runtime gateway → main Worker</code></pre>
<p>Rollback uses the reverse order. The runtime gateway needs staging and production dispatch namespaces plus a dynamic outbound contract. Cloudflare's <a href="https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/">dynamic dispatch documentation</a> describes that provider boundary.</p>
<p>Keep every advanced readiness variable <code>disabled</code> until the deployed support versions, service bindings, migrations, egress policy, and operator smoke tests match. After creating operator-owned configs, inspect their shape with:</p>
<pre><code>npm run self-host:capabilities -- \\
  --main-config /path/to/main.wrangler.jsonc \\
  --control-config /path/to/control.wrangler.jsonc \\
  --runtime-config /path/to/runtime.wrangler.jsonc \\
  --deny-config /path/to/deny.wrangler.jsonc</code></pre>
<p>The static wizard intentionally stops at this boundary. It neither purchases Workers for Platforms nor mutates dispatch namespaces, advanced readiness, or support-service release state.</p>
<h2>Source and operations boundary</h2>
<p>This repository contains the application and support Worker implementations, tests, public-safe examples, and the static self-host setup. It does not contain Shiplet.cc credentials, production routes, resource identifiers, release records, or generated deployment state.</p>
<p>Shiplet.cc's private operations repository pins the protected source revision and owns its production/rehearsal configs, release sequencing, migrations, smoke evidence, and rollback records. Those private identifiers are not needed to run the static-first wizard in your own account.</p>
`;
