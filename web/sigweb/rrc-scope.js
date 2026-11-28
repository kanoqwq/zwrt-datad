// A state projection of decoded RRC. The original tree remains the inspection
// record, including future extensions and configurations awaiting a condition.
const cache=new WeakMap();
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const deferred=/^(?:conditionalReconfiguration|condReconfigToAddModList|condRRCReconfig|condReconfigurationToAddModList|condReconfigurationToApply)(?:-r\d+)?$/;
const requiresCe=/^(?:rrc(?:Connection)?(?:Reconfiguration|Setup|Release|Reestablishment|Resume)(?:Complete)?|securityModeCommand)$/;
function currentRoot(tree){
 const top=tree?.message?.c1;if(!top)return tree?.message?null:tree;
 if(Object.keys(top).length!==1)return null;
 const [name,body]=Object.entries(top)[0];if(!object(body))return null;
 const ce=body.criticalExtensions;
 if(!ce)return requiresCe.test(name)?null:tree;
 if(!object(ce)||Object.keys(ce).length!==1)return null;
 const branch=Object.hasOwn(ce,'c1')?ce.c1:ce;
 if(!object(branch)||Object.keys(branch).length!==1)return null;
 const [key,value]=Object.entries(branch)[0];
 return (key===name||new RegExp('^'+name+'-r\\d+$').test(key))&&object(value)?tree:null;
}
function project(node){
 if(!node||typeof node!=='object')return node;
 let out=node;
 for(const [key,value]of Object.entries(node)){
  const next=deferred.test(key)||key==='criticalExtensionsFuture'?undefined:project(value);
  if(next===value)continue;
  if(out===node)out=Array.isArray(node)?node.slice():{...node};
  if(next===undefined)delete out[key];else out[key]=next;
 }
 return out;
}
function resumeFields(tree){
 const name='rrcConnectionResume-r13',body=tree?.message?.c1?.[name],ies=body?.criticalExtensions?.c1?.[name];
 if(!object(ies))return tree;
 const aliases={};
 // 36.331 declares these versioned fields as the same MeasConfig and
 // RadioResourceConfigDedicated types used by the ordinary LTE projections.
 for(const [from,to] of [['measConfig-r13','measConfig'],['radioResourceConfigDedicated-r13','radioResourceConfigDedicated']])
  if(Object.hasOwn(ies,from)&&!Object.hasOwn(ies,to))aliases[to]=ies[from];
 for(let node=ies;object(node);node=node.nonCriticalExtension)if(node['fullConfig-r15']==='true'&&!Object.hasOwn(ies,'fullConfig'))aliases.fullConfig='true';
 if(!Object.keys(aliases).length)return tree;
 return {...tree,message:{...tree.message,c1:{...tree.message.c1,[name]:{...body,criticalExtensions:{...body.criticalExtensions,c1:{...body.criticalExtensions.c1,[name]:{...ies,...aliases}}}}}}};
}
export function currentRrcTree(tree){
 if(!object(tree))return null;
 if(cache.has(tree))return cache.get(tree);
 const result=currentRoot(tree)?resumeFields(project(tree)):null;cache.set(tree,result);return result;
}
export function currentRrcIes(tree){
 const current=currentRrcTree(tree),top=current?.message?.c1;
 if(!top||Object.keys(top).length!==1)return null;
 const body=Object.values(top)[0],ce=body?.criticalExtensions;
 return ce?Object.values(ce.c1||ce)[0]:body;
}
// NAS is only carried by the current IEs (and their version extension chain),
// not by an arbitrary descendant RRC/capability/conditional container.
export function currentNasPayloads(tree){
 const out=[];
 for(let node=currentRrcIes(tree);object(node);node=node.nonCriticalExtension){
  for(const key of ['dedicatedNAS-Message','dedicatedInfoNAS'])if(typeof node[key]==='string')out.push(node[key]);
  for(const key of ['dedicatedNAS-MessageList','dedicatedInfoNASList'])if(Array.isArray(node[key]))out.push(...node[key].filter(x=>typeof x==='string'));
  const choice=node.dedicatedInfoType;
  if(object(choice)&&Object.keys(choice).length===1&&typeof choice.dedicatedInfoNAS==='string')out.push(choice.dedicatedInfoNAS);
 }
 return out;
}
export function currentAsSecurity(tree){
 let ies=currentRrcIes(tree);if(!object(ies))return null;
 let config=ies.securityConfigSMC?.securityAlgorithmConfig;
 const bearer=ies.radioBearerConfig?.securityConfig;
 if(!config&&bearer?.keyToUse!=='secondary')config=bearer?.securityAlgorithmConfig;
 if(!config){
  const handover=ies.securityConfigHO?.handoverType;
  if(object(handover)&&Object.keys(handover).length===1)config=(handover.intraLTE||handover.interRAT)?.securityAlgorithmConfig;
 }
 if(!object(config))return null;
 const cipher=config.cipheringAlgorithm,integrity=config.integrityProtAlgorithm;
 return typeof cipher==='string'||typeof integrity==='string'?{cipher,integrity}:null;
}
