/**
 * SPIKE FIXTURE — module boundaries and re-exports.
 *
 * `barrel.ts` re-exports `deep.ts` in three ways. `crossmodule.ts` consumes the barrel.
 * The question is whether the analyser's declaration resolution survives the indirection,
 * or whether a barrel is a wall.
 */
export {receiveDirect, receiveRenamed as receiveAliased} from './deep';
export * from './deep2';
