# bc4f0ce sonrası değişiklikler: inceleme ve stabilizasyon planı

İnceleme tarihi: 2026-09-03. Başlangıç commit'i:
`bc4f0ce63560096d2692bc791998174b8b98f93c` (hariç). İncelenen son commit:
`37b156855210780f934dd1d7b9531b221504e1aa` (dahil).

Bu rapor 7 commit ve 63 değişen dosyayı kapsayan kaynak incelemesini,
ilgili mevcut testlerin sonucunu ve kontrollü hata denemelerini kaydeder.
Uygulama kodunda düzeltme yapılmadı. İşlerin takibi
[Roadmap / Priority 0 stabilizasyon planında](../ROADMAP.md#priority-0-post-bc4f0ce-stabilization)
yapılır. Her akış ayrı incelenip düzeltilmeli; tamamlanma kutuları ancak
ilgili kabul ölçütleri sağlandığında kapatılmalı.

## Öncelik ve kanıt kuralları

Bu altı akışın tamamı roadmap'te **Priority 0** işidir: yeni özellik ve ölçek
çalışmalarından önce ele alınır. Bu, her bulgunun aynı hata şiddetinde olduğu
anlamına gelmez. Mevcut webOS 4 soğuk açılış doğrulaması da Priority 0 kalır.

- **Yeniden üretildi:** Üretim kodu veya üretim kaynağından çıkarılan fonksiyon,
  sentetik girdi ve kontrollü bağımlılıklarla çalıştırıldı. Gerçek TV testi değildir.
- **Kodla doğrulandı:** Çağrı zinciri ve durum geçişi kaynakta görüldü;
  uçtan uca kullanıcı senaryosu ayrıca test edilmelidir.
- **Aday / doğrulama gerekli:** Risk veya davranış farkı belirlendi; gözlenen
  kullanıcı hatası olarak kabul edilmemelidir.
- **Devralınan eksik:** Başlangıç commit'inde de bulunan sorun veya eksik;
  yeni commit'in oluşturduğu regresyon diye etiketlenmez.

## Değişiklik haritası

| Commit | Değişiklik | Etkilenen akış |
| --- | --- | --- |
| `e871d57` | İsteğe bağlı uzaktan tanılama, ayarlar ve logger bağlantısı | A |
| `74569f9` | HTTP alıcısı, depolama ve gösterge paneli kurulumu | F |
| `f2e5b3f` | Gösterge paneli provisioning ve volume düzeltmeleri | F |
| `d28410b` | Geri tuşu tekrarı, Home dönüşü ve çıkış sayacı | E |
| `8eedb33` | Türkçe normalizasyon ve 24/7 dizi/canlı ayrımı | B, C |
| `b518b57` | Dahili Luna istemcisi ve tüketicilerin geçişi | D, E |
| `37b1568` | Upstream birleştirmesi; başlangıç testleri ve test ayarları | D, bütünleşik doğrulama |

Birleştirme kaydında `e2e/startup.spec.ts` ve `vitest.config.ts` çatışmaları
bulunuyor. Son durum, yeni bridge taklidini önceki başlangıç HTTP fixture'larıyla
birleştiriyor; worker sınırı ve coverage ayarlarını koruyor. Bu dosyalarda
inceleme sırasında ayrıca kanıtlanmış bir merge hatası bulunmadı.

## Bulgu özeti

| Kimlik | Etki | Durum | Bulgular / yapılacak iş |
| --- | --- | --- | --- |
| A1 | Yüksek | Yeniden üretildi | JSON metnindeki hassas alan maskelenmeden gönderilebiliyor |
| A2 | Yüksek | Yeniden üretildi | Eski başarısız paket kapatma ve adres değişimi sonrasında geri geliyor |
| A3 | Orta | Yeniden üretildi | Askıda geçirilen süre arayüz gecikmesi olarak raporlanabiliyor |
| A4 | Yüksek | Doğrulama gerekli | Kapanışta kuyruk teslimi ve oturum işaretinin anlamı |
| B1 | Yüksek | Fonksiyon deneyi + çağrı zinciri | Önbellek yüklemesi M3U kayıtlarının türünü değiştirebiliyor |
| B2 | Yüksek | Aday; karar kuralı yeniden üretildi | Belirsiz dizi URL'leri yeterli canlı kanıtı olmadan 24/7 kabul ediliyor |
| C1 | Yüksek | Yeniden üretildi | EPG eşleme aramasının worker ve yerel yolları farklı sonuç veriyor |
| D1 | Yüksek | Yeniden üretildi + çağrı zinciri | Cevapsız tek seferlik Luna istekleri tutulmaya devam ediyor |
| D2 | Orta | Yeniden üretildi; devralınan eksik | Dizi biçimindeki JSON yanıtı başarı kabul ediliyor |
| E1 | Yüksek | Cihaz doğrulaması gerekli | Çıkış artık Home başlatmak yerine pencereyi kapatıyor |
| F1 | Orta | Yeniden üretildi | Bozuk JSON ve null gövde istemci hatası yerine 503 oluyor |
| F2 | Orta | Doğrulama gerekli | Sağlık kontrolü ve panel sayaçları operasyonel başarıyı tek başına kanıtlamıyor |

## A — Telemetri istemcisi ve ayarlar

Akış: Settings → StorageService → Telemetry.configure → logger/capture →
en fazla 100 olaylık kuyruk → en fazla 25 olaylık POST → alıcı.
Normal gönderim aralığı 10 saniye, heartbeat aralığı 30 saniye ve HTTP zaman
aşımı 5 saniye. Debug ve işaretlenmemiş info kayıtları gönderilmiyor.

### A1 — JSON metni hassas alan temizliğini atlıyor

Kaynak: `src/services/telemetry.ts:101` (`scrubString`, `scrub`, `message`).
Ek çağrı örneği: `src/app.ts:623`, Luna hatasını `JSON.stringify(err)` ile logluyor.

Nesne olarak verilen `{ password: 'synthetic-secret' }` anahtar üzerinden
maskelenirken, aynı nesnenin JSON metni yalnızca metin temizleyiciden geçiyor.
Bu temizleyici `password=...` biçimini tanıyor, JSON'daki iki noktalı biçimi
tanımıyor. Sentetik JSON metniyle oluşturulan pakette `synthetic-secret`
aynen kaldı. Bu bir maskeleme sınırı hatasıdır; gerçek kimlik bilgisi
sızdığına ilişkin cihaz kaydı incelenmedi.

Yapılacaklar: Yapılandırılmış logları koru; JSON metni, hata mesajı ve iç içe
değerler için tutarlı bir temizlik politikası belirle. Metin dönüşümlerinin
derinlik sınırında temizliği atlamadığını denetle.

Kabul: Sentetik sır; nesne, JSON metni, Error, URL ve iç içe dizi üzerinden
verildiğinde son HTTP gövdesinde bulunmamalı. Yararlı hata bağlamı korunmalı.

### A2 — Yeniden yapılandırma eski gönderimleri ayırmıyor

Kaynak: `src/services/telemetry.ts:178` (`flush`) ve `:197` (`configure`).

Tekrar üretme sırası:

1. Tanılamayı `http://host:4318` için aç ve 25 olayla gönderimi başlat.
2. İstek sonuçlanmadan tanılamayı kapat; `configure` kuyruğu boşaltır.
3. Eski isteği başarısız tamamla; `catch` eski paketi kuyruğa geri ekler.
4. Tanılamayı `http://host:9000` için aç ve gönderim zamanlayıcısını ilerlet.

Eski 25 olay yeni adrese gönderildi. İstek sonucu, oluşturulduğu ayar sürümüyle
ilişkilendirilmediği için kapatma sırasında temizlenen veriyi yeniden getiriyor.
Adres açık durumdayken değiştirilirse de eski kuyruk/gönderim sonucu için
ayrıştırılmış bir politika yok.

Yapılacaklar: Gönderim ve kuyruk sahipliğini yapılandırma nesliyle ilişkilendir;
kapatma ve adres değişimi sonrasında eski tamamlanmaları etkisizleştir.
Gönderilmiş bir isteğin sunucuya ulaşmış kısmının geri alınabileceği varsayılmamalı.

Kabul: Aç → gönder → kapat → hata → farklı adrese aç dizisinde eski olay
yeniden kuyruğa alınmamalı. Yeni neslin gönderimi eski callback tarafından
engellenmemeli. Hızlı aç/kapat, boş adres, timeout ve başarılı geç yanıt test edilmeli.

### A3 — Askıdan dönüş yanlış donma sinyali üretebiliyor

Kaynak: `src/services/telemetry.ts:229`.

Heartbeat gecikmesi son callback zamanından hesaplanıyor. Yalnızca callback
anındaki `document.hidden` kontrol ediliyor; görünürlük geçişi zaman tabanını
sıfırlamıyor. Kontrollü deneyde uygulama gizlendi, zaman 180 saniye ilerletildi,
uygulama görünür yapıldı ve gecikmiş heartbeat çalıştırıldı. Sonuç
`performance.event_loop_lag` ve `lagMs=150000` oldu.

Yapılacaklar: Ön planda geçirilen zaman ile askıda geçirilen zamanı ayır.
Heartbeat ve oturum yaşam döngüsünü aynı görünürlük sözleşmesine bağla.

Kabul: Askıya alma/dönüş bir UI donması sayılmamalı; ön planda gerçek 2 saniye
ve üzeri gecikme algılanmaya devam etmeli. Gerçek cihaz zamanlayıcı davranışı
ayrıca doğrulanmalı.

### A4 — Kapanış, son paket ve ayar kaydı denetimi

Kaynak: `src/services/telemetry.ts:236`, `src/app.ts:366`,
`src/components/settings.ts:1979`, `src/services/storage-service.ts:809`.

`pagehide`, `session.end` ekleyip beklemeden `flush()` çağırıyor. Başka gönderim
varsa flush hemen döner; oturum işareti teslim sonucu beklenmeden kaldırılır.
Bu koddan son olayın sunucuya ulaştığı sonucu çıkarılamaz. Yerel temiz kapanış
işareti ile uzaktaki olay teslimi ayrı anlamlara sahip olmalıdır.

Doğrulama: 0/24/25/100 bekleyen olay, devam eden istek, çevrimdışı sunucu,
ani kapanma ve askıdan dönüş. Tanılamanın kapalı başlaması, sonradan açılması,
Settings Cancel, kayıt hatası ve yeniden açılışta ayar tutarlılığı da incelenmeli.
Adres normalizasyonunda port, tam yol, sorgu, IPv6 ve geçersiz girdi sınırları
tanımlanmalı; mevcut iki endpoint örneği tam kapsam sayılmamalı.

Kabul: Çıkış süresini sınırsız uzatmayan, webOS 4 ile uyumlu teslim/kayıp
politikası belgelenmeli ve test edilmeli. `session.previous_unclean` bir
kesin çökme teşhisi olarak sunulmamalı.

## B — 24/7 yayınlar, kaynak türü ve önbellek

Akış: M3U grup sınıflandırması / Xtream canlı API → kaynak filtresi →
birleşik önbellek → tür indeksleri → Home, Search ve M3U dizi kataloğu.

### B1 — Xtream filtresi M3U önbelleğini de değiştiriyor

Kaynak: `src/services/playlist-service.ts:78` ve `:211`.

`isXtreamLiveEntry` artık karar vermenin yanında `channel.contentKind = 'live'`
ataması yapıyor. `load()` ise bu fonksiyonu, kaydın Xtream üyeliğine bakmadan
önbellekteki her kanal için çağırıyor. Bu yan etki `8eedb33` ile eklendi.

Üretim kaynağından çıkarılan fonksiyona yalnızca `m3u1` üyeliği olan,
`name='Alpha Part 1'`, `url='http://host/play/ch1'`, `contentKind='series'`
kaydı verildi. Girdi nesnesinin türü `live` oldu. Kaynak incelemesi bu
fonksiyonun M3U-only önbellek yüklemesinde de çağrıldığını doğruluyor;
tam yenileme → kalıcı kayıt → yeniden açılış testi henüz çalıştırılmadı.

Etki: Yenilemede dizi sayılan kayıt yeniden açılışta farklı indekse girebilir;
dizi görünürlüğü, Home sayımları ve kayıtlı öğeyi türe göre çözümleme etkilenebilir.

Yapılacaklar: Filtreyi yan etkisiz hale getir; gerekiyorsa tür normalizasyonunu
kaynak bilgisi olan tek bir sınırda uygula. Ortak M3U/Xtream üyeliği olan
kayıtlar için kaynak bazlı anlamın korunmasını denetle.

Kabul: M3U-only, Xtream-only ve ortak üyelikli kayıtlar; taze yükleme,
önbellekten yükleme ve yenileme sonrasında aynı amaçlanan türü korumalı.
Önbellek okuma filtresi girdiyi habersiz değiştirmemeli. Favori, resume ve
Watchlist kimlikleri kaybolmamalı.

### B2 — Bilinmeyen yayın, 24/7 yayına eşitleniyor

Kaynak: `src/utils/m3u-episode.ts:31`, `src/components/search.ts:519`,
`:806`, `:891`, `src/components/m3u-catalog.ts:314`.

Kural; tanınan VOD uzantısı, `/movie/` veya `/series/` kök yolu ve tanınan
sezon/bölüm adı yoksa true dönüyor. Örneğin `Alpha Part 1` ve
`http://host/a.m3u8` true veriyor. Manifestin canlı mı sabit süreli mi olduğu
bu kararda bilinmiyor. Bu deney kararın genişliğini kanıtlar; örnek akışın
gerçekte VOD olduğunu kanıtlamaz.

Search, bu kayıtları yerel dizi sonuçlarından çıkarıp kanal sonuçlarına
alabiliyor. M3U dizi kataloğu aynı yardımcıyı uygulamıyor; türe göre seçip
bölüm adı çözülemeyenleri düz listeye alıyor. Dolayısıyla sınıflandırma
yalnızca arama görünümünde düzeltilmiş olmamalı.

Yapılacaklar: Canlı, bölüm ve belirsiz kayıtlar için karar tablosu hazırla.
Yetkili kaynak türü, yol, kapsayıcı ve isim ipuçlarının önceliğini belirle.
URL'deki eksik kanıtı otomatik canlı kanıtı sayma. Ağ probe'u eklemek zorunlu
çözüm değildir; mevcut kaynak bilgisi önce kullanılmalı.

Kabul: Sürekli yayın, uzantısız VOD, HLS VOD, farklı bölüm adı, sorguda uzantı,
kökte olmayan servis yolu ve açık `/live/` rotası sentetik örneklerle kapsanmalı.
Home, Live, Search, Series ve cache aynı kararı kullanmalı. Arama limitinden
sonra yapılan tür filtresinin uygun sonuçları dışarıda bırakıp bırakmadığı
ayrıca kontrol edilmeli; bu son limit sorunu yeni regresyon olarak doğrulanmadı.

## C — Türkçe arama ve worker/yerel sonuç eşitliği

### C1 — EPG eşleme araması worker kaybında eşleşme kaybediyor

Kaynak: `src/workers/scoped-search-index.ts:115`,
`src/services/epg-service.ts:396`, `src/components/channel-list-editor.ts:1085`.

Worker, alanları ve sorguyu `foldDiacritics` ile hazırlıyor. Yerel EPG yolu
alanlar ve sorgu için yalnızca küçük harfe çevirme kullanıyor. Düzenleyici,
worker hatasında bu yerel yola geçiyor.

Üretim worker sınıfı ve üretim kaynağından çıkarılan yerel yöntem aynı
`Alpha Işık` kaydıyla çalıştırıldı. `isik` sorgusunda worker 1 sonuç,
yerel yol 0 sonuç verdi. Yeni normalizasyon bu iki yol arasındaki farkı büyütüyor.

Yapılacaklar: Alan hazırlama ve sorgu normalizasyonunu iki yolda ortaklaştır.
Seçili kaydın korunması, kaynak önceliği ve eşit puan sıralamasını değiştirme.
M3U katalog fallback'i (`src/components/m3u-catalog.ts:498`) de yalnızca
küçük harf/substring kullanıyor; bütün arama yüzeyleri için kapsama tablosuna ekle.
Bu ikinci yolun bazı aksan farkları önceden de vardı.

Kabul: `I/İ/ı/i`, `Ç/ç`, `Ğ/ğ`, `Ö/ö`, `Ş/ş`, `Ü/ü`, birleşik/ayrışık
Unicode ve noktalama örnekleri worker açıkken ve zorla başarısızken aynı
uygun kayıtları vermeli. EPG kimliği, görünen ad, alias ve seçili eşleme
kapsanmalı. Grup ikonu ve içerik türü sözlüklerinde normalizasyonun mevcut
eşleşmeleri bozmadığı denetlenmeli. Gerçek kanal adı kullanılmamalı.

## D — Luna taşıma katmanı ve tüketicileri

Akış: `lunaRequest` → PalmServiceBridge → başarı/hata callback'i →
tek seferlik istek temizliği veya aboneliği tutma. Tüketiciler: uygulama
servis yaşam döngüsü, hatırlatıcılar, DRM ve native altyazı kontrolü.

### D1 — Cevapsız isteklerin sahipliği ve ömrü sınırsız

Kaynak: `src/services/luna.ts:28`, `:90`, `src/app.ts:438`,
`src/services/playready-drm.ts` içindeki `call` ve
`src/components/player-tracks.ts` içindeki `setNativeCC`.

Yeni `activeRequests` dizisi, callback veya açık iptal gelene kadar bridge'i
tutuyor. Cevap vermeyen sahte bridge'e üç tek seferlik çağrı yapıldığında
üçü de tutuldu; taşıma katmanı hiçbir timeout kurmadı. Uygulamadaki 3 saniyelik
başlangıç timeout'u Promise'i sonuçlandırıyor ama Luna handle'ını iptal etmiyor.

DRM ve native altyazı tüketicilerindeki cevapsız kalma politikası da incelenmeli:
DRM çağrısı bekleyebilir, altyazı `ccPending` durumunda kalabilir. Tüketicilerdeki
timeout eksikliği kısmen devralınmıştır; yeni güçlü referans listesi ayrıca
ömür yönetimini gerekli kılıyor.

Yapılacaklar: Tek seferlik istek ve abonelik için ayrı süre/iptal sözleşmesi
belirle. Başlangıçtaki kasıtlı geç başarı kurtarmasını koruyarak istek sahibini
ve görünürlük neslini takip et. Her isteğe körlemesine aynı timeout ekleme.

Kabul: Cevapsız çağrı, geç başarı, görünürlük değişimi, servis yeniden başlatma
ve oynatıcıdan ayrılma sonrasında terk edilmiş bridge kalmamalı. Mevcut geç
başlangıç kurtarma çalışmalı. DRM ve altyazı bekleme durumu sınırlı olmalı.
Gerçek cihazda tekrarlı çevrimlerin kaynak kullanımı ayrıca ölçülmeli.

### D2 — Yanıt biçimi doğrulaması eksik

Kaynak: `src/services/luna.ts:122` ve `isFailure`.

JSON dizi değeri `[]`, object kontrolünden geçip başarı callback'ini çağırdı.
Bu kabul eski shim'de de vardı; geçişte giderilmemiş bir protokol eksikliği.
Bozuk JSON/primitive testleri diziyi kapsamıyor.

Yapılacaklar: Yanıtın nesne sözleşmesini doğrula. `returnValue` alanı olmayan
geçerli servis yanıtlarını yanlışlıkla reddetme. Hata kodu türü ve başarısız
aboneliğin terminal olup olmadığı tüketici sözleşmesiyle birlikte incelenmeli.

Kabul: Dizi/null/primitive/bozuk JSON hata yoluna gitmeli; normal yanıtlar
korunmalı. Geç callback, tüketici callback'inin hata fırlatması ve iptalin
tekrarlanması tek tamamlanma/temizlik beklentileriyle test edilmeli.
`serviceEvents` başarısızlığından sonra gerekli yeniden abonelik davranışı
belirlenmeli; mevcut kodun yalnızca logladığı unutulmamalı.

## E — Geri tuşu, Home dönüşü ve uygulamadan çıkış

### E1 — Çıkış sözleşmesi cihazda yeniden doğrulanmalı

Kaynak: `src/app.ts:366`, `:826`, `:895`, `:917`,
`src/navigation/key-handler.ts:166`, `e2e/home.spec.ts`.

Eski shim, çıkış yolunda TV'nin Home uygulamasını başlatıyordu. Yeni yol,
kullanıcı verisini yazdıktan sonra servisi durdurup `window.close()` çağırıyor.
Bu gerçek bir davranış değişikliğidir; tek başına hata kanıtı değildir.
Home E2E testleri `window.close` taklidiyle çağrı sayısını ölçüyor;
TV'nin pencere/askı/yeniden açılış davranışını kanıtlamıyor.

Geri tuşu düzeltmesi Home'a dönüşte sayacı sıfırlıyor ve `repeat=true`
olaylarını engelliyor. Bunun farklı görünüm geçmişleriyle birleşimi incelenmeli.
Çıkış yazması beklerken üçüncü ayrı basışın ikinci bir `exitApp()` başlatması
için de mevcut kodda tek işlem koruması yok; bu devralınan risk ayrıca
geciktirilmiş kayıt senaryosuyla doğrulanmalı.

Doğrulama sırası:

1. Live/Guide/Settings/Search/katalog/detay/oynatıcı → Back → beklenen görünüm.
2. Home'da ilk basış → uyarı; süre içindeki ikinci ayrı basış → tek çıkış.
3. Basılı tutma, input/overlay odakları, süre aşımı ve Home'dan ayrılıp dönüş.
4. Yavaş/başarısız veri yazması; çıkış sırasında oynatma ve servis durumu.
5. TV'de kapanış → yeniden açılış; ayrıca askıya alma → devam etme.

Kabul: İstenmeyen çıkış ve yinelenen kayıt/çıkış işlemi olmamalı. Başarısız
kayıtta uygulama açık kalmalı. Native video, LAN servis portu ve abonelik
durumu seçilen çıkış sözleşmesine uymalı. Cihaz/firmware ve derleme kimliğiyle
kayıt alınmalı; eski webOS 4 doğrulama maddesi bu kanıtla ilişkilendirilmeli.

## F — Telemetri alıcısı ve gösterge paneli

Akış: TV'nin text/plain JSON isteği → HTTP gövde/olay doğrulama → Loki push →
başarılı yanıt → Grafana sorgusu. Bu alıcı TV içindeki bundled-service değildir;
ayrı konteynerde çalışır.

### F1 — Kalıcı gövde hataları geçici servis hatası gibi dönüyor

Kaynak: `ops/telemetry/receiver/server.js:122` ve `:138`.

HTTP handler'ı socket açmadan, sahte istek/yanıt ve sentetik gövdelerle
çalıştırıldı. `{` gövdesi ve `null` gövdesi ayrı ayrı 503
`ingest_unavailable` verdi. JSON parse hatası ve null üzerinde alan erişimi,
depolama kesintisiyle aynı catch bloğuna gidiyor.

Yapılacaklar: Sözdizimi/şema hatasını upstream erişim hatasından ayır.
İstemcinin her başarısız paketi yeniden kuyruğa almasıyla birlikte değerlendir;
kalıcı olarak geçersiz bir paket tekrar deneme döngüsünde tutulmamalı.
Boyut aşımında `req.destroy()` sonrası 413'ün istemciye gerçekten ulaşıp
ulaşmadığını gerçek yerel HTTP testiyle ayrıca denetle.

Kabul: Bozuk JSON/null/yanlış şema 400; boyut aşımı tanımlı davranış;
depolama kesintisi geçici hata olmalı. Geçerli paket 204 almalı.
İstemcide kalıcı hata ile geçici hata için açık kuyruk politikası bulunmalı.

### F2 — Operasyonel doğrulama ve sayaç anlamları

`GET /health` depolamaya istek yapmadan 200 dönüyor. Bu bir süreç canlılık
kontrolüdür; uçtan uca olay saklama kanıtı değildir. Bağlantı testi ise POST
yolundan geçtiği için depolama kabulünü de denetler. Raporda bu iki sonuç
birbirinin yerine kullanılmamalı.

Paneldeki `playback.stall.*` sorgusu `reload` ve `exhausted` olaylarını
sayabiliyor; tek bir kesintinin kurtarma denemeleri ayrı olaylar olduğundan
sayaç doğrudan benzersiz donma sayısı kabul edilmemeli. UI gecikme paneli de
A3'teki askıdan dönüş sinyalinden etkilenebilir.

Yapılacaklar: Liveness/readiness ayrımını ve metrik tanımlarını belgele;
gerekirse kontrol/panel adlarını veya olay modelini düzelt. Kurulumu boş volume
ve mevcut volume ile doğrula; provision edilen veri kaynağı/panel, yeniden
başlatma, saklama süresi ve disk doluluğu davranışını denetle.

Kabul: Sentetik test olayı bağlantı testi sonrasında panelde görünmeli.
Depolama kapalıyken süreç canlı olsa da ingest başarısızlığı anlaşılmalı.
Aynı sentetik kesintinin deneme sayısı ile kesinti sayısı ayırt edilebilmeli.
Mevcut konteyner sürümlerinin çalıştığı veya kurulumun tamamlandığı bu raporda
iddia edilmiyor; Docker/Pi/TV ortamında çalıştırma yapılmadı.

## Mevcut doğrulama ve sınırlar

| Kontrol | Sonuç |
| --- | --- |
| `npm run typecheck` | Geçti |
| `npm run lint` | Geçti |
| İlgili 9 Vitest dosyası | 227 test geçti |
| Sentetik kaynak deneyleri | A1/A2/A3, B1 fonksiyonu, B2 kararı, C1, D1/D2, F1 yeniden üretildi |
| Tam birim testi / E2E / IPK / TV / Docker | Bu rapor çalışmasında çalıştırılmadı |

Çalıştırılan hedefli test komutu:

```bash
npm test -- src/services/telemetry.test.ts src/services/luna.test.ts src/services/m3u-series.test.ts src/services/playlist-service.test.ts src/components/search.test.ts src/utils/unicode-text.test.ts src/utils/channel-search.test.ts src/navigation/key-handler.test.ts src/workers/scoped-search-index.test.ts
```

Deney aracı yerel ve ignore edilen `test-output/post-bc4f0ce-audit.cjs`,
çıktısı `test-output/post-bc4f0ce-audit-results.json` dosyasında bulunur.
`node test-output/post-bc4f0ce-audit.cjs` ile mevcut çalışma alanında tekrar
çalıştırılabilir; bu dosyalar sürümlenen regresyon testleri değildir.
Bağımlılıklar taklit edildi; gerçek ağ isteği, cihaz erişimi veya kimlik
bilgisi kullanılmadı. B1'de tüm PlaylistService yaşam döngüsü yerine kaynak
fonksiyonu; C1'in yerel tarafında kaynak yöntemi çalıştırıldı. D1'in iç
referans sayacı yalnızca deney kopyasına eklenmiş bir gözlem noktasıdır.

Mevcut telemetri testleri temel adres dönüşümü, başarılı test gönderimi ve
nesne/URL temizliğini kapsıyor; başarısız gönderim yarışı ve askı zamanı yok.
Luna testleri normal yanıt, iptal, abonelik ve bozuk JSON'u kapsıyor;
cevapsız tüketici ömrü ve JSON dizisi yok. 24/7 testleri pozitif canlı örneği
ve bilinen bölüm/rota reddini kapsıyor; M3U cache yeniden açılışı yok.
Yeşil mevcut testler, bu rapordaki sınır durumlarının doğru olduğunu göstermez.

## Uygulama sırası ve tamamlanma ölçütü

1. **P0-A:** Önce A1/A2; ardından A3/A4 ile tanılama verisinin güvenilirliği.
2. **P0-B:** B1'i regresyon testiyle sabitle; B2 karar tablosunu ve tüm
   tüketicilerde aynı sınıflandırmayı tamamla.
3. **P0-C:** Worker ve fallback sonuç eşitliğini aynı fixture üzerinden doğrula.
4. **P0-D:** İstek sahipliği, timeout ve abonelik ömrünü tüketicilerle birlikte düzelt.
5. **P0-E:** D sonrası gezinme/çıkış senaryolarını masaüstü ve TV'de doğrula.
6. **P0-F:** A ile uyumlu HTTP hata politikası ve uçtan uca panel doğrulaması.
7. **P0-G:** Son değişiklikler üzerinde bütünleşik regresyon ve cihaz kanıtı.

Her akışta sıra: yeniden üretme → mevcut mimariye uygun küçük düzeltme → ilgili
regresyon testi → kabul kanıtı → roadmap kutusunu kapatma. Yeni bir durum
konteyneri veya playback mimarisi kurmak bu işlerin hedefi değildir.

Son doğrulama; typecheck/lint, tam `npm test`, her iki Playwright projesinde
tam `npm run test:e2e`, build ve cihaz gerektiren bulgular için gerçek cihaz
kanıtını kapsamalı. Bundled-service kodu değişirse `npm run service:smoke`
ayrıca gerekir. Commit istenirse AGENTS.md'deki son değişiklikler üzerinde
tam test ve kesin commit mesajı onayı kuralları geçerlidir.

İnceleme veya masaüstü testinin tamamlanması, açık cihaz doğrulamasını
tamamlanmış saymak için yeterli değildir. İlk inceleme sırasında hiçbir
düzeltme işi tamamlanmış olarak işaretlenmemişti. Güncel uygulama durumu
ROADMAP.md'de tutulur; P0-A istemci ve ayar kapsamı tamamlandı ve bu işin
kapanışı için fiziksel webOS 4 doğrulaması şartı kaldırıldı.
