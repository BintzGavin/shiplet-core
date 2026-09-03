import {
  getUser,
  getUserByEmail,
  type ShipletUser,
  upsertUser,
} from "./store";
import type { WorkOSUser } from "./workos";

type WorkOSIdentityRow = {
  user_id: string;
};

async function userForWorkOSIdentity(
  db: D1Database,
  workosUserId: string,
) {
  return db
    .prepare(
      `SELECT users.*
			 FROM workos_user_identities
			 JOIN users ON users.id = workos_user_identities.user_id
			 WHERE workos_user_identities.workos_user_id = ?
			 LIMIT 1`,
    )
    .bind(workosUserId)
    .first<ShipletUser>();
}

async function bindWorkOSIdentity(
  db: D1Database,
  input: {
    workosUserId: string;
    userId: string;
    email: string;
    authenticatedOn: string;
  },
) {
  await db
    .prepare(
      `INSERT INTO workos_user_identities (
				 workos_user_id, user_id, email, created_on, last_authenticated_on
			 ) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(workos_user_id) DO UPDATE SET
			 email = excluded.email,
			 last_authenticated_on = excluded.last_authenticated_on`,
    )
    .bind(
      input.workosUserId,
      input.userId,
      input.email,
      input.authenticatedOn,
      input.authenticatedOn,
    )
    .run();

  const identity = await db
    .prepare(
      `SELECT user_id FROM workos_user_identities
			 WHERE workos_user_id = ? LIMIT 1`,
    )
    .bind(input.workosUserId)
    .first<WorkOSIdentityRow>();
  if (!identity || identity.user_id !== input.userId) {
    throw new Error("workos_identity_binding_conflict");
  }
}

export async function resolveVerifiedWorkOSUser(
  db: D1Database,
  workosUser: WorkOSUser,
): Promise<ShipletUser> {
  if (workosUser.emailVerified !== true) {
    throw new Response("A verified email address is required", { status: 403 });
  }
  const email = workosUser.email.trim().toLowerCase();
  if (!workosUser.id || !email) {
    throw new Response("WorkOS identity is invalid", { status: 403 });
  }

  let user = await userForWorkOSIdentity(db, workosUser.id);
  if (!user) {
    user = await getUserByEmail(db, email);
    if (!user) {
      try {
        await upsertUser(db, {
          id: workosUser.id,
          email,
          firstName: workosUser.firstName,
          lastName: workosUser.lastName,
        });
        user = await getUser(db, workosUser.id);
      } catch (error) {
        const concurrentUser = await getUserByEmail(db, email);
        if (!concurrentUser) throw error;
        user = concurrentUser;
      }
    }
    if (!user) throw new Error("workos_identity_user_missing");
    await bindWorkOSIdentity(db, {
      workosUserId: workosUser.id,
      userId: user.id,
      email,
      authenticatedOn: new Date().toISOString(),
    });
  }

  await upsertUser(db, {
    id: user.id,
    email,
    firstName: workosUser.firstName,
    lastName: workosUser.lastName,
  });
  const synchronized = await getUser(db, user.id);
  if (!synchronized) throw new Error("workos_identity_user_missing");
  return synchronized;
}

export async function latestWorkOSUserIdForLocalUser(
  db: D1Database,
  userId: string,
) {
  const identity = await db
    .prepare(
      `SELECT workos_user_id
			 FROM workos_user_identities
			 WHERE user_id = ?
			 ORDER BY last_authenticated_on DESC
			 LIMIT 1`,
    )
    .bind(userId)
    .first<{ workos_user_id: string }>();
  return identity?.workos_user_id || null;
}
