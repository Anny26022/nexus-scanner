import { Monitor, Sun, Moon, ArrowUpRight } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';

interface NavbarProps {
  activeTab: 'screener' | 'ipo';
  onTabChange: (tab: 'screener' | 'ipo') => void;
}

export function Navbar({ activeTab, onTabChange }: NavbarProps) {
  const { choice, setChoice } = useTheme();
  return <header className="app-sidebar">
    <div className="brand"><svg className="brand-mark" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="11" stroke="currentColor" strokeWidth="0.5" fill="none" />
      <path d="M12 4L16 12L12 20L8 12L12 4Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M8 12H16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <path d="M12 7L14 12L12 17" stroke="currentColor" strokeWidth="0.75" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="12" cy="12" r="6" stroke="currentColor" strokeWidth="0.25" strokeOpacity="0.3" fill="none" />
    </svg><span>Nexus <span className="brand-subtitle">Screener</span></span></div>
    <nav className="primary-nav" aria-label="Main navigation">
      <button type="button" aria-current={activeTab === 'screener' ? 'page' : undefined} onClick={() => onTabChange('screener')}><span>Screener</span><ArrowUpRight className="nav-arrow" size={14} /></button>
      <button type="button" aria-current={activeTab === 'ipo' ? 'page' : undefined} onClick={() => onTabChange('ipo')}><span>IPO Catalogue</span><ArrowUpRight className="nav-arrow" size={14} /></button>
    </nav>
    <div className="sidebar-footer">
      <p className="sidebar-note">A clearer view of<br />the Indian market.</p>
      <div className="theme-control" role="group" aria-label="Appearance">
        {([{id: 'light', label: 'Light appearance', Icon: Sun}, {id: 'system', label: 'System appearance', Icon: Monitor}, {id: 'dark', label: 'Dark appearance', Icon: Moon}] as const).map(({id, label, Icon}) =>
          <button type="button" key={id} aria-label={label} title={label} aria-pressed={choice === id} onClick={() => setChoice(id)}><Icon size={16} /></button>)}
      </div>
    </div>
  </header>;
}
