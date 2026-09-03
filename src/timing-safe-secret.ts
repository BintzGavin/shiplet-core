const encoder = new TextEncoder();
const SHA_256_BYTES = 32;

async function digestSecret(value: string): Promise<Uint8Array> {
	return new Uint8Array(
		await crypto.subtle.digest("SHA-256", encoder.encode(value)),
	);
}

function constantTimeEqualSha256(left: Uint8Array, right: Uint8Array): boolean {
	let mismatch = left.byteLength ^ right.byteLength;
	for (let index = 0; index < SHA_256_BYTES; index += 1) {
		mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return mismatch === 0;
}

export async function timingSafeSecretMatches(
	expectedSecret: string,
	presentedSecret: string,
): Promise<boolean> {
	const [expectedDigest, presentedDigest] = await Promise.all([
		digestSecret(expectedSecret),
		digestSecret(presentedSecret),
	]);
	return constantTimeEqualSha256(expectedDigest, presentedDigest);
}
