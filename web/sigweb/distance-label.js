// Display units only. The TA estimate and its fixed-offset calculation stay intact.
export function formatDistance(meters,language='zh') {
  if(typeof meters!=='number'||!Number.isFinite(meters)||meters<0)return '—';
  const kilometers=meters>=1000;
  const value=Number((kilometers?meters/1000:meters).toFixed(kilometers?2:1));
  return `${value} ${language==='en'?(kilometers?'km':'m'):(kilometers?'千米':'米')}`;
}
export function taDistanceLabel(meters,language='zh') {
  const distance=formatDistance(meters,language);
  return distance==='—'?(language==='en'?'TA distance':'TA 距离'):`TA · ${distance}`;
}
