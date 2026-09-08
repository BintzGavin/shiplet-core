import { normalizeEmbedSiteUrl, type EmbedInstallationRecord } from "./embed";
import { newId, type OrganizationRecord, type ShipletUser } from "./store";
import type { Project } from "./types";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export async function registerBrowserEmbed(
  db: D1Database,
  project: Project,
  user: ShipletUser,
  siteUrl: string,
) {
  const normalized = normalizeEmbedSiteUrl(siteUrl);
  if (!normalized || !project.organization_id)
    throw new Response(
      "A valid site URL and organization project are required",
      { status: 400 },
    );
  const origin = normalized.siteOrigin;
  const existing = await db
    .prepare(
      "SELECT * FROM embed_installations WHERE project_id = ? AND site_origin = ? AND revoked_on IS NULL ORDER BY created_on LIMIT 1",
    )
    .bind(project.id, origin)
    .first<EmbedInstallationRecord>();
  if (existing) return existing;
  const id = newId("embed_installation");
  // Browser installations have no server credential. Only an authenticated
  // editor can change them, and a reviewer still needs project access.
  await db
    .prepare(
      `INSERT INTO embed_installations
    (id, project_id, organization_id, site_origin, site_url, site_name, secret_hash, created_by_user_id, created_on, last_used_on, revoked_on)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL
    WHERE NOT EXISTS (SELECT 1 FROM embed_installations WHERE project_id = ? AND site_origin = ? AND revoked_on IS NULL)`,
    )
    .bind(
      id,
      project.id,
      project.organization_id,
      origin,
      normalized.siteUrl,
      project.name,
      `browser-only:${id}`,
      user.id,
      new Date().toISOString(),
      project.id,
      origin,
    )
    .run();
  return (await db
    .prepare(
      "SELECT * FROM embed_installations WHERE project_id = ? AND site_origin = ? AND revoked_on IS NULL ORDER BY created_on LIMIT 1",
    )
    .bind(project.id, origin)
    .first<EmbedInstallationRecord>())!;
}

export function embedInstallSnippet(appOrigin: string, installationId: string) {
  return `<script src="${appOrigin}/api/embed/widget.js" defer></script>\n<shiplet-feedback installation-id="${installationId}"></shiplet-feedback>`;
}

export function renderEmbedSetup(input: {
  appOrigin: string;
  projects: Project[];
  organizations: OrganizationRecord[];
  selectedProjectId: string;
  installations: EmbedInstallationRecord[];
  message?: string;
}) {
  const e = escapeHtml;
  const options = input.projects
    .map(
      (project) =>
        `<option value="${e(project.id)}"${project.id === input.selectedProjectId ? " selected" : ""}>${e(project.name)}</option>`,
    )
    .join("");
  const installations = input.installations
    .map((installation) => {
      const snippet = embedInstallSnippet(input.appOrigin, installation.id);
      const prompt = `Install Shiplet feedback in this frontend. Add the following script once and mount the custom element once in the shared browser layout, outside route-specific content. Preserve existing authentication and routing. Do not add API keys or a backend proxy. Use the provided installation ID only on ${installation.site_origin}; register other origins separately at ${input.appOrigin}/embed/install. Verify opening feedback, selecting an element, SPA navigation, mobile layout, and cleanup. Follow ${input.appOrigin}/docs/embed for framework examples and CSP requirements.\n\n${snippet}`;
      return `<section class="success-card shiplet-panel"><h2>${e(installation.site_origin)}</h2><p>Paste these two tags into your shared page layout. Reviewers sign in with their Shiplet account.</p><label>Install snippet<textarea readonly rows="3" style="width:100%;font-family:monospace">${e(snippet)}</textarea></label><details><summary>Paste this into your agent</summary><label>Agent install prompt<textarea readonly rows="9" style="width:100%">${e(prompt)}</textarea></label></details><p><a href="${e(installation.site_url)}" target="_blank" rel="noopener noreferrer">Open your site</a> · <a href="/docs/embed">Install guide</a></p><form method="post" action="/embed/install"><input type="hidden" name="project_id" value="${e(installation.project_id)}"><input type="hidden" name="installation_id" value="${e(installation.id)}"><button class="btn btn-secondary" name="action" value="revoke">Disconnect this site</button></form></section>`;
    })
    .join("");
  return `<div class="dashboard-shell shiplet-dashboard-stage"><header class="app-page-topbar"><div class="app-page-title"><span class="success-card-label">Shiplet on your site</span><h1>Connect a website</h1><p>Leave comments directly on your working site. Teammates and agents share the same feedback queue.</p></div></header><p><a href="/">Back to workspace</a> · <a href="/docs/embed">Installation guide</a></p>${input.message ? `<p role="status" class="banner banner-info">${e(input.message)}</p>` : ""}<section class="success-card shiplet-panel"><form method="post" action="/embed/install" style="display:grid;gap:16px"><label>Shiplet<select name="project_id"><option value="new">Create a Shiplet for this website</option>${options}</select></label><label>Workspace for a new Shiplet<select name="organization_id">${input.organizations.map((org) => `<option value="${e(org.id)}">${e(org.name)}</option>`).join("")}</select></label><label>Site URL<input type="url" name="site_url" placeholder="https://your-site.com" required maxlength="2048"></label><p>Use HTTPS, or localhost for development. Add each staging and production origin separately.</p><button class="btn btn-primary" type="submit">Create install snippet</button></form></section>${input.projects.length ? `<details><summary>Manage existing connections</summary><ul>${input.projects.map((project) => `<li><a href="/embed/install?project_id=${e(project.id)}">${e(project.name)}</a></li>`).join("")}</ul></details>` : ""}${installations}</div>`;
}
