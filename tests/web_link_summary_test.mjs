import test from 'node:test';
import assert from 'node:assert/strict';
import {createCards,applyCards,linkRows} from '../web/signal-cards.js';
import {linkSummary} from '../web/link-summary.js';
import {vendorCardDisplay,updateVendorCard} from '../web/vendor-state.js';
import {readFileSync} from 'node:fs';
import {bytesFromHex} from '../web/core.js';
import {decodePacket} from '../web/signal.js';
import {formatDistance,taDistanceLabel} from '../web/sigweb/distance-label.js';

test('BLER and MCS keep explicit directions; grant counts cannot supply BLER',()=>{
  const c=createCards({radio:'NR',bler:'0.00%',mcs:'0',ulMcs:'12',linkParams:{'上行重传占比':'12%','UL grants（本包）':15000}});
  assert.deepEqual(linkSummary(c),{bler:'DL 0.00% / UL 重传12%',uplink:'UL 重传12%',mcs:'MCS ↓0 ↑12'});
  assert.deepEqual(linkSummary(createCards()),{bler:'DL — / UL 未上报',uplink:'UL 未上报',mcs:'MCS ↓— ↑—'});
  assert.match(new Map(linkRows(c)).get('上行 BLER'),/未直接上报/);
  assert.equal(new Map(linkRows(c)).get('上行 MCS'),'12');
});
test('real B881 cumulative counters reach the UL card without being relabelled BLER',()=>{
  const {records}=JSON.parse(readFileSync(new URL('./fixtures/uplink-tb-counts.json',import.meta.url)));
  let c=createCards({radio:'NR',bler:'8.68%',mcs:'22',ulMcs:'14'});
  records.forEach((record,index)=>{
    const event=decodePacket(record.code,bytesFromHex(record.packet),null,index+1);
    assert.equal(event.m.kind,'ulTb');c=applyCards(c,record.code,event);
    assert.equal(c.linkParams['上行新传 TB'],record.newTb);
    assert.equal(c.linkParams['上行重传 TB'],record.retransmitTb);
    assert.equal(linkSummary(c).uplink,`UL 重传${Number(record.retransmitPercent.toFixed(1))}%`);
    assert.equal(c.bler,'8.68%');
  });
  const idle=applyCards(c,0xb881,{diag_valid:true,ts:3,m:{kind:'ulTb',value:{newTb:0,retransmitTb:0,retransmitPercent:null}}});
  assert.equal(linkSummary(idle).uplink,'UL 重传待统计');
});
test('distance buttons share meter and kilometer formatting with sigweb',()=>{
  assert.equal(taDistanceLabel(1132.0288),'TA · 1.13 千米');
  assert.equal(taDistanceLabel(897.81595),'TA · 897.8 米');
  assert.equal(formatDistance(0),'0 米');assert.equal(taDistanceLabel(null),'TA 距离');
});
test('a non-grant NR report clears old UL MCS and RB values without changing DL',()=>{
  const event=values=>({diag_valid:true,ts:1,m:{kind:'ulSchedule',value:values}});
  let c=createCards({radio:'NR',bler:'2.00%',mcs:'18'});
  c=applyCards(c,0xb883,event([{grant:{mcs:12,rb:24,rbStart:0}}]));
  assert.equal(c.ulMcs,'12');assert.equal(c.mcs,'18');assert.equal(c.bler,'2.00%');
  c=applyCards(c,0xb883,event([{grant:null}]));
  assert.equal(c.ulMcs,null);assert.equal(c.linkParams['UL MCS'],null);assert.equal(c.linkParams['UL RB'],null);
  assert.equal(linkSummary(c).mcs,'MCS ↓18 ↑—');
});
test('real B883 packets reach UL MCS through the packet decoder and clear on non-grant reports',()=>{
  const {records}=JSON.parse(readFileSync(new URL('./fixtures/signal-link-grants.json',import.meta.url)));
  let c=createCards({radio:'NR',mcs:'18',bler:'0.00%'});
  records.forEach((record,index)=>{
    const event=decodePacket(record.code,bytesFromHex(record.packet),null,index+1);
    assert.equal(event.diag_valid,true);assert.equal(event.m.kind,'ulSchedule');
    c=applyCards(c,record.code,event);
    assert.equal(c.ulMcs,record.expected.at(-1)?.mcs?.toString()??null);
    assert.equal(c.mcs,'18');assert.equal(c.bler,'0.00%');
  });
  assert.equal(c.ulMcs,null);
});
test('serving cell changes discard old readings while partial metadata preserves them',()=>{
  const base=createCards({radio:'NR',cell:{pci:393,arfcn:627264,band:'n78',freq:3408.96},vendorCell:'NR:627264:393',
    bler:'2.00%',mcs:'18',ulMcs:'12'});
  const partial=applyCards(base,0xb821,{diag_valid:true,ts:2,radio:'NR',cell:{pci:393,arfcn:null,band:'NR'}});
  assert.equal(partial.ulMcs,'12');assert.equal(partial.cell.arfcn,627264);assert.equal(partial.cell.band,'n78');
  const changed=applyCards(partial,0xb821,{diag_valid:true,ts:3,radio:'NR',cell:{pci:394,arfcn:627264,band:'n78'}});
  assert.equal(changed.ulMcs,null);assert.equal(changed.bler,null);assert.equal(changed.mcs,null);
});
test('same PCI but changed full identity clears both vendor reference and link readings',()=>{
  const old=createCards({radio:'NR',cell:{pci:393,arfcn:627264},bler:'2.00%',mcs:'18',ulMcs:'12',
    vendorState:{radio:'NR',cell:{pci:393,arfcn:627264,identity:'1'},lastAt:1},vendorEvidence:{radio:'NR',cell:{identity:'1'}}});
  const c=updateVendorCard(old,{ts:2,cellIdentity:'2'});
  assert.equal(c.ulMcs,null);assert.equal(c.bler,null);assert.equal(c.mcs,null);
  assert.equal(vendorCardDisplay(c).label,'未知');
});
test('zero or absent reference scores do not invent a vendor; positive ranking leaves rules intact',()=>{
  const zero=createCards({vendor:'未知',vendorEvidence:{radio:'LTE',broadcast:{deltaF:['deltaF-2','deltaF5','deltaF-2','deltaF-2','deltaF-2']}}});
  assert.equal(vendorCardDisplay(zero).label,'未知');assert.equal(vendorCardDisplay(zero).reference,false);
  const c=createCards({vendor:'未知',vendorEvidence:{radio:'NR',dedicated:{status:'decoded',source:'NR rrcSetup primary UL BWP',deltaF:[0,-3,6,0,0]}}});
  assert.equal(vendorCardDisplay(c).label,'中兴(60%)');assert.equal(c.vendor,'未知');
});
