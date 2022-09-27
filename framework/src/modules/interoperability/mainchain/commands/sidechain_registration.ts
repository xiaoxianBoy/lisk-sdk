/*
 * Copyright © 2022 Lisk Foundation
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

import { codec } from '@liskhq/lisk-codec';
import { utils } from '@liskhq/lisk-cryptography';
import { validator } from '@liskhq/lisk-validator';
import { MainchainInteroperabilityStore } from '../store';
import { BaseInteroperabilityCommand } from '../../base_interoperability_command';
import {
	CHAIN_REGISTERED,
	EMPTY_HASH,
	MAX_UINT64,
	CCM_STATUS_OK,
	MAINCHAIN_ID_BUFFER,
	MODULE_NAME_INTEROPERABILITY,
	REGISTRATION_FEE,
	TOKEN_ID_LSK,
	CROSS_CHAIN_COMMAND_REGISTRATION,
	EMPTY_BYTES,
	CCM_SENT_STATUS_SUCCESS,
} from '../../constants';
import { ccmSchema, registrationCCMParamsSchema, sidechainRegParams } from '../../schemas';
import { SidechainRegistrationParams } from '../../types';
import { computeValidatorsHash, isValidName } from '../../utils';
import {
	CommandVerifyContext,
	VerificationResult,
	VerifyStatus,
	CommandExecuteContext,
} from '../../../../state_machine';
import { ChainAccountStore } from '../../stores/chain_account';
import { ChannelDataStore } from '../../stores/channel_data';
import { ChainValidatorsStore } from '../../stores/chain_validators';
import { OutboxRootStore } from '../../stores/outbox_root';
import { RegisteredNamesStore } from '../../stores/registered_names';
import { ImmutableStoreGetter, StoreGetter } from '../../../base_store';
import { TokenMethod } from '../../../token';
import { ChainAccountUpdatedEvent } from '../../events/chain_account_updated';
import { OwnChainAccountStore } from '../../stores/own_chain_account';
import { CcmProcessedEvent } from '../../events/ccm_processed';

export class SidechainRegistrationCommand extends BaseInteroperabilityCommand {
	public schema = sidechainRegParams;
	private _tokenMethod!: TokenMethod;

	public addDependencies(tokenMethod: TokenMethod) {
		this._tokenMethod = tokenMethod;
	}

	public async verify(
		context: CommandVerifyContext<SidechainRegistrationParams>,
	): Promise<VerificationResult> {
		const {
			transaction: { senderAddress },
			params: { certificateThreshold, initValidators, chainID, name, sidechainRegistrationFee },
		} = context;

		try {
			validator.validate(sidechainRegParams, context.params);
		} catch (err) {
			return {
				status: VerifyStatus.FAIL,
				error: err as Error,
			};
		}

		// 	The sidechain name property has to contain only characters from the set [a-z0-9!@$&_.]
		if (!isValidName(name)) {
			return {
				status: VerifyStatus.FAIL,
				error: new Error(
					`Invalid name property. It should contain only characters from the set [a-z0-9!@$&_.].`,
				),
			};
		}

		// 	The sidechain name has to be unique with respect to the set of already registered sidechain names in the blockchain state
		const nameSubstore = this.stores.get(RegisteredNamesStore);
		const nameExists = await nameSubstore.has(context, Buffer.from(name, 'utf8'));

		if (nameExists) {
			return {
				status: VerifyStatus.FAIL,
				error: new Error('Name already registered.'),
			};
		}

		// The chainID has to be unique with respect to the set of already registered sidechains.
		const chainAccountSubstore = this.stores.get(ChainAccountStore);
		const chainAccountExists = await chainAccountSubstore.has(context, chainID);

		if (chainAccountExists) {
			return {
				status: VerifyStatus.FAIL,
				error: new Error('Chain ID already registered.'),
			};
		}

		// Check that the first byte of the chainID matches.
		if (chainID[0] !== MAINCHAIN_ID_BUFFER[0]) {
			return {
				status: VerifyStatus.FAIL,
				error: new Error('Chain ID does not match the mainchain network.'),
			};
		}

		let totalBftWeight = BigInt(0);
		for (let i = 0; i < initValidators.length; i += 1) {
			const currentValidator = initValidators[i];

			// The blsKeys must be lexicographically ordered and unique within the array.
			if (
				initValidators[i + 1] &&
				currentValidator.blsKey.compare(initValidators[i + 1].blsKey) > -1
			) {
				return {
					status: VerifyStatus.FAIL,
					error: new Error('Validators blsKeys must be unique and lexicographically ordered'),
				};
			}

			if (currentValidator.bftWeight <= BigInt(0)) {
				return {
					status: VerifyStatus.FAIL,
					error: new Error('Validator bft weight must be greater than 0'),
				};
			}

			totalBftWeight += currentValidator.bftWeight;
		}

		if (totalBftWeight > MAX_UINT64) {
			return {
				status: VerifyStatus.FAIL,
				error: new Error(`Validator bft weight must not exceed ${MAX_UINT64}`),
			};
		}

		// Minimum certificateThreshold value: floor(1/3 * totalWeight) + 1
		// Note: BigInt truncates to floor
		if (certificateThreshold < totalBftWeight / BigInt(3) + BigInt(1)) {
			return {
				status: VerifyStatus.FAIL,
				error: new Error('Certificate threshold below minimum bft weight '),
			};
		}

		// Maximum certificateThreshold value: total bft weight
		if (certificateThreshold > totalBftWeight) {
			return {
				status: VerifyStatus.FAIL,
				error: new Error('Certificate threshold above maximum bft weight'),
			};
		}

		// sidechainRegistrationFee must be valid
		if (sidechainRegistrationFee !== REGISTRATION_FEE) {
			return {
				status: VerifyStatus.FAIL,
				error: new Error(`Sidechain registration fee must be equal to ${REGISTRATION_FEE}`),
			};
		}

		// Sender must have enough balance to pay for extra command fee.
		const availableBalance = await this._tokenMethod.getAvailableBalance(
			context.getMethodContext(),
			senderAddress,
			TOKEN_ID_LSK,
		);
		if (availableBalance < REGISTRATION_FEE) {
			return {
				status: VerifyStatus.FAIL,
				error: new Error(
					`Sender does not have enough balance. Required: ${REGISTRATION_FEE}, found: ${availableBalance}`,
				),
			};
		}

		return {
			status: VerifyStatus.OK,
		};
	}

	public async execute(context: CommandExecuteContext<SidechainRegistrationParams>): Promise<void> {
		const {
			getMethodContext,
			transaction: { senderAddress },
			params: { certificateThreshold, initValidators, chainID, name },
		} = context;
		const methodContext = getMethodContext();

		// Add an entry in the chain substore
		const chainSubstore = this.stores.get(ChainAccountStore);
		const sidechainAccount = {
			name,
			lastCertificate: {
				height: 0,
				timestamp: 0,
				stateRoot: EMPTY_HASH,
				validatorsHash: computeValidatorsHash(initValidators, certificateThreshold),
			},
			status: CHAIN_REGISTERED,
		};

		await chainSubstore.set(context, chainID, sidechainAccount);

		// Add an entry in the channel substore
		const messageFeeTokenID = {
			chainID: utils.intToBuffer(1, 4),
			localID: utils.intToBuffer(0, 4),
		};
		const channelSubstore = this.stores.get(ChannelDataStore);
		await channelSubstore.set(context, chainID, {
			inbox: { root: EMPTY_HASH, appendPath: [], size: 0 },
			outbox: { root: EMPTY_HASH, appendPath: [], size: 0 },
			partnerChainOutboxRoot: EMPTY_HASH,
			messageFeeTokenID,
		});

		// Add an entry in the validators substore
		const chainValidatorsSubstore = this.stores.get(ChainValidatorsStore);
		await chainValidatorsSubstore.set(context, chainID, {
			activeValidators: initValidators,
			certificateThreshold,
		});

		// Add an entry in the outbox root substore
		const outboxRootSubstore = this.stores.get(OutboxRootStore);
		await outboxRootSubstore.set(context, chainID, { root: EMPTY_HASH });

		// Add an entry in the registered names substore
		const registeredNamesSubstore = this.stores.get(RegisteredNamesStore);
		await registeredNamesSubstore.set(context, Buffer.from(name, 'utf-8'), { id: chainID });

		// Burn the registration fee
		await this._tokenMethod.burn(methodContext, senderAddress, TOKEN_ID_LSK, REGISTRATION_FEE);

		// Emit chain account updated event.
		this.events.get(ChainAccountUpdatedEvent).log(methodContext, chainID, sidechainAccount);

		// Send registration CCM to the sidechain.
		const encodedParams = codec.encode(registrationCCMParamsSchema, {
			chainID,
			name,
			messageFeeTokenID,
		});

		const ownChainAccountSubstore = this.stores.get(OwnChainAccountStore);
		const ownChainAccount = await ownChainAccountSubstore.get(methodContext, EMPTY_BYTES);

		const ccm = {
			nonce: ownChainAccount.nonce,
			module: MODULE_NAME_INTEROPERABILITY,
			crossChainCommand: CROSS_CHAIN_COMMAND_REGISTRATION,
			sendingChainID: ownChainAccount.chainID,
			receivingChainID: chainID,
			fee: BigInt(0),
			status: CCM_STATUS_OK,
			params: encodedParams,
		};
		const interoperabilityStore = this.getInteroperabilityStore(context);
		await interoperabilityStore.addToOutbox(chainID, ccm);

		// Update own chain account nonce
		ownChainAccount.nonce += BigInt(1);
		await ownChainAccountSubstore.set(context, EMPTY_BYTES, ownChainAccount);

		// Emit CCM processed event.
		const ccmID = utils.hash(codec.encode(ccmSchema, ccm));
		this.events.get(CcmProcessedEvent).log(methodContext, ownChainAccount.chainID, chainID, {
			ccmID,
			status: CCM_SENT_STATUS_SUCCESS,
		});
	}

	protected getInteroperabilityStore(
		context: StoreGetter | ImmutableStoreGetter,
	): MainchainInteroperabilityStore {
		return new MainchainInteroperabilityStore(this.stores, context, this.interoperableCCMethods);
	}
}
