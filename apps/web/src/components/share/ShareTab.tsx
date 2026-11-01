import type { ReactNode } from 'react';
import type { useT } from '../../i18n';
import { RemixIcon } from '../RemixIcon';
import styles from './ShareTab.module.css';

export interface ShareDeployAction {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
}

/** Deployment custom domains may vary; only open browser-safe HTTP(S) URLs. */
function browsableSharePageUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl, window.location.origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Sharing means deploying with the user's own provider credentials. */
export function ShareTab({
  menuOrigin,
  t,
  deployActions,
  sharePageUrl,
  canCopyShareLink,
  shareUnavailableHint,
  copyShareLink,
  copyShareLinkLabel,
  canOpenSharePage,
  shareLinkStatusHint,
}: {
  menuOrigin: 'toolbar' | 'artifact-card';
  t: ReturnType<typeof useT>;
  deployActions: readonly ShareDeployAction[];
  sharePageUrl: string;
  canCopyShareLink: boolean;
  shareUnavailableHint: string;
  copyShareLink: (url: string) => Promise<boolean>;
  copyShareLinkLabel: string;
  canOpenSharePage: boolean;
  shareLinkStatusHint: string;
}) {
  return (
    <div className={`chrome-unified-panel chrome-unified-panel--share ${styles.panel}`}>
      {deployActions.map((action) => (
        <button
          key={action.id}
          type="button"
          className="share-menu-item"
          role="menuitem"
          disabled={action.disabled}
          title={action.title}
          onClick={action.onSelect}
        >
          <span className="share-menu-icon">{action.icon}</span>
          <span>{action.label}</span>
        </button>
      ))}
      {menuOrigin === 'toolbar' && sharePageUrl ? (
        <>
          <div className="share-menu-divider" />
          <div className="share-menu-section-label" role="presentation">
            {t('fileViewer.shareMenuPublishOnline')}
          </div>
          <button
            type="button"
            className="share-menu-item"
            role="menuitem"
            disabled={!canCopyShareLink}
            title={canCopyShareLink ? undefined : shareUnavailableHint}
            onClick={() => {
              void copyShareLink(sharePageUrl);
            }}
          >
            <span className="share-menu-icon"><RemixIcon name="file-copy-line" size={15} /></span>
            <span>{copyShareLinkLabel}</span>
          </button>
          <button
            type="button"
            className="share-menu-item"
            role="menuitem"
            disabled={!canOpenSharePage}
            title={canOpenSharePage ? undefined : shareLinkStatusHint || shareUnavailableHint}
            onClick={() => {
              if (!canOpenSharePage) return;
              const url = browsableSharePageUrl(sharePageUrl);
              if (url) window.open(url, '_blank', 'noopener,noreferrer');
            }}
          >
            <span className="share-menu-icon"><RemixIcon name="external-link-line" size={15} /></span>
            <span>{t('fileViewer.openSharePage')}</span>
          </button>
          {shareLinkStatusHint || shareUnavailableHint ? (
            <div className="share-menu-section-label" role="presentation">
              {shareLinkStatusHint || shareUnavailableHint}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
