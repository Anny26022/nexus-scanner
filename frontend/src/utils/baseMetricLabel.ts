/** Human labels preserve the stable engine path as the option value. */
export function baseMetricLabel(path:string):string {
  const labels:Record<string,string>={ageSessions:'Duration (sessions)',depthPct:'Depth (%)',atrContraction:'ATR contraction (×)',volumeDryUp:'Volume dry-up (×)',medianTurnover20:'Median 20-day turnover (₹ Cr)',distanceClosing52wHigh:'Below 52-week closing high (%)',aboveClosing52wLow:'Above 52-week closing low (%)',rsRating:'RS rating',rsChange5:'RS change, 5 sessions',rsChange22:'RS change, 22 sessions',rsLineAtHigh:'RS line at 252-session high',closeInRange:'Close in range',throughPct:'Close beyond pivot (%)',volumeRatio:'Volume / prior 20-day median',historyFromListing:'History reaches listing',historySessions:'Available history (sessions)',netUpDownVolume:'Net up/down volume balance',upDownVolumeRatio:'Up/down volume ratio',quietDepth:'Quietest volume / median',quietAgeSessions:'Quietest day age (sessions)',listingAgeWeeks:'Listing age (weeks)',overheadPct:'Higher closing-price supply (%)',distanceFromPivotPct:'Distance from pivot (%)',level:'Structure level'};
  const parts=path.split('.'),key=parts.pop()!;
  const name=labels[key]??key.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/(SMA|EMA)(\d+)/g,'$1 $2').replace(/Pct$/,' (%)').replace(/_/g,' / ');
  const scope=parts.shift();
  const prefix=scope==='selection'?'Before breakout':scope==='current'?'Now':scope==='breakout'?'Breakout':scope==='base'?'Base':'';
  const slice=parts.includes('parts')?parts.at(-1)?.replace('_',' '):undefined;
  return [prefix,slice,name.charAt(0).toUpperCase()+name.slice(1)].filter(Boolean).join(' · ');
}
