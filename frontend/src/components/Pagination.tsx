import { ChevronLeft, ChevronRight } from 'lucide-react';

type Props = { page: number; pageSize: number; total: number; busy?: boolean; onPageChange: (page: number) => void };

/** Always reserves the same space, including empty and single-page results. */
export function Pagination({ page, pageSize, total, busy = false, onPageChange }: Props) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pages);
  return <nav className="pagination" aria-label="Results pagination">
    <span className="pagination-range">{total ? ((safePage - 1) * pageSize + 1).toLocaleString('en-IN') : 0}-{Math.min(safePage * pageSize, total).toLocaleString('en-IN')} <span>of</span> {total.toLocaleString('en-IN')}</span>
    <div className="pagination-controls">
      <button type="button" className="button button-secondary" disabled={busy || safePage <= 1} onClick={() => onPageChange(safePage - 1)}><ChevronLeft size={15} />Previous</button>
      <span className="pagination-page">{safePage} <span>/</span> {pages}</span>
      <button type="button" className="button button-secondary" disabled={busy || safePage >= pages} onClick={() => onPageChange(safePage + 1)}>Next<ChevronRight size={15} /></button>
    </div>
  </nav>;
}
