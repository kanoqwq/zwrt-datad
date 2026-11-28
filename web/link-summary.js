// Summaries keep known directions and units; sample/grant counts are not BLER.
export function linkSummary(c) {
  const rate=c.linkParams?.['上行重传占比'];
  const uplink=typeof rate==='string'&&/^\d+(?:\.\d+)?%$/.test(rate)?`UL 重传${Number(Number(rate.slice(0,-1)).toFixed(1))}%`:
    c.linkParams?.['上行新传 TB']!=null?'UL 重传待统计':'UL 未上报';
  return {bler:`DL ${c.bler??'—'} / ${uplink}`,uplink,mcs:`MCS ↓${c.mcs??'—'} ↑${c.ulMcs??'—'}`};
}
