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
    return deepcopy(output)
