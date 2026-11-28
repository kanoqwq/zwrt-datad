// Network configuration profiles, never a signalled manufacturer identity.
// Sample provenance: docs/base-station-vendor-identification.md.
import {decodeCapabilityRequest} from '../rrc.js';
import {currentRrcTree,currentRrcIes} from './rrc-scope.js';
import {bytesFromHex as fromHex} from '../core.js';
import {vendorSimilarity} from './vendor-similarity.js';

const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const num=v=>Number.isFinite(v)?v:null;
const power=v=>Number.isInteger(v)&&v>=-60&&v<=50?v:null;
const flag=v=>v===true||v==='true'||v==='supported';
const FORMATS=['Format1','Format1b','Format2','Format2a','Format2b'];
const ENUM_VALUES=[[-2,0,2],[1,3,5],[-2,0,1,2],[-2,0,2],[-2,0,2]];
const NAMES={Huawei:['华为','Huawei'],ZTE:['中兴','ZTE'],Ericsson:['爱立信','Ericsson'],Nokia:['诺基亚','Nokia'],Datang:['大唐','Datang']};
const PROFILE_ZH={
  'SUL + per-band carrier request limits':'SUL 与分频段载波数量限制样例',
  'n28/n41/n79 + SRS request sample':'n28/n41/n79 与 SRS 请求样例（用户图 1）',
  'n1/n5/n8/n26/n28/n78 + SRS request sample':'n1/n5/n8/n26/n28/n78 与 SRS 请求样例（用户图 2）',
  'paired n14/n28 and n41/n90 request sample':'n14/n28、n41/n90 成组查询样例（用户图 3）',
  'n1/n5/n26/n65/n66/n77/n78 request sample':'n1/n5/n26/n65/n66/n77/n78 查询样例',
  'dedicated PUCCH f2=1 / f3=3':'专用 PUCCH f2=1 / f3=3 样例',
  'user field rule: NR SIB1 ims-EmergencySupport=true':'NR SIB1 ims-EmergencySupport=true 现场特征（用户提供）',
};
const resetMessages=new Set(['rrcSetup','rrcConnectionSetup','rrcReestablishment','rrcConnectionReestablishment','rrcRelease','rrcConnectionRelease']);
const extensions=node=>{
  const out=[];
  for(let depth=0;object(node)&&depth<32;depth++,node=node.nonCriticalExtension)out.push(node);
  return out;
};
const extended=(node,key)=>extensions(node).find(n=>Object.hasOwn(n,key))?.[key];
const deltaValue=(value,index)=>typeof value==='string'&&ENUM_VALUES[index].some(n=>value==='deltaF'+n)?Number(value.slice(6)):null;
function bandsOf(tree){
  const list=Array.isArray(tree)?tree:tree?.frequencyBandListFilter;
  return (Array.isArray(list)?list:[]).flatMap(item=>{
    if(object(item.bandInformationNR)){
      const b=item.bandInformationNR;
      return [{rat:'nr',band:b.bandNR,dl:num(b.maxCarriersRequestedDL),ul:num(b.maxCarriersRequestedUL)}];
    }
    return object(item.bandInformationEUTRA)?[{rat:'eutra',band:item.bandInformationEUTRA.bandEUTRA}]:[];
  });
}
function readFilter(type,raw,path,decoded){
  if(raw===undefined)return {status:'absent',bands:[],path};
  if(typeof raw!=='string'||!raw.length||raw.length>2*1048576||!/^(?:[a-f\d]{2})+$/i.test(raw))return {status:'invalid',bands:[],path};
  const result=decodeCapabilityRequest(type,fromHex(raw));
  if(!result)return {status:['nr','eutra-nr','eutra','bands','common'].includes(type)?'invalid':'unsupported',bands:[],path};
  decoded.push({type,path,bytes:raw.length/2,...result});
  const tree=result.tree;
  if(type==='eutra'){
    const ies=currentRrcIes({message:{c1:{ueCapabilityEnquiry:tree}}});
    return {status:'decoded',bands:(extended(ies,'requestedFrequencyBands-r11')||[]).map(band=>({rat:'eutra',band})),path};
  }
  return {status:'decoded',bands:bandsOf(tree),srs:flag(extended(tree,'srs-SwitchingTimeRequest')),
    uplinkTxSwitch:flag(tree?.['uplinkTxSwitchRequest-r16']),path};
}
function enquiry(radio,ies){
  const decodedFilters=[],requests=[];
  let common={status:'absent',uplinkTxSwitch:false};
  if(radio==='NR'){
    for(const [i,r] of (ies['ue-CapabilityRAT-RequestList']||[]).entries())requests.push({rat:r['rat-Type'],
      ...readFilter(r['rat-Type'],r.capabilityRequestFilter,`ue-CapabilityRAT-RequestList[${i}].capabilityRequestFilter`,decodedFilters)});
    const ext=ies['ue-CapabilityEnquiryExt']?.['UECapabilityEnquiry-v1560-IEs'];
    if(object(ext?.capabilityRequestFilterCommon))common={status:'decoded',
      uplinkTxSwitch:flag(ext.capabilityRequestFilterCommon['uplinkTxSwitchRequest-r16']),
      codebookTypes:Object.entries(ext.capabilityRequestFilterCommon['codebookTypeRequest-r16']||{}).filter(([,v])=>flag(v)).map(([name])=>name)};
  }else{
    const requested=ies['ue-CapabilityRequest']||[];
    requests.push(...requested.map(rat=>({rat,status:'absent',bands:rat==='eutra'?(extended(ies,'requestedFrequencyBands-r11')||[]).map(band=>({rat:'eutra',band})):[]})));
    // 36.331 defines three different inner types; never try alternatives.
    const bandFilter=readFilter('bands',extended(ies,'requestedFreqBandsNR-MRDC-r15'),'requestedFreqBandsNR-MRDC-r15',decodedFilters);
    const nrFilter=readFilter('nr',extended(ies,'requestedCapabilityNR-r15'),'requestedCapabilityNR-r15',decodedFilters);
    for(const r of requests.filter(r=>['nr','eutra-nr'].includes(r.rat))){
      Object.assign(r,{...bandFilter,srs:nrFilter.srs??false});
      if(nrFilter.status==='invalid')r.status='invalid';
    }
    common=readFilter('common',extended(ies,'requestedCapabilityCommon-r15'),'requestedCapabilityCommon-r15',decodedFilters);
  }
  return {radio,kind:'enquiry',source:`${radio} DL-DCCH UECapabilityEnquiry`,requests,common,decodedFilters};
}

const cache=new WeakMap();
export function fingerprint(radio,tree,channel){
  if(!object(tree))return null;
  const key=radio+':'+(channel||'');
  let entries=cache.get(tree);
  if(!entries){entries=new Map();cache.set(tree,entries);}
  if(!entries.has(key))entries.set(key,extractFingerprint(radio,tree,channel));
  return entries.get(key);
}
function extractFingerprint(radio,tree,channel){
  if(!['LTE','NR'].includes(radio))return null;
  tree=currentRrcTree(tree);
  const message=tree?.message?.c1;
  if(!object(message)||Object.keys(message).length!==1)return null;
  const name=Object.keys(message)[0],ies=currentRrcIes(tree);
  if(!ies)return null;
  if(name==='ueCapabilityEnquiry')return !channel||channel==='DL_DCCH'?enquiry(radio,ies):null;
  const reset=resetMessages.has(name);
  if(radio==='NR'&&name==='systemInformationBlockType1'&&(!channel||channel==='BCCH_DL_SCH')){
    const common=ies.servingCellConfigCommon,bwp=common?.uplinkConfigCommon?.initialUplinkBWP;
    return {radio,kind:'broadcast',source:'NR SIB1 ASN.1',ims:flag(ies['ims-EmergencySupport']),
      pusch:num(bwp?.['pusch-ConfigCommon']?.setup?.['p0-NominalWithGrant']),
      pucch:num(bwp?.['pucch-ConfigCommon']?.setup?.['p0-nominal']),referenceSignalPower:power(common?.['ss-PBCH-BlockPower'])};
  }
  if(radio==='LTE'&&name==='systemInformation'&&(!channel||channel==='BCCH_DL_SCH')){
    const sib=ies['sib-TypeAndInfo']?.find(item=>object(item.sib2))?.sib2;
    if(!sib)return null;
    const common=sib.radioResourceConfigCommon,control=common?.uplinkPowerControlCommon;
    const values=control?.['deltaFList-PUCCH'];
    return {radio,kind:'broadcast',source:'LTE SIB2 ASN.1',pusch:num(control?.['p0-NominalPUSCH']),pucch:num(control?.['p0-NominalPUCCH']),
      deltaF:values?FORMATS.map(f=>values['deltaF-PUCCH-'+f]??null):null,referenceSignalPower:power(common?.['pdsch-ConfigCommon']?.referenceSignalPower)};
  }
  if(radio==='NR'&&['rrcSetup','rrcResume','rrcReconfiguration'].includes(name)&&(!channel||channel===(name==='rrcSetup'?'DL_CCCH':'DL_DCCH'))){
    // Current primary CellGroup only; no SCells, UE responses, deferred
    // candidates or target handover containers enter this projection.
    const group=ies.masterCellGroup?.CellGroupConfig,serving=group?.spCellConfig?.spCellConfigDedicated;
    const ul=serving?.uplinkConfig,active=ul?.['firstActiveUplinkBWP-Id'];
    const bwp=active>0?ul?.['uplinkBWP-ToAddModList']?.find(b=>b['bwp-Id']===active)?.['bwp-Dedicated']:ul?.initialUplinkBWP;
    const config=bwp?.['pucch-Config'],control=config?.setup?.['pucch-PowerControl'];
    const sync=object(group?.spCellConfig?.reconfigurationWithSync),full=flag(extended(ies,'fullConfig'));
    if(object(control)||config?.release===null||reset||sync||full||active!==undefined)return {radio,kind:'dedicated',source:`NR ${name} primary UL BWP`,
      reset:reset||sync||full,clearBroadcast:sync||full,
      status:object(control)?'decoded':config?.release===null?'released':group?'absent':'unavailable',
      deltaF:Array.from({length:5},(_,i)=>num(control?.['deltaF-PUCCH-f'+i])),bwp:active??0};
  }
  if(reset&&(!channel||channel===(/Setup$|Reestablishment$/.test(name)?'DL_CCCH':'DL_DCCH')))return {radio,kind:'reset',source:name,reset:true};
  return null;
}

function profileMatches(evidence){
  const matches=[],add=(id,source,profile)=>matches.push({id,source,profile});
  const broadcast=evidence.broadcast;
  if(evidence.radio==='LTE'&&broadcast){
    const values=broadcast.deltaF?.map(deltaValue),indices=values?.map((v,i)=>v===null?-1:ENUM_VALUES[i].indexOf(v));
    const pattern=indices?.length===5&&indices.every(i=>i>=0)?indices.join(''):null;
    const id={'11111':'Ericsson','11222':'Huawei','10111':'Nokia','21222':'ZTE'}[pattern];
    if(id)add(id,broadcast.source,'LTE deltaF '+pattern);
    // A known template collision is a caveat, not contradictory evidence.
    // Keep the matched LTE manufacturer visible, including Huawei 11222.
    return {matches,sharedTemplate:pattern==='11222',pattern,values};
  }
  if(evidence.radio!=='NR')return {matches};
  if(broadcast?.ims===true)add('Datang',broadcast.source,'user field rule: NR SIB1 ims-EmergencySupport=true');
  for(const request of evidence.enquiry?.requests||[]){
    if(request.status!=='decoded'||!['nr','eutra-nr'].includes(request.rat))continue;
    const bands=[...new Set(request.bands.filter(b=>b.rat==='nr').map(b=>b.band))].sort((a,b)=>a-b);
    const equal=expected=>bands.length===expected.length&&bands.every((b,i)=>b===expected[i]);
    const sul=bands.filter(b=>[80,81,82,83,84,86].includes(b));
    const limits=request.bands.filter(b=>b.rat==='nr'&&(Number.isFinite(b.dl)||Number.isFinite(b.ul))).length;
    if(bands.length>=8&&sul.length>=4&&limits>=4)add('Huawei',evidence.enquiry.source,'SUL + per-band carrier request limits');
    // User-labelled screenshots: SRS occurs in Huawei too, so it is never
    // sufficient by itself. Do not require an unrelated common UL Tx request.
    if(request.srs&&sul.length===0&&limits===0){
      if(equal([28,41,79]))add('ZTE',evidence.enquiry.source,'n28/n41/n79 + SRS request sample');
      if(equal([1,5,8,26,28,78]))add('ZTE',evidence.enquiry.source,'n1/n5/n8/n26/n28/n78 + SRS request sample');
    }
    if([14,28,41,90].every(b=>bands.includes(b)))add('Ericsson',evidence.enquiry.source,'paired n14/n28 and n41/n90 request sample');
    if(equal([1,5,26,65,66,77,78]))add('Nokia',evidence.enquiry.source,'n1/n5/n26/n65/n66/n77/n78 request sample');
  }
  const delta=evidence.dedicated?.deltaF;
  if(delta?.[2]===1&&delta?.[3]===3)add('Huawei',evidence.dedicated.source,'dedicated PUCCH f2=1 / f3=3');
  const overlap=delta?.[0]===5&&delta?.[1]===5&&delta?.[2]===0&&delta?.[3]===0;
  return {matches,overlap};
}

function details(evidence,result,en){
  const empty=en?'not observed':'未观测',b=evidence.broadcast,d=evidence.dedicated,q=evidence.enquiry;
  const lines=[`${evidence.radio} · ${en?'Network configuration samples; manufacturer unconfirmed':'网络配置样例匹配 · 厂商未经身份确认'}`];
  if(b){
    lines.push(b.source,`P0 PUSCH=${b.pusch??empty} / PUCCH=${b.pucch??empty} dBm`);
    if(evidence.radio==='NR')lines.push(`ims-EmergencySupport: ${b.ims?'true':empty}`);
    if(b.deltaF)lines.push('deltaF f1 / f1b / f2 / f2a / f2b: '+b.deltaF.map(v=>v??empty).join(' / '),
      `${en?'Actual offsets (dB)':'实际偏移（dB）'}: ${result.values?.map(v=>v??empty).join(' / ')||empty}`,
      `${en?'Enum indices':'枚举索引'}: ${result.pattern??(en?'incomplete or invalid':'不完整或无效')}`);
    lines.push(`${evidence.radio==='NR'?'ss-PBCH-BlockPower':'referenceSignalPower'}: ${b.referenceSignalPower??empty} dBm/RE`);
  }
  if(q&&evidence.radio==='NR'){
    lines.push(q.source);
    for(const r of q.requests){
      const state={absent:en?'field absent':'字段缺省',invalid:en?'invalid encoding':'容器解析失败',unsupported:en?'unsupported RAT':'未支持的 RAT',decoded:en?'decoded':'已解析'}[r.status];
      lines.push(`${r.rat}: ${state} · ${r.bands.map(b=>(b.rat==='nr'?'n':'b')+b.band+(b.dl!=null||b.ul!=null?`(DL ${b.dl??'—'}/UL ${b.ul??'—'})`:'')).join(', ')||'—'}`);
      if(r.status==='decoded')lines.push(`srs-SwitchingTimeRequest: ${r.srs?'true':empty}`);
    }
    lines.push(`uplinkTxSwitchRequest-r16: ${q.common?.uplinkTxSwitch?'true':empty}`);
    if(q.common?.codebookTypes?.length)lines.push(`codebookTypeRequest-r16: ${q.common.codebookTypes.join(', ')}`);
  }
  if(q&&evidence.radio==='LTE')lines.push(en?'LTE sender capability enquiries are retained separately; LTE vendor matching uses the five SIB2 values, not NR capability filters.':'LTE 发送节点的能力查询独立保留；LTE 厂商候选按 SIB2 五项匹配，不用 NR 能力过滤器判断。');
  if(d)lines.push(d.source,`PUCCH f0 / f1 / f2 / f3 / f4: ${d.deltaF.map(v=>v??(d.status==='decoded'?(en?'field absent':'字段缺省'):empty)).join(' / ')}`,
    `${en?'Configuration state':'配置状态'}: ${en?d.status:({decoded:'已解析',released:'已释放',absent:'字段缺省',unavailable:'未取得配置'})[d.status]}`);
  for(const m of result.matches)lines.push(`${en?'Sample candidate':'样例候选'}: ${NAMES[m.id][en?1:0]} · ${en?m.profile:PROFILE_ZH[m.profile]||m.profile} · ${m.source}`);
  if(result.overlap)lines.push(en?'Known small-cell/pRRU sample overlap; no validated power threshold separates manufacturers.':'存在小基站 / pRRU 样例重叠；没有已验证的功率门限可用于区分厂商。');
  if(result.sharedTemplate)lines.push(en?'Some small cells can share this configuration. The Huawei candidate remains visible; reference-power sign or P0 alone does not override the SIB2 match.':'部分小基站可能使用相同配置；保留华为候选，不因参考功率为负或 P0 数值而取消 SIB2 匹配。');
  if(result.status==='conflict')lines.push(en?'Conflicting sample evidence; no manufacturer selected.':'不同样例的证据冲突，不强行选定厂商。');
  if(result.status==='unknown'){
    if(evidence.radio==='LTE'&&b)lines.push(en?'LTE SIB2 observed; its deltaF values are incomplete, invalid or outside the supported profiles.':'已读取 LTE SIB2；deltaF 字段不完整、无效或未命中现有厂商样例。');
    else if(q?.requests.some(r=>['nr','eutra-nr'].includes(r.rat)&&r.status==='decoded'))lines.push(en?'DL capability enquiry decoded; its request features do not match the current manufacturer profiles.':'已解析下行能力查询；请求特征未命中现有厂商样例。');
    else if(q?.requests.some(r=>['nr','eutra-nr'].includes(r.rat)&&r.status==='invalid'))lines.push(en?'DL capability enquiry received, but its NR request filter could not be decoded; manufacturer matching remains unavailable.':'已收到下行能力查询，但 NR 能力过滤器解析失败，暂不能进行厂商匹配。');
    else if(q)lines.push(en?'DL capability enquiry decoded, but no usable NR request filter was included.':'已解析下行能力查询，但其中未包含可用的 NR 能力过滤条件。');
    else if(d?.status==='decoded')lines.push(en?'Primary connection configuration decoded without a profile match; no DL capability enquiry observed yet.':'已解析主小区连接配置，但未命中厂商样例；尚未观测到下行能力查询。');
    else lines.push(en?'No supported sample matched; waiting for a DL capability enquiry or primary connection configuration.':'未命中已支持的样例，等待下行能力查询或主小区连接配置。');
    if(evidence.radio==='NR'&&!q)lines.push(en?'No DL capability enquiry in this capture context. It is normally sent during connection establishment; refreshing the page does not request it from the network.':'本次采集上下文尚无下行能力查询。它通常在连接建立时下发，刷新网页不会让网络重新查询。');
  }
  lines.push(evidence.radio==='NR'?(en?'P0 and reference power do not independently identify a manufacturer. NR ims-EmergencySupport=true matches the user-provided Datang field rule. Sample matches do not establish accuracy or identity.':'P0 和参考功率不独立判厂商；NR ims-EmergencySupport=true 按用户提供的现场规则匹配大唐。样例匹配不代表准确率或身份确认。'):(en?'LTE matching uses SIB2 deltaF values; IMS support, P0 and reference power do not identify a manufacturer. Sample matches do not establish accuracy or identity.':'LTE 使用 SIB2 deltaF 匹配；IMS 支持、P0 和参考功率不独立判厂商。样例匹配不代表准确率或身份确认。'));
  return lines.join('\n');
}

export function verdict(input){
  const evidence=input.kind?{radio:input.radio,[input.kind]:input}:input.source&&!input.broadcast&&!input.enquiry&&!input.dedicated?{radio:input.radio,broadcast:input}:input;
  const profile=profileMatches(evidence),ids=[...new Set(profile.matches.map(m=>m.id))];
  const status=ids.length>1?'conflict':profile.overlap&&ids.length?'ambiguous':ids.length?'candidate':'unknown';
  const vendor=status==='candidate'?NAMES[ids[0]].join(' '):null;
  const label=status==='candidate'?NAMES[ids[0]][0]:status==='conflict'?'候选冲突':status==='ambiguous'?'候选不唯一':'未知';
  const labelEn=status==='candidate'?ids[0]:status==='conflict'?'Conflicting candidates':status==='ambiguous'?'Ambiguous candidates':'Unknown';
  const result={...profile,status,vendor,label,labelEn,candidates:ids};
  return {...result,detail:details(evidence,result,false),detailEn:details(evidence,result,true)};
}

export const vendorLabel=(result,language='zh')=>result?.[language==='en'?'labelEn':'label']||(language==='en'?'Unknown':'未知');

// A positive reference can be retained without becoming a manufacturer verdict.
// Cache immutable evidence slots, not every high-rate serving-cell timestamp.
const referenceSlots=new WeakMap();
const usableQuery=evidence=>evidence?.enquiry?.requests?.some(request=>request.status==='decoded'&&
  ['nr','eutra-nr'].includes(request.rat)&&request.bands?.some(b=>b.rat==='nr'&&Number.isInteger(b.band)));
export function hasVendorReference(evidence){
  if(!['NR','LTE'].includes(evidence?.radio))return false;
  for(const kind of ['broadcast','enquiry','dedicated']){
    const slot=evidence[kind];if(!object(slot))continue;
    let entries=referenceSlots.get(slot);if(!entries){entries=new Map();referenceSlots.set(slot,entries);}
    const key=evidence.radio+':'+kind;
    if(!entries.has(key))entries.set(key,vendorSimilarity({radio:evidence.radio,[kind]:slot}).rows.some(row=>row.score>0));
    if(entries.get(key))return true;
  }
  return false;
}

const comparableCell=(a,b)=>!Object.keys(a).some(k=>a[k]!=null&&b[k]!=null&&String(a[k])!==String(b[k]));
const sameKnownCell=(a,b)=>comparableCell(a,b)&&(
  a.identity!=null&&b.identity!=null&&String(a.identity)===String(b.identity)||
  a.pci!=null&&b.pci!=null&&a.arfcn!=null&&b.arfcn!=null&&String(a.pci)===String(b.pci)&&String(a.arfcn)===String(b.arfcn));

// Three active evidence slots and one last match per RAT, all cell-scoped.
// A separate 32-cell archive can restore a prior result, never old query state.
// Connection release clears active evidence, not the same cell's last match.
// Full decoded filters remain on events, not in the cell-state snapshot.
export class VendorTracker {
  constructor(){this.radios=new Map();this.lastMatches=new Map();this.cellHistory=[];}
  forgetCell(state){this.cellHistory=this.cellHistory.filter(x=>x.evidence.radio!==state.radio||!sameKnownCell(x.evidence.cell,state.cell));}
  rememberCell(state,result){
    const cell=state.cell;
    if(cell.identity==null&&(cell.pci==null||cell.arfcn==null))return;
    this.forgetCell(state);
    this.cellHistory.push({evidence:state,result});
    if(this.cellHistory.length>32)this.cellHistory.shift();
  }
  current(state){
    const result=verdict(state),radio=state.radio;
    if(result.status==='candidate'){this.lastMatches.set(radio,{evidence:state,result});this.rememberCell(state,result);}
    else if(result.status!=='unknown'){this.lastMatches.delete(radio);this.forgetCell(state);}
    let remembered=result.status==='unknown'?this.lastMatches.get(radio):null,fromHistory=false;
    if(remembered&&!comparableCell(remembered.evidence.cell,state.cell)){
      this.lastMatches.delete(radio);remembered=null;
    }
    if(result.status==='unknown'&&!remembered){
      const matches=this.cellHistory.filter(x=>x.evidence.radio===radio&&sameKnownCell(x.evidence.cell,state.cell));
      if(matches.length===1){remembered=matches[0];fromHistory=true;this.lastMatches.set(radio,remembered);}
    }
    if(result.status==='unknown'&&remembered?.result.status!=='candidate'&&hasVendorReference(state)&&
        (!usableQuery(remembered?.evidence)||usableQuery(state))){
      this.lastMatches.set(radio,{evidence:state,result});this.rememberCell(state,result);
      return {evidence:state,result};
    }
    if(!remembered)return {evidence:state,result};
    // Bind a formerly partial scope to later identity/PLMN metadata. Otherwise
    // a weak PCI/frequency record could incorrectly survive identity reuse.
    if(Object.entries(state.cell).some(([key,value])=>value!=null&&remembered.evidence.cell[key]==null)){
      remembered={...remembered,evidence:{...remembered.evidence,cell:{...remembered.evidence.cell,...state.cell}}};
      this.lastMatches.set(radio,remembered);this.rememberCell(remembered.evidence,remembered.result);
    }
    return {evidence:remembered.evidence,result:{...remembered.result,retained:true,restored:fromHistory,
      detail:(fromHistory?'已恢复此服务小区此前的匹配；当前消息未重新命中样例。\n':'同一服务小区最近一次匹配；当前消息未重新命中样例。\n')+remembered.result.detail,
      detailEn:(fromHistory?'Restored the earlier match for this serving cell; current messages do not match a profile again.\n':'Last match for the same serving cell; current messages do not match a profile again.\n')+remembered.result.detailEn}};
  }
  observe(event){
    if(!['NR','LTE'].includes(event.radio))return null;
    // Serving-cell metadata can come from a device/PHY status event rather
    // than an ASN.1 message. It still invalidates the old cell's profiles.
    const radio=event.radio,fragment=event.decodeStatus==='decoded'&&event.tree?fingerprint(radio,event.tree,event.channel):null;
    const previous=this.radios.get(radio),now=Number.isFinite(event.ts)?event.ts:previous?.lastAt??0;
    const cell={identity:event.cellIdentity,pci:event.cell?.pci??event.servingPci,arfcn:event.cell?.arfcn,
      network:event.plmn?.mcc!=null&&event.plmn?.mnc!=null?`${event.plmn.mcc}-${event.plmn.mnc}`:undefined};
    if(!fragment&&Object.values(cell).every(v=>v==null))return null;
    if(previous&&now<previous.lastAt)return {...this.current(previous),
      staleScope:Object.entries(cell).some(([k,v])=>v!=null&&previous.cell[k]!=null&&String(v)!==String(previous.cell[k]))};
    const changed=previous&&!comparableCell(cell,previous.cell);
    if(changed)this.lastMatches.delete(radio);
    const state=changed||!previous?{radio,cell:{},lastAt:now}: {...previous,cell:{...previous.cell},lastAt:now};
    Object.assign(state.cell,Object.fromEntries(Object.entries(cell).filter(([,v])=>v!=null)));
    if(fragment){
      if(fragment.reset){delete state.enquiry;delete state.dedicated;}
      if(fragment.clearBroadcast){delete state.broadcast;this.lastMatches.delete(radio);this.forgetCell(state);}
      if(fragment.kind!=='reset'){
        const {decodedFilters,...compact}=fragment;
        state[fragment.kind]={...compact,observedAt:now};
      }
    }
    this.radios.set(radio,state);
    return this.current(state);
  }
}
