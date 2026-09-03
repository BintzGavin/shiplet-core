export function createReadyMessage(scope) {
	return {
		schemaVersion: "shiplet.review-frame/v1",
		type: "frame.ready",
		channelId: scope.channelId,
		nonce: scope.nonce,
		shipletId: scope.shipletId,
		revisionId: scope.revisionId,
	};
}

export function createRequestMessage(
	scope,
	requestId,
	sequence,
	action,
	resource,
	payload,
) {
	return {
		schemaVersion: "shiplet.review-frame/v1",
		type: "rpc.request",
		channelId: scope.channelId,
		requestId,
		sequence,
		shipletId: scope.shipletId,
		revisionId: scope.revisionId,
		action,
		resource,
		payload,
	};
}
