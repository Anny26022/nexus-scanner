/** Human labels preserve the stable engine path as the option value. */
export function baseMetricLabel(path:string):string {
  const labels:Record<string,string>={ageSessions:'Duration (sessions)',depthPct:'Depth (%)',atrContraction:'ATR contraction (×)',volumeDryUp:'Volume dry-up (×)',medianTurnover20:'Median 20-day turnover (₹ Cr)',distanceClosing52wHigh:'Below 52-week closing high (%)',aboveClosing52wLow:'Above 52-week closing low (%)',rsRating:'RS rating',rsChange5:'RS change, 5 sessions',rsChange22:'RS change, 22 sessions',rsLineAtHigh:'RS line at 252-session high',closeInRange:'Close in range',throughPct:'Close beyond pivot (%)',volumeRatio:'Volume / prior 20-day median',historyFromListing:'History reaches listing',historySessions:'Available history (sessions)',netUpDownVolume:'Net up/down volume balance',upDownVolumeRatio:'Up/down volume ratio',quietDepth:'Quietest volume / median',quietAgeSessions:'Quietest day age (sessions)',listingAgeWeeks:'Listing age (weeks)',overheadPct:'Higher closing-price supply (%)',distanceFromPivotPct:'Distance from pivot (%)',level:'Structure level'};
  const parts=path.split('.'),key=parts.pop()!;
  const facts:Record<string,string>={price:'Price (₹)',marketCapCr:'Market cap (₹ Cr)',turnoverCr:'Average traded value (₹ Cr/day)',volume:'Average volume (shares/day)',upTurnoverCr:'Up-day traded value total (₹ Cr)',downTurnoverCr:'Down-day traded value total (₹ Cr)',upVolume:'Up-day share volume total',downVolume:'Down-day share volume total',upDays:'Up days',downDays:'Down days',changePct:'First-to-last close change (%)',ageWeeks:'Base age (sessions ÷ 5 weeks)',quietVolume:'Quietest day (shares)',medianVolume:'Median day (shares)',quietTurnoverCr:'Quietest day (₹ Cr)',medianTurnoverCr:'Median day (₹ Cr)',quietTurnoverAgeSessions:'Quietest turnover day age (sessions)',rsMonthAgo:'RS 22 sessions ago'};
  const ma=/^(sma|ema)(\d+)(MonthAgo)?$/.exec(key);
  const average=/^average(Turnover|Volume)(\d+)$/.exec(key);
  const name=labels[key]??(ma?`${ma[2]}-session ${ma[1].toUpperCase()} (₹)${ma[3]?', 21 sessions ago':''}`:average?`${average[2]}-session average ${average[1]==='Turnover'?'turnover (₹ Cr/day)':'volume (shares/day)'}`:facts[key])??key.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/(SMA|EMA)(\d+)/g,'$1 $2').replace(/Pct$/,' (%)').replace(/_/g,' / ');
  const scope=parts.shift();
  const displayName=['current','selection'].includes(scope??'')&&key==='turnoverCr'?'1-day turnover (₹ Cr)':
    ['current','selection'].includes(scope??'')&&key==='volume'?'1-day volume (shares)':name;
  const prefix=scope==='selection'?'Before breakout':scope==='current'?'Now':scope==='breakout'?'Breakout':scope==='base'?'Base':'';
  const slice=parts.includes('parts')?parts.at(-1)?.replace('_',' '):undefined;
  return [prefix,slice,displayName.charAt(0).toUpperCase()+displayName.slice(1)].filter(Boolean).join(' · ');
}
