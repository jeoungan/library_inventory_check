import type { Metadata, Viewport } from 'next';
import './globals.css';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export const metadata: Metadata = {
  metadataBase: new URL('https://jangseo-inventory-scan.hsmu-makers.chatgpt.site'),
  title: '바코드 장서 점검',
  description: '바코드를 카테고리별로 스캔하고 TXT로 저장하는 장서점검 도구',
  applicationName: '바코드 장서 점검',
  manifest: `${basePath}/manifest.webmanifest`,
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: '바코드 장서 점검',
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    type: 'website',
    locale: 'ko_KR',
    title: '바코드 장서 점검',
    description: '스캔 · 목록 관리 · TXT 저장',
    images: [{
      url: 'https://jangseo-inventory-scan.hsmu-makers.chatgpt.site/og.png',
      alt: '바코드 장서 점검 · 스캔 · 목록 관리 · TXT 저장',
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '바코드 장서 점검',
    description: '스캔 · 목록 관리 · TXT 저장',
    images: ['https://jangseo-inventory-scan.hsmu-makers.chatgpt.site/og.png'],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#f5f6f7',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
