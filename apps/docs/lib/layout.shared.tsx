import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { BrandTitle } from '@/components/brand-title';
import { gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <BrandTitle />,
      url: '/docs',
      transparentMode: 'none',
    },
    links: [
      { text: 'Website', url: 'https://www.openmausbot.com', external: true },
      { text: 'Changelog', url: '/docs/changelog' },
      { type: 'button', text: 'Download', url: 'https://github.com/milind-soni/OpenMausBot/releases/latest', external: true },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data; upstream-artifacts: pinned third-party binaries and historical upstream provenance cannot be redirected by a product rename; deployed-services: existing worker databases, service health identities and hosted addresses must not become a different service
