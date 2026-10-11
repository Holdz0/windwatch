# WindWatch

Hesap gerektirmeyen sesli görüşme, kamera, ekran paylaşımı ve sohbet uygulaması.
React / TypeScript arayüzü, Socket.IO oda yönetimi ve tarayıcının yerleşik WebRTC
bağlantıları kullanılır. Medya ve dosyalar katılımcılar arasında taşınır.

## Çalıştırma

Node.js **22.12 veya üzeri** gerekir. İki terminal açın:

```powershell
cd backend
npm ci
npm run dev
```

```powershell
cd frontend
npm ci
npm run dev
```

Arayüz: `http://localhost:5173`, sunucu: `http://localhost:5000`.
Kamera, mikrofon ve ekran paylaşımı localhost dışında HTTPS gerektirir.

## Ekran paylaşımı ve ses

- Paylaşım penceresinde **Sesi paylaş** seçeneğini işaretleyin.
- Mikrofon, kamera, ekran görüntüsü ve ekran sesi ayrı WebRTC kanallarındadır.
  Mikrofonu kapatmak ekran sesini kapatmaz; kamera ekran paylaşımı sırasında da çalışır.
- `restrictOwnAudio: true` ile WindWatch sekmesinin ürettiği ses, yakalanan sistem
  sesinden çıkarılır. Katılımcı sesleri yeniden odaya gönderilmez.
- Paylaşımın ses izi kontrol edilir. Tarayıcı masaüstü/pencere sesinden WindWatch
  sesini ayırmayı doğrulayamıyorsa yalnızca o ses izi durdurulur; görüntü ve
  mikrofon devam eder. Başka bir tarayıcı sekmesini sesli paylaşmak kullanılabilir.
- Bu özellik Chrome 141 ile eklendi; işletim sistemi ve seçilen kaynak da ses
  yakalama desteğini belirler. [Chrome sürüm notları](https://developer.chrome.com/release-notes/141#support_restrictownaudio).
- WindWatch sekmesi paylaşım seçiminden hariç tutulur. Kaynak değiştirmek için
  paylaşımı durdurup yeni kaynağı seçin.
- Kalite ayarları paylaşım sürerken değiştirilebilir. Yerleşik WebRTC tıkanıklık
  kontrolü çalışır; seçilen bitrate yalnızca üst sınırdır.

Katılımcı sesi kartların görünürlüğünden bağımsız çalar. Sohbeti açmak, yayını
sabitlemek veya mobilde küçük kartları gizlemek sesleri kesmez. Tarayıcı otomatik
ses oynatmayı engellerse **Katılımcıların sesini duymak için tıklayın** düğmesi görünür.

## Dağıtım ayarları

`backend/.env` örneği (npm start / npm run dev bu dosyayı yükler):

```env
PORT=5000
FRONTEND_URL=https://windwatch.example.com
NODE_ENV=production
```

Birden fazla izinli arayüz adresi `FRONTEND_URL` içinde virgülle ayrılabilir.

`frontend/.env` örneği (Vite derleme sırasında okur):

```env
VITE_BACKEND_URL=https://api.windwatch.example.com
VITE_TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:5349
VITE_TURN_USERNAME=your-turn-username
VITE_TURN_CREDENTIAL=your-turn-credential
```

**TURN sunucusu:** STUN tek başına bazı mobil ağlar, kurumsal ağlar ve simetrik NAT
arkasındaki katılımcıları bağlayamaz. Bu ağlarda medya için çalışan bir TURN
hizmeti gerekir. Özel TURN ayarlanmamışsa önceki PeerJS yapılandırmasının herkese
açık röleleri yedek olarak korunur; bunların erişilebilirliği garanti değildir.
Üretimde yukarıdaki ayarlarla kendi TURN hizmetinizi kullanın. Statik Vite ayarları kullanıcıya görünür;
üretimde süreli TURN kimlik bilgileri kullanılması önerilir.

Arayüz ve sunucu **birlikte** güncellenmelidir. Eski PeerJS protokolü kaldırıldı;
eski istemciyle yeni sunucu arasında medya bağlantısı kurulmaz. `/peer` servisi
artık kullanılmaz. Ters proxy Socket.IO için WebSocket yükseltmesini desteklemelidir.

## Oda ve dosya davranışı

- P2P bağlantılar her katılımcı çifti arasında kurulur. Oda en fazla **8 kişi**
  alır; daha büyük gruplar için bir SFU altyapısı gerekir.
- Aynı anda tek ekran paylaşımı yapılabilir. Sunucudan onay gelmeden paylaşım
  yayımlanmaz; zaman aşımında yakalanan cihazlar serbest bırakılır.
- Geçici bağlantı kopmasında üyelik ve kurucu yetkisi 20 saniye korunur. Medya
  bağlantısı bozulursa yeniden kurulur. Boş odalar 10 dakika sonra temizlenir.
- Odalar ve son 50 mesaj bellekte tutulur; sunucu yeniden başlatılırsa silinir.
- Dosya başına 100 MB, oturum başına toplam 250 MB paylaşılabilir. Dosyalar
  16 KB parçalarla ve gönderim tamponu sınırıyla aktarılır; sunucuda saklanmaz.
  Gönderen ayrılır veya sayfayı yenilerse önceki dosya teklifleri kullanılamaz.

## Kontroller

```powershell
cd backend
npm test
npm audit
```

```powershell
cd frontend
npx playwright install chromium
npm test
npm run build
npm run lint
npm audit
```

Tarayıcı testleri gerçek iki/üç katılımcılı RTCPeerConnection bağlantıları kurar;
kamera ve mikrofon için tarayıcının test cihazları, ekran için üretilen test
akışları kullanılır. Ayrı medya izleri, mobil sohbet sırasında ses, sonradan
katılım, bağlantı kurtarma, izin beklerken ayrılma, onay zaman aşımı ve dosya
bütünlüğü doğrulanır. İşletim sisteminin gerçek ekran/sistem sesi yakalaması,
gerçek mikrofon-kulaklık akustiği ve uzak ağlardaki TURN bağlantısı bu otomatik
testlerin kapsamı dışındadır.
