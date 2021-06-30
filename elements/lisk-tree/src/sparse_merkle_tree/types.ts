/*
 * Copyright © 2021 Lisk Foundation
 *
 * See the LICENSE file at the top-level directory of this distribution
 * for licensing information.
 *
 * Unless otherwise agreed in a custom licensing agreement with the Lisk Foundation,
 * no part of this software, including this file, may be copied, modified,
 * propagated, or distributed except according to the terms contained in the
 * LICENSE file.
 *
 * Removal or modification of this copyright notice is prohibited.
 */

export interface InclusionProof {
	readonly siblingHashes: Buffer[];
	readonly queries: InclusionProofQuery[];
}

export interface InclusionProofQuery {
	readonly key: Buffer;
	readonly value: Buffer;
	readonly bitmap: Buffer;
}

export interface InclusionProofQueryWithHash extends InclusionProofQuery {
	hash: Buffer;
	binaryBitmap: string;
}
