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

import {
	BasePlugin,
	PluginInitContext,
	apiClient,
	Certificate,
	BFTHeights,
	db as liskDB,
	codec,
	chain,
	BFTParameters,
	LIVENESS_LIMIT,
	ChainAccount,
	OutboxRootWitness,
	MESSAGE_TAG_CERTIFICATE,
	ActiveValidator,
	cryptography,
	ccmSchema,
	JSONObject,
	Schema,
	OwnChainAccountJSON,
	Transaction,
	InboxUpdate,
	LastCertificate,
	LastCertificateJSON,
	CcmSendSuccessEventData,
	CcmProcessedEventData,
	CCMProcessedResult,
	CCMsg,
	tree,
	CrossChainUpdateTransactionParams,
	certificateSchema,
	ccuParamsSchema,
	ChainStatus,
} from 'lisk-sdk';
import { calculateActiveValidatorsUpdate } from './active_validators_update';
import { getNextCertificateFromAggregateCommits } from './certificate_generation';
import {
	CCU_FREQUENCY,
	MODULE_NAME_INTEROPERABILITY,
	CCM_SEND_SUCCESS,
	DB_KEY_SIDECHAIN,
	CCU_TOTAL_CCM_SIZE,
	COMMAND_NAME_SUBMIT_SIDECHAIN_CCU,
	CCM_PROCESSED,
} from './constants';
import { ChainConnectorStore, getDBInstance } from './db';
import { Endpoint } from './endpoint';
import { configSchema } from './schemas';
import {
	ChainConnectorPluginConfig,
	SentCCUs,
	ProveResponse,
	BlockHeader,
	CrossChainMessagesFromEvents,
} from './types';

const { address, ed, encrypt } = cryptography;

interface Data {
	readonly blockHeader: chain.BlockHeaderJSON;
}

interface LivenessValidationResult {
	status: boolean;
	isLive: boolean;
	chainID: Buffer;
	certificateTimestamp: number;
	blockTimestamp: number;
}

interface CertificateValidationResult {
	status: boolean;
	livenessValidationResult?: LivenessValidationResult;
	chainStatus: number;
	certificate: Certificate;
	blockHeader: BlockHeader;
	hasValidBLSWeightedAggSig?: boolean;
	message: string;
}

type ModuleMetadata = [
	{
		stores: { key: string; data: Schema }[];
		events: { name: string; data: Schema }[];
		name: string;
	},
];

export class ChainConnectorPlugin extends BasePlugin<ChainConnectorPluginConfig> {
	public endpoint = new Endpoint();
	public configSchema = configSchema;
	private _chainConnectorPluginDB!: liskDB.Database;
	private _sidechainChainConnectorStore!: ChainConnectorStore;
	private _lastCertificate!: LastCertificate;
	private _ccuFrequency!: number;
	private _mainchainAPIClient!: apiClient.APIClient;
	private _sidechainAPIClient!: apiClient.APIClient;
	private _ownChainID!: Buffer;
	private readonly _sentCCUs: SentCCUs = [];
	private _privateKey!: Buffer;

	public get nodeModulePath(): string {
		return __filename;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	public async init(context: PluginInitContext): Promise<void> {
		await super.init(context);
		this.endpoint.init(this._sentCCUs);
		this._ccuFrequency = this.config.ccuFrequency ?? CCU_FREQUENCY;
		const { password, encryptedPrivateKey } = this.config;
		if (password) {
			const parsedEncryptedKey = encrypt.parseEncryptedMessage(encryptedPrivateKey);
			this._privateKey = await encrypt.decryptMessageWithPassword(parsedEncryptedKey, password);
		}
	}

	public async load(): Promise<void> {
		this._chainConnectorPluginDB = await getDBInstance(this.dataPath);
		this._sidechainChainConnectorStore = new ChainConnectorStore(
			this._chainConnectorPluginDB,
			DB_KEY_SIDECHAIN,
		);
		this.endpoint.load(this._sidechainChainConnectorStore);

		this._mainchainAPIClient = await apiClient.createIPCClient(this.config.mainchainIPCPath);
		if (this.config.sidechainIPCPath) {
			this._sidechainAPIClient = await apiClient.createIPCClient(this.config.sidechainIPCPath);
		} else {
			this._sidechainAPIClient = this.apiClient;
		}
		// TODO: After DB issue we need to fetch the last sent CCUs and assign it to _sentCCUs
		// eslint-disable-next-line no-console
		console.log(this._sentCCUs);
		// TODO: Fetch the certificate height from last sent CCU and update the height

		// TODO: CCM should be collected and stored via events
		if (this._sidechainAPIClient) {
			this._ownChainID = Buffer.from(
				(
					await this._sidechainAPIClient.invoke<OwnChainAccountJSON>(
						'interoperability_getOwnChainAccount',
					)
				).chainID,
				'hex',
			);
			// Fetch last certificate from the receiving chain and update the _lastCertificate
			const lastCertificate = await this._mainchainAPIClient.invoke<LastCertificateJSON>(
				'interoperability_getChainAccount',
				{ chainID: this._ownChainID },
			);
			this._lastCertificate = {
				height: lastCertificate.height,
				stateRoot: Buffer.from(lastCertificate.stateRoot, 'hex'),
				timestamp: lastCertificate.timestamp,
				validatorsHash: Buffer.from(lastCertificate.validatorsHash, 'hex'),
			};
			// On a new block start with CCU creation process
			this._sidechainAPIClient.subscribe('chain_newBlock', async (data?: Record<string, unknown>) =>
				this._newBlockHandler(data),
			);

			this._sidechainAPIClient.subscribe(
				'chain_deleteBlock',
				async (data?: Record<string, unknown>) => this._deleteBlockHandler(data),
			);
		}
	}

	private async _newBlockHandler(data?: Record<string, unknown>) {
		const { blockHeader: receivedBlock } = data as unknown as Data;
		const newBlockHeader = chain.BlockHeader.fromJSON(receivedBlock).toObject();
		// Save block header, aggregateCommit, validatorsData and cross chain messages if any.
		try {
			await this._saveDataOnNewBlock(newBlockHeader);
		} catch (error) {
			this.logger.error(error, 'Failed during saving data on new block event.');

			return;
		}

		// When all the relevant data is saved successfully then try to create CCU
		// When # of CCMs are there on the outbox to be sent or # of blocks passed from last certified height
		if (this._ccuFrequency >= newBlockHeader.height - this._lastCertificate.height) {
			// TODO: _createCCU needs to be implemented which will create and send the CCU transaction
			await this._submitCCUs([]);
			await this._calculateCCUParams();
			// if the transaction is successfully sent then update the last certfied height and do the cleanup
			// TODO: also check if the state is growing, delete everything from the inMemory state if it goes beyond last 3 rounds
			await this._cleanup();
		}
	}

	private async _saveDataOnNewBlock(newBlockHeader: BlockHeader) {
		// Save block header if a new block header arrives
		const blockHeaders = await this._sidechainChainConnectorStore.getBlockHeaders();

		const indexBlockHeader = blockHeaders.findIndex(
			header => header.height === newBlockHeader.height,
		);
		if (indexBlockHeader > -1) {
			blockHeaders[indexBlockHeader] = newBlockHeader;
		} else {
			blockHeaders.push(newBlockHeader);
		}

		// Check for events if any and store them
		const events = await this._sidechainAPIClient.invoke<JSONObject<chain.EventAttr[]>>(
			'chain_getEvents',
			{ height: newBlockHeader.height },
		);

		// eslint-disable-next-line no-restricted-syntax, no-labels
		ccmInEventsCheck: if (events && events.length > 0) {
			const ccmSendSuccessEvents = events.filter(
				eventAttr =>
					eventAttr.name === CCM_SEND_SUCCESS && eventAttr.module === MODULE_NAME_INTEROPERABILITY,
			);

			const ccmProcessedEvents = events.filter(
				eventAttr =>
					eventAttr.name === CCM_PROCESSED && eventAttr.module === MODULE_NAME_INTEROPERABILITY,
			);

			if (ccmSendSuccessEvents.length === 0 && ccmProcessedEvents.length === 0) {
				// If there are no CCMs present in the events for the height then skip CCM saving part
				// eslint-disable-next-line no-labels
				break ccmInEventsCheck;
			}

			const { modules } = await this._sidechainAPIClient.invoke<{ modules: ModuleMetadata }>(
				'system_getMetadata',
			);
			const interoperabilityMetadata = modules.find(m => m.name === MODULE_NAME_INTEROPERABILITY);

			const ccmsFromEvents = [];
			// Save ccm send success events
			if (ccmSendSuccessEvents.length > 0) {
				const ccmSendSuccessEventInfo = interoperabilityMetadata?.events.filter(
					e => e.name === 'ccmSendSuccess',
				);

				if (!ccmSendSuccessEventInfo?.[0]?.data) {
					throw new Error('No schema found for "ccmSendSuccess" event data.');
				}

				for (const e of ccmSendSuccessEvents) {
					const eventData = codec.decode<CcmSendSuccessEventData>(
						ccmSendSuccessEventInfo[0].data,
						Buffer.from(e.data, 'hex'),
					);
					ccmsFromEvents.push(eventData.ccm);
				}
			}
			// Save ccm processed events based on CCMProcessedResult FORWARDED = 1
			if (ccmProcessedEvents.length > 0) {
				const ccmProcessedEventInfo = interoperabilityMetadata?.events.filter(
					e => e.name === 'ccmProcessed',
				);

				if (!ccmProcessedEventInfo?.[0]?.data) {
					throw new Error('No schema found for "ccmProcessed" event data.');
				}

				for (const e of ccmProcessedEvents) {
					const eventData = codec.decode<CcmProcessedEventData>(
						ccmProcessedEventInfo[0].data,
						Buffer.from(e.data, 'hex'),
					);
					if (eventData.result === CCMProcessedResult.FORWARDED) {
						ccmsFromEvents.push(eventData.ccm);
					}
				}
			}

			// TODO: find a better way to find storeKey from metadata
			const store = interoperabilityMetadata?.stores.find(
				s => s.data.$id === '/modules/interoperability/outbox',
			);

			// Calculate the inclusion proof of the CCMs
			const outboxKey = Buffer.concat([Buffer.from(store?.key as string, 'hex'), this._ownChainID]);
			const stateProveResponse = await this._sidechainAPIClient.invoke<ProveResponse>(
				'state_prove',
				{
					queries: [outboxKey],
				},
			);
			const inclusionProofOutboxRoot: OutboxRootWitness = {
				bitmap: stateProveResponse.proof.queries[0].bitmap,
				siblingHashes: stateProveResponse.proof.siblingHashes,
			};
			const crossChainMessages = await this._sidechainChainConnectorStore.getCrossChainMessages();
			crossChainMessages.push({
				ccms: ccmsFromEvents,
				height: newBlockHeader.height,
				inclusionProof: inclusionProofOutboxRoot,
			});

			await this._sidechainChainConnectorStore.setCrossChainMessages(crossChainMessages);
		}

		// Save validatorsData for a new validatorsHash
		const validatorsHashPreimages =
			await this._sidechainChainConnectorStore.getValidatorsHashPreimage();

		// Get validatorsData at new block header height
		const bftParameters = await this._sidechainAPIClient.invoke<BFTParameters>(
			'consensus_getBFTParameters',
			{ height: newBlockHeader.height },
		);
		const indexValidatorsData = validatorsHashPreimages.findIndex(v =>
			v.validatorsHash.equals(bftParameters?.validatorsHash),
		);
		// Save validatorsData if there is a new validatorsHash
		if (indexValidatorsData === -1) {
			validatorsHashPreimages.push({
				certificateThreshold: bftParameters?.certificateThreshold,
				validators: bftParameters?.validators,
				validatorsHash: bftParameters?.validatorsHash,
			});
		}

		// Save aggregateCommit if present in the block header
		const aggregateCommits = await this._sidechainChainConnectorStore.getAggregateCommits();
		if (newBlockHeader.aggregateCommit) {
			const indexAggregateCommit = aggregateCommits.findIndex(
				commit => commit.height === newBlockHeader.aggregateCommit.height,
			);
			if (indexAggregateCommit > -1) {
				aggregateCommits[indexAggregateCommit] = newBlockHeader.aggregateCommit;
			} else {
				aggregateCommits.push(newBlockHeader.aggregateCommit);
			}
		}

		// Save all the data
		await this._sidechainChainConnectorStore.setBlockHeaders(blockHeaders);
		await this._sidechainChainConnectorStore.setAggregateCommits(aggregateCommits);
		await this._sidechainChainConnectorStore.setValidatorsHashPreimage(validatorsHashPreimages);
	}

	public async _calculateCCUParams(): Promise<void> {
		const blockHeaders = await this._sidechainChainConnectorStore.getBlockHeaders();
		const aggregateCommits = await this._sidechainChainConnectorStore.getAggregateCommits();
		const validatorsHashPreimages =
			await this._sidechainChainConnectorStore.getValidatorsHashPreimage();
		const bftHeights = await this._sidechainAPIClient.invoke<BFTHeights>('consensus_getBFTHeights');
		// Calculate certificate
		const certificate = getNextCertificateFromAggregateCommits(
			blockHeaders,
			aggregateCommits,
			validatorsHashPreimages,
			bftHeights,
			this._lastCertificate,
		);
		if (!certificate) {
			throw new Error('No certificate found in the CCU creation process.');
		}
		// Calculate activeValidatorsUpdate
		let activeValidatorsUpdate: ActiveValidator[] = [];
		let certificateThreshold = BigInt(0);
		const blockHeader = blockHeaders.find(header => header.height === certificate.height);
		if (!blockHeader) {
			throw new Error('No block header found for the given certificate height.');
		}
		if (!this._lastCertificate.validatorsHash.equals(certificate.validatorsHash)) {
			const validatorsUpdateResult = calculateActiveValidatorsUpdate(
				certificate,
				validatorsHashPreimages,
				this._lastCertificate,
			);
			activeValidatorsUpdate = validatorsUpdateResult.activeValidatorsUpdate;
			certificateThreshold = validatorsUpdateResult.certificateThreshold;
		}
		// Calculate inboxUpdate
		const inboxUpdates = await this._calculateInboxUpdate(certificate);

		// Now create CCUs for all the inboxUpdates handling full or partial updates
		const serializedCertificate = codec.encode(certificateSchema, certificate);
		for (const inboxUpdate of inboxUpdates) {
			const serializedCCUParams = codec.encode(ccuParamsSchema, {
				sendingChainID: this._ownChainID,
				activeValidatorsUpdate,
				certificate: serializedCertificate,
				certificateThreshold,
				inboxUpdate
			} as CrossChainUpdateTransactionParams)
			await this._submitCCUs([serializedCCUParams]);
		}
	}

	public async unload(): Promise<void> {
		await this._mainchainAPIClient.disconnect();
		if (this._sidechainAPIClient) {
			await this._sidechainAPIClient.disconnect();
		}

		this._sidechainChainConnectorStore.close();
	}

	private async _deleteBlockHandler(data?: Record<string, unknown>) {
		const { blockHeader: receivedBlock } = data as unknown as Data;

		const newBlockHeader = chain.BlockHeader.fromJSON(receivedBlock).toObject();

		const findIndexByHeight = (someData: { height: number }[]): number =>
			someData.findIndex(datum => datum.height === newBlockHeader.height);

		const blockHeaders = await this._sidechainChainConnectorStore.getBlockHeaders();
		const blockHeaderIndex = findIndexByHeight(blockHeaders);
		if (blockHeaderIndex !== -1) {
			blockHeaders.splice(blockHeaderIndex, 1);
			await this._sidechainChainConnectorStore.setBlockHeaders(blockHeaders);
		}

		const aggregateCommits = await this._sidechainChainConnectorStore.getAggregateCommits();
		const aggregateCommitIndex = findIndexByHeight(aggregateCommits);
		if (aggregateCommitIndex !== -1) {
			aggregateCommits.splice(aggregateCommitIndex, 1);
			await this._sidechainChainConnectorStore.setAggregateCommits(aggregateCommits);
		}

		const validatorsHashPreimage =
			await this._sidechainChainConnectorStore.getValidatorsHashPreimage();
		const validatorsHashPreimageIndex = validatorsHashPreimage.findIndex(v =>
			v.validatorsHash.equals(newBlockHeader.validatorsHash),
		);
		if (validatorsHashPreimageIndex !== -1) {
			validatorsHashPreimage.splice(validatorsHashPreimageIndex, 1);
			await this._sidechainChainConnectorStore.setValidatorsHashPreimage(validatorsHashPreimage);
		}
	}

	
	private async _calculateInboxUpdate(certificate: Certificate): Promise<InboxUpdate[]> {
		const crossChainMessages = await this._sidechainChainConnectorStore.getCrossChainMessages();

		// Filter all the CCMs to be included between lastCertifiedheight and certificate height.
		const ccmsToBeIncluded = crossChainMessages.filter(
			ccmFromEvents =>
				ccmFromEvents.height <= certificate.height &&
				ccmFromEvents.height > this._lastCertificate.height,
		);
		const ccmsListOfList = this._groupCCMsBySize(ccmsToBeIncluded);
		// Take the inclusion proof of the last CCM to be included.
		const { inclusionProof } = ccmsToBeIncluded[ccmsToBeIncluded.length - 1];

		if (ccmsListOfList.length === 1) {
			const ccmHashesList = ccmsListOfList[0].map(ccm => codec.encode(ccmSchema, ccm));
			return [
				{
					crossChainMessages: ccmHashesList,
					messageWitnessHashes: [],
					outboxRootWitness: inclusionProof,
				},
			];
		}

		// Calculate list of inboxUpdates to be sent by multiple CCUs
		const inboxUpdates = [];
		for (const subList of ccmsListOfList) {
			const ccmHashesList = subList.map(ccm => codec.encode(ccmSchema, ccm));
			// Calculate message witnesses

			const merkleTree = new tree.MerkleTree({ db: this._chainConnectorPluginDB });
			for (const ccm of ccmHashesList) {
				await merkleTree.append(ccm);
			}
			const messageWitness = await merkleTree.generateRightWitness(ccmHashesList.length);

			inboxUpdates.push({
				crossChainMessages: ccmHashesList,
				messageWitnessHashes: messageWitness,
				outboxRootWitness: inclusionProof,
			});
		}

		return inboxUpdates;
	}

	/**
	 * This will return lists with sub-lists, where total size of CCMs in each sub-list will be <= CCU_TOTAL_CCM_SIZE
	 * Each sublist can contain CCMS from DIFFERENT heights
	 */
	private _groupCCMsBySize(ccmsFromEvents: CrossChainMessagesFromEvents[]): CCMsg[][] {
		const groupedCCMsBySize: CCMsg[][] = [];

		if (ccmsFromEvents.length === 0) {
			return groupedCCMsBySize;
		}

		const allCCMs: CCMsg[] = [];
		for (const filteredCCMsFromEvent of ccmsFromEvents) {
			allCCMs.push(...filteredCCMsFromEvent.ccms);
		}

		// This will group/bundle CCMs in a list where total size of the list will be <= CCU_TOTAL_CCM_SIZE
		const groupBySize = (startIndex: number): [list: CCMsg[], newIndex: number] => {
			const newList: CCMsg[] = [];
			let totalSize = 0;
			let i = startIndex;

			for (; i < allCCMs.length; i += 1) {
				const ccm = allCCMs[i];
				const ccmBytes = codec.encode(ccmSchema, ccm);
				const size = ccmBytes.length;
				totalSize += size;
				if (totalSize > CCU_TOTAL_CCM_SIZE) {
					return [newList, i];
				}

				newList.push(ccm);
			}

			return [newList, i];
		};

		const buildGroupsBySize = (startIndex: number) => {
			const [list, lastIndex] = groupBySize(startIndex);
			groupedCCMsBySize.push(list);

			if (lastIndex < allCCMs.length) {
				buildGroupsBySize(lastIndex);
			}
		};

		buildGroupsBySize(0);
		return groupedCCMsBySize;
	}

	public async validateCertificate(
		certificateBytes: Buffer,
		certificate: Certificate,
		blockHeader: BlockHeader,
		chainAccount: ChainAccount,
		sendingChainID: Buffer,
	): Promise<CertificateValidationResult> {
		const result: CertificateValidationResult = {
			status: false,
			chainStatus: chainAccount.status,
			certificate,
			blockHeader,
			message: 'Certificate validation failed.',
		};

		if (chainAccount.status === ChainStatus.TERMINATED) {
			result.message = 'Sending chain is terminated.';
			return result;
		}

		if (certificate.height <= chainAccount.lastCertificate.height) {
			result.message = 'Certificate height is higher than last certified height.';
			return result;
		}

		const certificateLivenessValidationResult = await this._verifyLiveness(
			sendingChainID,
			certificate.timestamp,
			blockHeader.timestamp,
		);

		result.livenessValidationResult = certificateLivenessValidationResult;

		if (!certificateLivenessValidationResult.status) {
			result.message = 'Liveness validation failed.';
			return result;
		}

		if (chainAccount.status === ChainStatus.ACTIVE) {
			result.status = true;

			return result;
		}

		const validatorsHashPreimage =
			await this._sidechainChainConnectorStore.getValidatorsHashPreimage();
		const validatorData = validatorsHashPreimage.find(data =>
			data.validatorsHash.equals(blockHeader.validatorsHash),
		);

		if (!validatorData) {
			result.message = 'Block validators are not valid.';

			return result;
		}

		const keysList = validatorData.validators.map(validator => validator.blsKey);

		const weights = validatorData.validators.map(validator => validator.bftWeight);

		const hasValidWeightedAggSig = cryptography.bls.verifyWeightedAggSig(
			keysList,
			certificate.aggregationBits as Buffer,
			certificate.signature as Buffer,
			MESSAGE_TAG_CERTIFICATE,
			sendingChainID,
			certificateBytes,
			weights,
			validatorData.certificateThreshold,
		);
		if (hasValidWeightedAggSig) {
			result.hasValidBLSWeightedAggSig = true;
			result.status = false;
			return result;
		}

		result.message = 'Weighted aggregate signature is not valid.';

		return result;
	}

	private async _verifyLiveness(
		chainID: Buffer,
		certificateTimestamp: number,
		blockTimestamp: number,
	): Promise<LivenessValidationResult> {
		const isLive = await this._mainchainAPIClient.invoke<boolean>('interoperability_isLive', {
			chainID,
			timestamp: certificateTimestamp,
		});

		const result: LivenessValidationResult = {
			status: true,
			isLive,
			chainID,
			certificateTimestamp,
			blockTimestamp,
		};

		if (isLive && blockTimestamp - certificateTimestamp < LIVENESS_LIMIT / 2) {
			return result;
		}

		result.status = false;

		return result;
	}

	private async _cleanup() {
		// Delete CCMs
		const crossChainMessages = await this._sidechainChainConnectorStore.getCrossChainMessages();
		const index = crossChainMessages.findIndex(ccm => ccm.height === this._lastCertificate.height);
		crossChainMessages.splice(index, 1);

		await this._sidechainChainConnectorStore.setCrossChainMessages(crossChainMessages);

		// Delete blockHeaders
		const blockHeaders = await this._sidechainChainConnectorStore.getBlockHeaders();

		await this._sidechainChainConnectorStore.setBlockHeaders(
			blockHeaders.filter(blockHeader => blockHeader.height >= this._lastCertificate.height),
		);

		// Delete aggregateCommits
		const aggregateCommits = await this._sidechainChainConnectorStore.getAggregateCommits();

		await this._sidechainChainConnectorStore.setAggregateCommits(
			aggregateCommits.filter(
				aggregateCommit => aggregateCommit.height >= this._lastCertificate.height,
			),
		);
		// Delete validatorsHashPreimages
		const validatorsHashPreimages =
			await this._sidechainChainConnectorStore.getValidatorsHashPreimage();

		await this._sidechainChainConnectorStore.setValidatorsHashPreimage(
			validatorsHashPreimages.filter(
				validatorsHashPreimage =>
					validatorsHashPreimage.certificateThreshold >= BigInt(this._lastCertificate.height),
			),
		);
	}

	private async _submitCCUs(ccuParams: Buffer[]): Promise<void> {
		// This can be changed based on mainchain/sidechain
		const activeAPIClient = this._sidechainAPIClient;
		const activePrivateKey = this._privateKey;
		const activePublicKey = ed.getPublicKeyFromPrivateKey(activePrivateKey);
		const activeTargetCommand = COMMAND_NAME_SUBMIT_SIDECHAIN_CCU;

		const { nonce } = await activeAPIClient.invoke<{ nonce: string }>('auth_getAuthAccount', {
			address: address.getLisk32AddressFromPublicKey(activePublicKey),
		});

		const { chainID: chainIDStr } = await activeAPIClient.invoke<{ chainID: string }>(
			'system_getNodeInfo',
		);
		const chainID = Buffer.from(chainIDStr, 'hex');

		for (let i = 0; i < ccuParams.length; i += 1) {
			const tx = new Transaction({
				module: MODULE_NAME_INTEROPERABILITY,
				command: activeTargetCommand,
				nonce: BigInt(nonce) + BigInt(i),
				senderPublicKey: activePublicKey,
				fee: BigInt(this.config.ccuFee),
				params: ccuParams[i],
				signatures: [],
			});
			tx.sign(chainID, activePrivateKey);
			const result = await activeAPIClient.invoke<{
				transactionId: string;
			}>('txpool_postTransaction', {
				transaction: tx.getBytes().toString('hex'),
			});
			this.logger.info({ transactionID: result.transactionId }, 'Sent CCU transaction');
		}
	}
}
