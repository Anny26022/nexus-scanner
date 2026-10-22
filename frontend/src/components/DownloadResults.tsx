import { useState } from 'react';
import { Download } from 'lucide-react';
import { formatCsvResults } from '../utils/copyResults';
import { Button } from './Button';

export interface DownloadResultsColumn<T = any> {
  id: string;
  label: string;
  getValue?: (row: T) => unknown;
}

export interface DownloadResultsProps<T = any> {
  loadRows: () => Promise<T[]>;
  columns: DownloadResultsColumn<T>[];
  filename?: string;
  disabled?: boolean;
}

export function DownloadResults<T = any>({
  loadRows,
  columns,
  filename = 'nexus-results.csv',
  disabled = false,
}: DownloadResultsProps<T>) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (downloading || disabled) return;
    setDownloading(true);
    try {
      const rows = await loadRows();
      if (!rows || !rows.length) return;
      const csvContent = formatCsvResults(rows as unknown as Record<string, unknown>[], columns);
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to download CSV:', err);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Button
      variant="secondary"
      className="results-copy-button"
      aria-label={downloading ? 'Downloading CSV' : 'Download CSV'}
      title="Download CSV"
      disabled={disabled || downloading}
      onClick={() => void handleDownload()}
    >
      <Download size={14} />
    </Button>
  );
}
