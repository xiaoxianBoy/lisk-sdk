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
 *
 */

import * as glob from 'glob';
import { join } from 'path';
import * as fs from 'fs';
import * as yml from 'js-yaml';

export const EMPTY_BUFFER = Buffer.alloc(0);

export const getAllFiles = (
	dirs: string[],
	ignore?: RegExp,
): { path: string; toString: () => string }[] => {
	return dirs
		.map((dir: string) => {
			return glob
				.sync(join(__dirname, dir, '**/*.{yaml,yml}'))
				.filter(path => (ignore ? !ignore.test(path) : true))
				.map(path => ({ path, toString: () => `${dir}${path.split(dir)[1]}` }));
		})
		.flat();
};

export const loadSpecFile = <T = Record<string, unknown>>(filePath: string) =>
	(yml.load(fs.readFileSync(filePath, 'utf8')) as unknown) as T;

export const hexToBuffer = (str: string | null): Buffer =>
	str ? Buffer.from(str.substr(2), 'hex') : EMPTY_BUFFER;