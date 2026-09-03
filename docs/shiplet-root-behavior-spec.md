# ShipletRoot behavioral specification

Status: implementation contract for the production cutover.

## Product boundary

Every non-sandbox Shiplet has one deterministically addressed `ShipletRoot`
Durable Object. The object is the strongly consistent authority for the
Shiplet's programmable review layer and live reviewer coordination.

The platform Worker continues to own authentication, organization-wide
discovery, public HTTP routing, and authorization policy. R2 continues to own
large immutable artifact bytes. D1 remains the organization-wide query and
reporting projection. Neither the browser widget nor model-written code
receives credentials or direct storage authority.

The custom widget renders in a sandboxed browser frame. Model-written Code Mode
programs execute in disposable Dynamic Workers. Both cross into trusted
Shiplet behavior only through host-mediated operations routed to the selected
`ShipletRoot`.

## Identity and initialization

- The platform addresses the object with `SHIPLET_ROOT.getByName(project.id)`.
- The first initialization records the immutable Shiplet ID and the supplied
  review-layer snapshot atomically.
- Repeating initialization for the same Shiplet is idempotent.
- Attempting to initialize the same object with a different Shiplet ID fails
  closed and leaves stored state unchanged.
- New Shiplets are initialized before their creation request succeeds.
- Existing Shiplets were imported from their D1/revision state during the
  expand-and-import release. The contracted release has no legacy D1 read path.
- A missing root can initialize only from the immutable active revision's
  bundled default widget, providing deterministic disaster recovery without
  reviving the retired repository.

## Review-layer behavior

- Reading returns exactly the active version, entry path, and widget-relative
  files owned by that Shiplet.
- Preparing a preview applies bounded file changes to one expected active
  version, validates the complete result, and leaves the active layer unchanged.
- Applying a preview requires explicit human or delegated-agent approval and
  the exact base version used to create it.
- Exactly one competing preview can win a version fence.
- Applied, expired, missing, or stale previews cannot change active state.
- Each successful apply records its actor and an ordered local audit event.
- Widget files remain separate from artifact files and cannot escape their
  relative namespace.

## Inheritance

- A Shiplet may initialize from another accessible Shiplet's active review
  layer.
- Initialization copies a snapshot. Later source mutations do not silently
  change the child.
- The child records source Shiplet ID and source layer version as provenance.
- The child receives its own active version and can diverge independently.
- Credentials, connection grants, reviewer authority, feedback, and audit
  events are never inherited.
- A future source update must enter through an ordinary preview and approval;
  there is no live cascading inheritance.

## Presence behavior

- The same `ShipletRoot` accepts authenticated reviewer WebSockets for its
  Shiplet.
- Presence and cursor messages remain ephemeral WebSocket attachments; they are
  not written to SQLite.
- Origin, Shiplet access, and capability checks occur in the trusted platform
  Worker before the WebSocket reaches the object.
- Hibernation and reconnects cannot change durable review-layer state.

## Code Mode boundary

- The public MCP catalog remains exactly `search` and `execute`.
- Generated JavaScript runs in an isolated Dynamic Worker with direct outbound
  networking disabled.
- The host callback performs authentication and routes Shiplet-scoped review
  operations to the deterministically named `ShipletRoot`.
- A generated program can compose operations across Shiplets, but each
  Shiplet's mutations are serialized by its own root object.
- Dynamic code cannot read secrets, approve its own protected writes, or obtain
  raw SQLite, D1, or R2 bindings.

## Storage ownership

| State | Authority |
| --- | --- |
| Review layer, previews, provenance, local review audit | `ShipletRoot` SQLite |
| Presence and cursors | `ShipletRoot` hibernating WebSockets |
| Organizations, memberships, searchable Shiplet directory | D1 |
| Artifact and large immutable files | R2 with D1 directory metadata |
| OAuth and external connection secrets | Existing trusted vault boundaries |

## Migration and cutover

1. Expand: deploy the new `SHIPLET_ROOT` namespace without changing public
   behavior.
2. Import: initialize roots from current review-layer state on creation or
   first access. Preserve D1 and R2 source data.
3. Prove: exercise direct Durable Object tests, route tests, Code Mode tests,
   inheritance tests, concurrency fences, and production canary reads.
4. Cut over: make all review-layer reads, previews, applies, widget serving, and
   presence connections use `ShipletRoot`.
5. Contract: remove the old review-layer repository, D1 schema creation,
   `ReviewPresenceRoom` class, binding, and routing branches from shipped code.
6. Retain rollback data: leave the old production D1 rows untouched for one
   release. They are inert backup data, not a live code path. Destructive data
   removal requires a separate backup-and-retention decision.

## Rollback

- Before contract, rollback is a Worker version rollback because source D1/R2
  data remains intact.
- After contract, rollback uses the immediately preceding Worker version and
  the retained D1 rows.
- No migration step mutates artifact bytes, deletes a Shiplet, or broadens a
  connection grant.

## Acceptance scenarios

1. Given two Shiplets, when each root is initialized and one is changed, then
   the other root's layer and version are unchanged.
2. Given a Shiplet whose root is unexpectedly empty after cutover, when its
   layer is first read, then the root initializes from the active revision's
   default widget and subsequent reads are stable.
3. Given two previews from one base version, when the first is applied, then the
   second returns a conflict and cannot overwrite it.
4. Given a source Shiplet, when a child is created from its layer, then the child
   records provenance and later source changes do not alter the child.
5. Given a custom widget, when its entry document is requested, then the browser
   receives the sandboxed widget and the response identifies the root-owned
   review-layer version.
6. Given an MCP client, when it lists tools and modifies a review layer, then it
   sees only `search` and `execute`, generated code has no direct network access,
   and the resulting mutation is visible through the ordinary review URL.
7. Given a valid reviewer WebSocket, when it connects after cutover, then
   presence is coordinated by the same Shiplet root without exposing session
   authority to either frame.
