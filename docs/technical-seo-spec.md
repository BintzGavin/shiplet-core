# Technical SEO behavior spec

This spec covers the indexable control-plane pages that exist before Shiplet adds a public landing page, pSEO routes, or an editorial/news surface.

## Public documentation metadata

Given a crawler requests a public documentation page,
when Shiplet renders the page,
then the response has a unique title, description, self-referencing canonical URL, matching Open Graph URL, and index/follow directive.

Given `/docs` and `/docs/introduction` currently represent the same introduction,
when a crawler requests `/docs/introduction`,
then Shiplet permanently redirects to `/docs` so only one canonical introduction URL exists.

Given a public documentation page has both a documentation-shell label and an article title,
when Shiplet renders the page,
then only the article title is an `h1`.

## Non-public indexing controls

Given a crawler reaches an authenticated dashboard, sandbox session, admin page, API response, auth route, or machine-readable discovery file,
when Shiplet returns the response,
then the response includes an `X-Robots-Tag` that prevents indexing.

Given Shiplet renders an authenticated, sandbox, archived, or admin HTML page,
when the document head is generated,
then its robots meta directive is `noindex,nofollow,noarchive` and it does not claim the homepage as canonical.

## Sitemap quality

Given a crawler requests `/sitemap.xml`,
when Shiplet builds the sitemap,
then it lists only canonical, indexable HTML pages and excludes `llms.txt`, `openapi.json`, private application routes, and duplicate documentation URLs.

Given a guide is added to or removed from the public documentation registry,
when Shiplet builds the sitemap,
then its canonical URL is added or removed automatically without maintaining a second list.
The website-widget and browser-capture guides are included; retired WordPress and introduction aliases are excluded.

Given a crawler follows any sitemap entry anonymously,
when the page responds,
then it returns HTML with status 200, a self-referencing canonical, and permission to index.
Capture sessions, downloads, authenticated workspaces, and user artifacts are not discovery entries.

Given a deployment supplies its canonical application URL,
when it serves `robots.txt` and `sitemap.xml`,
then both use that URL instead of the request host and sitemap locations are XML-escaped.
The root sitemap is advertised by `robots.txt`. Dates, update frequencies, and priorities are omitted rather than guessed.
