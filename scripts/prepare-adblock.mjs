import {build} from 'esbuild';import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
fs.mkdirSync(path.join(root,'electron/vendor'),{recursive:true});
await build({stdin:{contents:"export { FiltersEngine, Request } from '@ghostery/adblocker';",resolveDir:root,loader:'js'},outfile:path.join(root,'electron/vendor/adblock-engine.mjs'),bundle:true,format:'esm',platform:'node',target:'node22',minify:true,legalComments:'linked'});
fs.copyFileSync(path.join(path.dirname(require.resolve('@ghostery/adblocker/package.json')),'LICENSE'),path.join(root,'electron/vendor/adblock-LICENSE.txt'));
