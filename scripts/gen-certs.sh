#!/bin/bash
# Vygeneruje certifikáty pre HTTPS. Bez nich kamera na mobiloch NEFUNGUJE —
# prehliadače povolia prístup ku kamere len na dôveryhodnej https:// adrese.
#
# Vyrobia sa dva certifikáty:
#   certs/ca.pem    – lokálna certifikačná autorita; TÚTO si raz nainštaluješ
#                     do telefónov (návod nižšie / na stránke /pomoc.html)
#   certs/cert.pem  – certifikát servera, podpísaný tou CA, platný pre všetky
#                     LAN adresy tohto počítača
#
# Prečo nestačí obyčajný self-signed certifikát: keď v ňom nie je LAN adresa
# (alebo mu telefón neverí), Safari aj Chrome označia stránku za nezabezpečenú
# a getUserMedia (kamera) zlyhá — aj keď varovanie preklikneš.
set -e
cd "$(dirname "$0")/.."
mkdir -p certs

# Pozbieraj IP adresy tohto počítača v lokálnej sieti.
IPS=$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -v '^127\.' || true)
if [ -z "$IPS" ]; then
  IPS=$(hostname -I 2>/dev/null || true)
fi

ALT="DNS:localhost,DNS:$(hostname),IP:127.0.0.1"
for ip in $IPS; do ALT="$ALT,IP:$ip"; done

echo "Certifikát bude platiť pre:"
echo "  $ALT" | tr ',' '\n' | sed 's/^/    /'
echo

# --- 1. Lokálna CA (tá sa inštaluje do telefónov) ---------------------------
openssl req -x509 -newkey rsa:2048 -nodes -sha256 \
  -keyout certs/ca-key.pem -out certs/ca.pem \
  -days 825 -subj "/CN=LPT2 tabor CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

# --- 2. Certifikát servera, podpísaný tou CA --------------------------------
# iOS 13+ vyžaduje: SAN, extendedKeyUsage=serverAuth, RSA >= 2048,
# platnosť max 825 dní, SHA-256. Toto všetko spĺňa.
openssl req -newkey rsa:2048 -nodes -sha256 \
  -keyout certs/key.pem -out certs/server.csr \
  -subj "/CN=LPT2 rozdelovacka" 2>/dev/null

cat > certs/server.ext <<EOF
subjectAltName=$ALT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF

openssl x509 -req -in certs/server.csr -sha256 \
  -CA certs/ca.pem -CAkey certs/ca-key.pem -CAcreateserial \
  -out certs/cert.pem -days 825 -extfile certs/server.ext 2>/dev/null

rm -f certs/server.csr certs/server.ext certs/ca.pem.srl certs/.srl

echo "Hotovo. Reštartuj server (node server.js)."
echo
echo "Na telefónoch treba RAZ nainštalovať certifikačnú autoritu:"
echo "  1. Otvor v telefóne stránku s návodom: https://<IP>:3443/pomoc.html"
echo "  2. Stiahni a nainštaluj certifikát (tlačidlo na tej stránke)"
echo "  3. iPhone: Nastavenia -> Všeobecné -> Info -> Nastavenia dôvery"
echo "     certifikátov -> zapni prepínač pri 'LPT2 tabor CA'"
echo "  4. Android: Nastavenia -> Zabezpečenie -> Certifikáty -> nainštaluj"
echo "     ako 'certifikát CA'"
