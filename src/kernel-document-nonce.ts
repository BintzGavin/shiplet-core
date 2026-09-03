declare const kernelDocumentNonceBrand: unique symbol;

export type KernelDocumentNonce = string & {
	readonly [kernelDocumentNonceBrand]: "trusted-kernel-document-nonce";
};

const KERNEL_NONCE_PATTERN = /^[A-Za-z0-9+/_=-]{20,}$/;

export function kernelScriptNonceAttribute(nonce: KernelDocumentNonce) {
	if (!KERNEL_NONCE_PATTERN.test(nonce)) {
		throw new TypeError("Invalid trusted kernel document nonce");
	}
	return `nonce="${nonce}"`;
}
