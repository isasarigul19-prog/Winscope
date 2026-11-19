WinScope tek yönetici güvenlik yaması

Bu ZIP tam uygulama değildir; mevcut WinScope projesine eklenecek güvenlik yamasıdır. "server.js" analiz motorunun içindeki fonksiyonlara dokunmaz.

Kurulum

1. GitHub'da "security/single-admin-auth" dalında çalış.
2. "auth.js", "auth.test.js", "install-security.js" dosyalarını "server.js" ve "package.json" ile aynı klasörde tut.
3. "scripts" klasörünü de proje köküne kopyala.
4. Proje klasöründe terminalden çalıştır:

node install-security.js
npm run check

Kurulum betiği "server.js.before-single-admin.bak" yedeği oluşturur. Beklediği kod işaretleri bulunmazsa dosyaları değiştirmeden durur.

Render ortam değişkenleri

Render > Web Service > Environment bölümüne şu iki değişken eklenir:

- "WINSCOPE_ADMIN_PASSWORD_HASH"
- "WINSCOPE_SESSION_SECRET"

Parola özetini üretmek için:

node scripts/hash-admin-password.js

En az 12 karakterli bir parola kullan. Parola ekranda görünmez.

Oturum anahtarı üretmek için:

node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"

Gerçek parolayı veya oturum anahtarını GitHub'a yükleme.

Test ve yayın

- Önce "npm run check" testlerini çalıştır.
- Önce ayrı bir Render test servisi kullan.
- Login ekranını ve doğru parola ile giriş işlemini test et.
- "main" dalına onay olmadan merge etme.
- Üretim servisine onay olmadan dağıtım yapma.

Bu yama tek yönetici içindir. Çoklu kullanıcı veya parola sıfırlama sistemi içermez.
