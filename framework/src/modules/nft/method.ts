/*
 * Copyright © 2023 Lisk Foundation
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
import { BaseMethod } from '../base_method';
import { InteroperabilityMethod, ModuleConfig } from './types';
import { NFTStore } from './stores/nft';
import { ImmutableMethodContext, MethodContext } from '../../state_machine';
import {
	ALL_SUPPORTED_NFTS_KEY,
	LENGTH_CHAIN_ID,
	LENGTH_COLLECTION_ID,
	LENGTH_NFT_ID,
	NFT_NOT_LOCKED,
	NftEventResult,
} from './constants';
import { UserStore } from './stores/user';
import { DestroyEvent } from './events/destroy';
import { SupportedNFTsStore } from './stores/supported_nfts';

export class NFTMethod extends BaseMethod {
	private _config!: ModuleConfig;
	// @ts-expect-error TODO: unused error. Remove when implementing.
	private _interoperabilityMethod!: InteroperabilityMethod;

	public init(config: ModuleConfig): void {
		this._config = config;
	}

	public addDependencies(interoperabilityMethod: InteroperabilityMethod) {
		this._interoperabilityMethod = interoperabilityMethod;
	}

	public getChainID(nftID: Buffer): Buffer {
		if (nftID.length !== LENGTH_NFT_ID) {
			throw new Error(`NFT ID must have length ${LENGTH_NFT_ID}`);
		}

		return nftID.slice(0, LENGTH_CHAIN_ID);
	}

	public async getNFTOwner(methodContext: ImmutableMethodContext, nftID: Buffer): Promise<Buffer> {
		const nftStore = this.stores.get(NFTStore);

		const nftExists = await nftStore.has(methodContext, nftID);

		if (!nftExists) {
			throw new Error('NFT substore entry does not exist');
		}

		const data = await nftStore.get(methodContext, nftID);

		return data.owner;
	}

	public async getLockingModule(
		methodContext: ImmutableMethodContext,
		nftID: Buffer,
	): Promise<string> {
		const owner = await this.getNFTOwner(methodContext, nftID);

		if (owner.length === LENGTH_CHAIN_ID) {
			throw new Error('NFT is escrowed to another chain');
		}

		const userStore = this.stores.get(UserStore);
		const userData = await userStore.get(methodContext, userStore.getKey(owner, nftID));

		return userData.lockingModule;
	}

	public async destroy(
		methodContext: MethodContext,
		address: Buffer,
		nftID: Buffer,
	): Promise<void> {
		const nftStore = this.stores.get(NFTStore);

		const nftExists = await nftStore.has(methodContext, nftID);

		if (!nftExists) {
			this.events.get(DestroyEvent).log(
				methodContext,
				{
					address,
					nftID,
				},
				NftEventResult.RESULT_NFT_DOES_NOT_EXIST,
			);

			throw new Error('NFT substore entry does not exist');
		}

		const owner = await this.getNFTOwner(methodContext, nftID);

		if (owner.length === LENGTH_CHAIN_ID) {
			this.events.get(DestroyEvent).log(
				methodContext,
				{
					address,
					nftID,
				},
				NftEventResult.RESULT_NFT_ESCROWED,
			);

			throw new Error('NFT is escrowed to another chain');
		}

		if (!owner.equals(address)) {
			this.events.get(DestroyEvent).log(
				methodContext,
				{
					address,
					nftID,
				},
				NftEventResult.RESULT_INITIATED_BY_NONOWNER,
			);

			throw new Error('Not initiated by the NFT owner');
		}

		const userStore = this.stores.get(UserStore);
		const userKey = userStore.getKey(owner, nftID);
		const { lockingModule } = await userStore.get(methodContext, userKey);

		if (lockingModule !== NFT_NOT_LOCKED) {
			this.events.get(DestroyEvent).log(
				methodContext,
				{
					address,
					nftID,
				},
				NftEventResult.RESULT_NFT_LOCKED,
			);

			throw new Error('Locked NFTs cannot be destroyed');
		}

		await nftStore.del(methodContext, nftID);

		await userStore.del(methodContext, userKey);

		this.events.get(DestroyEvent).log(methodContext, {
			address,
			nftID,
		});
	}

	public async getCollectionID(methodContext: MethodContext, nftID: Buffer): Promise<Buffer> {
		const nftStore = this.stores.get(NFTStore);
		const nftExists = await nftStore.has(methodContext, nftID);
		if (!nftExists) {
			throw new Error('NFT substore entry does not exist');
		}
		return nftID.slice(LENGTH_CHAIN_ID, LENGTH_CHAIN_ID + LENGTH_COLLECTION_ID);
	}

	public async isNFTSupported(methodContext: MethodContext, nftID: Buffer): Promise<boolean> {
		const nftStore = this.stores.get(NFTStore);
		const nftExists = await nftStore.has(methodContext, nftID);
		if (!nftExists) {
			throw new Error('NFT substore entry does not exist');
		}

		const nftChainID = this.getChainID(nftID);
		if (nftChainID.equals(this._config.ownChainID)) {
			return true;
		}

		const supportedNFTsStore = this.stores.get(SupportedNFTsStore);
		const supportForAllKeysExists = await supportedNFTsStore.has(
			methodContext,
			ALL_SUPPORTED_NFTS_KEY,
		);
		if (supportForAllKeysExists) {
			return true;
		}

		const supportForNftChainIdExists = await supportedNFTsStore.has(methodContext, nftChainID);
		if (supportForNftChainIdExists) {
			const supportedNFTsStoreData = await supportedNFTsStore.get(methodContext, nftChainID);
			if (supportedNFTsStoreData.supportedCollectionIDArray.length === 0) {
				return true;
			}
			const collectionID = await this.getCollectionID(methodContext, nftID);
			if (
				supportedNFTsStoreData.supportedCollectionIDArray.some(id =>
					collectionID.equals(id.collectionID),
				)
			) {
				return true;
			}
		}

		return false;
	}
}
