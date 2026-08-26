import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '장서점검 · 바코드 스캐너',
    short_name: '장서점검',
    description: '휴대폰 카메라로 도서 바코드를 읽고 TXT 파일로 저장합니다.',
    start_url: '/',
    display: 'standalone',
    background_color: '#eef3f0',
    theme_color: '#102a29',
    orientation: 'portrait',
    lang: 'ko',
  };
}
