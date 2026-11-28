import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {RrcDecoder} from '../web/rrc.js';
import {bytesFromHex} from '../web/core.js';
import {decodePacket} from '../web/signal.js';
import {createCards,applyCards} from '../web/signal-cards.js';
import {verdict} from '../web/sigweb/vendor.js';
import {vendorSimilarity} from '../web/sigweb/vendor-similarity.js';
import {vendorCardDisplay} from '../web/vendor-state.js';
const schema=JSON.parse(gunzipSync(readFileSync(new URL('../web/rrc-schema.json.gz',import.meta.url))));
const decoder=new RrcDecoder(schema);
const samples=JSON.parse(readFileSync(new URL('./fixtures/sigweb-vendor-profiles.json',import.meta.url))).cases;
const captured=JSON.parse(readFileSync(new URL('./fixtures/sigweb-vendor-captured.json',import.meta.url))).cases;
const plain=value=>JSON.parse(JSON.stringify(value));
function ota(sample,ts=100,pci=12){
  const nr=sample.radio==='NR',head=nr?31:21,raw=bytesFromHex(sample.payload),packet=new Uint8Array(12+head+raw.length),v=new DataView(packet.buffer),code=nr?0xb821:0xb0c0;
  v.setUint16(0,packet.length,true);v.setUint16(2,code,true);packet[12]=nr?17:27;
  v.setUint16(12+(nr?7:6),pci,true);v.setUint32(12+(nr?17:8),nr?627264:1650,true);
  packet[12+(nr?24:14)]=(nr?{DL_CCCH:3,DL_DCCH:4,BCCH_DL_SCH:2}:{BCCH_DL_SCH:3,DL_DCCH:9})[sample.channel];
  v.setUint16(12+head-2,raw.length,true);packet.set(raw,12+head);
  return {code,event:decodePacket(code,packet,decoder,ts)};
}
const sample=name=>samples.find(s=>s.name===name);
const apply=(cards,pdu)=>applyCards(cards,pdu.code,pdu.event);

test('synced modules and schemas match the recorded source manifest',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../web/sigweb/source-manifest.json',import.meta.url)));
  for(const entry of manifest.entries){
    const bytes=readFileSync(new URL('../'+entry.destination,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.installedSHA256,entry.destination);
  }
  for(const type of ['nr','bands','common'])assert.ok(Object.hasOwn(schema.roots,'REQUEST:'+type));
});

test('all tutorial and captured RRC messages preserve independent ASN.1 trees',()=>{
  for(const f of [...samples,...captured]){
    const decoded=decoder.decode(f.radio,f.channel,bytesFromHex(f.payload));
    assert.ok(decoded,f.name);assert.deepEqual(plain(decoded.tree),f.expected,f.name);
  }
});

test('P0 and downlink reference power cannot assign a NR vendor',()=>{
  for(const pusch of [-100,-80,-74,-66]){
    assert.equal(verdict({radio:'NR',broadcast:{ims:false,pusch,pucch:-100,referenceSignalPower:24,source:'NR SIB1'}}).label,'未知');
  }
});

test('decoded NR SIB1 true IMS matches Datang, stays NR-only and preserves conflicting evidence',()=>{
  const pdu=ota(sample('datang-nr-sib1-ims'));
  let cards=apply(createCards(),pdu);
  assert.equal(cards.vendor,'大唐');assert.match(cards.vendorDetail,/现场特征（用户提供）/);
  const row=vendorSimilarity(cards.vendorEvidence).rows.find(r=>r.id==='Datang');
  assert.equal(row.score,100);assert.equal(row.comparisonCount,1);
  assert.equal(apply(createCards(),ota(sample('nr-sib1-no-ims'))).vendor,'未知');
  assert.notEqual(apply(createCards(),ota(sample('lte-sib1-b39-observation'))).vendor,'大唐');
  assert.equal(verdict({radio:'LTE',broadcast:{ims:true}}).label,'未知');
  cards=apply(cards,ota(sample('zte-query-sample'),200));
  assert.equal(cards.vendorResult.status,'conflict');assert.deepEqual(cards.vendorResult.candidates,['Datang','ZTE']);
  cards=apply(cards,ota(sample('missing-dedicated'),300,13));
  cards=apply(cards,ota(sample('nr-sib1-no-ims'),400,13));
  assert.equal(cards.vendor,'未知');
});

test('NR capability requests reach the same four vendor labels as sigweb',()=>{
  for(const [name,label]of [['zte','中兴'],['huawei','华为'],['ericsson','爱立信'],['nokia','诺基亚']]){
    const pdu=ota(sample(name+'-query-sample'));
    assert.equal(pdu.event.vendorFingerprint.kind,'enquiry');
    const cards=apply(createCards(),pdu);
    assert.equal(cards.vendor,label);assert.doesNotMatch(cards.vendor,/候选/);
    assert.equal(cards.vendorResult.status,'candidate');
    assert.deepEqual(pdu.event.vendorFingerprint.requests.find(r=>r.rat==='eutra').bands.map(b=>b.band),[3,8,39,40,41]);
    assert.doesNotThrow(()=>structuredClone(cards));
  }
});

test('request decoding uses the declared inner type and rejects trailing data',()=>{
  const pdu=ota(sample('zte-query-sample'));
  const request=pdu.event.tree.message.c1.ueCapabilityEnquiry.criticalExtensions.ueCapabilityEnquiry['ue-CapabilityRAT-RequestList'][0];
  const raw=bytesFromHex(request.capabilityRequestFilter);
  assert.deepEqual(plain(decoder.decodeRequest('nr',raw)),plain(decoder.decodeRequest('eutra-nr',raw)));
  assert.equal(decoder.decodeRequest('nr',Uint8Array.from([...raw,255])),null);
  assert.equal(decoder.decodeRequest('geran-cs',raw),null);
});

test('all four LTE SIB2 lists match despite negative downlink reference power',()=>{
  for(const [name,label]of [['ericsson','爱立信'],['huawei','华为'],['nokia','诺基亚'],['zte','中兴']]){
    const cards=apply(createCards(),ota(sample('lte-sib2-'+name+'-sample')));
    assert.equal(cards.vendor,label);assert.equal(cards.vendorEvidence.broadcast.referenceSignalPower,-11);
    assert.equal(cards.txPower,null);
  }
});

test('real NR captures use supported screenshot patterns and keep reference rankings independent',()=>{
  for(const kind of ['unisoc','qualcomm']){
    const matching=captured.filter(f=>f.name.startsWith(kind));let cards=createCards();
    for(const [i,role]of ['setup','query'].entries()){
      const pdu=ota(matching.find(f=>f.name.endsWith(role)),100+i);
      assert.ok(pdu.event.tree);cards=apply(cards,pdu);
    }
    assert.equal(cards.vendor,kind==='unisoc'?'未知':'中兴');assert.equal(vendorSimilarity(cards.vendorEvidence).available,true);
    assert.equal(vendorCardDisplay(cards).label,kind==='unisoc'?'爱立信(25%)':'中兴(80%)');
    assert.equal(vendorCardDisplay(cards,'en').label,kind==='unisoc'?'Ericsson(25%)':'ZTE(80%)');
    assert.equal(cards.vendorEvidence.enquiry.requests[0].status,'decoded');
    if(kind==='unisoc')assert.match(cards.vendorDetail,/已解析下行能力查询/);
    if(kind==='unisoc'){
      assert.match(cards.vendorDetail,/codebookTypeRequest-r16: type1-SinglePanel-r16/);
      assert.match(cards.vendorDetail,/字段缺省 \/ 0 \/ 字段缺省 \/ 5 \/ 字段缺省/);
    }
    assert.deepEqual(vendorSimilarity(cards.vendorEvidence),vendorSimilarity(structuredClone(cards).vendorEvidence));
  }
});

test('new screenshots accept SRS-labelled ZTE patterns and extended Ericsson paired bands',()=>{
  for(const [name,label]of [['zte-srs-without-ul-switch','中兴'],['zte-fdd-srs-sample','中兴'],['ericsson-extended-mfbi-sample','爱立信'],['huawei-query-sample','华为'],['unrelated-srs-only','未知'],['zte-fdd-bands-only','未知'],['ericsson-incomplete-mfbi','未知']]){
    assert.equal(apply(createCards(),ota(sample(name))).vendor,label,name);
  }
});

test('same-cell releases retain a match after worker cloning, actual cell changes clear it',()=>{
  let cards=apply(createCards(),ota(sample('zte-query-sample')));
  cards=structuredClone(cards);
  const release={diag_valid:true,decodeEvidence:'ASN1_SCHEMA',radio:'NR',channel:'DL_DCCH',ts:200,
    cell:{pci:12,arfcn:627264},m:{kind:'rrc'},tree:{message:{c1:{rrcRelease:{criticalExtensions:{rrcRelease:{}}}}}}};
  cards=applyCards(cards,0xb821,release);
  assert.equal(cards.vendor,'中兴');assert.equal(cards.vendorResult.retained,true);
  assert.match(vendorCardDisplay(cards).label,/^中兴\(\d+%\)$/);
  assert.equal(cards.vendorState.enquiry,undefined);
  cards=apply(cards,ota(sample('missing-dedicated'),300,13));
  assert.equal(cards.vendor,'未知');assert.equal(cards.vendorLastMatch.evidence.cell.pci,13);
  assert.equal(cards.vendorResult.retained,undefined,'a new-cell reference must use that cell evidence');
});

test('conflicts, malformed filters, stale cells and neighbor broadcasts retain their boundaries',()=>{
  let cards=apply(createCards(),ota(sample('huawei-dedicated-sample'),100));
  cards=apply(cards,ota(sample('zte-query-sample'),200));
  assert.equal(cards.vendorResult.status,'conflict');assert.equal(cards.vendorLastMatch,null);
  cards=apply(cards,ota(sample('missing-dedicated'),300));assert.equal(cards.vendor,'未知');
  const stale=apply(cards,ota(sample('huawei-query-sample'),100,99));assert.equal(stale,cards);
  assert.equal(ota(sample('invalid-inner-filter')).event.vendorFingerprint.requests[0].status,'invalid');
  const lte=apply(createCards(),ota(sample('lte-sib2-huawei-sample'),400,12));
  assert.equal(apply(lte,ota(sample('lte-sib2-zte-sample'),500,13)),lte);
});

test('worker clones retain bounded cell history and restore only a revisited known tuple',()=>{
  let c=apply(createCards(),ota(sample('zte-query-sample'),100,12));
  c=apply(structuredClone(c),ota(sample('missing-dedicated'),200,13));
  assert.equal(c.vendor,'未知');
  c=apply(structuredClone(c),ota(sample('huawei-query-sample'),300,13));
  assert.equal(c.vendor,'华为');
  c=apply(structuredClone(c),ota(sample('missing-dedicated'),400,12));
  assert.equal(c.vendor,'中兴');assert.equal(c.vendorResult.restored,true);
  assert.equal(c.vendorState.enquiry,undefined);
  assert.ok(c.vendorHistory.length<=32);
});

test('captured reference-only labels survive release and setup through worker clones',()=>{
  for(const [kind,roles,label]of [['unisoc',['setup','query'],'爱立信(25%)'],['qualcomm',['setup'],'中兴(60%)']]){
    let c=createCards();
    for(const [index,role]of roles.entries())c=apply(c,ota(captured.find(f=>f.name.startsWith(kind)&&f.name.endsWith(role)),100+index));
    assert.equal(c.vendorResult.status,'unknown');assert.equal(vendorCardDisplay(c).label,label);
    for(const [index,name]of ['rrcRelease','rrcSetup'].entries()){
      c=applyCards(structuredClone(c),0xb821,{diag_valid:true,decodeEvidence:'ASN1_SCHEMA',radio:'NR',
        channel:name==='rrcSetup'?'DL_CCCH':'DL_DCCH',ts:200+index,cell:{pci:12,arfcn:627264},m:{kind:'rrc'},
        tree:{message:{c1:{[name]:{criticalExtensions:{[name]:{}}}}}}});
      assert.equal(vendorCardDisplay(c).label,label);assert.equal(c.vendorResult.status,'unknown');
      assert.equal(c.vendorResult.retained,true);assert.equal(c.vendorState.enquiry,undefined);
    }
  }
});

test('reference history restores only its cell and binds later identity metadata',()=>{
  let c=apply(createCards(),ota(captured.find(f=>f.name==='qualcomm-nr-pci393-setup')));
  c=applyCards(structuredClone(c),0xb821,{diag_valid:true,radio:'NR',ts:200,cell:{pci:13,arfcn:627264},m:{kind:'rrc'}});
  assert.equal(vendorCardDisplay(c).label,'未知');
  c=applyCards(structuredClone(c),0xb821,{diag_valid:true,radio:'NR',ts:300,cell:{pci:12,arfcn:627264},m:{kind:'rrc'}});
  assert.equal(vendorCardDisplay(c).label,'中兴(60%)');assert.equal(c.vendorState.enquiry,undefined);
  c=applyCards(c,0xb821,{diag_valid:true,radio:'NR',ts:400,cell:{pci:12,arfcn:627264},cellIdentity:'123',m:{kind:'rrc'}});
  c=applyCards(c,0xb821,{diag_valid:true,radio:'NR',ts:500,cell:{pci:12,arfcn:627264},cellIdentity:'456',m:{kind:'rrc'}});
  assert.equal(vendorCardDisplay(c).label,'未知');
});
