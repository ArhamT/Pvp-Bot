'use strict';

const { boxBreakoutMethods } = require('./box_breakout');
const {
  railStallEscapeMethods,
  RAIL_BLOCK_NAMES,
  UNBREAKABLE_BLOCKS,
  isTntCartEntity
} = require('./rail_stall_escape');

/**
 * Backward-compatible re-export barrel combining `box_breakout.js` and `rail_stall_escape.js`.
 */
const hazardUnstickMethods = Object.assign({}, boxBreakoutMethods, railStallEscapeMethods);

module.exports = {
  hazardUnstickMethods,
  RAIL_BLOCK_NAMES,
  UNBREAKABLE_BLOCKS,
  isTntCartEntity
};
