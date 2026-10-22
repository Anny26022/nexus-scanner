import type { ReactNode } from 'react';
import { Sun, Moon, ArrowUpRight, PanelLeftClose, ScanSearch, Rocket, CandlestickChart } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';

interface NavbarProps {
  activeTab: 'screener' | 'ipo' | 'charts';
  onTabChange: (tab: 'screener' | 'ipo' | 'charts') => void;
  onHideSidebar: () => void;
  sessionControl?: ReactNode;
}

const NAV_ITEMS = [
  { id: 'screener', label: 'Screener', Icon: ScanSearch },
  { id: 'ipo', label: 'IPO Catalogue', Icon: Rocket },
  { id: 'charts', label: 'Charts', Icon: CandlestickChart },
] as const;

export function Navbar({ activeTab, onTabChange, onHideSidebar, sessionControl }: NavbarProps) {
  const { choice, setChoice } = useTheme();
  return <header className="app-sidebar">
    <div className="sidebar-brand-row"><div className="brand"><svg className="brand-mark" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="11" stroke="currentColor" strokeWidth="0.5" fill="none" />
      <path d="M12 4L16 12L12 20L8 12L12 4Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M8 12H16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <path d="M12 7L14 12L12 17" stroke="currentColor" strokeWidth="0.75" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="12" cy="12" r="6" stroke="currentColor" strokeWidth="0.25" strokeOpacity="0.3" fill="none" />
    </svg><span>Nexus <span className="brand-subtitle">Screener</span></span></div><button type="button" className="sidebar-toggle" aria-label="Hide sidebar" title="Hide sidebar" onClick={onHideSidebar}><PanelLeftClose size={16}/></button></div>
    <nav className="primary-nav" aria-label="Main navigation">
      {NAV_ITEMS.map(({id, label, Icon}) => (
        <button key={id} type="button" aria-current={activeTab === id ? 'page' : undefined} onClick={() => onTabChange(id)}>
          <Icon size={16} aria-hidden="true" />
          <span>{label}</span>
          <ArrowUpRight className="nav-arrow" size={14} aria-hidden="true" />
        </button>
      ))}
    </nav>
    {sessionControl && <div className="sidebar-session">
      <span className="sidebar-session-label">Session</span>
      {sessionControl}
    </div>}
    <div className="sidebar-footer">
      <div className="theme-control" role="group" aria-label="Appearance">
        {([{id: 'light', label: 'Light appearance', Icon: Sun}, {id: 'dark', label: 'Dark appearance', Icon: Moon}] as const).map(({id, label, Icon}) =>
          <button type="button" key={id} aria-label={label} title={label} aria-pressed={choice === id} onClick={() => setChoice(id)}><Icon size={16} /></button>)}
      </div>
    </div>
  </header>;
}
