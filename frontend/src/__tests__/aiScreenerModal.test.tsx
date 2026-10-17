import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {AiScreenerModal} from '../components/AiScreenerModal';
import {compileNaturalLanguageQuery} from '../api/aiScreenerCompiler';
import {validateAiScreenResult} from '../api/aiScreenerContract';

vi.mock('../api/aiScreenerCompiler',async original=>({
  ...await original<typeof import('../api/aiScreenerCompiler')>(), compileNaturalLanguageQuery:vi.fn(),
}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const compiled = () => validateAiScreenResult({name:'Above moving averages',summary:'Match either condition.',matchMode:'any',
  clauses:[{sourceText:'above 200 EMA',status:'EXACT',conditionId:'PRICE_VS_MAS',parameters:{rules:['ABOVE_EMA_200']}}]});
function setup() {
  const apply=vi.fn(), edit=vi.fn(), close=vi.fn();
  render(<QueryClientProvider client={new QueryClient()}><AiScreenerModal isOpen onClose={close}
    onApplyConditions={apply} onOpenFilterEditor={edit}/></QueryClientProvider>);
  fireEvent.change(screen.getByRole('textbox',{name:'Describe your screen'}),{target:{value:'above 200 EMA'}});
  fireEvent.click(screen.getByRole('button',{name:'Compile screen'}));
  return {apply, edit, close};
}
it('preserves compiled OR logic when the user runs the preview',async()=>{
  const result=compiled();
  vi.mocked(compileNaturalLanguageQuery).mockResolvedValue(result);
  const {apply}=setup();
  fireEvent.click(await screen.findByRole('button',{name:'Run this screen'}));
  expect(apply).toHaveBeenCalledWith(result.conditionsMap,true,'any');
});
it('blocks running partial screens but lets the user explicitly edit the supported subset',async()=>{
  const result=compiled();
  result.unsupportedClauses=['MACD crossover'];
  result.clauses.push({sourceText:'MACD crossover',status:'UNSUPPORTED',label:'Unavailable'});
  vi.mocked(compileNaturalLanguageQuery).mockResolvedValue(result);
  const {apply,edit}=setup();
  expect(await screen.findByRole('button',{name:'Run this screen'})).toBeDisabled();
  expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Edit supported filters'}));
  expect(edit).toHaveBeenCalledWith(result.conditionsMap,'any');
});
it('shows inference errors without exposing an executable screen',async()=>{
  vi.mocked(compileNaturalLanguageQuery).mockRejectedValue(new Error('Workers AI unavailable'));
  const {apply}=setup();
  expect(await screen.findByRole('alert')).toHaveTextContent('Workers AI unavailable');
  expect(screen.queryByRole('button',{name:'Run this screen'})).not.toBeInTheDocument();
  expect(apply).not.toHaveBeenCalled();
});
