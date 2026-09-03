@authkit @authorization @organization-access
Feature: Organization-domain access to Shiplet reviews
  Organization-scoped Shiplets should be immediately available to colleagues
  whose verified email domain belongs to the publishing organization, while
  authenticated outsiders should be able to request access without learning
  more than they need to make that request.

  Background:
    Given the WorkOS organization "Acme" has verified the domain "acme.example"
    And just-in-time membership is enabled for "acme.example"
    And the organization owns a Shiplet with visibility "organization"

  Rule: Anonymous visitors authenticate before Shiplet access is evaluated

    Scenario: A first-time visitor opens an organization-scoped Shiplet review link
      Given the visitor has never signed in to Shiplet
      When the visitor opens the Shiplet review link
      Then Shiplet redirects the visitor to the AuthKit login screen
      And the login handoff securely preserves the exact Shiplet review link
      And Shiplet does not disclose the protected artifact before authentication

  Rule: A verified organization domain grants membership without an invitation

    Scenario: A first-time colleague signs in with the verified organization domain
      Given the visitor opened the Shiplet review link before signing in
      When AuthKit authenticates the visitor as "reviewer@acme.example"
      And WorkOS just-in-time provisioning creates an active membership in "Acme"
      Then Shiplet synchronizes the WorkOS organization membership locally
      And Shiplet redirects the colleague back to the same review destination
      And the colleague can view the Shiplet
      And no explicit invitation or Shiplet access grant is required

    Scenario: Verified organization domains are matched case-insensitively
      When AuthKit authenticates the visitor as "Reviewer@ACME.EXAMPLE"
      And WorkOS just-in-time provisioning creates an active membership in "Acme"
      Then the colleague can view the Shiplet
      And no explicit invitation or Shiplet access grant is required

    Scenario: A subdomain does not inherit access from a verified parent domain
      When AuthKit authenticates the visitor as "reviewer@studio.acme.example"
      And "studio.acme.example" is not a verified domain of "Acme"
      Then Shiplet does not create an organization membership from the email address
      And Shiplet shows the request access screen

  Rule: Authenticated outsiders request access instead of seeing a raw denial

    Scenario Outline: A non-member sees the request access screen
      Given the visitor has no organization membership or Shiplet access grant
      When AuthKit authenticates the visitor as "<email>"
      And the visitor returns to the Shiplet review link
      Then Shiplet shows a request access screen
      And the screen identifies the Shiplet being requested
      And the screen has one primary action named "Request access"
      And Shiplet does not render the protected artifact

      Examples:
        | email                       |
        | reviewer@different.example |
        | reviewer@gmail.com         |

    Scenario: An explicitly invited external reviewer keeps access
      Given AuthKit authenticates the visitor as "contractor@different.example"
      And the visitor has an accepted viewer grant for the Shiplet
      When the visitor opens the Shiplet review link
      Then the visitor can view the Shiplet
      And Shiplet does not show the request access screen

  Rule: Requesting access notifies the owner without granting access

    Scenario: An outsider confirms an access request
      Given AuthKit authenticates the visitor as "reviewer@different.example"
      And the visitor is viewing the request access screen
      When the visitor confirms "Request access"
      Then Shiplet records one pending access request for the visitor and Shiplet
      And Shiplet sends one email to the Shiplet owner
      And the email identifies the requester and the Shiplet
      And the email includes a secure link for the owner to manage access
      And Shiplet confirms that the request was sent
      But the visitor still cannot view the protected artifact

    Scenario: Repeating a pending request does not spam the owner
      Given a pending access request already exists for the visitor and Shiplet
      When the visitor confirms "Request access" again
      Then Shiplet keeps one pending access request for the visitor and Shiplet
      And Shiplet does not send another owner email
      And Shiplet confirms that the request is already pending

    Scenario: Email delivery fails
      Given the visitor is viewing the request access screen
      And the owner notification email cannot be accepted for delivery
      When the visitor confirms "Request access"
      Then Shiplet does not claim that the request was sent
      And Shiplet shows a retryable error
      And the visitor still cannot view the protected artifact

  Rule: Domain access applies only to organization-scoped Shiplets

    Scenario: Matching a verified domain does not override a narrower Shiplet policy
      Given the organization owns a Shiplet whose visibility is not "organization"
      When AuthKit authenticates the visitor as "reviewer@acme.example"
      Then Shiplet evaluates the Shiplet's existing access policy
      And domain membership does not create a Shiplet-specific grant
