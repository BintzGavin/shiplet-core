import { BROWSER_INSTALLATION_FILTER } from "./embed";

// "Toolbar for the public" on a connected site. Null (the default) shows the
// signed-out toolbar as always: Annotate, Comments and, when visitor feedback
// is on, Feedback. "feedback_only" shows the public just Feedback; the site's
// team adds ?shiplet=review to the page address to get the full toolbar back.
// A display choice only: Annotate still needs a sign-in and review access.
export type EmbedPublicToolbar = "feedback_only";

// The stored column value; anything but the exact choice keeps today's toolbar.
export function readEmbedPublicToolbar(value: unknown): EmbedPublicToolbar | null {
  return value === "feedback_only" ? "feedback_only" : null;
}

// The setup form's choice: "full" clears the setting, "feedback_only" sets it,
// anything else (missing, repeated, other spelling) is refused.
export function parseEmbedPublicToolbarChoice(
  values: string[],
): { value: EmbedPublicToolbar | null } | null {
  if (values.length !== 1) return null;
  if (values[0] === "full") return { value: null };
  if (values[0] === "feedback_only") return { value: "feedback_only" };
  return null;
}

export async function setInstallationPublicToolbar(
  db: D1Database,
  projectId: string,
  installationId: string,
  value: EmbedPublicToolbar | null,
) {
  const result = await db
    .prepare(
      `UPDATE embed_installations SET public_toolbar = ? WHERE id = ? AND project_id = ? AND revoked_on IS NULL AND ${BROWSER_INSTALLATION_FILTER}`,
    )
    .bind(value, installationId, projectId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

// What the signed-out start page shows: the full toolbar, Feedback alone, or
// nothing at all (Feedback only while visitor feedback is off).
export function embedSignedOutToolbar(input: {
  setting: EmbedPublicToolbar | null;
  visitorsOn: boolean;
  team: boolean;
}): "full" | "feedback" | "hidden" {
  if (input.setting !== "feedback_only" || input.team) return "full";
  return input.visitorsOn ? "feedback" : "hidden";
}
