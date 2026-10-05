import { ConditionDef } from '../types/screener';
import nativeConditions from './nativeConditions.json';
import baseMetrics from './baseMetrics.json';
import { baseMetricLabel } from '../utils/baseMetricLabel';

const INDICATOR_OPTIONS = [
  'CLOSE','OPEN','HIGH','LOW','VOLUME','HL2','HLC3','OHLC4','SMA','EMA','WMA','VOLUME_SMA',
  'RSI','MACD','MACD_SIGNAL','MACD_HIST','STOCH_K','STOCH_D','CCI','WILLIAMS_R','MFI','ROC','OBV',
  'ADX','PLUS_DI','MINUS_DI','ATR','SUPERTREND','SUPERTREND_DIRECTION','BB_UPPER','BB_MIDDLE','BB_LOWER','BB_PCTB','BB_WIDTH',
  'DONCHIAN_UPPER','DONCHIAN_LOWER',
].map(value => ({ label: value.replaceAll('_', ' '), value }));

const OSCILLATOR_OPTIONS = ['RSI','MACD','MACD_HIST','STOCH_K','CCI','MFI','WILLIAMS_R','ROC','OBV']
  .map(value => ({ label: value.replaceAll('_', ' '), value }));

const ADVANCED_TECHNICAL_CONDITIONS: ConditionDef[] = [
  {
    id: 'INDICATOR_COMPARE', label: 'Indicator Compare / Crossover', category: 'trend',
    description: 'Compare any supported indicator with a fixed value or another indicator, including recent crossovers and offsets.',
    parameters: [
      { id:'leftIndicator', label:'Indicator', type:'select', defaultValue:'RSI', options:INDICATOR_OPTIONS },
      { id:'leftPeriod', label:'Period', type:'number', defaultValue:14, min:1, max:500, step:1 },
      { id:'leftOffset', label:'Offset', type:'number', defaultValue:0, min:0, max:250, step:1, unit:'bars' },
      { id:'op', label:'Test', type:'select', defaultValue:'ABOVE', options:[
        {label:'> Greater',value:'GREATER'},{label:'≥ At or above',value:'ABOVE'},
        {label:'= Equal',value:'EQUAL'},{label:'≤ At or below',value:'BELOW'},{label:'< Less',value:'LESS'},
        {label:'Crosses above',value:'CROSSES_ABOVE'},{label:'Crosses below',value:'CROSSES_BELOW'},
      ]},
      { id:'rightIndicator', label:'Against', type:'select', defaultValue:'', options:[{label:'Fixed value',value:''},...INDICATOR_OPTIONS] },
      { id:'rightValue', label:'Value', type:'number', defaultValue:60 },
      { id:'rightPeriod', label:'Its period', type:'number', defaultValue:20, min:1, max:500, step:1 },
      { id:'rightOffset', label:'Its offset', type:'number', defaultValue:0, min:0, max:250, step:1, unit:'bars' },
      { id:'withinDays', label:'Fired within', type:'number', defaultValue:1, min:1, max:250, step:1, unit:'d' },
    ],
  },
  {
    id:'MA_CONVERGENCE', label:'MA Convergence', category:'trend',
    description:'Compare the normalized spread between selected moving averages with a percentage threshold of the close.',
    parameters:[
      {id:'periods',label:'Periods',type:'string',defaultValue:'9,20,50,200'},
      {id:'maType',label:'Average',type:'select',defaultValue:'EMA',options:[{label:'EMA',value:'EMA'},{label:'SMA',value:'SMA'},{label:'WMA',value:'WMA'}]},
      {id:'comparison',label:'Comparison',type:'select',defaultValue:'BELOW',options:[{label:'At most (tight convergence)',value:'BELOW'},{label:'At least (minimum spread)',value:'ABOVE'}]},
      {id:'maxSpreadPct',label:'Spread threshold',type:'number',defaultValue:1.5,min:0,max:100,step:.1,unit:'%'},
      {id:'withinDays',label:'Within',type:'number',defaultValue:1,min:1,max:250,unit:'d'},
    ],
  },
  {
    id:'DIVERGENCE', label:'Price / Oscillator Divergence', category:'trend',
    description:'Confirmed regular or hidden bullish/bearish divergence between price and oscillator fractal pivots.',
    parameters:[
      {id:'oscillator',label:'Oscillator',type:'select',defaultValue:'RSI',options:OSCILLATOR_OPTIONS},
      {id:'oscPeriod',label:'Period',type:'number',defaultValue:14,min:1,max:250,step:1},
      {id:'direction',label:'Direction',type:'select',defaultValue:'BULLISH',options:[{label:'Bullish',value:'BULLISH'},{label:'Bearish',value:'BEARISH'}]},
      {id:'variant',label:'Type',type:'select',defaultValue:'REGULAR',options:[{label:'Regular',value:'REGULAR'},{label:'Hidden',value:'HIDDEN'}]},
      {id:'maxBarDifference',label:'Pivot gap',type:'number',defaultValue:1,min:0,max:20,step:1,unit:'bars'},
      {id:'pivotLeft',label:'Pivot left',type:'number',defaultValue:5,min:1,max:30,step:1,unit:'bars'},
      {id:'pivotRight',label:'Confirm right',type:'number',defaultValue:3,min:1,max:30,step:1,unit:'bars'},
      {id:'lookbackDays',label:'Lookback',type:'number',defaultValue:120,min:20,max:1000,step:1,unit:'d'},
      {id:'withinDays',label:'Fired within',type:'number',defaultValue:8,min:1,max:250,step:1,unit:'d'},
      {id:'invalidateOnBreak',label:'Invalidate if broken',type:'boolean',defaultValue:true},
    ],
  },
  {
    id:'SUPERTREND', label:'Supertrend Direction', category:'trend',
    description:'Wilder-ATR Supertrend is bullish or bearish, or turned into that direction recently.',
    parameters:[
      {id:'period',label:'ATR period',type:'number',defaultValue:10,min:1,max:100,step:1},
      {id:'multiplier',label:'Multiplier',type:'number',defaultValue:3,min:.1,max:20,step:.1},
      {id:'direction',label:'Direction',type:'select',defaultValue:'BULLISH',options:[{label:'Bullish (green)',value:'BULLISH'},{label:'Bearish (red)',value:'BEARISH'}]},
      {id:'signal',label:'Match',type:'select',defaultValue:'STATE',options:[{label:'Current state',value:'STATE'},{label:'Recent turn',value:'TURN'}]},
      {id:'withinDays',label:'Within',type:'number',defaultValue:1,min:1,max:250,step:1,unit:'d'},
    ],
  },
];

const BASE_STAGE_PARAMETER: ConditionDef['parameters'][number] = {
  id:'stage',label:'Stage',type:'select',defaultValue:'FORMING',options:[
    {label:'Forming',value:'FORMING'},{label:'Fresh breakout',value:'FRESH_BREAKOUT'},
    {label:'Holding',value:'HOLDING'},{label:'Played out',value:'PLAYED_OUT'}],
};
const BASE_METRIC_PARAMETERS: ConditionDef['parameters'] = [BASE_STAGE_PARAMETER,
  {id:'metric',label:'Metric',type:'select',defaultValue:'base.depthPct',options:baseMetrics.map(value=>({label:baseMetricLabel(value),value}))},
  {id:'comparison',label:'Comparison',type:'select',defaultValue:'BELOW',options:[
    {label:'> Greater',value:'GREATER'},{label:'≥ At or above',value:'ABOVE'},{label:'= Equal',value:'EQUAL'},
    {label:'≤ At or below',value:'BELOW'},{label:'< Less',value:'LESS'}]},
  {id:'value',label:'Value',type:'number',defaultValue:25},
];
const BASE_CONDITIONS: ConditionDef[] = [
  {id:'BASE_STAGE',label:'Base stage / holding',category:'range',description:'Select one detected base at this stage. Every base condition uses the same episode.',parameters:[BASE_STAGE_PARAMETER,
    {id:'holdingPolicy',label:'Holding',type:'select',defaultValue:'ANY',options:[{label:'Any',value:'ANY'},
      {label:'Always above pivot',value:'STRICT'},{label:'Retests allowed; above now',value:'RETEST'}]}]},
  {id:'BASE_METRIC',label:'Base quality / strength',category:'range',description:'Compare a metric within the selected base. Breakout base measurements are frozen.',parameters:BASE_METRIC_PARAMETERS},
  {id:'BASE_FORMULA',label:'Base metric arithmetic',category:'range',description:'Compare arithmetic within one selected base. An optional expression supports parentheses and +, −, ×, ÷.',parameters:[...BASE_METRIC_PARAMETERS,
    {id:'formula',label:'Expression (optional)',type:'string',defaultValue:''},
    {id:'arithmetic',label:'Operation',type:'select',defaultValue:'DIVIDE',options:['ADD','SUBTRACT','MULTIPLY','DIVIDE'].map(value=>({label:value.toLowerCase(),value}))},
    {id:'rightMetric',label:'Second metric',type:'select',defaultValue:'base.volumeDryUp',options:baseMetrics.map(value=>({label:baseMetricLabel(value),value}))}]},
];
export const NEXUS_CONDITION_CATALOG: ConditionDef[] = [
  ...BASE_CONDITIONS,
  ...ADVANCED_TECHNICAL_CONDITIONS,
  ...nativeConditions as ConditionDef[],
  // --- TREND ---
  {
    id: 'trend_price_vs_ma',
    label: 'Price vs Moving Average',
    category: 'trend',
    description: 'Screen stocks trading above or below specific SMA or EMA levels',
    parameters: [
      {
        id: 'maType',
        label: 'MA Type',
        type: 'select',
        defaultValue: 'SMA',
        options: [
          { label: 'SMA', value: 'SMA' },
          { label: 'EMA', value: 'EMA' },
        ],
      },
      {
        id: 'maPeriod',
        label: 'MA Period',
        type: 'select',
        defaultValue: 50,
        options: [
          { label: '10 Period', value: 10 },
          { label: '20 Period', value: 20 },
          { label: '50 Period', value: 50 },
          { label: '200 Period', value: 200 },
        ],
      },
      {
        id: 'operator',
        label: 'Position',
        type: 'select',
        defaultValue: 'above',
        options: [
          { label: 'Above', value: 'above' },
          { label: 'Below', value: 'below' },
          { label: 'Within % Range', value: 'within_pct' },
        ],
      },
      {
        id: 'thresholdPct',
        label: 'Threshold %',
        type: 'number',
        defaultValue: 0,
        min: -50,
        max: 100,
        unit: '%',
      },
    ],
  },
  {
    id: 'trend_ma_stack',
    label: 'Moving Average Stack Order',
    category: 'trend',
    description: 'Check if shorter MAs are aligned strictly above longer MAs (Bullish Stack)',
    parameters: [
      {
        id: 'stackOrder',
        label: 'Stack Alignment',
        type: 'select',
        defaultValue: '20_above_50_above_200',
        options: [
          { label: 'EMA 20 > EMA 50 > EMA 200 (Bullish)', value: '20_above_50_above_200' },
          { label: 'SMA 10 > SMA 20 > SMA 50', value: '10_above_20_above_50' },
          { label: 'EMA 200 > EMA 50 > EMA 20 (Bearish)', value: 'bearish_stack' },
        ],
      },
    ],
  },
  {
    id: 'trend_ma_slope',
    label: 'MA Slope & Trajectory',
    category: 'trend',
    description: 'Filter by slope angle or percentage change of moving average over N bars',
    parameters: [
      {
        id: 'targetMa',
        label: 'Target MA',
        type: 'select',
        defaultValue: 50,
        options: [
          { label: 'SMA 20', value: 20 },
          { label: 'SMA 50', value: 50 },
          { label: 'SMA 200', value: 200 },
        ],
      },
      {
        id: 'minSlopePct',
        label: 'Min 20-Day MA Change %',
        type: 'number',
        defaultValue: 1.5,
        min: -20,
        max: 50,
        unit: '%',
      },
    ],
  },
  {
    id: 'trend_persistent_momentum',
    label: 'Persistent Trend Momentum',
    category: 'trend',
    description: 'Stocks maintaining price above 20 EMA for a minimum consecutive number of sessions',
    parameters: [
      {
        id: 'minDaysAboveEMA',
        label: 'Min Days Above 20 EMA',
        type: 'number',
        defaultValue: 10,
        min: 1,
        max: 100,
      }
    ],
  },
  {
    id: 'trend_ema_reclaim',
    label: 'EMA Key Level Reclaim',
    category: 'trend',
    description: 'Price recently crossed back above a key EMA after pulling back',
    parameters: [
      {
        id: 'reclaimedEma',
        label: 'Reclaimed EMA',
        type: 'select',
        defaultValue: 'EMA 20',
        options: [
          { label: 'EMA 10', value: 'EMA 10' },
          { label: 'EMA 20', value: 'EMA 20' },
          { label: 'EMA 50', value: 'EMA 50' },
        ]
      },
      {
        id: 'reclaimedWithin',
        label: 'Reclaimed Within',
        type: 'number',
        defaultValue: 3,
        min: 1,
        max: 10,
        unit: 'days',
      }
    ],
  },
  {
    id: 'trend_pct_days_above_ma',
    label: '% Days Above Moving Average',
    category: 'trend',
    description: 'Percentage of trading days in the last 50 sessions trading above 50 SMA',
    parameters: [
      {
        id: 'minPctDays',
        label: 'Min % Days Above SMA 50',
        type: 'number',
        defaultValue: 80,
        min: 0,
        max: 100,
        unit: '%',
      }
    ],
  },

  // --- MOMENTUM & VOLUME ---
  {
    id: 'mom_rvol',
    label: 'Relative Volume (RVOL)',
    category: 'momentum',
    description: 'Compare current session volume against its 20-day average volume',
    parameters: [
      {
        id: 'minRvol',
        label: 'Min RVOL Multiple',
        type: 'number',
        defaultValue: 1.5,
        min: 0,
        max: 50,
        step: 0.1,
      },
      {
        id: 'maxRvol',
        label: 'Max RVOL Multiple',
        type: 'number',
        defaultValue: 20,
        min: 0,
        max: 100,
        step: 0.1,
      },
    ],
  },
  {
    id: 'mom_return',
    label: 'Price Return / Change %',
    category: 'momentum',
    description: 'Filter by price performance over 1 day, 1 week, 1 month, or 3 months',
    parameters: [
      {
        id: 'period',
        label: 'Period',
        type: 'select',
        defaultValue: '1D',
        options: [
          { label: '1 Session (1D)', value: '1D' },
          { label: '1 Week (5D)', value: '5D' },
          { label: '1 Month (21D)', value: '21D' },
          { label: '3 Months (63D)', value: '63D' },
        ],
      },
      {
        id: 'minReturn',
        label: 'Min Return %',
        type: 'number',
        defaultValue: 2,
        min: -100,
        max: 500,
        unit: '%',
      },
      {
        id: 'maxReturn',
        label: 'Max Return %',
        type: 'number',
        defaultValue: 100,
        min: -100,
        max: 1000,
        unit: '%',
      },
    ],
  },
  {
    id: 'mom_consecutive_up',
    label: 'Consecutive Up Days',
    category: 'momentum',
    description: 'Number of consecutive sessions closing higher than previous close',
    parameters: [
      {
        id: 'minConsecutiveDays',
        label: 'Min Consecutive Days',
        type: 'number',
        defaultValue: 3,
        min: 1,
        max: 20,
      }
    ],
  },
  {
    id: 'mom_gap',
    label: 'Session Gap Up / Gap Down',
    category: 'momentum',
    description: 'Opening price gap relative to previous session high/close',
    parameters: [
      {
        id: 'gapType',
        label: 'Gap Type',
        type: 'select',
        defaultValue: 'Gap Up',
        options: [
          { label: 'Gap Up', value: 'Gap Up' },
          { label: 'Gap Down', value: 'Gap Down' },
        ]
      },
      {
        id: 'minGapPct',
        label: 'Min Gap %',
        type: 'number',
        defaultValue: 2,
        min: 0,
        max: 50,
        step: 0.5,
        unit: '%',
      }
    ],
  },
  {
    id: 'mom_delivery_vol',
    label: 'NSE Delivery Volume %',
    category: 'momentum',
    description: 'Percentage of total traded volume taken for delivery',
    parameters: [
      {
        id: 'minDeliveryPct',
        label: 'Min Delivery %',
        type: 'number',
        defaultValue: 50,
        min: 0,
        max: 100,
        step: 5,
        unit: '%',
      }
    ]
  },

  // --- RANGE & PATTERNS ---
  {
    id: 'range_52w_proximity',
    label: 'Distance from 52-Week High / Low',
    category: 'range',
    description: 'Proximity of current price to 52-week peak or 52-week trough',
    parameters: [
      {
        id: 'target',
        label: 'Target Peak/Trough',
        type: 'select',
        defaultValue: 'High',
        options: [
          { label: 'Within % of 52-Week High', value: 'High' },
          { label: 'Within % of 52-Week Low', value: 'Low' },
        ],
      },
      {
        id: 'maxDistancePct',
        label: 'Max Distance %',
        type: 'number',
        defaultValue: 5,
        min: 0,
        max: 100,
        unit: '%',
      },
    ],
  },
  {
    id: 'range_contraction',
    label: 'Volatility Contraction (VCP)',
    category: 'range',
    description: 'Compare recent short-term price range to longer-term price range',
    parameters: [
      {
        id: 'shortPeriod',
        label: 'Short Period (Days)',
        type: 'number',
        defaultValue: 10,
        min: 3,
        max: 20,
      },
      {
        id: 'maxRatio',
        label: 'Max Range Ratio vs 60D',
        type: 'number',
        defaultValue: 0.5,
        min: 0.1,
        max: 1.0,
        step: 0.1,
      }
    ],
  },
  {
    id: 'range_inside_bar',
    label: 'Inside Bar Pattern',
    category: 'range',
    description: 'Price action contained entirely within previous sessions high and low',
    parameters: [
      {
        id: 'timeframe',
        label: 'Timeframe',
        type: 'select',
        defaultValue: 'Daily',
        options: [
          { label: 'Daily Inside Bar', value: 'Daily' },
          { label: 'Weekly Inside Bar', value: 'Weekly' },
        ]
      },
      {
        id: 'consecutive',
        label: 'Consecutive Bars',
        type: 'number',
        defaultValue: 1,
        min: 1,
        max: 5,
      }
    ],
  },

  // --- RELATIVE STRENGTH ---
  {
    id: 'rs_rating',
    label: 'Overall RS >',
    category: 'relative_strength',
    description: 'Proprietary 1-99 rating comparing stock performance vs broader market',
    parameters: [
      {
        id: 'minRsRating',
        label: 'Min RS',
        type: 'number',
        defaultValue: 0,
        min: 0,
        max: 99,
      },
    ],
  },
  {
    id: 'rs_1month',
    label: '1 Month RS >',
    category: 'relative_strength',
    description: '1-Month Relative Strength percentile rating',
    parameters: [
      {
        id: 'minRsRating',
        label: 'Min RS',
        type: 'number',
        defaultValue: 0,
        min: 0,
        max: 99,
      }
    ]
  },
  {
    id: 'rs_3month',
    label: '3 Month RS >',
    category: 'relative_strength',
    description: '3-Month Relative Strength percentile rating',
    parameters: [
      {
        id: 'minRsRating',
        label: 'Min RS',
        type: 'number',
        defaultValue: 0,
        min: 0,
        max: 99,
      }
    ]
  },
  {
    id: 'rs_divergence',
    label: 'RS Divergence Turn',
    category: 'relative_strength',
    description: 'Filter stocks showing relative strength while price is subdued',
    parameters: [
      {
        id: 'minRsVsNifty',
        label: 'Min 60d RS vs Nifty 50 (%)',
        type: 'number',
        defaultValue: 0,
        min: -50,
        max: 100,
      },
      {
        id: 'minBelowHigh',
        label: 'Min % Below 52w High',
        type: 'number',
        defaultValue: 30,
        min: 0,
        max: 100,
      }
    ],
  },

  // --- FUNDAMENTALS ---
  {
    id: 'fund_free_float',
    label: 'Free Float (%)',
    category: 'fundamentals',
    description: 'Percentage of shares available for public trading',
    parameters: [
      {
        id: 'minFloat',
        label: 'Min Float %',
        type: 'number',
        defaultValue: 0,
        min: 0,
        max: 100,
      },
      {
        id: 'maxFloat',
        label: 'Max Float %',
        type: 'number',
        defaultValue: 100,
        min: 0,
        max: 100,
      }
    ]
  },
  {
    id: 'fund_stock_price',
    label: 'Stock Price (₹) >',
    category: 'fundamentals',
    description: 'Minimum stock price',
    parameters: [
      {
        id: 'minPrice',
        label: 'Min Price',
        type: 'number',
        defaultValue: 50,
        min: 0,
        max: 100000,
      }
    ]
  },
  {
    id: 'fund_earnings_growth',
    label: 'Quarterly Earnings Growth (YoY)',
    category: 'fundamentals',
    description: 'Year-over-year percentage growth in most recent quarterly net profit',
    parameters: [
      {
        id: 'minGrowthPct',
        label: 'Min YoY Growth %',
        type: 'number',
        defaultValue: 20,
        min: -100,
        max: 1000,
        unit: '%',
      },
    ],
  },
  {
    id: 'fund_pe_ratio',
    label: 'Price to Earnings (P/E) Ratio',
    category: 'fundamentals',
    description: 'Current P/E multiple based on trailing 12 months earnings',
    parameters: [
      {
        id: 'minPe',
        label: 'Min P/E',
        type: 'number',
        defaultValue: 0,
        min: -50,
        max: 500,
      },
      {
        id: 'maxPe',
        label: 'Max P/E',
        type: 'number',
        defaultValue: 30,
        min: 0,
        max: 1000,
      },
    ],
  },
  {
    id: 'fund_roe',
    label: 'Return on Equity (ROE) %',
    category: 'fundamentals',
    description: 'Annual Return on Equity percentage',
    parameters: [
      {
        id: 'minRoe',
        label: 'Min ROE %',
        type: 'number',
        defaultValue: 15,
        min: -100,
        max: 100,
      }
    ]
  },

  // --- LIQUIDITY & MISC ---
  {
    id: 'liq_turnover',
    label: '50 Days Avg. Turnover (Cr.) >',
    category: 'liquidity',
    description: 'Minimum 50-day average daily traded value in Crores (INR)',
    parameters: [
      {
        id: 'minTurnoverCr',
        label: 'Min Turnover (Cr)',
        type: 'number',
        defaultValue: 5,
        min: 0,
        max: 10000,
        step: 1,
      },
    ],
  },
  {
    id: 'liq_market_cap',
    label: 'Market Cap Range (Cr.)',
    category: 'liquidity',
    description: 'Total market value of outstanding shares in Crores (INR)',
    parameters: [
      {
        id: 'minMarketCap',
        label: 'Min Mkt Cap',
        type: 'number',
        defaultValue: 1000,
        min: 0,
        max: 2000000,
        step: 100,
      },
      {
        id: 'maxMarketCap',
        label: 'Max Mkt Cap',
        type: 'number',
        defaultValue: 2000000,
        min: 0,
        max: 2000000,
        step: 100,
      },
    ],
  },
  {
    id: 'misc_fno_only',
    label: 'Include only F&O stock',
    category: 'liquidity',
    description: 'Filter for stocks available in the Futures & Options segment',
    parameters: [
      {
        id: 'isFno',
        label: 'Status',
        type: 'select',
        defaultValue: 'true',
        options: [
          { label: 'Yes', value: 'true' },
          { label: 'No', value: 'false' },
        ]
      }
    ]
  },
  {
    id: 'misc_exclude_circuit',
    label: 'Exclude Circuit Stocks',
    category: 'liquidity',
    description: 'Exclude stocks hitting circuit limits or in specific bands',
    parameters: [
      {
        id: 'circuitBands',
        label: 'Band limit to exclude',
        type: 'multiselect',
        defaultValue: ['5', '10'],
        options: [
          { label: '5% Circuit Limit', value: '5' },
          { label: '10% Circuit Limit', value: '10' },
          { label: '20% Circuit Limit', value: '20' },
        ]
      }
    ]
  }
];
