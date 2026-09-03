import { parse } from "acorn";

export type CodeModeRequestOptions = {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	path: string;
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	idempotencyKey?: string;
};

type AcornNode = {
	type: string;
	[key: string]: unknown;
};

export function parseCodeModeRequest(code: string): CodeModeRequestOptions {
	const ast = parseCode(code);
	const call = findCodemodeCall(ast, "request");
	if (!call) {
		throw new Response("Code must call codemode.request({...}).", {
			status: 400,
		});
	}

	const requestCall = call as AcornNode;
	const args = Array.isArray(requestCall.arguments)
		? requestCall.arguments
		: [];
	const value = literalFromNode(args[0] as AcornNode | undefined);
	if (!isRecord(value)) {
		throw new Response("codemode.request requires an object argument.", {
			status: 400,
		});
	}

	const method = normalizeMethod(value.method);
	const path = typeof value.path === "string" ? value.path.trim() : "";
	if (!path.startsWith("/")) {
		throw new Response("codemode.request path must start with '/'.", {
			status: 400,
		});
	}

	const request: CodeModeRequestOptions = { method, path };
	if (isRecord(value.query)) {
		request.query = normalizeQuery(value.query);
	}
	if ("headers" in value) {
		request.idempotencyKey = normalizeIdempotencyHeader(value.headers);
	}
	if ("body" in value) {
		request.body = value.body;
	}
	return request;
}

function normalizeIdempotencyHeader(value: unknown) {
	if (!isRecord(value)) {
		throw new Response("codemode.request headers must be an object.", {
			status: 400,
		});
	}
	const headers = Object.entries(value);
	if (headers.length === 0) return undefined;
	if (headers.length !== 1 || headers[0][0].toLowerCase() !== "idempotency-key") {
		throw new Response("Only the Idempotency-Key request header is supported.", {
			status: 400,
		});
	}
	const headerValue = headers[0][1];
	if (
		typeof headerValue !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(headerValue)
	) {
		throw new Response("Invalid Idempotency-Key request header.", {
			status: 400,
		});
	}
	return headerValue;
}

export function codeReadsSpec(code: string) {
	const ast = parseCode(code);
	return Boolean(findCodemodeCall(ast, "spec"));
}

function parseCode(code: string) {
	try {
		return parse(code, {
			ecmaVersion: "latest",
			sourceType: "script",
			allowAwaitOutsideFunction: true,
		}) as unknown as AcornNode;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Response(`Invalid Code Mode JavaScript: ${message}`, {
			status: 400,
		});
	}
}

function findCodemodeCall(
	node: AcornNode,
	methodName: "request" | "spec",
): AcornNode | null {
	let found: AcornNode | null = null;
	walk(node, (current) => {
		if (found || current.type !== "CallExpression") return;
		const callee = current.callee as AcornNode | undefined;
		if (!callee || callee.type !== "MemberExpression") return;
		const object = callee.object as AcornNode | undefined;
		const property = callee.property as AcornNode | undefined;
		if (
			object?.type === "Identifier" &&
			object.name === "codemode" &&
			property?.type === "Identifier" &&
			property.name === methodName
		) {
			found = current;
		}
	});
	return found;
}

function walk(node: unknown, visit: (node: AcornNode) => void) {
	if (!isRecord(node) || typeof node.type !== "string") return;
	const current = node as AcornNode;
	visit(current);
	for (const [key, value] of Object.entries(current)) {
		if (key === "parent") continue;
		if (Array.isArray(value)) {
			for (const item of value) walk(item, visit);
		} else if (isRecord(value) && typeof value.type === "string") {
			walk(value, visit);
		}
	}
}

function literalFromNode(node: AcornNode | undefined): unknown {
	if (!node) return undefined;

	if (node.type === "Literal") {
		return node.value;
	}

	if (node.type === "TemplateLiteral") {
		const expressions = Array.isArray(node.expressions) ? node.expressions : [];
		const quasis = Array.isArray(node.quasis) ? node.quasis : [];
		if (expressions.length > 0) {
			throw new Response("Template literals with expressions are not supported.", {
				status: 400,
			});
		}
		const first = quasis[0] as AcornNode | undefined;
		const value = first?.value as { cooked?: string } | undefined;
		return value?.cooked || "";
	}

	if (node.type === "ObjectExpression") {
		const output: Record<string, unknown> = {};
		const properties = Array.isArray(node.properties) ? node.properties : [];
		for (const property of properties as AcornNode[]) {
			if (property.type !== "Property") continue;
			const key = propertyKey(property.key as AcornNode | undefined);
			if (!key) continue;
			output[key] = literalFromNode(property.value as AcornNode | undefined);
		}
		return output;
	}

	if (node.type === "ArrayExpression") {
		const elements = Array.isArray(node.elements) ? node.elements : [];
		return elements.map((element) =>
			literalFromNode(element as AcornNode | undefined),
		);
	}

	if (node.type === "UnaryExpression" && node.operator === "-") {
		const value = literalFromNode(node.argument as AcornNode | undefined);
		if (typeof value === "number") return -value;
	}

	throw new Response(`Unsupported Code Mode value: ${node.type}`, {
		status: 400,
	});
}

function propertyKey(node: AcornNode | undefined) {
	if (!node) return "";
	if (node.type === "Identifier") return String(node.name || "");
	if (node.type === "Literal") return String(node.value || "");
	return "";
}

function normalizeMethod(value: unknown): CodeModeRequestOptions["method"] {
	const method = typeof value === "string" ? value.toUpperCase() : "";
	if (
		method === "GET" ||
		method === "POST" ||
		method === "PUT" ||
		method === "PATCH" ||
		method === "DELETE"
	) {
		return method;
	}
	throw new Response("codemode.request method is not supported.", {
		status: 400,
	});
}

function normalizeQuery(value: Record<string, unknown>) {
	const output: Record<string, string | number | boolean | undefined> = {};
	for (const [key, item] of Object.entries(value)) {
		if (
			typeof item === "string" ||
			typeof item === "number" ||
			typeof item === "boolean" ||
			item === undefined
		) {
			output[key] = item;
		}
	}
	return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
