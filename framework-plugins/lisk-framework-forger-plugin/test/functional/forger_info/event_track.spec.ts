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

import { testing } from 'lisk-framework';
import {
	closeApplicationEnv,
	createApplicationEnv,
	getForgerInfoByAddress,
	getForgerInfoByPublicKey,
	getForgerPlugin,
	waitNBlocks,
	waitTill,
} from '../../utils/application';
import { getRandomAccount } from '../../utils/accounts';
import { createTransferTransaction, createVoteTransaction } from '../../utils/transactions';

describe('Forger Info', () => {
	let appEnv: testing.ApplicationEnv;
	let accountNonce = 0;
	let networkIdentifier: Buffer;

	beforeAll(async () => {
		appEnv = createApplicationEnv('event_track');
		await appEnv.startApplication();
		// The test application generates a dynamic genesis block so we need to get the networkID like this
		networkIdentifier = appEnv.networkIdentifier;
	});

	afterAll(async () => {
		await closeApplicationEnv(appEnv);
	});

	describe('New Block', () => {
		it('should save forger info after new block', async () => {
			// Arrange
			const forgerPluginInstance = getForgerPlugin(appEnv.application);

			// Act
			const { generatorPublicKey } = appEnv.application['_node']['_chain'].lastBlock.header;
			const forgerInfo = await getForgerInfoByPublicKey(forgerPluginInstance, generatorPublicKey);

			// Assert
			expect(forgerInfo).toMatchSnapshot();
		});

		it('should save forger info with received fees if payload included in new block', async () => {
			// Arrange
			const forgerPluginInstance = getForgerPlugin(appEnv.application);
			const account = getRandomAccount();
			const transaction = createTransferTransaction({
				amount: '2',
				recipientAddress: account.address,
				fee: '0.3',
				nonce: accountNonce,
				networkIdentifier,
			});
			accountNonce += 1;

			await appEnv.application['_channel'].invoke('app:postTransaction', {
				transaction: transaction.getBytes().toString('hex'),
			});
			await waitNBlocks(appEnv.application, 1);

			const {
				header: { generatorPublicKey },
			} = appEnv.application['_node']['_chain'].lastBlock;
			const forgerInfo = await getForgerInfoByPublicKey(forgerPluginInstance, generatorPublicKey);

			// Assert
			expect(forgerInfo).toMatchSnapshot();
		});

		describe('Vote transactions', () => {
			it('should save forger info with votes received in new block', async () => {
				// Arrange
				const forgerPluginInstance = getForgerPlugin(appEnv.application);
				const [forgingDelegateAddress] = forgerPluginInstance['_forgersList'].entries()[0];
				const transaction1 = createVoteTransaction({
					amount: '10',
					recipientAddress: forgingDelegateAddress.toString('hex'),
					fee: '0.3',
					nonce: accountNonce,
					networkIdentifier,
				});
				accountNonce += 1;

				await appEnv.application['_channel'].invoke('app:postTransaction', {
					transaction: transaction1.getBytes().toString('hex'),
				});
				await waitNBlocks(appEnv.application, 1);
				await waitTill(200);

				const forgerInfo = await getForgerInfoByAddress(
					forgerPluginInstance,
					forgingDelegateAddress.toString('binary'),
				);
				// Assert
				expect(forgerInfo).toMatchSnapshot();
				expect(forgerInfo.votesReceived[0].amount).toEqual(BigInt(1000000000));
			});

			it('should update forger info with multiple votes received for same delegate in new block', async () => {
				// Arrange
				const forgerPluginInstance = getForgerPlugin(appEnv.application);
				const [forgingDelegateAddress] = forgerPluginInstance['_forgersList'].entries()[0];
				const transaction1 = createVoteTransaction({
					amount: '10',
					recipientAddress: forgingDelegateAddress.toString('hex'),
					fee: '0.3',
					nonce: accountNonce,
					networkIdentifier,
				});
				accountNonce += 1;
				const transaction2 = createVoteTransaction({
					amount: '50',
					recipientAddress: forgingDelegateAddress.toString('hex'),
					fee: '0.3',
					nonce: accountNonce,
					networkIdentifier,
				});
				accountNonce += 1;

				await appEnv.application['_channel'].invoke('app:postTransaction', {
					transaction: transaction1.getBytes().toString('hex'),
				});
				await appEnv.application['_channel'].invoke('app:postTransaction', {
					transaction: transaction2.getBytes().toString('hex'),
				});
				await waitNBlocks(appEnv.application, 1);
				await waitTill(200);

				const forgerInfo = await getForgerInfoByAddress(
					forgerPluginInstance,
					forgingDelegateAddress.toString('binary'),
				);
				// Assert
				expect(forgerInfo).toMatchSnapshot();
				expect(forgerInfo.votesReceived[0].amount).toEqual(BigInt(7000000000));
			});

			it('should update forger info with upvote and downvote for same delegate in new block', async () => {
				// Arrange
				const forgerPluginInstance = getForgerPlugin(appEnv.application);
				const [forgingDelegateAddress] = forgerPluginInstance['_forgersList'].entries()[0];
				const transaction1 = createVoteTransaction({
					amount: '-50',
					recipientAddress: forgingDelegateAddress.toString('hex'),
					fee: '0.3',
					nonce: accountNonce,
					networkIdentifier,
				});
				accountNonce += 1;
				const transaction2 = createVoteTransaction({
					amount: '+10',
					recipientAddress: forgingDelegateAddress.toString('hex'),
					fee: '0.3',
					nonce: accountNonce,
					networkIdentifier,
				});
				accountNonce += 1;

				await appEnv.application['_channel'].invoke('app:postTransaction', {
					transaction: transaction1.getBytes().toString('hex'),
				});
				await appEnv.application['_channel'].invoke('app:postTransaction', {
					transaction: transaction2.getBytes().toString('hex'),
				});
				await waitNBlocks(appEnv.application, 1);
				await waitTill(200);

				const forgerInfo = await getForgerInfoByAddress(
					forgerPluginInstance,
					forgingDelegateAddress.toString('binary'),
				);
				// Assert
				expect(forgerInfo).toMatchSnapshot();
				expect(forgerInfo.votesReceived[0].amount).toEqual(BigInt(3000000000));
			});

			it('should update forger info with voters info and remove when amount becomes zero', async () => {
				// Arrange
				const forgerPluginInstance = getForgerPlugin(appEnv.application);
				const [forgingDelegateAddress1] = forgerPluginInstance['_forgersList'].entries()[0];
				const [forgingDelegateAddress2] = forgerPluginInstance['_forgersList'].entries()[1];
				const transaction1 = createVoteTransaction({
					amount: '-30',
					recipientAddress: forgingDelegateAddress1.toString('hex'),
					fee: '0.3',
					nonce: accountNonce,
					networkIdentifier,
				});
				accountNonce += 1;
				const transaction2 = createVoteTransaction({
					amount: '20',
					recipientAddress: forgingDelegateAddress2.toString('hex'),
					fee: '0.3',
					nonce: accountNonce,
					networkIdentifier,
				});
				accountNonce += 1;

				await appEnv.application['_channel'].invoke('app:postTransaction', {
					transaction: transaction1.getBytes().toString('hex'),
				});
				await appEnv.application['_channel'].invoke('app:postTransaction', {
					transaction: transaction2.getBytes().toString('hex'),
				});
				await waitNBlocks(appEnv.application, 1);
				await waitTill(200);

				const forgerInfo1 = await getForgerInfoByAddress(
					forgerPluginInstance,
					forgingDelegateAddress1.toString('binary'),
				);
				const forgerInfo2 = await getForgerInfoByAddress(
					forgerPluginInstance,
					forgingDelegateAddress2.toString('binary'),
				);
				// Assert
				expect(forgerInfo1).toMatchSnapshot();
				expect(forgerInfo1.votesReceived).toBeEmpty();
				expect(forgerInfo2).toMatchSnapshot();
				expect(forgerInfo2.votesReceived[0].amount).toEqual(BigInt(2000000000));
			});
		});
	});

	describe('Delete Block', () => {
		it('should update forger info after delete block', async () => {
			// Arrange
			const { generatorPublicKey } = appEnv.application['_node']['_chain'].lastBlock.header;
			const forgerPluginInstance = getForgerPlugin(appEnv.application);
			await appEnv.application['_node']['_processor'].deleteLastBlock();

			// Act
			await waitTill(50);
			const forgerInfo = await getForgerInfoByPublicKey(forgerPluginInstance, generatorPublicKey);

			// Asserts
			expect(forgerInfo).toMatchSnapshot();
		});
	});
});
