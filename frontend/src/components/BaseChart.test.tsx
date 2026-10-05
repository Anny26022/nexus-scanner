import { describe,it,expect } from 'vitest';
import { render,screen } from '@testing-library/react';
import { BaseChartPlot,chartGeometry } from './BaseChart';
import type { ChartSnapshot } from '../api/realAdapter';
const chart:ChartSnapshot={schemaVersion:1,symbol:'TEST',asOfDate:'2026-09-24',historyStartDate:'2026-09-21',
  candles:[{date:'2026-09-21',open:100,high:101,low:99,close:100,volume:100},
    {date:'2026-09-22',open:94,high:95,low:93,close:94,volume:50},
    {date:'2026-09-23',open:94,high:96,low:93,close:95,volume:40},
    {date:'2026-09-24',open:102,high:104,low:101,close:103,volume:200}],
  volumeEvents:{},corporateActions:[],earnings:[],regulatoryAnnouncements:[],marketNews:[]};
const record={pivot:100,base:{startDate:'2026-09-21',endDate:'2026-09-23',floor:93,depthPct:7,atrContraction:.6,volumeDryUp:.5},breakout:{date:'2026-09-24'}};
describe('base chart overlays',()=>{
  it('ends the base before breakout and positions pivot using its price',()=>{
    const g=chartGeometry(chart,record)!;
    expect(g.startIndex).toBe(0);expect(g.endIndex).toBe(2);expect(g.breakoutIndex).toBe(3);
    expect(g.y(100)).toBeLessThan(g.y(93));
  });
  it('renders independently identifiable range, pivot and breakout overlays',()=>{
    render(<BaseChartPlot chart={chart} record={record}/>);
    expect(screen.getByTestId('base-range')).toBeInTheDocument();
    expect(screen.getByTestId('base-pivot')).toBeInTheDocument();
    expect(screen.getByTestId('base-breakout')).toBeInTheDocument();
    expect(screen.getByText(/Depth 7.00%/)).toBeInTheDocument();
  });
  it('supports no detected base and missing history without fabricated overlays',()=>{
    expect(chartGeometry({...chart,candles:[]})).toBe(null);
    render(<BaseChartPlot chart={chart}/>);
    expect(screen.queryByTestId('base-range')).not.toBeInTheDocument();
  });
});
