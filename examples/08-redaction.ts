/**
 * Safe-by-default redaction.
 *
 * Every path adorn can emit a value through — `@Log`, contract-violation messages, observation events
 * — renders `[REDACTED]` BY DEFAULT, without reading any annotation. `setValueDisclosure('all')` turns
 * raw values back on for local debugging; a `@Sensitive` marking VETOES even that. The safe default
 * holds with zero `@Sensitive` anywhere — the annotation is defence-in-depth, never the thing that
 * makes an emission safe.
 *
 *   Run:  npx ts-node examples/08-redaction.ts
 */
import {Contract, Log, Sensitive, setValueDisclosure} from '../index';

@Contract()
class Auth {
    @Log()
    login(user: string, @Sensitive() password: string): string {
        return `session for ${user}`;
    }
}

const auth = new Auth();

console.log('=== default disclosure "none" — adorn redacts its own emissions ===');
auth.login('ada', 'hunter2'); // the @Log line shows [REDACTED] for BOTH values

console.log('\n=== setValueDisclosure("all") — raw values return, EXCEPT the @Sensitive one ===');
setValueDisclosure('all');
auth.login('ada', 'hunter2'); // `user` now shows; `password` stays [REDACTED] — the @Sensitive veto

setValueDisclosure('none'); // reset the process default

console.log('\nNote: even under "all", `password` never rendered — that veto is the only thing');
console.log('@Sensitive does on this path, and it cannot be turned off.');
