# Proyecto Grúa — Control web por Bluetooth (BLE)

Interfaz web moderna para controlar la grúa (brazo robótico de 4 servos) directamente
desde el navegador, conectada de forma **inalámbrica por Bluetooth de baja energía (BLE)**
a un **ESP32**.

Este proyecto reemplaza la app de escritorio en C# (`GruaControl`) por una página web que
funciona en cualquier computador o celular Android con Chrome/Edge, sin instalar nada.

---

## 1. ¿Por qué ESP32 en vez del HC-05 que ya tenías?

Los navegadores (Chrome, Edge, etc.) implementan la API **Web Bluetooth**, que solo sabe
hablar **Bluetooth de baja energía (BLE)**. El HC-05/HC-06 que usaba tu Arduino original es
**Bluetooth clásico** (perfil SPP, "puerto serie por Bluetooth"), y eso **no es accesible
desde una página web** — por diseño del estándar, ningún navegador lo soporta ni lo va a
soportar.

El ESP32 sí tiene un radio BLE integrado, así que el firmware nuevo (`firmware/grua_ble/`)
expone un servicio BLE estándar ("Nordic UART Service") que la página web puede descubrir y
usar directamente, sin programas intermedios ni cables.

> Tu Arduino original (`grua.ino`, `grua_recordings.ino`) y la app de escritorio
> (`GruaControl/`) siguen funcionando igual que siempre si los quieres seguir usando; este
> proyecto es un **camino alternativo**, no reemplaza el hardware existente.

---

## 2. Estructura del proyecto

```
grua-control-web/
├── firmware/
│   └── grua_ble/
│       └── grua_ble.ino      # Firmware del ESP32 (servos + grabaciones + BLE)
├── web/
│   ├── index.html            # Página principal
│   ├── css/styles.css        # Estilos (tema claro/oscuro automático, responsive)
│   └── js/
│       ├── protocol.js       # Construcción/parseo de comandos (lógica pura, sin DOM ni BLE)
│       ├── ble.js            # Conexión Web Bluetooth (GATT, notificaciones, escritura)
│       ├── ui.js             # Construcción de la interfaz (sliders, tarjetas, log)
│       └── app.js            # Conecta todo lo anterior y maneja el estado de la app
├── tests/
│   └── protocol.test.js      # Pruebas unitarias (QA) del protocolo, sin hardware ni navegador
├── package.json
└── README.md                 # Este archivo
```

Separar `protocol.js` (lógica pura) de `ble.js` (transporte) y `ui.js` (interfaz) permite
probar las reglas de negocio (rangos de ángulos, formato de comandos, parseo de respuestas)
con pruebas automatizadas rápidas, sin depender de un navegador ni de tener la grúa conectada.

---

## 3. Cableado del ESP32

| Servo            | Pin ESP32 | Rango de ángulo |
|-------------------|-----------|------------------|
| 1 — Base           | GPIO 13   | 0° – 180°        |
| 2 — Codo           | GPIO 14   | 0° – 180°        |
| 3 — Hombro         | GPIO 27   | 25° – 155°       |
| 4 — Pinza (garra)  | GPIO 26   | 80° – 145°       |

- Todos los servos comparten **GND** con el ESP32.
- Alimenta los servos con una **fuente externa de 5V** (no desde el pin 5V/3V3 del ESP32):
  los 4 servos moviéndose a la vez pueden pedir más corriente de la que la placa puede dar,
  y eso causa reinicios aleatorios del ESP32.
- Si esos pines ya están ocupados en tu placa, cámbialos al inicio de `grua_ble.ino`
  (constante `SERVO_PINS`) y vuelve a cargar el firmware. Evita los pines 0, 2, 5, 12, 15
  (arrancan el ESP32 en modos especiales) y el rango 34-39 (son solo de entrada).

> **Nota:** el sketch original (`grua.ino`) también leía dos joysticks y un botón físico
> para mover la grúa sin necesidad de la app. Ese control físico **no se migró** a este
> firmware BLE (los pines analógicos y de arranque del ESP32 no coinciden con los del
> Arduino Uno). Si lo necesitas, dilo y lo agregamos sobre esta misma base.

---

## 4. Cargar el firmware en el ESP32

1. Abre **Arduino IDE** (2.x recomendado).
2. **Archivo → Preferencias**, y en "Gestor de URLs Adicionales de Tarjetas" agrega:
   `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
3. **Herramientas → Placa → Gestor de tarjetas**, busca **esp32** (Espressif Systems) e
   instálalo.
4. **Herramientas → Gestionar bibliotecas**, busca **ESP32Servo** (de Kevin Harrington /
   John K. Bennett) e instálala. (Las librerías BLE y EEPROM ya vienen incluidas con el
   soporte de placa ESP32, no hay que instalarlas aparte.)
5. Conecta el ESP32 por USB, elige tu modelo en **Herramientas → Placa** (por ejemplo
   "ESP32 Dev Module") y el puerto correspondiente.
6. Abre `firmware/grua_ble/grua_ble.ino` y presiona **Subir**.
7. Abre el **Monitor Serie** a 115200 baudios: al encender deberías ver el ID del firmware,
   `READY`, y luego `Esperando conexion BLE ('Grua-ESP32')...`.

---

## 5. Ejecutar la interfaz web

Web Bluetooth solo funciona en un **contexto seguro** (`https://` o `http://localhost`), así
que **no puedes abrir `index.html` haciendo doble clic** (eso carga la página como
`file://`, y el navegador bloquea Bluetooth ahí). Necesitas servirla con un servidor local.

**Opción rápida (Python, ya viene instalado en la mayoría de sistemas):**

```bash
cd web
python3 -m http.server 8000
```

Luego abre `http://localhost:8000` en **Chrome** o **Edge**.

**Alternativa (Node.js):**

```bash
cd web
npx http-server -p 8000
```

**Para usarla desde el celular** (Chrome en Android): sirve la carpeta con algún hosting
gratuito por HTTPS (GitHub Pages, Netlify, Vercel, etc.) y ábrela desde ahí — el celular no
puede llegar al `localhost` de tu computador salvo que estén en la misma red y uses la IP
local con un certificado válido, así que un hosting con HTTPS es lo más simple.

> **Compatibilidad:** Web Bluetooth funciona en Chrome/Edge/Opera de escritorio y en Chrome
> para Android. **No funciona en Safari (iOS/macOS) ni en Firefox** — es una limitación del
> navegador, no de esta app. Si el navegador no lo soporta, la página lo detecta y muestra
> un aviso en vez de fallar en silencio.

---

## 6. Usar la interfaz

1. Enciende el ESP32 de la grúa.
2. Abre la página y presiona **«Conectar por Bluetooth»**.
3. En la ventana que abre el navegador, elige **`Grua-ESP32`** y confirma.
4. Cuando el punto de estado se ponga verde ("Conectado"), la grúa vuelve sola a una
   posición inicial conocida, y ya puedes:
   - Mover la grúa con el **mando tipo videojuego** (mantén presionado un botón, como en
     una máquina de peluches — ver sección 6.1).
   - Abrir/cerrar la garra con sus botones dedicados.
   - Grabar una secuencia de movimientos en cualquiera de los 6 slots (botón **Grabar**,
     mueve los servos, y **Detener**), reproducirla luego con **Reproducir**, o borrarla.
   - Ver el registro de actividad (comandos, confirmaciones, avisos) en tiempo real.
   - Si prefieres un control más preciso, abre **"Ajuste fino (sliders)"** para mover cada
     servo con un slider tradicional en vez de mantener presionado.

### 6.1 Mando tipo videojuego

| Control                          | Mueve                | Con el teclado |
|-----------------------------------|-----------------------|----------------|
| ▲ / ▼ (D-pad)                     | Hombro (arriba/abajo)  | `↑` / `↓`      |
| ◀ / ▶ (D-pad)                     | Base (izquierda/derecha) | `←` / `→`    |
| Extender / Recoger                | Codo (reach)           | `E` / `Q`      |
| Abrir garra / Cerrar garra        | Pinza                  | `Espacio` (alterna) |

Mantén presionado (mouse, dedo, o tecla) y la grúa se mueve de a poco mientras lo sostengas,
igual que el joystick físico del proyecto original — al soltar, se detiene donde quedó.

> **Nota sobre las direcciones:** como no probamos el firmware sobre tu grúa física, elegimos
> una convención razonable (por ejemplo, "Extender" gira el codo hacia un lado). Si al
> probarlo alguna dirección queda invertida respecto al movimiento real, es un cambio de una
> sola línea: en `web/js/app.js`, busca el comentario **"Convención de signos"** cerca de
> `GAMEPAD_STEP_DEGREES` y cambia el signo de la dirección que corresponda.

Si pasan más de 7 segundos sin que la página le mande nada al ESP32, el firmware avisa
`WARN:LINK:LOST` (se ve un aviso rojo en la interfaz); por eso la app manda automáticamente
un `PING` cada 3 segundos aunque no muevas nada, para mantener el enlace activo.

---

## 7. Protocolo de comandos

La interfaz y el firmware se hablan por texto plano, un comando por línea (terminada en
`\n`). Es el mismo protocolo que ya usaba el Arduino original, para no tener que rediseñar
la lógica de servos/grabaciones.

**La interfaz le manda al ESP32:**

| Comando              | Efecto                                              |
|-----------------------|------------------------------------------------------|
| `ID?`                  | Pide el identificador del firmware                   |
| `PING` / `HELLO`      | Igual que `ID?`, sirve para probar el enlace          |
| `S{1-4}:{ángulo}`     | Mueve el servo indicado (1=Base 2=Codo 3=Hombro 4=Pinza) |
| `REC:SLOTS?`          | Pide el estado de los 6 slots de grabación            |
| `REC:VALIDATE?`       | Valida la memoria de grabaciones                      |
| `REC:START:{1-6}`     | Empieza a grabar en ese slot                          |
| `REC:STOP`            | Detiene la grabación activa                           |
| `REC:PLAY:{1-6}`      | Reproduce ese slot                                    |
| `REC:CLEAR:{1-6}`     | Borra ese slot                                        |
| `REC:CLEAR:ALL`       | Borra los 6 slots                                     |

**El ESP32 le manda a la interfaz** (algunos sin que se los pidan):

| Mensaje                          | Significado                                      |
|-----------------------------------|---------------------------------------------------|
| `HB:ALIVE`                        | "Late" cada 2s mientras el ESP32 está vivo         |
| `WARN:LINK:LOST` / `INFO:LINK:RESTORED` | Aviso de enlace caído / recuperado           |
| `REC:SLOTS:xxxxxx`                | Estado (guardado/vacío) de los 6 slots             |
| `REC:STARTED:n` / `REC:STOPPED:n` | Confirmación de inicio/fin de grabación            |
| `REC:PLAYING:n` / `REC:PLAYED:n`  | Confirmación de inicio/fin de reproducción         |
| `REC:EMPTY:n` / `REC:FULL`        | Slot vacío al reproducir / grabación llena         |

Ver `web/js/protocol.js` para el detalle exacto de cómo se construyen y se interpretan.

---

## 8. Calidad y pruebas (QA)

### Pruebas automatizadas

`protocol.js` es lógica pura (sin DOM, sin BLE), así que se puede probar con Node sin
navegador ni hardware:

```bash
npm test
```

Cubre: recorte de ángulos fuera de rango, el espejado del servo de la Base, los límites
propios de cada servo (p. ej. la Pinza entre 80°-145°), la construcción de todos los
comandos `REC:*`, y el parseo de todas las respuestas que manda el firmware (incluyendo
líneas vacías o con caracteres raros, para que un mensaje corrupto por BLE no rompa la
interfaz).

### Checklist de pruebas manuales (con el ESP32 real)

- [ ] La página muestra el aviso de "navegador no compatible" en Safari/Firefox, y el botón
      de conectar en Chrome/Edge funciona.
- [ ] Al conectar, aparece el ID del firmware en el pie de página y el punto de estado se
      pone verde.
- [ ] Cada botón del mando (▲▼◀▶, Extender/Recoger) mueve el servo correcto mientras se
      mantiene presionado, y se detiene al soltar.
- [ ] Las mismas direcciones funcionan con el teclado (flechas, `Q`/`E`, `Espacio`).
- [ ] Si una dirección se ve invertida respecto al movimiento físico real, se corrigió el
      signo correspondiente en `app.js` (ver sección 6.1).
- [ ] Los sliders de "Ajuste fino" mueven el servo correspondiente en el rango esperado.
- [ ] Los botones "Abrir garra" / "Cerrar garra" mueven el slider de la Pinza y el servo.
- [ ] Grabar un slot, detenerlo, y reproducirlo mueve la grúa reproduciendo la secuencia.
- [ ] Borrar un slot y "Borrar todo" limpian las tarjetas correctamente.
- [ ] Apagar el ESP32 dispara el aviso de "Sin respuesta" / enlace perdido en la interfaz.
- [ ] Desconectar y volver a conectar funciona sin recargar la página.
- [ ] Probado en un celular Android con Chrome (si aplica).

---

## 9. Solución de problemas

- **"Este navegador no soporta Web Bluetooth"**: usa Chrome o Edge, y asegúrate de estar en
  `https://` o `http://localhost` (no abras el archivo directo con doble clic).
- **No aparece `Grua-ESP32` en la lista de dispositivos**: revisa que el ESP32 esté
  encendido y que el Monitor Serie muestre "Esperando conexion BLE"; acércate al ESP32
  (BLE tiene menos alcance que el Bluetooth clásico del HC-05).
- **Se conecta pero los servos no se mueven**: revisa el cableado (pines/GND/alimentación
  externa) y mira el Monitor Serie por USB — el firmware imprime ahí lo mismo que manda por
  BLE.
- **Se desconecta solo**: casi siempre es alimentación (los servos "chupan" corriente al
  moverse y hacen caer el voltaje del ESP32) — usa una fuente externa dedicada para los
  servos, no la salida del ESP32.
