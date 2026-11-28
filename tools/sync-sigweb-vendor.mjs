// Explicit maintenance command; builds never require the sigweb checkout.
// Usage: node tools/sync-sigweb-vendor.mjs D:/ufi-no-zte/sigweb-uni
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const repo=fileURLToPath(new URL('../',import.meta.url));
if(!process.argv[2])throw Error('Provide the local sigweb-uni checkout path');
const source=resolve(process.argv[2]),sha=b=>createHash('sha256').update(b).digest('hex');
const entries=[];
async function copy(from,to,transform=b=>b){
  const original=await readFile(resolve(source,from)),content=transform(original);
  const destination=resolve(repo,to);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,content);
  entries.push({source:from,destination:to,sourceSHA256:sha(original),installedSHA256:sha(content)});
}
await copy('web/src/vendor.js','web/sigweb/vendor.js',b=>{
  let text=b.toString();
  const replacements=[
    ["from './rrc-uper.js'","from '../rrc.js'"],
    ["import {fromHex} from './framing.js';","import {bytesFromHex as fromHex} from '../core.js';"],
  ];
  for(const [before,after]of replacements){if(!text.includes(before))throw Error('Unexpected upstream import: '+before);text=text.replace(before,after);}
  return Buffer.from(text);
});
await copy('web/src/vendor-similarity.js','web/sigweb/vendor-similarity.js');
await copy('web/src/vendor-display.js','web/sigweb/vendor-display.js');
await copy('web/src/distance-label.js','web/sigweb/distance-label.js');
await copy('web/src/rrc-scope.js','web/sigweb/rrc-scope.js');
await copy('web/sigspec/rrc-schema.json','web/rrc-schema.json.gz',b=>gzipSync(b,{level:9,mtime:0}));
await copy('web/sigspec/RRC_SCHEMA_NOTICE.txt','web/licenses/RRC_SCHEMA_NOTICE.txt');
await copy('web/sigspec/RRC_SCHEMA_LICENSE.txt','web/licenses/RRC_SCHEMA_LICENSE.txt');
await copy('tests/fixtures/vendor-profiles.json','tests/fixtures/sigweb-vendor-profiles.json');
await copy('tests/fixtures/vendor-captured-requests.json','tests/fixtures/sigweb-vendor-captured.json');
await writeFile(resolve(repo,'web/sigweb/source-manifest.json'),JSON.stringify({
  component:'sigweb-uni vendor matching and reference similarity',
  adaptation:'Only vendor.js import paths are adapted; protocol decoding uses the local RrcDecoder REQUEST roots.',
  entries,
},null,2)+'\n');
console.log('Synced '+entries.length+' resources; no runtime or build dependency on the source checkout.');
