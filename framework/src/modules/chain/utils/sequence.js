/*
 * Copyright © 2018 Lisk Foundation
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

'use strict';

const util = require('util');

/**
 * Creates a FIFO sequence array and default settings with config values.
 * Calls __tick with 3
 *
 * @class
 * @memberof utils
 * @requires util
 * @param {string} config
 * @see Parent: {@link utils}
 * @todo Add description for the params
 */
class Sequence {
	constructor(config) {
		let _default = {
			onWarning: null,
			warningLimit: 50,
		};
		_default = Object.assign(_default, config);
		const self = this;
		this.sequence = [];

		setImmediate(function nextSequenceTick() {
			if (_default.onWarning && self.sequence.length >= _default.warningLimit) {
				_default.onWarning(self.sequence.length, _default.warningLimit);
			}
			self.__tick(() => {
				setTimeout(nextSequenceTick, 3);
			});
		});
	}

	/**
	 * Removes the first task from sequence and execute it with args.
	 *
	 * @param {function} cb
	 * @returns {setImmediateCallback} With cb or task.done
	 * @todo Add description for the params
	 */
	__tick(cb) {
		const task = this.sequence.shift();
		if (!task) {
			return setImmediate(cb);
		}
		let args = [
			function(err, res) {
				if (task.done) {
					setImmediate(task.done, err, res);
				}
				setImmediate(cb);
			},
		];
		if (task.args) {
			args = args.concat(task.args);
		}
		return task.worker.apply(task.worker, args);
	}

	/**
	 * Adds a new task to sequence.
	 *
	 * @param {function} worker
	 * @param {Array} args
	 * @param {function} done
	 * @todo Add description for the params
	 */
	add(worker, args, done) {
		if (!done && args && typeof args === 'function') {
			done = args;
			args = undefined;
		}
		if (worker && typeof worker === 'function') {
			const task = { worker, done };
			if (util.isArray(args)) {
				task.args = args;
			}
			this.sequence.push(task);
		}
	}

	/**
	 * Gets pending task in sequence.
	 *
	 * @returns {number} Sequence length
	 */
	count() {
		return this.sequence.length;
	}
}

module.exports = Sequence;