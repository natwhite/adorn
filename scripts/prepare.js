// `prepare` lifecycle: build `dist/` ONLY when it is missing.
//
// Why guarded (axiform feedback §10 — a regression of §8's bare `prepare: npm run build`): npm runs a
// dependency's `prepare` during the CONSUMER's install. For a `file:`/link consumer, Arborist first retires
// the linked package's own `node_modules` dev tree (typescript, @types/node, …), THEN runs `prepare`; an
// unconditional `tsc` then fails with TS2688 ("Cannot find type definition file for 'node'") and the whole
// install rolls back. A `file:` consumer already has a locally-built `dist/`, so there is nothing to build.
//
// A fresh GIT dependency, by contrast, has NO `dist/` (it is gitignored), and npm DOES install its devDeps
// before `prepare` — so the build runs and succeeds there, which is the case §8 added `prepare` for. Guarding
// on `dist/index.js` keeps that benefit while making the script a no-op for `file:`/link and already-built
// local trees. (A build failure still propagates — this only skips an UNNECESSARY build.)
const fs = require('fs');
const {execSync} = require('child_process');

if (fs.existsSync('dist/index.js')) {
    process.stdout.write('adorn prepare: dist/ already present — skipping build.\n');
} else {
    execSync('npm run build', {stdio: 'inherit'});
}
