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
- Paylaşım sürerken her izleyicinin bağlantısı iki saniyede bir ayrı izlenir.
  Ağ toparlanmasına rağmen düşük çözünürlük/FPS'te kalan kodlayıcı, en az altı
  saniyelik sağlıklı bant genişliği, paket kaybı ve gecikme ölçümünden sonra
  seçilen kaliteye tekrar yükselmeyi dener. İşlemci kaynaklı düşüş zorlanmaz;
  denemeler arasında 30–120 saniye beklenir. Ses, dosya aktarımı ve bağlantı
  yeniden başlatılmaz. Kalite/FPS sınırları ve tasarruf bütçesi aşılmaz.

Katılımcı sesi kartların görünürlüğünden bağımsız çalar. Sohbeti açmak, yayını
sabitlemek veya mobilde küçük kartları gizlemek sesleri kesmez. Tarayıcı otomatik
ses oynatmayı engellerse **Katılımcıların sesini duymak için tıklayın** düğmesi görünür.

## Tasarruf modu

Ekran paylaşımı ayarlarından **Tasarruf** seçilebilir; devam eden paylaşımda da
uygulanır. Önceki 720p / 10 fps / 700 kbps profili yerine:

- Ekran için **1080p ve 30 fps'e kadar** yakalama, izleyici başına **500 kbps**
  video üst sınırı kullanılır. Sabit yazıda netlik, harekette akıcılık hedeflenir.
  Tarayıcı bağlantı ve işlemci yüküne göre çözünürlüğü/kareleri uyarlayabilir;
  1080p ile 30 fps'in birlikte her içerikte sağlanacağı garantisi yoktur.
- Ekran kanalında bağlantı kurulurken **AV1**, ardından **VP9** tercih edilir.
  Karşılıklı destek yoksa diğer yerleşik codec'ler kullanılabilir; kamera kanalının
  codec sırası değiştirilmez. Bu tercih diğer ekran profillerine de fayda sağlar.
  [Chrome AV1 ekran sıkıştırma açıklaması](https://developer.chrome.com/blog/av1).
- Paylaşan kişinin kamera videosu 640 × 360 / 15 fps'e kadar ve en fazla
  **100 kbps** ile gönderilir. Mikrofon **24 kbps**, ekran sesi **64 kbps** ile
  sınırlandırılır; ses ve ekran, kameradan daha yüksek gönderim önceliği alır.
- **1,2 Mbps toplam gönderilen medya yükü** bütçesi bütün izleyicilere bölünür.
  Katılım/ayrılmada mevcut bağlantılar da yeniden bütçelenir. Kalabalık odada
  izleyici başına ayrılan ekran bitrate'i 500 kbps'in altına düşebilir.
- Yerleşik WebRTC tıkanıklık kontrolü ve değişmeyen ekran karelerini verimli
  kodlaması kullanılır. Kalite toparlanması yalnızca etkin ekran paylaşımında
  izlenir; paylaşım durunca kontrol de durur. İlave canvas görüntü işleme,
  tekrar kodlama veya simulcast katmanları eklenmez. Durağan bir ekranın düşük
  FPS'i kalite sorunu sayılmaz ve gereksiz kareler zorla gönderilmez.
- Tasarruf seçiliyken açık olan ayar panelinde gerçek gönderilen medya hızı,
  bu hızdan hesaplanan yaklaşık MB/saat ve gönderilen ekran boyutu/fps gösterilir.
  Ölçüm üç saniyede bir yapılır; panel kapanınca durur. Durağan ekranda düşük fps
  normaldir, kullanılmayan kareler gönderilmez.
- Başka profile geçildiğinde veya paylaşım durdurulduğunda kamera ve ses
  bütçeleri geri alınır; izler/bağlantılar yeniden başlatılmaz.

Bitrate değerleri tarayıcıya verilen medya hedef sınırlarıdır; kısa süreli anahtar
kareler/yeniden iletimler ve ağ protokollerinin ek yükü ayrıca veri kullanabilir.
Gösterilen ölçüm gönderilen RTP medya ve başlıklarını içerir; alınan medya,
dosya transferleri ve diğer ağ trafiği buna dahil değildir. Bu seçenek paylaşan
kişinin gönderimini düzenler; izleyicinin diğer katılımcılardan aldığı kameraları
sınırlandırmaz. Çok düşük bitrate'te hızlı oyun/video görüntüsü için keskinlikten
ödün verilmesi gerekir. Kalabalık odada daha fazla kaliteyi aynı yükleme hızıyla
sağlamak için bir sonraki mimari adım SFU'dur; mevcut bağlantılar P2P mesh'tir.

## Kamera ve ses cihazları

Giriş ekranındaki **Kamera ve ses cihazlarını kontrol et** düğmesi mikrofon,
kamera ve hoparlör/kulaklık seçimini açar. Kamera ve mikrofon izinleri yalnızca
ilgili test başlatılınca istenir. Kamera önizlemesi ve mikrofon seviye göstergesi
yerel çalışır; test mikrofonu hoparlöre bağlanmaz. Panel kapatıldığında test
izleri ve seviye ölçümü bırakılır, bekleyen izin isteği sonradan sonuçlansa da
izleri durdurulur. Seçilen cihazlar sonraki görüşmeler için hatırlanır.

Görüşmede kontrol çubuğundaki kulaklık simgesi aynı ayarları açar. Açık olan
mikrofon/kamera değiştirilirken yeni iz alınır ve mevcut WebRTC göndericisine
bağlanır; eski iz ardından durdurulur. Başarısız seçim çalışan eski cihazı
korur. Kapalı mikrofon/kamera için seçim yapmak cihazı veya yayını açmaz.
Bağlantısı kesilen seçili cihaz için sistem varsayılanı denenir; açılamıyorsa
ilgili medya kapatılır ve uyarı gösterilir. Mobil ön/arka kamera değişimi,
donanımın aynı anda iki kamerayı açamaması nedeniyle kısa süreli geçiş yapabilir.

Hoparlör testi kısa bir test sesi çalar. Katılımcı sesleri de seçilen çıkışa
yönlendirilir. Çıkış seçimi `setSinkId` desteğine ve site izinlerine bağlıdır;
desteklenmeyen tarayıcıda işletim sisteminin seçimi kullanılır. Varsa **Çıkış
cihazına izin ver** düğmesi tarayıcının çıkış seçim penceresini açar.
[Ses çıkışı API'si](https://www.w3.org/TR/audio-output/).

## Dosya aktarımı

Sohbetten paylaşılan dosya, alıcı **P2P İndir** düğmesine basınca aktarılır.
Paylaşmak aktarımın tamamlandığı anlamına gelmez; göndericide başlangıçta
**Paylaşıma hazır** gösterilir. İki tarafta aktarılan boyut, yüzde, hız, yaklaşık
kalan süre ve tamamlanma/iptal/hata durumu gösterilir. Gönderen farklı alıcıları
ayrı ayrı görebilir ve her aktarımı iptal edebilir. Alıcı da iptal edip yeniden
indirebilir; sohbeti kapatmak veya ayrı pencereye almak aktarımı durdurmaz.

Varsayılan hız sınırı **128 KB/sn**'dir. Sohbetteki hız seçimi her indirme için
karşı tarafa bildirilir; aynı zamanda kendi bütün dosya gönderimlerinizin ortak
bütçesini belirler. 64/128/256 KB/sn, 1 MB/sn veya sınırsız seçilebilir. Daha
düşük karşı taraf sınırı ve ağ koşulları gerçek hızı düşürebilir. Seçim sürmekte
olan aktarımlara da uygulanır. Sınırlar dosya içeriği içindir; protokol ek yükü
ve başlangıçtaki tek parça ayrıca veri kullanabilir.

Dosyalar 16 KB parçalarla ve sınırlı kanal kuyruğuyla taşınır. Her parçada ayrı
aktarım kimliği bulunur; iptal edilen dosyanın yolda kalan parçaları yeni
indirmeye eklenmez. Alıcı boyutu doğrulayıp teslim onayı verir. İptalde bekleme
zamanlayıcıları, geçici dosya parçaları ve gönderim işlemleri bırakılır.
Frontend istemcileri bu protokole birlikte güncellenmelidir.

## Senkron birlikte izleme

Oda başlığındaki **Birlikte izle** düğmesi video panelini açar. Video veya video
içeren sayfa bağlantısını girin ve **Videoyu tespit et** düğmesine basın.

- YouTube, Vimeo, doğrudan MP4/WebM/OGV ve HLS (`.m3u8`) bağlantıları tanınır.
  Sayfalardaki HTML video kaynakları, gömülü sağlayıcı oynatıcıları, video meta
  bilgileri ve oynatıcı yapılandırmalarındaki açık video bağlantıları aranır.
  Tek, güçlü bir aday bulunursa varsayılan olarak otomatik başlatılır; birden
  fazla kaynakta kullanıcı seçim yapar. Otomatik başlatma kapatılabilir.
- **Tekrar tespit et** yeni bir tarama yapar. İlk taramada bulunmayan, sonradan
  yüklenen video için **Kaynak sekmesinde tespit et** kullanılabilir. Video
  Yardımcısı bağlıysa sonuçsuz sayfa taraması kaynak sekmesine otomatik geçer.
- Her katılımcı videoyu kendi bağlantısından alır. Video görüntüsü/sesi WebRTC
  üzerinden diğer katılımcılara yeniden gönderilmez. Kaynak sekmesindeki video
  uygulamada açıldığında kaynak oynatıcı duraklatılır; aynı ses iki kez çalmaz.
  Herkes videonun internet trafiğini kendi bağlantısında kullanır.
- Ortak oynatma/duraklatma, ileri/geri sarma ve 0,5×–2× hız sunucunun zaman
  çizelgesiyle eşitlenir. İstemci saat farkı kısa ping örnekleriyle ölçülür.
  Küçük kaymalar HTML video oynatıcılarında geçici hız düzeltmesiyle, büyük
  kaymalar zaman değişimiyle toparlanır. Tarayıcı sesli otomatik oynatmayı
  engellerse **Bu cihazda izlemeyi başlat** düğmesi gösterilir.
- Ses seviyesi ve HLS görüntü kalitesi kişiseldir. HLS normalde bağlantıya göre
  otomatik kalite seçer; desteklenen çözünürlükler elle seçilebilir. Yerel HTML
  video sesi seçilen hoparlör/kulaklık çıkışına yönlendirilir. Gömülü sağlayıcı
  oynatıcılarının çıkış cihazı işletim sistemi/tarayıcı tarafından belirlenir.
- Videoyu başlatan kişi izleme yöneticisidir; oda kurucusu da kontrol edebilir
  veya yönetimi devralabilir. Yönetici **Herkes oynatıcıyı kontrol edebilir**
  seçeneğini açabilir. Sonradan katılan/reconnect yapan katılımcı güncel videoyu,
  zamanı, hızı ve kuyruğu alır. Yönetici ayrılırsa kontrol yeni oda kurucusuna geçer.
- Ortak kuyruk en fazla 20 video alır. Link tespit ederken **Kuyruğa ekle**
  işaretlenebilir. **Kuyruğu otomatik ilerlet** açıkken yöneticinin videosu
  bittiğinde sıradaki video açılır. Katılımcıların yükleme, hazır, başlatma
  bekleniyor ve hata durumları panelde gösterilir.
- Görüşmenin mikrofon/kamera/ekran bağlantıları izleme sırasında açık kalır.
  İzlemeyi bitirmek görüşmeden çıkmaz; oynatıcı kaynakları serbest bırakılır.

### Dinamik sayfalarda tespit

Farklı sitenin iframe içeriğine erişim tarayıcı tarafından sınırlandırılır.
Sunucu HTML taraması sayfanın JavaScript'ini çalıştırmaz. Dinamik oynatıcılar
için odadaki yardım bölümünden **Chrome / Edge Video Yardımcısını indir**:

1. ZIP'i klasöre çıkartın. `chrome://extensions` / `edge://extensions` adresinde
   geliştirici modunu açın; **Paketlenmemiş öğe yükle** ile klasörü seçin.
2. WindWatch sekmesindeyken uzantı menüsünden **Açık WindWatch adresine izin ver**
   düğmesine basın ve WindWatch sayfasını yenileyin.
3. Linki girip kaynak sekmesinde tespiti başlatın. Site kullanıcı etkileşimi
   bekliyorsa **Kaynak sekmesine git** ile videoyu başlatın. Video başladığında
   otomatik tespit edilir. Yeniden tespit aynı sekmeyi kullanır.

Bir video linki WindWatch içinde açılamıyorsa **Kaynak sitede senkron izle**,
videoyu katılımcıların kendi kaynak sekmesindeki gerçek HTML oynatıcısında
eşitler. Bu modda her katılımcının uzantıyı kurması, kaynağı açması ve kendi site
erişimine sahip olması gerekir. Yardımcı DRM çözmez, erişim/paywall aşmaz;
kapalı gölge DOM ve korumalı tarayıcı sayfaları erişilebilir değildir. Bir reklam
seçilirse reklam bitince tekrar tespit yapılabilir. Her sitenin dışarıda
oynatılabilir bir video bağlantısı sağladığı veya tüm video kontrollerine izin
verdiği garanti edilmez; hata durumunda kaynak sitede izleme yolu gösterilir.

Kaynaklar yalnızca seçilen sekmede gözlenir. Çerez/parola/HTTP kimlik doğrulama
başlıkları paylaşılmaz. İzinli WindWatch adresleri uzantı menüsünden kaldırılabilir.
İzleme/panel/oda kapanınca gözlemciler durur; kaynak sekmesi kullanıcının açık
sekmesi olarak bırakılır. [Yardımcı kaynakları ve ayrıntılar](extension/README.md).

Uzantı kaynakları değişirse indirilebilir paketi yenileyin:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-helper.ps1
```

Sayfa taraması yalnızca oda üyeleri için yapılır; istek sıklığı, süre, yanıt
boyutu ve yönlendirmeler sınırlıdır. Özel/yerel ağ adreslerine sunucudan erişim
engellenir ve DNS sonucu gerçek isteğe sabitlenir. İçerik veya oturum bilgisi
proxy edilmez; videolar doğrudan kaynak siteden oynatılır. HLS/Vimeo kütüphaneleri
yalnızca ilgili kaynak açıldığında yüklenir. Oda izleme durumu diğer oda verileri
gibi bellektedir ve sunucu yeniden başladığında silinir.

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

Tarayıcı testleri gerçek iki ila dört katılımcılı RTCPeerConnection bağlantıları kurar;
kamera ve mikrofon için tarayıcının test cihazları, ekran için üretilen test
akışları kullanılır. Ayrı medya izleri, mobil sohbet sırasında ses, sonradan
katılım, bağlantı kurtarma, izin beklerken ayrılma, onay zaman aşımı ve dosya
bütünlüğü doğrulanır. Tasarruf için toplam bütçe, AV1 ve VP8 geri dönüşü, katılımcı
değişiminde bitrate paylaşımı, canlı profil geçişi ve üretilmiş hareketli/durağan
ekrandaki kare/veri gönderimi de kontrol edilir. Cihaz önizleme temizliği, canlı
iz değiştirme, başarısız seçim, cihaz çıkarılınca varsayılana geçiş, dosya
ilerlemesi/iptal/yeniden indirme ve ortak gönderim hız sınırı da doğrulanır.
Birlikte izleme testleri gerçek WebM/HLS videolarında oynatma, duraklatma,
ileri sarma, hız, geç katılma, yerel ses seviyesi ve otomatik kuyruk geçişini
kontrol eder. Gerçek Chromium uzantısıyla geç başlayan video tespiti, aynı
sekmede yeniden tarama, kaynak oynatıcı senkronizasyonu, kapalı sekmeyi yeniden
açma ve izleme bitince kaynak sesini durdurma da sınanır. YouTube/Vimeo
bağlantılarının sınıflandırılması kontrol edilir; üçüncü taraf sitelerin canlı
erişim, hesap ve gömme kısıtlamaları bu yerel testlerle doğrulanmaz.
Cihaz değişim testleri tarayıcının test cihazlarına eklenen kontrollü cihaz
kimlikleriyle çalışır; gerçek USB/Bluetooth donanım değişimi ve çıkış sesi
duyulurluğu fiziksel cihazla ayrıca kontrol edilmelidir. İşletim sisteminin gerçek ekran/sistem sesi yakalaması,
gerçek mikrofon-kulaklık akustiği ve uzak ağlardaki TURN bağlantısı bu otomatik
testlerin kapsamı dışındadır.
