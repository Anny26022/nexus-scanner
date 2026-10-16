import { Sun, Moon, ArrowUpRight, PanelLeftClose } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';

interface NavbarProps {
  activeTab: 'screener' | 'ipo' | 'charts';
  onTabChange: (tab: 'screener' | 'ipo' | 'charts') => void;
  onHideSidebar: () => void;
  sessionDate?: string;
}

export function Navbar({ activeTab, onTabChange, onHideSidebar, sessionDate }: NavbarProps) {
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
      <button type="button" aria-current={activeTab === 'screener' ? 'page' : undefined} onClick={() => onTabChange('screener')}><span>Screener</span><ArrowUpRight className="nav-arrow" size={14} /></button>
      <button type="button" aria-current={activeTab === 'ipo' ? 'page' : undefined} onClick={() => onTabChange('ipo')}><span>IPO Catalogue</span><ArrowUpRight className="nav-arrow" size={14} /></button>
      <button type="button" aria-current={activeTab === 'charts' ? 'page' : undefined} onClick={() => onTabChange('charts')}><span>Charts</span><ArrowUpRight className="nav-arrow" size={14} /></button>
    </nav>
    <div className="sidebar-footer">
      {sessionDate && <div className="mobile-session-badge"><span>{new Date(`${sessionDate}T00:00:00`).toLocaleDateString('en-IN', {day: 'numeric', month: 'short', year: 'numeric'})}</span></div>}
      <div className="theme-control" role="group" aria-label="Appearance">
        {([{id: 'light', label: 'Light appearance', Icon: Sun}, {id: 'dark', label: 'Dark appearance', Icon: Moon}] as const).map(({id, label, Icon}) =>
          <button type="button" key={id} aria-label={label} title={label} aria-pressed={choice === id} onClick={() => setChoice(id)}><Icon size={16} /></button>)}
      </div>
    </div>
  </header>;
}
