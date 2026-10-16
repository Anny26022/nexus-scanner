import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { candleValues, ChartLegend, updateCandleValues } from '../components/ChartLegend';

afterEach(cleanup);
const bar={date:'2026-03-23',open:1.25,high:1.25,low:1.20,close:1.25,volume:2100};
it('renders a compact real-metrics strip and readable OHLC values',()=>{
  render(<ChartLegend symbol="QUINTEGRA" bar={bar} previous={bar} metrics={{marketCapCrore:5,freeFloatPct:100,circuitLimit:'5%'}} sessionDate="2026-03-23"/>);
  expect(screen.getByLabelText('QUINTEGRA snapshot metrics')).toHaveTextContent('MCap₹5 CrFF MCap₹5 CrCircuit5');
  const output=screen.getByLabelText('QUINTEGRA candle values');
  expect(output).toHaveTextContent('23 Mar 2026'); expect(output).toHaveTextContent('+0.00%'); expect(output).toHaveTextContent('2.1K');
  expect(output.querySelector('[data-quote="low"]')).toHaveTextContent('1.20');
});
it('omits missing/invalid metrics and updates hovered quote fields without replacing markup',()=>{
  render(<ChartLegend symbol="TEST" bar={bar} metrics={{marketCapCrore:NaN,freeFloatPct:50,circuitLimit:'unknown'}}/>);
  expect(screen.queryByText('MCap')).not.toBeInTheDocument(); expect(screen.queryByText('Circuit')).not.toBeInTheDocument();
  const output=screen.getByLabelText('TEST candle values') as HTMLOutputElement;
  const close=output.querySelector('[data-quote="close"]');
  updateCandleValues(output,{...bar,close:1,volume:null},bar);
  expect(output.querySelector('[data-quote="close"]')).toBe(close);
  expect(close).toHaveTextContent('1.00'); expect(output.querySelector('[data-quote="change"]')).toHaveTextContent('-20.00%');
  expect(output.querySelector('[data-quote="change"]')).toHaveAttribute('data-tone','down');
  expect(candleValues(bar).change).toBe('-');
});
