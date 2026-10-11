import { ChevronLeft, ChevronRight } from 'lucide-react';

type Props = { page: number; pageSize: number; total: number; busy?: boolean; onPageChange: (page: number) => void };

/** Always reserves the same space, including empty and single-page results. */
export function Pagination({ page, pageSize, total, busy = false, onPageChange }: Props) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <nav className="pagination" aria-label="Results pagination">
    <span className="pagination-range">{total ? ((page - 1) * pageSize + 1).toLocaleString('en-IN') : 0}-{Math.min(page * pageSize, total).toLocaleString('en-IN')} <span>of</span> {total.toLocaleString('en-IN')}</span>
    <div className="pagination-controls">
      <button type="button" className="button button-secondary" disabled={busy || page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft size={15} />Previous</button>
      <span className="pagination-page">{page} <span>/</span> {pages}</span>
      <button type="button" className="button button-secondary" disabled={busy || page >= pages} onClick={() => onPageChange(page + 1)}>Next<ChevronRight size={15} /></button>
    </div>
  </nav>;
}
