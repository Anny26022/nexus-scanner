import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './Button';

type Props = { page: number; pageSize: number; total?: number; busy?: boolean; onPageChange: (page: number) => void; onPageSizeChange?: (size: number) => void };

/** Always reserves the same space, including empty, single-page and not-yet-loaded results. */
export function Pagination({ page, pageSize, total, busy = false, onPageChange, onPageSizeChange }: Props) {
  const known = typeof total === 'number';
  const pages = known ? Math.max(1, Math.ceil(total / pageSize)) : undefined;
  const safePage = pages === undefined ? Math.max(1, page) : Math.min(Math.max(1, page), pages);
  return <nav className="pagination" aria-label="Results pagination">
    <span className="pagination-range">{known
      ? <>{total ? ((safePage - 1) * pageSize + 1).toLocaleString('en-IN') : 0}-{Math.min(safePage * pageSize, total).toLocaleString('en-IN')} <span>of</span> {total.toLocaleString('en-IN')}</>
      : <>— <span>of</span> —</>}</span>
    <div className="pagination-controls">
      {onPageSizeChange && <label className="pagination-size">Rows <select aria-label="Rows per page" value={pageSize} disabled={busy}
        onChange={event => onPageSizeChange(Number(event.target.value))}>
        {[15, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}
      </select></label>}
      <Button variant="secondary" disabled={busy || pages === undefined || safePage <= 1} onClick={() => onPageChange(safePage - 1)}><ChevronLeft size={15} />Previous</Button>
      <span className="pagination-page">{safePage} <span>/</span> {pages ?? '…'}</span>
      <Button variant="secondary" disabled={busy || pages === undefined || safePage >= pages} onClick={() => onPageChange(safePage + 1)}>Next<ChevronRight size={15} /></Button>
    </div>
  </nav>;
}
