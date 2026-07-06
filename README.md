# 🌬️ WindWatch

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-blue.svg?style=flat-sharp&logo=node.js)](https://nodejs.org/)
[![React Version](https://img.shields.io/badge/react-v19.0-blue?style=flat-sharp&logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/typescript-v6.0-blue?style=flat-sharp&logo=typescript)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/vite-v8.0-646CFF?style=flat-sharp&logo=vite)](https://vite.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-sharp)](https://opensource.org/licenses/MIT)

**WindWatch**, hesap oluşturma zorunluluğu bulunmayan, tamamen anonim ve gerçek zamanlı bir sesli, görüntülü sohbet ve ekran paylaşım platformudur. WebRTC P2P (Peer-to-Peer) teknolojisini Socket.io sinyalleşme altyapısıyla harmanlayarak yüksek hızlı, güvenli ve gecikmesiz bir iletişim deneyimi sunar.

---

## ✨ Özellikler

*   🎥 **Görüntülü ve Sesli İletişim (P2P):** Doğrudan tarayıcılar arası (WebRTC) yüksek kaliteli, şifreli ses ve görüntü akışı.
*   🖥️ **Yüksek Performanslı Ekran Paylaşımı:** 60 FPS'e kadar akıcı, 1080p limitli ekran paylaşımı. Sistem sesini mikrofon sesiyle harmanlayarak iletme (Audio Mixing) özelliği.
*   💬 **Gerçek Zamanlı Sohbet:** Odadaki katılımcılar arasında güvenli, anlık mesajlaşma paneli.
*   🎨 **Premium Arayüz & Cam Morfizmi (Glassmorphic UI):** Hareketli mesh-gradient ışık küreleri, modern cam morfizmi kart tasarımları ve esnek (responsive) video ızgara sistemi.
*   🔒 **Güvenlik Odaklı Mimari:**
    *   **DoS Koruması:** Boş kalan ve kullanılmayan odaların RAM tüketmesini önleyen sunucu taraflı Çöp Toplayıcı (Garbage Collector).
    *   **Rate Limiting:** WebSocket mesaj hız sınırlayıcı ve `/create-room` API limitleri ile spam/sel saldırılarına karşı koruma.
    *   **XSS Koruması:** React'in güvenli render motoru ve sunucu taraflı sanitization kontrolleri.
    *   **Güvenli Başlıklar:** Helmet ve sıkılaştırılmış CSP (Content Security Policy) yapılandırmaları.

---

## 🛠️ Teknoloji Yığını

### Frontend
*   **Çekirdek:** React 19, TypeScript, Vite
*   **İletişim:** PeerJS (WebRTC Wrapper), Socket.io Client
*   **Tasarım & İkonlar:** Vanilla CSS, Lucide React
*   **Kod Düzeni:** Oxlint, TypeScript compiler (`tsc`)

### Backend
*   **Çekirdek:** Node.js, Express
*   **Sinyalleşme:** Socket.io, ExpressPeerServer (PeerJS Server)
*   **Güvenlik:** Helmet (CSP), Express Rate Limit, CORS Whitelist

---

## 📂 Proje Yapısı

```text
windwatch/
├── backend/               # Sunucu ve Sinyalleşme Servisleri
│   ├── src/
│   │   ├── server.js      # Ana sunucu kurulumu & middleware'ler
│   │   ├── rooms.js       # Bellek içi (In-memory) oda yönetimi & GC
│   │   └── socketHandler.js # WebSocket event yönetimleri ve hız limitleri
│   ├── package.json
│   └── package-lock.json
│
└── frontend/              # Arayüz ve WebRTC İstemcisi
    ├── src/
    │   ├── components/
    │   │   ├── Home.tsx   # Sekmeli (Tabbed) giriş & oda katılım arayüzü
    │   │   ├── Room.tsx   # Canlı oda akışı & WebRTC yönetimi
    │   │   ├── Chat.tsx   # Sohbet paneli
    │   │   ├── Controls.tsx # Medya kontrolleri (Mikrofon, Kamera, Ekran)
    │   │   └── VideoGrid.tsx # Katılımcı video yerleşim ızgarası
    │   ├── App.tsx
    │   ├── index.css      # Tema değişkenleri, cam morfizmi ve animasyonlar
    │   └── main.tsx
    ├── package.json
    └── vite.config.ts
```

---

## 🚀 Kurulum ve Çalıştırma

Projeyi yerel bilgisayarınızda çalıştırmak için aşağıdaki adımları sırasıyla uygulayınız.

### Gereksinimler
*   Node.js (v18.0.0 veya üzeri)
*   npm (veya yarn)

### 1. Depoyu Klonlayın
```bash
git clone https://github.com/kullanici_adi/windwatch.git
cd windwatch
```

### 2. Backend Kurulumu ve Çalıştırma
```bash
cd backend
npm install
# Geliştirici modu (Nodemon ile)
npm run dev
# veya normal başlatma
npm start
```
*Backend varsayılan olarak `http://localhost:5000` portu üzerinde çalışmaya başlayacaktır.*

### 3. Frontend Kurulumu ve Çalıştırma
```bash
# Projenin kök dizininden frontend'e geçin
cd ../frontend
npm install
# Geliştirici sunucusunu başlatın
npm run dev
```
*Frontend varsayılan olarak `http://localhost:5173` portu üzerinde çalışmaya başlayacaktır.*

---

## ⚙️ Çevre Değişkenleri (Environment Variables)

### Frontend (`frontend/.env`)
Varsayılan olarak localhost ayarlanmıştır, ancak farklı bir sunucu adresi kullanıyorsanız `.env` dosyası oluşturup tanımlayabilirsiniz:
```env
VITE_BACKEND_URL=http://localhost:5000
```

### Backend (`backend/.env`)
```env
PORT=5000
FRONTEND_URL=http://localhost:5173
NODE_ENV=development
```

---

## 🔒 Güvenlik Notları & Sıkılaştırma

Projede yakın zamanda yapılan güvenlik denetimleri doğrultusunda şu sıkılaştırmalar uygulanmıştır:
1.  **PeerJS Debug Log Sızıntısı Engellendi:** Canlı ortamlarda (`NODE_ENV=production`) PeerJS sinyal loglarının sızmaması için debug özellikleri kapatıldı.
2.  **Otomatik Bellek Boşaltma:** Kullanıcıların oda oluşturup hiç katılmadığı durumlar için 2 dakikalık zaman aşımına sahip bir sunucu temizlik mekanizması entegre edilerek sunucunun kilitlenmesi engellendi.
3.  **Spam Koruması (Rate Limit):** Kullanıcıların sohbet kanalını sabote etmesini engellemek üzere WebSocket seviyesinde saniyede en fazla 5 mesaj limiti uygulandı.
4.  **Güvenli Bağımlılıklar:** Kritik zafiyet barındıran `uuid` paketi en güncel kararlı sürümle güncellenerek `npm audit` seviyesi temizlendi.

---

## 📄 Lisans

Bu proje **MIT Lisansı** altında lisanslanmıştır. Detaylar için `LICENSE` dosyasına göz atabilirsiniz.
