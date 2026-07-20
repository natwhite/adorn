/**
 * SPIKE FIXTURE — a sensitive field crossing a module boundary through a barrel.
 *
 * All three calls are single-hop from a `@Sensitive` field. If the analyser resolves through
 * the barrel it reports three findings in `deep.ts` / `deep2.ts`; if a barrel is a wall it
 * reports none, silently.
 */
import {Sensitive} from './marker';
import {receiveDirect, receiveAliased, receiveStarExported} from './barrel';

export class Patient {
    @Sensitive() mrn: string = '';
}

export function dispatch(p: Patient): void {
    receiveDirect(p.mrn);
    receiveAliased(p.mrn);
    receiveStarExported(p.mrn);
}
