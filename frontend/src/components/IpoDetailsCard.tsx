import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, X } from 'lucide-react';
import { IPORow } from '../types/screener';
import { SymbolWithLogo } from './SymbolWithLogo';
import { portalContainer } from '../embedding';

interface IpoDetailsCardProps {
  row: IPORow;
  id: string;
  left: number;
  top: number;
  placement: 'right' | 'left' | 'sheet';
  onClose: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

const number = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value)
  ? null : value.toLocaleString('en-IN', {maximumFractionDigits: digits});
const currency = (value: number | null | undefined) => {
  const formatted = number(value);
  return formatted == null ? null : `₹${formatted}`;
};
const date = (value: string | null | undefined) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-IN', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata'});
};
const externalUrl = (value: string | null | undefined) => {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch { return null; }
};
const crore = (value: number | null | undefined) => {
  const formatted = number(value);
  return formatted == null ? null : `₹${formatted} Cr`;
};

const Detail = ({label, value, featured = false}: {label: string; value: string | null | undefined; featured?: boolean}) => value
  ? <div className={`ipo-detail-metric${featured ? ' featured' : ''}`}><span>{label}</span><strong>{value}</strong></div> : null;

export const IpoDetailsCard: React.FC<IpoDetailsCardProps> = ({row, id, left, top, placement, onClose, onMouseEnter, onMouseLeave}) => {
  if (typeof document === 'undefined') return null;
  const research = row.ipoResearch;
  const profile = research?.profile;
  const provider = research?.provider;
  const decode = research?.issueDetail;
  const hasSubscription = research?.subscription && [research.subscription.total, research.subscription.retail,
    research.subscription.nii, research.subscription.institutional].some(value => value != null);
  const hasOverview = [research?.issuePrice, provider?.listingPrice, row.currentPrice, provider?.listingGainPct,
    row.listingDate, row.marketCapCrore, row.turnoverCrore, row.deliveryPct, provider?.gmp,
    research?.offer?.issueSizeCrore, research?.offer?.freshIssueCrore, research?.offer?.offerForSaleCrore,
    profile?.issueSize, profile?.offer?.floorPrice, profile?.offer?.ceilingPrice, profile?.offer?.lotSize,
    profile?.offer?.startDate, profile?.offer?.endDate, research?.issueDetail?.issue?.priceBandLow,
    research?.issueDetail?.issue?.priceBandHigh, research?.issueDetail?.issue?.lotSize,
    research?.issueDetail?.issue?.minInvestment].some(value => value != null && value !== '') || Boolean(hasSubscription) || Boolean(research?.conflicts?.length);
  const hasDecode = Boolean(decode && (decode.endpoints?.length || decode.fetchedAt || decode.allotmentStatus || decode.registrar ||
    decode.allotmentDate || decode.refundDate || decode.dematCreditDate || decode.documentCount != null ||
    decode.issue?.issueType || decode.issue?.qualityGrade || decode.issue?.totalApplications != null || decode.issue?.peAtUpper != null ||
    decode.issue?.revenueCrore != null || decode.issue?.profitCrore != null || decode.issue?.roePct != null || decode.issue?.leadManagers ||
    decode.issue?.about || decode.gmpHistory?.length || decode.documents?.length ||
    Object.values(decode.valuation ?? {}).some(value => value != null && value !== '') ||
    Object.values(decode.peerAvailability ?? {}).some(value => value != null && value !== '')));
  const hasResearch = Boolean(profile?.allotmentDate || profile?.companyDetail?.trim() || profile?.financials?.length || profile?.purpose?.length ||
    profile?.strengths?.length || profile?.risks?.length || profile?.management?.length || externalUrl(profile?.drhpUrl) || research?.conflicts?.length);
  const tabs = [
    ...(hasOverview ? [{id: 'overview' as const, label: 'Overview'}] : []),
    ...(hasDecode ? [{id: 'decode' as const, label: 'Details'}] : []),
    ...(hasResearch ? [{id: 'research' as const, label: 'Research'}] : []),
  ];
  const [requestedTab, setRequestedTab] = useState<'overview' | 'decode' | 'research'>('overview');
  const activeTab = tabs.some(tab => tab.id === requestedTab) ? requestedTab : tabs[0]?.id ?? 'overview';

  return createPortal(<section id={id} className="ipo-details-card" role="dialog" aria-label={`${row.name || row.symbol} IPO details`}
    style={{left, top, transformOrigin: placement === 'left' ? 'right 24px' : placement === 'sheet' ? 'center bottom' : 'left 24px'}}
    onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onFocus={onMouseEnter}
    onBlur={event => {if (!event.currentTarget.contains(event.relatedTarget)) onMouseLeave();}}
    onKeyDown={event => {if (event.key === 'Escape') {event.stopPropagation(); onClose();}}}>
    <header className="ipo-details-header">
      <div className="ipo-details-company"><SymbolWithLogo symbol={row.symbol} name={row.name} /></div>
      <button type="button" className="icon-button ipo-details-close" onClick={onClose} aria-label="Close IPO details"><X size={16} /></button>
    </header>
    {tabs.length > 0 && <div className="ipo-details-tabs" role="tablist" aria-label="IPO detail sections">
      {tabs.map(tab => <button key={tab.id} type="button" role="tab" id={`${id}-${tab.id}-tab`}
        aria-selected={activeTab === tab.id} aria-controls={`${id}-${tab.id}-panel`} tabIndex={activeTab === tab.id ? 0 : -1}
        onKeyDown={event => {
          const index = tabs.findIndex(item => item.id === tab.id);
          const nextIndex = event.key === 'ArrowRight' ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
          if (nextIndex == null) return;
          event.preventDefault();
          setRequestedTab(tabs[nextIndex].id);
          document.getElementById(`${id}-${tabs[nextIndex].id}-tab`)?.focus();
        }}
        className={activeTab === tab.id ? 'active' : ''} onClick={() => setRequestedTab(tab.id)}>{tab.label}</button>)}
    </div>}
    <div className="ipo-details-content">
      {!hasDecode && row.ipoDetailStatus?.lastSuccessAt && <p className="ipo-details-note">Last updated: {new Date(row.ipoDetailStatus.lastSuccessAt).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})} IST</p>}
      {row.ipoDetailStatus?.failedEndpoints.length ? <p className="ipo-details-note">Refresh errors: {row.ipoDetailStatus.failedEndpoints.join(', ')}. Previously available data is retained.</p> : null}
      {tabs.length > 0 && <div role="tabpanel" id={`${id}-${activeTab}-panel`} aria-labelledby={`${id}-${activeTab}-tab`}>
      {activeTab === 'overview' && <>
      <section className="ipo-details-section">
        <h3>Listing</h3>
        <div className="ipo-details-primary-grid">
          <Detail featured label="IPO price" value={currency(research?.issuePrice)} />
          <Detail featured label="Listing price" value={currency(provider?.listingPrice)} />
          <Detail featured label="Last close" value={currency(row.currentPrice)} />
          <Detail featured label="Listing gain" value={provider?.listingGainPct == null ? null : `${number(provider.listingGainPct)}%`} />
        </div>
        <div className="ipo-details-grid">
          <Detail label="Listing date" value={date(row.listingDate)} />
          <Detail label="Market cap" value={crore(row.marketCapCrore)} />
          <Detail label="Daily turnover" value={crore(row.turnoverCrore)} />
          <Detail label="Delivery" value={row.deliveryPct == null ? null : `${number(row.deliveryPct)}%`} />
          <Detail label="GMP at source refresh" value={provider?.gmp == null ? null : `${currency(provider.gmp)}${provider.gmpPct == null ? '' : ` (${number(provider.gmpPct)}%)`}`} />
        </div>
      </section>

      {(research?.offer || profile?.offer || profile?.issueSize != null || [decode?.issue?.priceBandLow, decode?.issue?.priceBandHigh, decode?.issue?.lotSize, decode?.issue?.minInvestment].some(value => value != null)) && <section className="ipo-details-section">
        <h3>Offer</h3>
        <div className="ipo-details-grid">
          <Detail label="Issue size" value={crore(research?.offer?.issueSizeCrore ?? profile?.issueSize)} />
          <Detail label="Fresh issue" value={crore(research?.offer?.freshIssueCrore)} />
          <Detail label="Offer for sale" value={crore(research?.offer?.offerForSaleCrore)} />
          <Detail label="Price band" value={profile?.offer?.floorPrice != null || profile?.offer?.ceilingPrice != null
            ? `${currency(profile.offer.floorPrice) ?? 'Not available'}-${currency(profile.offer.ceilingPrice) ?? 'Not available'}`
            : research?.issueDetail?.issue?.priceBandLow != null || research?.issueDetail?.issue?.priceBandHigh != null
              ? `${currency(research.issueDetail.issue.priceBandLow) ?? 'Not available'}-${currency(research.issueDetail.issue.priceBandHigh) ?? 'Not available'}` : null} />
          <Detail label="Lot size" value={number(profile?.offer?.lotSize ?? research?.issueDetail?.issue?.lotSize, 0)} />
          <Detail label="Minimum investment" value={currency(research?.issueDetail?.issue?.minInvestment)} />
          <Detail label="Offer dates" value={profile?.offer?.startDate || profile?.offer?.endDate
            ? `${date(profile.offer.startDate) ?? 'Not available'} - ${date(profile.offer.endDate) ?? 'Not available'}` : null} />
        </div>
      </section>}

      {research?.subscription && [research.subscription.total, research.subscription.retail, research.subscription.nii, research.subscription.institutional].some(value => value != null) && <section className="ipo-details-section">
        <h3>Subscription multiple</h3>
        <div className="ipo-details-grid">
          <Detail label="Total" value={number(research.subscription.total)} />
          <Detail label="Retail" value={number(research.subscription.retail)} />
          <Detail label="NII" value={number(research.subscription.nii)} />
          <Detail label="Institutional" value={number(research.subscription.institutional)} />
        </div>
      </section>}
      {research?.conflicts?.length ? <section className="ipo-details-section ipo-details-conflict">
        <h3>Source differences</h3>
        {research.conflicts.map(conflict => <p className="ipo-details-copy" key={conflict.field}>{conflict.field.replaceAll('_', ' ')} differs: primary {conflict.provider == null ? 'not reported' : number(conflict.provider)}; secondary {conflict.secondary == null ? 'not reported' : number(conflict.secondary)}. Both values are kept distinct.</p>)}
      </section> : null}
      </>}

      {activeTab === 'decode' && decode && <>
      <section className="ipo-details-section">
        <div className="ipo-details-section-heading"><h3>Issue details</h3>{decode.endpoints?.length ? <span>{decode.endpoints.length} records</span> : null}</div>
        {!decode.endpoints?.length && <p className="ipo-details-note">No company-specific detail sources are present in this snapshot.</p>}
        <div className="ipo-details-grid">
          <Detail label="Last updated" value={decode.fetchedAt ? `${date(decode.fetchedAt)}, ${new Date(decode.fetchedAt).toLocaleTimeString('en-IN', {hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata'})} IST` : null} />
          <Detail label="Allotment" value={decode.allotmentStatus ? `${decode.allotmentStatus}${decode.registrar ? `, ${decode.registrar}` : ''}` : null} />
          {!decode.allotmentStatus && <Detail label="Registrar" value={decode.registrar} />}
          <Detail label="Allotment date" value={date(decode.allotmentDate)} />
          <Detail label="Refund date" value={date(decode.refundDate)} />
          <Detail label="Demat credit" value={date(decode.dematCreditDate)} />
          <Detail label="Published documents" value={decode.documentCount == null ? null : String(decode.documentCount)} />
        </div>
        {(decode.issue?.issueType || decode.issue?.qualityGrade || decode.issue?.totalApplications != null || decode.issue?.peAtUpper != null || decode.issue?.revenueCrore != null || decode.issue?.profitCrore != null || decode.issue?.roePct != null || decode.issue?.leadManagers || decode.valuation || decode.peerAvailability) && <details className="ipo-detail-disclosure">
          <summary>Issue &amp; valuation</summary>
          <div className="ipo-details-grid">
          <Detail label="Issue type" value={decode.issue?.issueType} />
          <Detail label="Quality grade" value={decode.issue?.qualityGrade} />
          <Detail label="Applications" value={number(decode.issue?.totalApplications, 0)} />
          <Detail label="IPO P/E at upper band" value={number(decode.issue?.peAtUpper)} />
          <Detail label="Revenue (Cr)" value={crore(decode.issue?.revenueCrore)} />
          <Detail label="Profit after tax (Cr)" value={crore(decode.issue?.profitCrore)} />
          <Detail label="Return on net worth" value={decode.issue?.roePct == null ? null : `${number(decode.issue.roePct)}%`} />
          </div>
          {decode.issue?.leadManagers && <p className="ipo-details-copy ipo-details-about"><strong>Lead managers:</strong> {decode.issue.leadManagers}</p>}
          {decode.valuation && <div className="ipo-details-subsection"><h4>Valuation</h4><div className="ipo-details-grid">
          <Detail label="P/E" value={number(decode.valuation.pe)} /><Detail label="P/B" value={number(decode.valuation.pb)} />
          <Detail label="EV / EBITDA" value={number(decode.valuation.evEbitda)} /><Detail label="Peer median P/E" value={number(decode.valuation.peerMedianPe)} />
        </div>{decode.valuation.verdict && <p className="ipo-details-copy">{decode.valuation.verdict}</p>}</div>}
        {decode.peerAvailability && <p className="ipo-details-note">Peer valuation: {decode.peerAvailability.available ? 'available' : decode.peerAvailability.reason ?? 'not available'}.</p>}
        </details>}
        {decode.issue?.about && <details className="ipo-detail-disclosure"><summary>Company overview</summary><p className="ipo-details-copy ipo-details-about">{decode.issue.about}</p></details>}
        {decode.gmpHistory?.length ? <details className="ipo-detail-disclosure"><summary>GMP history <span>{decode.gmpHistory.length} updates</span></summary>
          {decode.gmpHistory.slice(-5).reverse().map((item, index) => <div className="ipo-gmp-history" key={`${item.date ?? 'gmp'}-${index}`}>
            <span>{date(item.date)}</span><strong>{currency(item.gmp) ?? 'Not available'}{item.gmpPct == null ? '' : ` (${number(item.gmpPct)}%)`}</strong>
          </div>)}
        </details> : null}
        {decode.documents?.length ? <details className="ipo-detail-disclosure"><summary>Documents <span>{decode.documents.length}</span></summary>{decode.documents.map((item, index) => externalUrl(item.url)
          ? <a className="ipo-details-link ipo-document-link" href={externalUrl(item.url)!} target="_blank" rel="noreferrer" key={`${item.url}-${index}`}>
              <span><strong>{item.label ?? item.kind ?? 'Document'}</strong>{item.note && <small>{item.note}</small>}</span><ExternalLink size={13} />
            </a>
          : <p className="ipo-details-copy" key={`${item.kind ?? 'document'}-${index}`}>{item.label ?? item.kind}</p>)}</details> : null}
      </section>
      </>}
      {activeTab === 'research' && profile && hasResearch && <section className="ipo-details-section">
        <h3>Research</h3>
        {profile.allotmentDate && <div className="ipo-details-grid"><Detail label="Allotment date" value={date(profile.allotmentDate)} /></div>}
        {profile.companyDetail && <details className="ipo-detail-disclosure"><summary>Company overview</summary><p className="ipo-details-copy">{profile.companyDetail}</p></details>}
        {profile.financials?.length ? <details className="ipo-detail-disclosure"><summary>Financials <span>{profile.financials.length} periods</span></summary><div className="ipo-details-grid">
          {profile.financials.map((item, index) => <React.Fragment key={`${item.date ?? 'period'}-${index}`}>
            <Detail label={`${item.date ?? 'Period'} revenue`} value={item.revenue == null ? null : `${item.unit === 'crores' ? '₹' : ''}${number(item.revenue)}${item.unit === 'crores' ? ' Cr' : ''}`} />
            <Detail label={`${item.date ?? 'Period'} profit`} value={item.profit == null ? null : `${item.unit === 'crores' ? '₹' : ''}${number(item.profit)}${item.unit === 'crores' ? ' Cr' : ''}`} />
          </React.Fragment>)}
        </div></details> : null}
        {profile.purpose?.length ? <details className="ipo-detail-disclosure"><summary>Use of proceeds <span>{profile.purpose.length}</span></summary>{profile.purpose.map((item, index) => <article className="ipo-details-paragraph" key={`${item.title ?? 'purpose'}-${index}`}>
          <strong>{item.title}</strong>{item.amount != null && <span>{` (${item.amount} ${item.unit ?? ''})`}</span>}{item.description && <p>{item.description}</p>}
        </article>)}</details> : null}
        {profile.strengths?.length ? <details className="ipo-detail-disclosure"><summary>Strengths <span>{profile.strengths.length}</span></summary>{profile.strengths.map((item, index) => <article className="ipo-details-paragraph" key={`${item.title ?? 'strength'}-${index}`}><strong>{item.title}</strong>{item.description && <p>{item.description}</p>}</article>)}</details> : null}
        {profile.risks?.length ? <details className="ipo-detail-disclosure"><summary>Risk factors <span>{profile.risks.length}</span></summary>{profile.risks.map((item, index) => <article className="ipo-details-paragraph" key={`${item.title ?? 'risk'}-${index}`}><strong>{item.title}</strong>{item.description && <p>{item.description}</p>}</article>)}</details> : null}
        {profile.management?.length ? <details className="ipo-detail-disclosure"><summary>Management <span>{profile.management.length}</span></summary><p className="ipo-details-copy">{profile.management.map(person => person.designation ? `${person.name} (${person.designation})` : person.name).join(', ')}</p></details> : null}
        {externalUrl(profile.drhpUrl) && <a className="ipo-details-link" href={externalUrl(profile.drhpUrl)!} target="_blank" rel="noreferrer">Open offer document <ExternalLink size={13} /></a>}
      </section>}

      {activeTab === 'research' && research?.conflicts?.length ? <section className="ipo-details-section ipo-details-conflict">
        <h3>Source differences</h3>
        {research.conflicts.map(conflict => <p className="ipo-details-copy" key={conflict.field}>{conflict.field.replaceAll('_', ' ')} differs: primary {conflict.provider == null ? 'not reported' : number(conflict.provider)}; secondary {conflict.secondary == null ? 'not reported' : number(conflict.secondary)}. Both values are kept distinct.</p>)}
      </section> : null}
      </div>}
    </div>
  </section>, portalContainer() ?? document.body);
};
