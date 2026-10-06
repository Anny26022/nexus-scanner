"""Original Nexus starting defaults; thresholds require replay validation."""
from copy import deepcopy


def metric(stage,path,comparison,value):
    return {'type':'condition','kind':'BASE_METRIC','params':{'stage':stage,'metric':path,'comparison':comparison,'value':value}}


def quality(stage):
    context='current' if stage=='FORMING' else 'selection'
    return [metric(stage,context+'.medianTurnover20','ABOVE',5),
        metric(stage,context+'.distanceSMA200','GREATER',0),metric(stage,context+'.slopeSMA200','GREATER',0),
        metric(stage,context+'.rsRating','ABOVE',80),metric(stage,context+'.rsChange22','ABOVE',0),
        metric(stage,context+'.distanceClosing52wHigh','BELOW',20),
        metric(stage,'base.ageSessions','ABOVE',15),metric(stage,'base.ageSessions','BELOW',100),
        metric(stage,'base.depthPct','BELOW',25),metric(stage,'base.atrContraction','BELOW',.8),
        metric(stage,'base.volumeDryUp','BELOW',.8)]


def build_presets():
    output=[]
    def add(slug,name,stage,clauses,description):
        stage_leaf={'type':'condition','kind':'BASE_STAGE','params':{'stage':stage,'holdingPolicy':'STRICT' if stage=='HOLDING' else 'ANY'}}
        output.append({'id':'lib-nexus-'+slug,'name':name,'category':'Bases & Contraction','horizon':'Positional',
            'description':description,'aka':[],'version':'nexus-bases-1','rules':[description],
            'expression':{'type':'group','op':'AND','children':[stage_leaf,*clauses]}})
    add('strong-bases','Strong Bases','FORMING',quality('FORMING')+[
        metric('FORMING','distanceFromPivotPct','ABOVE',-5),metric('FORMING','distanceFromPivotPct','BELOW',0)],
        'Liquid, shallow, tightening bases with persistent RS leadership, within 5% below pivot.')
    breakout=[metric('FRESH_BREAKOUT','breakout.volumeRatio','ABOVE',1.5),metric('FRESH_BREAKOUT','breakout.closeInRange','ABOVE',.7),
        metric('FRESH_BREAKOUT','breakout.throughPct','GREATER',0),metric('FRESH_BREAKOUT','distanceFromPivotPct','BELOW',5),
        metric('FRESH_BREAKOUT','distanceFromPivotPct','ABOVE',0),metric('FRESH_BREAKOUT','breakoutAgeSessions','BELOW',5)]
    add('fresh-breakouts','Fresh Breakouts','FRESH_BREAKOUT',quality('FRESH_BREAKOUT')+breakout,'Qualified frozen base, 1.5× median volume, strong close and breakout age 0–5 sessions inclusive.')
    holding=[metric('HOLDING',node['params']['metric'],node['params']['comparison'],node['params']['value']) for node in breakout[:3]]
    add('holding-breakouts','Holding Breakouts','HOLDING',quality('HOLDING')+holding,'Qualified breakouts that have continuously held the original pivot.')
    add('vcp-base','VCP Base','FORMING',[
        metric('FORMING','base.atrContraction','ABOVE',.3),metric('FORMING','base.atrContraction','BELOW',.9),
        metric('FORMING','base.volumeDryUp','ABOVE',.05),metric('FORMING','base.volumeDryUp','BELOW',.9),
        metric('FORMING','base.ageSessions','ABOVE',15),metric('FORMING','base.ageSessions','BELOW',1500),
        metric('FORMING','base.depthPct','ABOVE',2),metric('FORMING','base.depthPct','BELOW',35),
        metric('FORMING','current.distanceSMA50','GREATER',0),metric('FORMING','current.distanceSMA200','GREATER',0),
        metric('FORMING','current.distanceClosing52wHigh','BELOW',30),metric('FORMING','current.aboveClosing52wLow','ABOVE',15),
        metric('FORMING','current.rsRating','ABOVE',70)],'Contracting base with drying volume, trend alignment and relative strength.')
    add('blue-sky','Blue Sky','FORMING',[
        metric('FORMING','current.historyFromListing','EQUAL',1),metric('FORMING','base.overheadPct','EQUAL',0),metric('FORMING','current.rsRating','ABOVE',70),
        metric('FORMING','distanceFromPivotPct','ABOVE',-20),metric('FORMING','distanceFromPivotPct','BELOW',0)],'Strong forming base without higher closing-price supply in available history.')
    add('multi-year-base','Multi-year Base','FORMING',[
        metric('FORMING','base.ageSessions','ABOVE',252),metric('FORMING','base.ageSessions','BELOW',1500),
        metric('FORMING','current.distanceSMA200','GREATER',0),metric('FORMING','current.rsRating','ABOVE',60),
        metric('FORMING','distanceFromPivotPct','ABOVE',-20),metric('FORMING','distanceFromPivotPct','BELOW',0)],'Long-duration base above the 200 SMA with improving price position.')
    add('ipo-base','IPO Base','FORMING',[
        metric('FORMING','current.listingAgeWeeks','ABOVE',2),metric('FORMING','current.listingAgeWeeks','BELOW',50),
        metric('FORMING','base.ageSessions','ABOVE',15),metric('FORMING','base.depthPct','ABOVE',2),metric('FORMING','base.depthPct','BELOW',35),
        metric('FORMING','current.distanceSMA50','GREATER',0),metric('FORMING','distanceFromPivotPct','ABOVE',-20),
        metric('FORMING','distanceFromPivotPct','BELOW',0)],'Recent official listing forming a shallow base above its 50 SMA.')
    # Versioned setup families coexist with the seven original research presets.
    for family, name, legacy in (
        ('vcp', 'VCP Setup', 'vcp-base'), ('blue-sky', 'Blue Sky Setup', 'blue-sky'),
        ('multi-year', 'Multi-year Setup', 'multi-year-base'), ('ipo', 'IPO First Base', 'ipo-base')):
        preset = deepcopy(next(item for item in output if item['id'] == 'lib-nexus-' + legacy))
        preset.update(id='lib-nexus-'+family+'-setup', name=name, version='nexus-setups-3',
                      setupFamily=family, description='Versioned setup family with NSE liquidity floors and frozen lifecycle qualification.')
        nodes=preset['expression']['children']
        if family=='vcp':
            for node in nodes:
                if node.get('params',{}).get('metric')=='base.atrContraction':node['params']['metric']='base.trueRangeContraction'
        if family=='multi-year':
            next(node for node in nodes if node.get('params',{}).get('metric')=='base.ageSessions')['params'].update(metric='base.ageWeeks',value=52)
        if family=='ipo':
            next(node for node in nodes if node.get('params',{}).get('metric')=='current.listingAgeWeeks')['params']['metric']='current.listingAgeSessionWeeks'
            next(node for node in nodes if node.get('params',{}).get('metric')=='current.listingAgeWeeks')['params']['metric']='current.listingAgeSessionWeeks'
            nodes.append(metric('FORMING','firstEligibleBase','EQUAL',1))
        nodes.extend([metric('FORMING','current.marketCapCr','ABOVE',300),metric('FORMING','current.medianTurnover20','ABOVE',1)])
        output.append(preset)
    return deepcopy(output)


FAMILY_PRESETS = {'lib-nexus-'+name+'-setup' for name in ('vcp','blue-sky','multi-year','ipo')}


def materialize_base_preset(preset, parameters):
    """One validated, bounded expression for both latest scans and replay."""
    expression=deepcopy(preset['expression'])
    stage=parameters.get('setupStage','FORMING') if preset['id'] in FAMILY_PRESETS else expression['children'][0]['params']['stage']
    if stage not in ('FORMING','FRESH_BREAKOUT','HOLDING','PLAYED_OUT'): raise ValueError('Unsupported setup stage')
    for index,node in enumerate(expression['children']):
        p=node['params'];p['stage']=stage
        if node['kind']=='BASE_METRIC':
            if f'threshold{index}' in parameters:p['value']=parameters[f'threshold{index}']
            if stage!='FORMING' and preset['id'] in FAMILY_PRESETS:
                if p['metric'].startswith('current.'):p['metric']='selection.'+p['metric'][8:]
                if p['metric']=='distanceFromPivotPct':p['metric']='selection.distanceFromPivotPct'
        if node['kind']=='BASE_STAGE' and 'holdingPolicy' in parameters:p['holdingPolicy']=parameters['holdingPolicy']
    if preset['id'] in FAMILY_PRESETS:
        def number(key,default,low,high,integer=False):
            value=parameters.get(key,default)
            import math
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not low<=value<=high or integer and value!=int(value): raise ValueError('Invalid setup parameter: '+key)
            return value
        expression['children']=[node for node in expression['children'] if not (node['kind']=='BASE_METRIC' and node['params'].get('metric')=='base.depthPct' and node['params'].get('comparison')=='BELOW')]
        method=parameters.get('contractionMethod','RAW_TR')
        methods={'RAW_TR':'base.trueRangeContraction','WILDER_ATR':'base.atrContraction','SIMPLE_ATR':'base.atrSimpleContraction'}
        if not isinstance(method,str) or method not in methods:raise ValueError('Unsupported contraction method')
        if preset.get('setupFamily')=='vcp':
            for node in expression['children']:
                if node['params'].get('metric') in methods.values():node['params']['metric']=methods[method]
        depth=number('maxBaseDepth',35 if preset.get('setupFamily') in ('vcp','ipo') else 95,1,95)
        expression['children'].append(metric(stage,'base.depthPct','BELOW',depth))
        def boolean(key,default=False):
            value=parameters.get(key,default)
            if not isinstance(value,bool):raise ValueError(key+' must be boolean')
            return value
        strict=boolean('strictContractionLegs')
        legs=number('minContractionLegs',2 if strict else 0,0,10,True)
        if strict and legs==0:legs=2
        leg_ratio=number('maxContractionLegRatio',1,0,2)
        if strict and leg_ratio>1:raise ValueError('Strict contraction ratio must not exceed one')
        if legs==1:raise ValueError('Contraction ratio requires at least two legs')
        if legs:
            expression['children'].extend([metric(stage,'base.contractionLegCount','ABOVE',legs),metric(stage,'base.contractionMaxRatio','LESS' if strict else 'BELOW',leg_ratio)])
        scope='current' if stage=='FORMING' else 'selection'
        prior=number('minPriorAdvancePct',0,0,1000)
        if prior:expression['children'].append(metric(stage,'base.priorAdvance63Pct','ABOVE',prior))
        if boolean('requireAccumulation'):expression['children'].append(metric(stage,'base.netUpDownVolume','GREATER',0))
        if boolean('requireRising200'):expression['children'].append(metric(stage,scope+'.slopeSMA200','GREATER',0))
        for key,path in (('reclaim200Within','reclaimSMA200Age'),('slopeTurn200Within','slopeTurnSMA200Age')):
            days=number(key,0,0,252,True)
            if days:expression['children'].append(metric(stage,scope+'.'+path,'LESS',days))
        persistence=number('above50Persistence',1,1,252,True)
        if persistence>=1:expression['children'].append(metric(stage,scope+'.aboveSMA50Sessions','ABOVE',persistence))
        confirm=boolean('requireBreakoutConfirmation')
        volume=number('minBreakoutVolume',1.5,0,100)
        close_range=number('minBreakoutCloseInRange',.7,0,1)
        extension=number('maxBreakoutExtensionPct',5,0,1000)
        age=number('maxBreakoutAge',5,0,1500,True)
        if confirm:
            if stage=='FORMING':raise ValueError('Breakout confirmation requires a post-breakout stage')
            expression['children'].extend([metric(stage,'breakout.volumeRatio','ABOVE',volume),metric(stage,'breakout.closeInRange','ABOVE',close_range),metric(stage,'breakout.throughPct','GREATER',0)])
            if stage=='FRESH_BREAKOUT':expression['children'].extend([metric(stage,'breakoutAgeSessions','BELOW',age),metric(stage,'distanceFromPivotPct','ABOVE',0),metric(stage,'distanceFromPivotPct','BELOW',extension)])
        first=parameters.get('requireFirstBase',preset.get('setupFamily')=='ipo')
        if not isinstance(first,bool):raise ValueError('requireFirstBase must be boolean')
        expression['children']=[node for node in expression['children'] if node.get('params',{}).get('metric')!='firstEligibleBase']
        if first:expression['children'].append(metric(stage,'firstEligibleBase','EQUAL',1))
        ath=parameters.get('athPolicy','INTRADAY_AVAILABLE')
        if ath not in ('CLOSING_AVAILABLE','INTRADAY_AVAILABLE','AUDITED_INTRADAY'):raise ValueError('Unsupported ATH policy')
        if preset.get('setupFamily')=='blue-sky' and ath!='CLOSING_AVAILABLE':
            scope='current' if stage=='FORMING' else 'selection'
            expression['children'].extend([metric(stage,scope+'.historyCoverageComplete','EQUAL',1),metric(stage,scope+'.pivotVsHistoricalIntradayHigh','ABOVE',0)])
            if ath=='AUDITED_INTRADAY':expression['children'].append(metric(stage,scope+'.lifetimePriceHistoryVerified','EQUAL',1))
    return expression
