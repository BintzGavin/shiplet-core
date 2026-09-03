export type HostileWidgetScope = {
	channelId: string;
	nonce: string;
	shipletId: string;
	revisionId: string;
};

export declare function createReadyMessage(
	scope: HostileWidgetScope,
): Record<string, unknown>;

export declare function createRequestMessage(
	scope: HostileWidgetScope,
	requestId: string,
	sequence: number,
	action: string,
	resource: string,
	payload: unknown,
): Record<string, unknown>;
