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

import { Chain, Transaction } from '@liskhq/lisk-chain';
import { codec } from '@liskhq/lisk-codec';
import { InMemoryKVStore } from '@liskhq/lisk-db';
import { TransactionPool } from '@liskhq/lisk-transaction-pool';
import { when } from 'jest-when';
import { Logger } from '../../../../src/logger';
import { Broadcaster } from '../../../../src/node/generator/broadcaster';
import { NetworkEndpoint } from '../../../../src/node/generator/network_endpoint';
import {
	getTransactionsResponseSchema,
	postTransactionsAnnouncementSchema,
} from '../../../../src/node/generator/schemas';
import { Network } from '../../../../src/node/network';
import { StateMachine, VerifyStatus } from '../../../../src/node/state_machine';
import { fakeLogger } from '../../../utils/node';

describe('generator network endpoint', () => {
	const logger: Logger = fakeLogger;
	const tx = new Transaction({
		asset: Buffer.alloc(20),
		assetID: 0,
		fee: BigInt(100000),
		moduleID: 2,
		nonce: BigInt(0),
		senderPublicKey: Buffer.alloc(32),
		signatures: [Buffer.alloc(64)],
	});
	const tx2 = new Transaction({
		asset: Buffer.alloc(20),
		assetID: 1,
		fee: BigInt(200000),
		moduleID: 2,
		nonce: BigInt(0),
		senderPublicKey: Buffer.alloc(32),
		signatures: [Buffer.alloc(64)],
	});
	const defaultRateLimit = 10000;

	let endpoint: NetworkEndpoint;
	let broadcaster: Broadcaster;
	let chain: Chain;
	let stateMachine: StateMachine;
	let pool: TransactionPool;
	let network: Network;

	beforeEach(() => {
		broadcaster = {
			enqueueTransactionId: jest.fn(),
		} as never;
		chain = {
			dataAccess: {
				decodeTransaction: jest.fn().mockReturnValue(tx),
				getTransactionsByIDs: jest.fn().mockResolvedValue([]),
			},
			constants: {
				networkIdentifier: Buffer.from('networkIdentifier'),
			},
		} as never;
		pool = {
			contains: jest.fn().mockReturnValue(false),
			add: jest.fn().mockResolvedValue({}),
		} as never;
		stateMachine = {
			verifyTransaction: jest.fn().mockResolvedValue({
				status: VerifyStatus.OK,
			}),
		} as never;
		network = {
			applyPenaltyOnPeer: jest.fn(),
			requestFromPeer: jest.fn().mockResolvedValue({
				data: codec.encode(getTransactionsResponseSchema, {
					transactions: [tx.getBytes(), tx2.getBytes()],
				}),
			}),
			broadcast: jest.fn(),
		} as never;
		endpoint = new NetworkEndpoint({
			broadcaster,
			chain,
			network,
			pool,
			stateMachine,
		});
		endpoint.init({
			logger,
			blockchainDB: new InMemoryKVStore() as never,
		});
		jest.useFakeTimers();
	});

	describe('handleEventPostTransactionsAnnouncement', () => {
		const defaultPeerId = 'peer-id';

		let validTransactionsRequest: Buffer;

		beforeEach(() => {
			validTransactionsRequest = codec.encode(postTransactionsAnnouncementSchema, {
				transactionIds: [tx.id, tx2.id],
			});
		});

		describe('when it is called more than 3 times within 10 sec', () => {
			it('should apply penalty', async () => {
				// Act
				await endpoint.handleEventPostTransactionsAnnouncement(
					validTransactionsRequest,
					defaultPeerId,
				);
				await endpoint.handleEventPostTransactionsAnnouncement(
					validTransactionsRequest,
					defaultPeerId,
				);
				await endpoint.handleEventPostTransactionsAnnouncement(
					validTransactionsRequest,
					defaultPeerId,
				);
				await endpoint.handleEventPostTransactionsAnnouncement(
					validTransactionsRequest,
					defaultPeerId,
				);
				jest.advanceTimersByTime(defaultRateLimit);

				// Assert
				expect(network.applyPenaltyOnPeer).toHaveBeenCalledWith({
					peerId: defaultPeerId,
					penalty: 10,
				});
			});
		});

		describe('when invalid schema is received', () => {
			it('should apply penalty', async () => {
				// Assert
				await expect(
					endpoint.handleEventPostTransactionsAnnouncement(undefined, defaultPeerId),
				).toReject();
				expect(network.applyPenaltyOnPeer).toHaveBeenCalledWith({
					peerId: defaultPeerId,
					penalty: 100,
				});
			});
		});

		describe('when none of the transactions ids are known', () => {
			beforeEach(() => {
				// Arrange
				const transactionIds = codec.encode(postTransactionsAnnouncementSchema, {
					transactionIds: [tx.id, tx2.id],
				});

				(pool.contains as jest.Mock).mockReturnValue(false);
				(chain.dataAccess.getTransactionsByIDs as jest.Mock).mockResolvedValue([]);
				(chain.dataAccess.decodeTransaction as jest.Mock)
					.mockReturnValueOnce(tx)
					.mockReturnValueOnce(tx2);
				when(network.requestFromPeer as jest.Mock)
					.calledWith(expect.anything())
					.mockResolvedValue({
						data: transactionIds,
						peerId: defaultPeerId,
					} as never);
			});

			it('should request all the transactions', async () => {
				// Assert
				await endpoint.handleEventPostTransactionsAnnouncement(
					validTransactionsRequest,
					defaultPeerId,
				);
				expect(network.requestFromPeer).toHaveBeenCalledWith({
					procedure: 'getTransactions',
					data: validTransactionsRequest,
					peerId: defaultPeerId,
				});
			});

			it('should handle the received transactions', async () => {
				// Assert
				await endpoint.handleEventPostTransactionsAnnouncement(
					validTransactionsRequest,
					defaultPeerId,
				);
				expect(chain.dataAccess.decodeTransaction).toHaveBeenCalledTimes(2);
				expect(stateMachine.verifyTransaction).toHaveBeenCalledTimes(2);
				expect(pool.contains).toHaveBeenCalledTimes(4);
				expect(pool.add).toHaveBeenCalledTimes(2);
			});

			it('should apply penalty when validateTransactions fails', async () => {
				// Act
				(pool.contains as jest.Mock).mockReturnValue(false);
				(stateMachine.verifyTransaction as jest.Mock).mockResolvedValue({
					status: VerifyStatus.FAIL,
				});
				await endpoint.handleEventPostTransactionsAnnouncement(
					validTransactionsRequest,
					defaultPeerId,
				);

				// Assert
				expect(network.applyPenaltyOnPeer).toHaveBeenCalledWith({
					peerId: defaultPeerId,
					penalty: 100,
				});
			});

			it('should not apply penalty when add fails', async () => {
				// Act
				const error = new Error('validate error');
				(pool.add as jest.Mock).mockResolvedValue({ errors: [error] });

				// Assert
				await endpoint.handleEventPostTransactionsAnnouncement(
					validTransactionsRequest,
					defaultPeerId,
				);
				expect(network.applyPenaltyOnPeer).not.toHaveBeenCalledWith({
					peerId: defaultPeerId,
					penalty: 100,
				});
			});
		});

		describe('when some of the transactions ids are known', () => {
			beforeEach(() => {
				const transactionIds = codec.encode(postTransactionsAnnouncementSchema, {
					transactionIds: [tx2.id],
				});

				when(pool.contains as jest.Mock)
					.calledWith(tx.id)
					.mockReturnValue(true);
				when(network.requestFromPeer as jest.Mock)
					.calledWith(expect.anything())
					.mockResolvedValue({
						data: transactionIds,
						peerId: defaultPeerId,
					} as never);
				(chain.dataAccess.getTransactionsByIDs as jest.Mock).mockResolvedValue([]);
				(chain.dataAccess.decodeTransaction as jest.Mock).mockReturnValue(tx2);
			});

			it('should request all the transactions', async () => {
				// Arrange
				const transactionIds = codec.encode(postTransactionsAnnouncementSchema, {
					transactionIds: [tx2.id],
				});

				// Act
				await endpoint.handleEventPostTransactionsAnnouncement(
					validTransactionsRequest,
					defaultPeerId,
				);

				// Assert
				expect(network.requestFromPeer).toHaveBeenCalledWith({
					procedure: 'getTransactions',
					data: transactionIds,
					peerId: defaultPeerId,
				});
			});

			it('should handle the received transactions', async () => {
				// Act
				await endpoint.handleEventPostTransactionsAnnouncement(
					validTransactionsRequest,
					defaultPeerId,
				);

				// Assert
				expect(chain.dataAccess.decodeTransaction).toHaveBeenCalledTimes(1);
				expect(stateMachine.verifyTransaction).toHaveBeenCalledTimes(1);
				expect(pool.contains).toHaveBeenCalledTimes(3);
				expect(pool.add).toHaveBeenCalledTimes(1);
			});
		});
	});
});
