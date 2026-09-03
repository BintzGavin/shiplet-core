=== Shiplet ===
Contributors: shiplet
Tags: feedback, review, collaboration, qa
Requires at least: 6.3
Requires PHP: 7.4
Stable tag: 0.1.0
License: Apache-2.0
License URI: https://www.apache.org/licenses/LICENSE-2.0

Embed Shiplet's contextual review widget directly on your WordPress site's
original URLs.

== Description ==

Shiplet for WordPress connects one WordPress site to one Shiplet project.
Authorized Shiplet reviewers can open any page with `?shiplet-review=1`,
authenticate with Shiplet, and leave contextual feedback without using a
proxied review URL.

Ordinary visitors do not see Shiplet controls and do not download Shiplet's
remote review client.

== Installation ==

1. Upload the `shiplet` directory to `/wp-content/plugins/`.
2. Activate Shiplet in WordPress.
3. Open Settings > Shiplet.
4. Choose Connect to Shiplet, sign in, and select or create a project.
5. Add `?shiplet-review=1` to a site URL to start an authorized review session.

== Security ==

The plugin stores a revocable, site-scoped installation secret in WordPress.
It never renders that secret or an organization API key into public HTML.
Reviewer capabilities are short-lived and kept in the current browser tab's
session storage.

Production sites must use HTTPS. Each origin, such as staging and production,
must be connected separately.

== Changelog ==

= 0.1.0 =

* Initial WordPress embed connection and review-mode flow.
