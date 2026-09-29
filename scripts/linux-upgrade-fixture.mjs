import fs from 'node:fs';
import path from 'node:path';
// Produces only a synthetic tree; package installation belongs to ephemeral CI.
export function createLegacyBosFixture(root) {
 const controlRoot=path.join(root,'DEBIAN');
 const appRoot=path.join(root,'opt','BOS Bot');
 const resources=path.join(appRoot,'resources');
 fs.mkdirSync(controlRoot,{recursive:true,mode:0o755});
 fs.mkdirSync(resources,{recursive:true,mode:0o775});
 fs.chmodSync(appRoot,0o775);
 fs.chmodSync(resources,0o775);
 fs.writeFileSync(path.join(controlRoot,'control'),['Package: bos-bot','Version: 0.1.7','Architecture: amd64','Maintainer: BOS CI <ci@bos.invalid>','Description: BOS directory-mode upgrade fixture',''].join('\n'),{mode:0o644});
 fs.writeFileSync(path.join(resources,'legacy-upgrade-fixture'),'0.1.7\n',{mode:0o644});
 return {appRoot,resources,controlRoot};
}
