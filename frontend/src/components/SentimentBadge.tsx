import React from 'react';

export interface SentimentBadgeProps {
  sentiment: 'positive' | 'negative' | 'neutral' | string;
  showLabel?: boolean;
  className?: string;
  size?: 'sm' | 'md';
}

/** Sentiment badge: an up, down or flat mark in green, red or slate. */
export const SentimentBadge: React.FC<SentimentBadgeProps> = ({
  sentiment,
  showLabel = false,
  className = '',
  size = 'sm',
}) => {
  const norm = sentiment === 'positive' || sentiment === 'negative' ? sentiment : 'neutral';
  const isSm = size === 'sm';
  const iconSize = isSm ? 12 : 14;

  const labels = {
    positive: 'Positive',
    negative: 'Negative',
    neutral: 'Neutral',
  };

  return (
    <span
      className={`sentiment-badge is-${norm} ${showLabel ? 'has-label' : ''} ${className}`}
      title={`${labels[norm]} sentiment`}
    >
      <span className="sentiment-icon-wrap" aria-hidden="true">
        {norm === 'positive' ? (
          <svg
            width={iconSize}
            height={iconSize}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
            <polyline points="16 7 22 7 22 13" />
          </svg>
        ) : norm === 'negative' ? (
          <svg
            width={iconSize}
            height={iconSize}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
            <polyline points="16 17 22 17 22 11" />
          </svg>
        ) : (
          <svg
            width={iconSize}
            height={iconSize}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        )}
      </span>
      {showLabel && <span className="sentiment-text">{labels[norm]}</span>}
    </span>
  );
};
