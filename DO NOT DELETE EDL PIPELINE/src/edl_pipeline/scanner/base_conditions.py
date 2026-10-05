"""Conditions over one published base per selected lifecycle stage."""
import math
from .base_publication import compact_base_records

STAGES = ('FORMING','FRESH_BREAKOUT','HOLDING','PLAYED_OUT')
METRICS = {
    'pivot','distanceFromPivotPct','breakoutAgeSessions','belowPivotCloses','returnSinceBreakoutPct',
    *('base.'+key for key in ('ageSessions','depthPct','atrContraction','volumeDryUp','quietDepth','quietAgeSessions','upDownVolumeRatio','netUpDownVolume','rsStart','rsEnd','rsAverage','rsMinimum','rsMaximum','level','overheadPct','nestedCount')),
    *('breakout.'+key for key in ('volumeRatio','gapPct','throughPct','dailyGainPct','closeInRange')),
    *(scope+'.'+key for scope in ('selection','current') for key in ('medianTurnover20','distanceClosing52wHigh','aboveClosing52wLow','listingAgeWeeks','rsRating','rsChange5','rsChange22','industryRelative63','industryRelative252')),
    *(scope+'.'+prefix+kind+str(period) for scope in ('selection','current') for prefix in ('distance','slope') for kind in ('SMA','EMA') for period in (10,20,50,100,150,200)),
    *(scope+'.ratio'+kind+pair for scope in ('selection','current') for kind in ('SMA','EMA') for pair in ('50_200','150_200','10_20','20_50')),
}


def metric(record, path):
    if path not in METRICS: raise ValueError('Unsupported base metric: '+str(path))
    value=record
    for key in path.split('.'):
        value=value.get(key) if isinstance(value,dict) else None
    return value if isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) else None


def compare(value, operation, target):
    if not isinstance(target,(int,float)) or isinstance(target,bool) or not math.isfinite(target): raise ValueError('Base comparison requires a finite number')
    operations={'GREATER':lambda a:a>target,'ABOVE':lambda a:a>=target,'LESS':lambda a:a<target,'BELOW':lambda a:a<=target,'EQUAL':lambda a:a==target}
    if operation not in operations: raise ValueError('Unsupported base comparison')
    return None if value is None else operations[operation](value)


def evaluate_base_condition(episodes, kind, parameters):
    stage=parameters.get('stage','FORMING')
    if stage not in STAGES: raise ValueError('Unsupported base stage')
    selected=compact_base_records(episodes) if isinstance(episodes,list) else episodes
    record=(selected or {}).get(stage)
    if kind=='BASE_STAGE':
        policy=parameters.get('holdingPolicy','ANY')
        if policy not in ('ANY','STRICT','RETEST'): raise ValueError('Unsupported holding policy')
        if episodes is None: return None
        if record is None: return False
        if policy=='STRICT': return bool(record['continuousHolding'] and record['holdsPivot'])
        if policy=='RETEST': return bool(record['holdsPivot'])
        return True
    # Validate paths even when there is no qualifying base.
    left=metric(record,parameters.get('metric'))
    if kind=='BASE_FORMULA':
        right=metric(record,parameters.get('rightMetric'))
        operation=parameters.get('arithmetic','DIVIDE')
        if operation not in ('ADD','SUBTRACT','MULTIPLY','DIVIDE'): raise ValueError('Unsupported base arithmetic')
        left=None if left is None or right is None or (operation=='DIVIDE' and right==0) else {'ADD':lambda:left+right,'SUBTRACT':lambda:left-right,'MULTIPLY':lambda:left*right,'DIVIDE':lambda:left/right}[operation]()
    elif kind!='BASE_METRIC': raise ValueError('Unsupported base condition')
    return compare(left,parameters.get('comparison','ABOVE'),parameters.get('value'))
