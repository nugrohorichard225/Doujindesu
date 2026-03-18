# Doujindesu Mirror

Reverse proxy mirror untuk doujindesu.tv dengan fitur anti-duplikat SEO dan Cloudflare bypass.

## Fitur

- **Anti-Duplikat Google**: Canonical URL ke mirror, transformasi title/description/OG tags, JSON-LD structured data, breadcrumb schema
- **Cloudflare Bypass**: Cookie persistence, rotating User-Agent, browser-like headers, retry logic
- **Caching**: LRU cache untuk halaman (10 menit) dan gambar (1 jam)
- **Ad Removal**: Hapus iklan, popup, dan right-click blocker
- **Image Proxy**: Proxy gambar dari desu.photos
- **Railway Ready**: Konfigurasi deploy otomatis

## Deploy ke Railway

1. Push repo ke GitHub
2. Buka [railway.com](https://railway.com) dan buat project baru
3. Connect GitHub repo
4. Set environment variables di Railway Dashboard:

| Variable | Nilai | Keterangan |
|---|---|---|
| `ORIGINAL_HOST` | `doujindesu.tv` | Target website |
| `SITE_NAME` | `Nama Mirror Kamu` | **WAJIB GANTI** - nama unik |
| `SITE_TAGLINE` | `Tagline kamu` | Deskripsi singkat |
| `ADMIN_KEY` | `secret-key-kamu` | Key untuk admin endpoints |

5. Railway otomatis deploy

## Environment Variables

Lihat [.env.example](.env.example) untuk daftar lengkap.

## Endpoints

- `/health` — Health check
- `/robots.txt` — SEO robots
- `/sitemap-index.xml` — Sitemap index
- `/sitemap-main.xml` — Main sitemap
- `/admin/clear-cache?key=YOUR_KEY` — Clear cache

## Tips Anti-Duplikat Google

1. **GANTI `SITE_NAME`** dengan nama unik yang berbeda dari original
2. Pastikan canonical URL mengarah ke domain mirror kamu
3. Submit sitemap mirror kamu ke Google Search Console
4. Jangan submit URL original ke Search Console yang sama