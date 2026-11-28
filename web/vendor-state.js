import {VendorTracker,vendorLabel} from './sigweb/vendor.js';
import {vendorDisplay} from './sigweb/vendor-display.js';

export function vendorCardDisplay(cards,language='zh') {
  return vendorDisplay({vendorEvidence:cards.vendorEvidence,
    vendor:cards.vendorResult||(cards.vendor?{label:cards.vendor,labelEn:cards.vendor}:null)},language);
}

// Keep only structured-cloneable, bounded data on worker/public card snapshots.
export function updateVendorCard(cards,event) {
  if(!cards.radio)return cards;
  const tracker=new VendorTracker(),radio=cards.radio;
  if(cards.vendorState?.radio===radio)tracker.radios.set(radio,cards.vendorState);
  if(cards.vendorLastMatch)tracker.lastMatches.set(radio,cards.vendorLastMatch);
  tracker.cellHistory=cards.vendorHistory||[];
  const observed=tracker.observe({...event,radio,cell:event.cell||cards.cell,
    decodeStatus:event.tree&&event.decodeEvidence==='ASN1_SCHEMA'?'decoded':event.decodeStatus});
  if(!observed||observed.staleScope)return cards;
  const oldCell=cards.vendorState?.cell||cards.vendorEvidence?.cell,
    identityChanged=oldCell?.identity!=null&&event.cellIdentity!=null&&String(oldCell.identity)!==String(event.cellIdentity);
  return {...cards,...(identityChanged?{bler:null,mcs:null,ulMcs:null,modulation:null,linkParams:{},timingAdvance:null}:{}),
    vendor:vendorLabel(observed.result),vendorDetail:observed.result.detail,
    vendorResult:observed.result,vendorEvidence:observed.evidence,
    vendorState:tracker.radios.get(radio),vendorLastMatch:tracker.lastMatches.get(radio)||null,vendorHistory:tracker.cellHistory};
}
