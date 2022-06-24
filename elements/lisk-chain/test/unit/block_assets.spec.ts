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
import { getRandomBytes, intToBuffer } from '@liskhq/lisk-cryptography';
import { MerkleTree } from '@liskhq/lisk-tree';
import { BlockAsset, BlockAssets } from '../../src';
import { MAX_ASSET_DATA_SIZE_BYTES } from '../../src/constants';

describe('block assets', () => {
	let assets: BlockAssets;
	let assetList: BlockAsset[];

	beforeEach(() => {
		assetList = [
			{
				moduleID: intToBuffer(6, 4),
				data: getRandomBytes(64),
			},
			{
				moduleID: intToBuffer(3, 4),
				data: getRandomBytes(64),
			},
		];
		assets = new BlockAssets(assetList);
	});

	describe('sort', () => {
		it('should sort the assets in ascending order by module ID', () => {
			assets.sort();
			expect(assets['_assets'][0].moduleID.readInt32BE(0)).toEqual(3);
		});
	});

	describe('getAsset', () => {
		it('it should return undefined if no matching asset exists ', () => {
			expect(assets.getAsset(intToBuffer(5, 4))).toBeUndefined();
		});

		it('it should return asset data if matching asset exists ', () => {
			expect(assets.getAsset(intToBuffer(3, 4))).toBeInstanceOf(Buffer);
		});
	});

	describe('setAsset', () => {
		it('it should not overwrite existing asset', () => {
			const data = getRandomBytes(32);
			expect(() => assets.setAsset(intToBuffer(3, 4), data)).toThrow();
		});

		it('it should add asset data if matching asset does not exist ', () => {
			const data = getRandomBytes(32);
			assets.setAsset(intToBuffer(4, 4), data);
			expect(assets['_assets']).toHaveLength(3);
		});
	});

	describe('fromJSON', () => {
		it('should create BlockAssets from JSON format', () => {
			assets = BlockAssets.fromJSON([
				{
					moduleID: '4',
					data: getRandomBytes(30).toString('hex'),
				},
			]);
			expect(assets['_assets']).toHaveLength(1);
			expect(assets.getAsset(intToBuffer(4, 4))).toBeInstanceOf(Buffer);
		});
	});

	describe('getRoot', () => {
		it('should calculate and return asset root', async () => {
			const root = await assets.getRoot();
			const merkleT = new MerkleTree();
			await merkleT.init(assets.getBytes());
			await expect(assets.getRoot()).resolves.toEqual(root);
		});
	});

	describe('getAllAsset', () => {
		it('should return list of all assets', () => {
			expect(assets.getAll()).toContainAllValues(assetList);
		});
	});

	describe('validate', () => {
		describe('when block asset schema is invalid', () => {
			it(`should throw error when data type is incorrect`, () => {
				assetList = [
					{
						moduleID: intToBuffer(3, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(4, 4),
						data: getRandomBytes(128),
					},
				];
				assets = new BlockAssets(assetList);
				assets['_assets'][0] = '3' as any;

				expect(() => assets.validate()).toThrow();
			});
		});

		describe('when an asset data has size more than the limit', () => {
			it(`should throw error when asset data length is greater than ${MAX_ASSET_DATA_SIZE_BYTES}`, () => {
				assetList = [
					{
						moduleID: intToBuffer(3, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(4, 4),
						data: getRandomBytes(128),
					},
				];
				assets = new BlockAssets(assetList);
				expect(() => assets.validate()).toThrow(
					`Module with ID ${assetList[1].moduleID.readInt32BE(
						0,
					)} has data size more than ${MAX_ASSET_DATA_SIZE_BYTES} bytes.`,
				);
			});

			it(`should pass when asset data length is equal or less than ${MAX_ASSET_DATA_SIZE_BYTES}`, () => {
				assetList = [
					{
						moduleID: intToBuffer(3, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(4, 4),
						data: getRandomBytes(64),
					},
				];
				assets = new BlockAssets(assetList);
				expect(assets.validate()).toBeUndefined();
			});
		});

		describe('when the assets are not sorted by moduleID', () => {
			it('should throw error when assets are not sorted by moduleID', () => {
				assetList = [
					{
						moduleID: intToBuffer(4, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(3, 4),
						data: getRandomBytes(64),
					},
				];
				assets = new BlockAssets(assetList);
				expect(() => assets.validate()).toThrow(
					'Assets are not sorted in the increasing values of moduleID.',
				);
			});

			it('should pass when assets are sorted by moduleID', () => {
				assetList = [
					{
						moduleID: intToBuffer(2, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(3, 4),
						data: getRandomBytes(64),
					},
				];
				assets = new BlockAssets(assetList);
				expect(assets.validate()).toBeUndefined();
			});
		});

		describe('when there are multiple asset entries for a moduleID', () => {
			it('should throw error when there are more than 1 assets for a module', () => {
				assetList = [
					{
						moduleID: intToBuffer(2, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(3, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(3, 4),
						data: getRandomBytes(64),
					},
				];
				assets = new BlockAssets(assetList);
				expect(() => assets.validate()).toThrow(
					`Module with ID ${assetList[1].moduleID.readInt32BE(0)} has duplicate entries.`,
				);
			});

			it('should pass when there is atmost 1 asset for a module', () => {
				assetList = [
					{
						moduleID: intToBuffer(2, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(3, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(4, 4),
						data: getRandomBytes(64),
					},
				];
				assets = new BlockAssets(assetList);
				expect(assets.validate()).toBeUndefined();
			});
		});
	});

	describe('validateGenesis', () => {
		describe('when block asset schema is invalid', () => {
			it(`should throw error when data type is incorrect`, () => {
				assetList = [
					{
						moduleID: intToBuffer(3, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(4, 4),
						data: getRandomBytes(128),
					},
				];
				assets = new BlockAssets(assetList);
				assets['_assets'][0] = '3' as any;
				expect(() => assets.validateGenesis()).toThrow();
			});
		});

		describe('when an asset data has size more than the limit', () => {
			it(`should pass when asset data length is greater than ${MAX_ASSET_DATA_SIZE_BYTES}`, () => {
				assetList = [
					{
						moduleID: intToBuffer(3, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(4, 4),
						data: getRandomBytes(128),
					},
				];
				assets = new BlockAssets(assetList);
				expect(assets.validateGenesis()).toBeUndefined();
			});

			it(`should pass when asset data length is equal or less than ${MAX_ASSET_DATA_SIZE_BYTES}`, () => {
				assetList = [
					{
						moduleID: intToBuffer(3, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(4, 4),
						data: getRandomBytes(64),
					},
				];
				assets = new BlockAssets(assetList);
				expect(assets.validateGenesis()).toBeUndefined();
			});
		});

		describe('when the assets are not sorted by moduleID', () => {
			it('should throw error when assets are not sorted by moduleID', () => {
				assetList = [
					{
						moduleID: intToBuffer(4, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(3, 4),
						data: getRandomBytes(64),
					},
				];
				assets = new BlockAssets(assetList);
				expect(() => assets.validateGenesis()).toThrow(
					'Assets are not sorted in the increasing values of moduleID.',
				);
			});

			it('should pass when assets are sorted by moduleID', () => {
				assetList = [
					{
						moduleID: intToBuffer(2, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(3, 4),
						data: getRandomBytes(64),
					},
				];
				assets = new BlockAssets(assetList);
				expect(assets.validateGenesis()).toBeUndefined();
			});
		});

		describe('when there are multiple asset entries for a moduleID', () => {
			it('should throw error when there are more than 1 assets for a module', () => {
				assetList = [
					{
						moduleID: intToBuffer(2, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(3, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(3, 4),
						data: getRandomBytes(64),
					},
				];
				assets = new BlockAssets(assetList);
				expect(() => assets.validateGenesis()).toThrow(
					`Module with ID ${assetList[1].moduleID.readInt32BE(0)} has duplicate entries.`,
				);
			});

			it('should pass when there is atmost 1 asset for a module', () => {
				assetList = [
					{
						moduleID: intToBuffer(2, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(3, 4),
						data: getRandomBytes(64),
					},
					{
						moduleID: intToBuffer(4, 4),
						data: getRandomBytes(64),
					},
				];
				assets = new BlockAssets(assetList);
				expect(assets.validateGenesis()).toBeUndefined();
			});
		});
	});
});
