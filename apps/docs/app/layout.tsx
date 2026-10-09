import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import './global.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL('https://docs.openmausbot.com'),
  title: {
    default: 'BOS Bot Docs',
    template: '%s · BOS Bot Docs',
  },
  description: 'Install, configure, and extend your local-first team of AI agents.',
  openGraph: {
    title: 'BOS Bot Docs',
    description: 'Your own team of AI agents, in a chat app.',
    type: 'website',
  },
  icons: {
    icon: '/app-icon.svg',
    apple: '/app-icon.svg',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data; upstream-artifacts: pinned third-party binaries and historical upstream provenance cannot be redirected by a product rename; deployed-services: existing worker databases, service health identities and hosted addresses must not become a different service
