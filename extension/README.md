# WindWatch Video Yardımcısı

Chrome / Edge için Manifest V3 uzantısı. Dinamik sitelerde videoları, açık gölge
DOM içindeki oynatıcıları, erişilebilir iframe'leri ve HLS ağ yanıtlarını tespit
eder. Tespit edilen dosya/yayın URL'si WindWatch oynatıcısında açılabilir. Kaynak
site başka yerde oynatmaya izin vermiyorsa **Kaynak sitede senkron izle** seçeneği
her katılımcının kendi tarayıcısındaki HTML video oynatıcısını senkronize eder.

## Kurulum

1. Odadan yardımcı ZIP dosyasını indirin, bir klasöre çıkartın.
2. `chrome://extensions` veya `edge://extensions` adresinde geliştirici modunu açın.
3. **Paketlenmemiş öğe yükle** ile bu klasörü seçin.
4. WindWatch sekmesindeyken uzantı simgesini açıp **Açık WindWatch adresine izin ver**
   düğmesine basın. WindWatch sayfasını yenileyin.
5. Odaya dönün, linki girin ve **Kaynak sekmesinde tespit et** düğmesine basın.
   Video sonradan açılırsa otomatik tespit edilir. **Tekrar tespit et** mevcut
   kaynak sekmesini tekrar tarar; yeni bir sekme açmaz.

Kaynak sekmesi önce arka planda açılır. Site kullanıcı etkileşimi bekliyorsa
**Kaynak sekmesine git** ile videoyu bir kez başlatın. Kaynak sitede senkron
izleme için her katılımcının yardımcıyı kurması ve siteye kendi erişiminin olması
gerekir. Uzantı DRM çözmez, kapalı gölge DOM'a veya tarayıcının koruduğu sayfalara
erişmez; kısıtlamalı sitelerin video URL'lerinin başka yerde açılacağını garanti
etmez. Birden fazla oynatıcıda oynatılan, uzun süreli ve büyük video tercih edilir;
bir reklam yine de seçilirse reklam bitince **Tekrar tespit et** kullanılmalıdır.

## İzinlerin kapsamı

Her kaynak siteye erişebilmesi için HTTP/HTTPS site izinleri gerekir. Tespit ve
ağ yanıtı işleme yalnızca WindWatch'ta açıkça seçilmiş kaynak sekmesinde çalışır.
İzinli WindWatch adresleri uzantı menüsünden yönetilir. Sekmeler, oynatma
örnekleri ve en fazla 30 aday `chrome.storage.session` içinde tutulur; tarayıcı
kapanınca silinir. Çerezler ve HTTP kimlik doğrulama başlıkları okunmaz/aktarılmaz.
Oda/izleme kapanınca gözlemciler durur; açılmış kaynak sekmesi kullanıcıya bırakılır.
