import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://jangseo-inventory-scan.hsmu-makers.chatgpt.site'),
  title: '장서점검 · 바코드 스캐너',
  description: '휴대폰 카메라로 도서 바코드를 읽고 TXT 파일로 저장하는 장서점검 도구',
  applicationName: '장서점검',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: '장서점검',
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    type: 'website',
    locale: 'ko_KR',
    title: '장서점검',
    description: '도서 바코드 스캔 · TXT 저장',
    images: [{
      url: 'https://jangseo-inventory-scan.hsmu-makers.chatgpt.site/og.png',
      alt: '장서점검 · 도서 바코드 스캔 · TXT 저장',
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '장서점검',
    description: '도서 바코드 스캔 · TXT 저장',
    images: ['https://jangseo-inventory-scan.hsmu-makers.chatgpt.site/og.png'],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#102a29',
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
