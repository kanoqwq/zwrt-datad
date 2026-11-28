import {vendorLabel} from './vendor.js';
import {vendorSimilarity} from './vendor-similarity.js';

// Presentation only: do not promote a similarity score into a classifier result.
// Tracker evidence is immutable; keep repeated UI refreshes allocation-free.
const rankings=new WeakMap();
export function vendorDisplay(c,language='zh'){
  const evidence=c.vendorEvidence;
  let ranking;
  if(evidence&&typeof evidence==='object'){
    ranking=rankings.get(evidence);
    if(!ranking){ranking=vendorSimilarity(evidence);rankings.set(evidence,ranking);}
  }
  const first=ranking?.rows[0];
  if(first?.score>0)return {label:`${language==='en'?first.id:first.name}(${first.score}%)`,reference:true};
  return {label:c.vendor?vendorLabel(c.vendor,language):'—',reference:false};
}
