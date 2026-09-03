// Copyright (c) 2022 Cloudflare, Inc.
// Licensed under the APACHE LICENSE, VERSION 2.0 license found in the LICENSE file or at http://www.apache.org/licenses/LICENSE-2.0

import { D1QB } from "workers-qb";
import { ResourceRecord, Project } from "./types";

function normalizeFetchOne<T>(result: unknown): T | null {
	if (Array.isArray(result)) {
		return (result[0] as T | undefined) || null;
	}
	return (result as T | null) || null;
}

export async function Initialize(db: D1QB) {
	const dependentTables = [
		"review_notifications",
		"review_feedback_mentions",
		"review_feedback_replies",
		"review_api_tokens",
		"organization_api_token_project_rules",
		"organization_api_tokens",
		"review_feedback",
		"shiplet_watch_subscriptions",
		"project_assets",
		"shiplet_access_requests",
		"shiplet_access_grants",
		"app_invitations",
	];
	const tables: { name: string; schema: string }[] = [
		{
			name: "projects",
			schema:
				"id TEXT PRIMARY KEY, organization_id TEXT, owner_user_id TEXT, name TEXT NOT NULL, subdomain TEXT UNIQUE NOT NULL, custom_hostname TEXT, source_type TEXT NOT NULL DEFAULT 'static', external_origin_url TEXT, script_content TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'organization', archived_on TEXT, delete_after TEXT, created_on TEXT NOT NULL, modified_on TEXT NOT NULL",
		},
	];

	for (const tableName of dependentTables) {
		try {
			await db.delete({
				tableName,
				where: { conditions: "1 = 1" },
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("no such table")) {
				throw error;
			}
		}
	}

	for (const table of tables) {
		await db.dropTable({
			tableName: table.name,
			ifExists: true,
		});
	}
	for (const table of tables) {
		await db.createTable({
			tableName: table.name,
			schema: table.schema,
			ifNotExists: true,
		});
	}
}

export async function FetchTable(
	db: D1QB,
	table: string,
): Promise<ResourceRecord[] | undefined> {
	return (
		await db.fetchAll({
			tableName: table,
			fields: "*",
		})
	).results;
}

export async function CreateProject(db: D1QB, project: Project) {
	// Convert undefined to null for database
	const dbProject = {
		...project,
		custom_hostname: project.custom_hostname || null,
		external_origin_url: project.external_origin_url || null,
		archived_on: project.archived_on || null,
		delete_after: project.delete_after || null,
	};

	return db.insert({
		tableName: "projects",
		data: dbProject as unknown as Record<string, string | null>,
	});
}

export async function GetProjectBySubdomain(
	db: D1QB,
	subdomain: string,
): Promise<Project | null> {
	const result = await db.fetchOne({
		tableName: "projects",
		fields: "*",
		where: {
			conditions: "projects.subdomain IS ?",
			params: [subdomain],
		},
	});
	return normalizeFetchOne<Project>(result.results);
}

export async function GetProjectByCustomHostname(
	db: D1QB,
	hostname: string,
): Promise<Project | null> {
	const result = await db.fetchOne({
		tableName: "projects",
		fields: "*",
		where: {
			conditions: "projects.custom_hostname IS ?",
			params: [hostname],
		},
	});
	return normalizeFetchOne<Project>(result.results);
}

export async function GetAllProjects(db: D1QB): Promise<Project[]> {
	const result = await db.fetchAll({
		tableName: "projects",
		fields: "*",
	});
	return (result.results as Project[]) || [];
}

export async function UpdateProject(
	db: D1QB,
	projectId: string,
	updates: Partial<Project>,
) {
	return db.update({
		tableName: "projects",
		data: updates as unknown as Record<string, string>,
		where: {
			conditions: "projects.id IS ?",
			params: [projectId],
		},
	});
}
