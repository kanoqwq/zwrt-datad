// Descriptive comparison against tutorial samples, not P(manufacturer | logs).
// Used by card presentation and details. It never feeds the vendor classifier.
const profiles=[
  {id:'Huawei',zh:'华为',bands:[41,28,1,78,77,80,81,82,83,84,86],limits:true,srs:true,delta:{2:1,3:3}},
  {id:'ZTE',zh:'中兴',bands:[28,41,79],bandSamples:[[28,41,79],[1,5,8,26,28,78]],srs:true,delta:{0:0,1:-6,2:7,3:0,4:0},weakDelta:true},
  {id:'Ericsson',zh:'爱立信',bands:[14,28,41,90],bandSamples:[[14,28,41,90],[1,7,14,28,41,65,66,77,78,79,90]],noSetupPucch:true},
  {id:'Nokia',zh:'诺基亚',bands:[1,5,26,65,66,77,78]},
  {id:'Datang',zh:'大唐',nrOnly:true,ims:true},
];
const ltePatterns={Huawei:[0,3,1,2,2],ZTE:[2,3,1,2,2],Ericsson:[0,3,0,0,0],Nokia:[0,1,0,0,0]};
const enumValues=[[-2,0,2],[1,3,5],[-2,0,1,2],[-2,0,2],[-2,0,2]];
const mean=items=>items.reduce((sum,item)=>sum+item.fraction,0)/items.length;
const percent=value=>Math.round(value*100);
const text=(zh,en)=>({zh,en});
const comparison=(fraction,zh,en)=>({fraction,...text(zh,en)});
function group(key,items){return items.length?{key,fraction:mean(items),items}:null;}
function nrQuery(profile,q){
  if(!profile.bands)return null;
  const groups=[];
  for(const request of q?.requests||[]){
    if(request.status!=='decoded'||!['nr','eutra-nr'].includes(request.rat))continue;
    const bands=new Set((request.bands||[]).filter(b=>b.rat==='nr'&&Number.isInteger(b.band)).map(b=>b.band));
    if(!bands.size)continue;
    const items=[];
    if(bands.size){
      const reference=(profile.bandSamples||[profile.bands]).map(sample=>{
        const union=new Set([...bands,...sample]),overlap=sample.filter(b=>bands.has(b));
        return {sample,union,overlap,fraction:overlap.length/union.size};
      }).sort((a,b)=>b.fraction-a.fraction)[0];
      const {union,overlap,sample}=reference;
      items.push(comparison(overlap.length/union.size,
        `请求频段交并比 ${overlap.length}/${union.size}，样例 ${sample.map(b=>'n'+b).join('/')}`,
        `Requested-band intersection/union ${overlap.length}/${union.size}; sample ${sample.map(b=>'n'+b).join('/')}`));
    }
    if(profile.limits&&bands.size){
      const count=request.bands.filter(b=>b.rat==='nr'&&(Number.isFinite(b.dl)||Number.isFinite(b.ul))).length;
      items.push(comparison(count>=4?1:0,`分频段载波限制：观测 ${count} 项，样例至少 4 项`,`Per-band carrier limits: ${count} observed; sample has at least 4`));
    }
    if(profile.srs!==undefined)items.push(comparison(request.srs===true?1:0,
      `SRS 时间请求：${request.srs?'携带':'缺省'}，样例携带`,
      `SRS timing request: ${request.srs?'present':'absent'}; present in sample`));
    if(profile.switching!==undefined&&['decoded','absent'].includes(q.common?.status))items.push(comparison(q.common?.uplinkTxSwitch===true?1:0,
      `上行切换请求：${q.common?.uplinkTxSwitch?'携带':'缺省'}，样例携带`,
      `UL Tx switching request: ${q.common?.uplinkTxSwitch?'present':'absent'}; present in sample`));
    const candidate=group('query',items);if(candidate)groups.push(candidate);
  }
  // NR and MRDC requests may repeat the same filter. They are not votes.
  return groups.sort((a,b)=>b.fraction-a.fraction)[0]||null;
}
function nrDedicated(profile,d){
  if(!d)return null;
  const items=[];
  if(profile.delta&&d.status==='decoded')for(const [key,expected]of Object.entries(profile.delta)){
    const actual=d.deltaF?.[key];
    if(!Number.isInteger(actual))continue; // Absent fields are never zeros.
    items.push(comparison(actual===expected?1:0,`PUCCH f${key}：${actual}，样例 ${expected}`,`PUCCH f${key}: ${actual}; sample ${expected}`));
  }
  if(profile.noSetupPucch&&/\brrcSetup\b/.test(d.source||'')&&['decoded','absent'].includes(d.status))items.push(comparison(d.status==='absent'?1:0,
    `Setup 专用 PUCCH 功控：${d.status==='decoded'?'携带':'缺省'}，教程样例缺省`,
    `Setup dedicated PUCCH power control: ${d.status==='decoded'?'present':'absent'}; absent in tutorial sample`));
  return group('dedicated',items);
}
function lteBroadcast(profile,b){
  const items=[];
  for(const [index,expected]of ltePatterns[profile.id].entries()){
    const raw=b?.deltaF?.[index];
    if(typeof raw!=='string'||!enumValues[index].some(n=>raw==='deltaF'+n))continue;
    const actual=Number(raw.slice(6));
    items.push(comparison(actual===expected?1:0,`deltaF 项 ${index+1}：${actual}，样例 ${expected}`,`deltaF item ${index+1}: ${actual}; sample ${expected}`));
  }
  return group('broadcast',items);
}
function nrBroadcast(profile,b){
  if(!profile.ims||b?.ims!==true)return null;
  return group('nr-broadcast',[comparison(1,
    'NR SIB1 ims-EmergencySupport=true，匹配用户提供的大唐现场特征',
    'NR SIB1 ims-EmergencySupport=true; matches the user-provided Datang field rule')]);
}
export function vendorSimilarity(input){
  const evidence=input?.kind?{radio:input.radio,[input.kind]:input}:input||{};
  const supported=['LTE','NR'].includes(evidence.radio);
  const rows=profiles.filter(profile=>!profile.nrOnly||evidence.radio==='NR').map(profile=>{
    const groups=!supported?[]:evidence.radio==='LTE'?[lteBroadcast(profile,evidence.broadcast)]:[
      nrQuery(profile,evidence.enquiry),nrDedicated(profile,evidence.dedicated),nrBroadcast(profile,evidence.broadcast),
    ];
    const compared=groups.filter(Boolean);
    return {id:profile.id,name:profile.zh,score:compared.length?percent(mean(compared)):null,
      comparisonCount:compared.reduce((sum,g)=>sum+g.items.length,0),groups:compared,
      weakDelta:profile.weakDelta===true&&compared.some(g=>g.key==='dedicated')};
  }).sort((a,b)=>(b.score??-1)-(a.score??-1));
  return {method:'sample-field-similarity-v1',calibrated:false,rows,available:rows.some(r=>r.score!==null)};
}
