/*
 * Copyright © 2020 Lisk Foundation
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
import { BaseChannel } from 'lisk-framework';
import { PeerInfo, SharedState, TransactionPropagationStats } from '../types';

interface TransactionStats {
	transactions: Record<string, TransactionPropagationStats>;
	connectedPeers: number;
	averageReceivedTransactions: number;
}

const getAverage = (transactions: Record<string, TransactionPropagationStats>): number => {
	let transactionCount = 0;
	let total = 0;

	for (const transactionStats of Object.values(transactions)) {
		transactionCount += 1;
		total += transactionStats.count;
	}

	return transactionCount ? total / transactionCount : 0;
};

export const getTransactionStats = async (
	channel: BaseChannel,
	state: SharedState,
): Promise<TransactionStats> => ({
	transactions: state.transactions,
	connectedPeers: (await channel.invoke<ReadonlyArray<PeerInfo>>('app:getConnectedPeers')).length,
	averageReceivedTransactions: getAverage(state.transactions),
});
