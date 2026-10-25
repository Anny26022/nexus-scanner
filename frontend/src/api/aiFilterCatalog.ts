import type {ConditionDef, ParameterSpec} from '../types/screener';
import type {FilterChoices} from '../types/filterChoices';
import {FILTER_CONDITION_CATALOG} from '../data/conditionCatalog';
import {PRESET_CATALOG} from '../data/presetCatalog';
import {PRESET_ELIGIBILITY} from '../data/presetEligibility';
import technicalConfigurations from '../data/snapshotTechnicals.json';
import {SNAPSHOT_MA_PERIODS} from './snapshotScreen';
import {availableFilterParameters, isAvailableCondition} from '../utils/filterAvailability';
import {isExtendedCondition} from '../data/extendedMetrics';

export type AiParameter = ParameterSpec & {nullable?: boolean};
export type AiFilterDefinition = Omit<ConditionDef, 'parameters'> & {parameters: AiParameter[]};

/** The same evaluator capability checks and release choices used by the filter editor. */
export function createAiFilterCatalog(choices?: FilterChoices): AiFilterDefinition[] {
  return [...FILTER_CONDITION_CATALOG, ...PRESET_CATALOG].flatMap(def => {
    const defaults = availableFilterParameters(def);
    if (!defaults) return [];
    const preset = def.id.startsWith('lib-');
    const source: AiParameter[] = preset ? PRESET_ELIGIBILITY.map(rule => ({id:rule.id,label:rule.label,
      type:'number',defaultValue:rule.defaultValue,min:0,unit:rule.unit,nullable:true})) : def.parameters;
    const fixed = technicalConfigurations.find(config=>config.id === def.id)?.fixed as Record<string,unknown> | undefined;
    const parameters = source.map((parameter): AiParameter => {
      let p = {...parameter,defaultValue:defaults[parameter.id] ?? parameter.defaultValue};
      if (fixed && Object.hasOwn(fixed,p.id)) {
        const value = fixed[p.id];
        p = {...p,defaultValue:value,type:'select',options:[{value,label:String(value)}]};
      }
      if (['PRICE_VS_EMA','PRICE_VS_SMA'].includes(def.id) && p.id === 'period'
          || def.id === 'AVG_VOLUME_RATIO' && ['recentDays','baseDays'].includes(p.id)) {
        const periods = def.id === 'AVG_VOLUME_RATIO' ? [10,30,60,90] : SNAPSHOT_MA_PERIODS;
        p = {...p,type:'select',options:periods.map(value=>({value,label:String(value)}))};
      }
      if (def.id === 'PRICE_VS_SMA' && p.id === 'persistDays' || def.id === 'VOLUME_VS_AVG' && ['avgDays','withinDays'].includes(p.id)) {
        p = {...p,type:'select',options:[{value:p.defaultValue,label:String(p.defaultValue)}]};
      }
      if (def.id === 'RS_RATING' && p.id === 'window' || def.id === 'PE_RATIO' && p.id === 'reportType'
          || def.id === 'FUNDAMENTAL_METRIC' && p.id === 'metric'
          || def.id === 'AVG_TURNOVER' && p.id === 'windowMinutes') {
        p = {...p,options:p.options?.filter(option=>isAvailableCondition({instanceId:'catalog',conditionId:def.id,
          parameters:{...defaults,[p.id]:option.value}}))};
      }
      if (isExtendedCondition(def.id) && p.id === 'metric' && choices) {
        p = {...p,options:p.options?.filter(option=>choices.TRADINGVIEW_METRIC?.includes(option.value))};
        p.defaultValue = p.options?.[0]?.value;
      }
      if (['SECTOR','INDUSTRY','SERIES','PRICE_BAND','INDEX_MEMBERSHIP','NARRATIVE'].includes(def.id) && choices) {
        const raw = choices[def.id as keyof FilterChoices];
        const values = Array.isArray(raw) ? raw : [];
        p = {...p,type:def.id === 'INDEX_MEMBERSHIP' ? 'select' : 'multiselect',
          options:values.map(value=>({value,label:value})),defaultValue:def.id === 'INDEX_MEMBERSHIP' ? values[0] : values.slice(0,1)};
      }
      return p;
    });
    if (parameters.some(p=>['select','multiselect'].includes(p.type) && !p.options?.length)) return [];
    return [{...def,parameters}];
  });
}
