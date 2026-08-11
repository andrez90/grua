/*
 * ============================================================================
 *  Proyecto Grúa — Firmware ESP32 (control inalámbrico por Bluetooth BLE)
 * ============================================================================
 *
 *  Este sketch reemplaza la comunicación por cable serie + módulo HC-05
 *  (Bluetooth clásico) del proyecto original por un servicio BLE "Nordic
 *  UART Service" (NUS), que sí puede conectarse directamente desde una
 *  página web moderna usando la API Web Bluetooth del navegador.
 *
 *  El PROTOCOLO de comandos (los textos que se envían y reciben) es
 *  exactamente el mismo que usaba el Arduino original (grua.ino), para
 *  que la lógica de negocio (servos, pinza, grabación de movimientos)
 *  no tenga que reinventarse:
 *
 *    Comandos que envía la interfaz -> la grúa:
 *      ID?                  -> pide el identificador del firmware
 *      PING | HELLO | HELLO?-> igual que ID?, útil para probar el enlace
 *      S{1-4}:{angulo}      -> mueve un servo (1=Base 2=Codo 3=Hombro 4=Pinza)
 *      REC:SLOTS?           -> pide el estado de los 6 slots de grabación
 *      REC:VALIDATE?        -> valida la memoria EEPROM de grabaciones
 *      REC:START:{1-6}      -> empieza a grabar en el slot indicado
 *      REC:STOP             -> detiene la grabación activa
 *      REC:PLAY:{1-6}       -> reproduce el slot indicado
 *      REC:CLEAR:{1-6}      -> borra un slot
 *      REC:CLEAR:ALL        -> borra todos los slots
 *
 *    Mensajes que envía la grúa -> la interfaz (sin pedirlos):
 *      HB:ALIVE             -> "late" cada 2s mientras está viva
 *      WARN:LINK:LOST       -> no llegó ningún comando en 7s
 *      INFO:LINK:RESTORED   -> volvió a llegar actividad tras un LINK:LOST
 *      REC:*                -> confirmaciones de las operaciones de arriba
 *
 *  ---------------------------------------------------------------------
 *  CABLEADO (ajusta los pines si tu ESP32 los tiene ocupados):
 *  ---------------------------------------------------------------------
 *    Servo 1 (Base)    -> GPIO 13
 *    Servo 2 (Codo)    -> GPIO 14
 *    Servo 3 (Hombro)  -> GPIO 27
 *    Servo 4 (Pinza)   -> GPIO 26
 *    Todos los servos comparten GND con el ESP32 y se alimentan con una
 *    fuente externa de 5V (NO desde el pin 5V/3V3 del ESP32: los 4 servos
 *    en simultáneo pueden pedir más corriente de la que el regulador de
 *    la placa puede entregar).
 *
 *  ---------------------------------------------------------------------
 *  LIBRERÍAS NECESARIAS (Arduino IDE > Herramientas > Administrar bibliotecas):
 *  ---------------------------------------------------------------------
 *    - "ESP32Servo" de Kevin Harrington / John K. Bennett
 *    - Las librerías BLE (BLEDevice, BLEServer, ...) y EEPROM.h ya vienen
 *      incluidas al instalar el soporte de placas "esp32" by Espressif
 *      Systems en el Board Manager.
 *
 *  Board: cualquier placa "ESP32 Dev Module" (o la que corresponda a tu
 *  módulo específico).
 * ============================================================================
 */

#include <EEPROM.h>
#include <ESP32Servo.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ----------------------------------------------------------------------------
// Identidad del firmware / dispositivo BLE
// ----------------------------------------------------------------------------
const char* Firmware_ID_MeArm = "C5HF6U3SBKBB8BSB6KU3-BLE";
const char* BLE_DEVICE_NAME   = "Grua-ESP32";

// Nordic UART Service: estándar de facto para "puerto serie sobre BLE",
// compatible con Web Bluetooth y con la inmensa mayoría de apps BLE genéricas.
#define SERVICE_UUID           "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_RX "6E400002-B5A3-F393-E0A9-E50E24DCCA9E" // el navegador ESCRIBE aquí
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E" // el ESP32 NOTIFICA aquí

BLEServer* pServer = nullptr;
BLECharacteristic* pTxCharacteristic = nullptr;
BLECharacteristic* pRxCharacteristic = nullptr;
volatile bool deviceConnected = false;
volatile bool oldDeviceConnected = false;

// ----------------------------------------------------------------------------
// Servos: mismos rangos/orden que el proyecto original
// (0=Base, 1=Codo(hombro fisico), 2=Hombro(codo fisico), 3=Pinza)
// Los nombres "Codo"/"Hombro" reflejan como los etiqueta la interfaz, no
// necesariamente la articulación mecánica real; se conserva tal cual el
// proyecto original para no romper la numeración S1..S4 ya conocida.
// ----------------------------------------------------------------------------
const uint8_t SERVO_COUNT = 4;
const uint8_t SERVO_PINS[SERVO_COUNT] = {13, 14, 27, 26};
const int SERVO_MIN_ANGLE[SERVO_COUNT] = {0, 25, 0, 80};
const int SERVO_MAX_ANGLE[SERVO_COUNT] = {180, 155, 180, 145};
Servo servos[SERVO_COUNT];
int servo_values[SERVO_COUNT] = {90, 60, 150, 145};

// ----------------------------------------------------------------------------
// Grabación de movimientos (idéntico al original, persistido en EEPROM
// emulada por flash; en ESP32 hay que llamar EEPROM.begin()/commit()).
// ----------------------------------------------------------------------------
const uint8_t REC_MAGIC[4] = {'V', 'R', 'M', '1'};
const uint8_t REC_SLOT_LIMIT = 6;
const uint8_t REC_FRAME_LIMIT = 28;
const uint8_t REC_TIME_QUANTUM_MS = 20;

struct RecordingFrame {
  uint8_t servo[4];
  uint8_t dt_ticks;
};

struct RecordingSlot {
  uint8_t valid;
  uint8_t frame_count;
  RecordingFrame frames[REC_FRAME_LIMIT];
};

RecordingSlot recording_slots[REC_SLOT_LIMIT];
int active_recording_slot = -1;
unsigned long last_record_ms = 0;

// Tamaño total que ocupa la estructura de grabaciones en la EEPROM emulada.
const size_t EEPROM_SIZE = 6 + (size_t)REC_SLOT_LIMIT * (2 + sizeof(RecordingFrame) * REC_FRAME_LIMIT) + 16;

String input_buffer;
const unsigned long HEARTBEAT_INTERVAL_MS = 2000UL;
const unsigned long LINK_TIMEOUT_MS = 7000UL;
unsigned long lastHeartbeatMs = 0;
unsigned long lastHostActivityMs = 0;
bool linkLostNotified = false;

// ============================================================================
// Envío de texto hacia la interfaz (reemplaza a Serial.println del original)
// ============================================================================
void bleSend(const String& line) {
  Serial.println(line); // se conserva también por USB, útil para depurar con el Monitor Serie
  if (deviceConnected && pTxCharacteristic != nullptr) {
    // BLE tiene un límite de tamaño por notificación (MTU). Nuestros mensajes
    // son cortos, pero por seguridad se recorta si algo se escapara de eso.
    String payload = line + "\n";
    const size_t maxChunk = 180;
    for (size_t offset = 0; offset < payload.length(); offset += maxChunk) {
      String chunk = payload.substring(offset, min(payload.length(), offset + maxChunk));
      pTxCharacteristic->setValue((uint8_t*)chunk.c_str(), chunk.length());
      pTxCharacteristic->notify();
      delay(5); // pequeño respiro entre notificaciones consecutivas
    }
  }
}

void markHostActivity() {
  lastHostActivityMs = millis();
  if (linkLostNotified) {
    linkLostNotified = false;
    bleSend("INFO:LINK:RESTORED");
  }
}

void connectionHealthTick() {
  unsigned long now = millis();
  if ((unsigned long)(now - lastHeartbeatMs) >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMs = now;
    bleSend("HB:ALIVE");
  }

  if (!linkLostNotified && (unsigned long)(now - lastHostActivityMs) >= LINK_TIMEOUT_MS) {
    linkLostNotified = true;
    stop_recording();
    bleSend("WARN:LINK:LOST");
  }
}

// ============================================================================
// Persistencia de grabaciones en EEPROM (idéntico al original + commit())
// ============================================================================
int eeprom_base_address() {
  return 0;
}

int slot_eeprom_offset(uint8_t slot_index) {
  return eeprom_base_address() + 6 + slot_index * (2 + sizeof(RecordingFrame) * REC_FRAME_LIMIT);
}

void save_slot_to_eeprom(uint8_t slot_index) {
  if (slot_index >= REC_SLOT_LIMIT) {
    return;
  }
  int addr = slot_eeprom_offset(slot_index);
  EEPROM.write(addr++, recording_slots[slot_index].valid);
  EEPROM.write(addr++, recording_slots[slot_index].frame_count);
  for (uint8_t i = 0; i < REC_FRAME_LIMIT; ++i) {
    RecordingFrame frame = recording_slots[slot_index].frames[i];
    for (uint8_t s = 0; s < 4; ++s) {
      EEPROM.write(addr++, frame.servo[s]);
    }
    EEPROM.write(addr++, frame.dt_ticks);
  }
  EEPROM.commit();
}

void load_slot_from_eeprom(uint8_t slot_index) {
  if (slot_index >= REC_SLOT_LIMIT) {
    return;
  }
  int addr = slot_eeprom_offset(slot_index);
  recording_slots[slot_index].valid = EEPROM.read(addr++);
  recording_slots[slot_index].frame_count = EEPROM.read(addr++);
  if (recording_slots[slot_index].frame_count > REC_FRAME_LIMIT) {
    recording_slots[slot_index].valid = 0;
    recording_slots[slot_index].frame_count = 0;
  }
  for (uint8_t i = 0; i < REC_FRAME_LIMIT; ++i) {
    for (uint8_t s = 0; s < 4; ++s) {
      recording_slots[slot_index].frames[i].servo[s] = EEPROM.read(addr++);
    }
    recording_slots[slot_index].frames[i].dt_ticks = EEPROM.read(addr++);
  }
}

void initialize_recordings_storage() {
  EEPROM.begin(EEPROM_SIZE);

  if (EEPROM.read(0) == REC_MAGIC[0] && EEPROM.read(1) == REC_MAGIC[1] &&
      EEPROM.read(2) == REC_MAGIC[2] && EEPROM.read(3) == REC_MAGIC[3]) {
    for (uint8_t slot = 0; slot < REC_SLOT_LIMIT; ++slot) {
      load_slot_from_eeprom(slot);
    }
    return;
  }

  EEPROM.write(0, REC_MAGIC[0]);
  EEPROM.write(1, REC_MAGIC[1]);
  EEPROM.write(2, REC_MAGIC[2]);
  EEPROM.write(3, REC_MAGIC[3]);
  EEPROM.write(4, REC_SLOT_LIMIT);
  EEPROM.write(5, REC_FRAME_LIMIT);
  EEPROM.commit();
  for (uint8_t slot = 0; slot < REC_SLOT_LIMIT; ++slot) {
    recording_slots[slot].valid = 0;
    recording_slots[slot].frame_count = 0;
    save_slot_to_eeprom(slot);
  }
}

bool has_saved_recordings() {
  for (uint8_t i = 0; i < REC_SLOT_LIMIT; ++i) {
    if (recording_slots[i].valid > 0 && recording_slots[i].frame_count > 1) {
      return true;
    }
  }
  return false;
}

bool recording_layout_is_valid() {
  if (EEPROM.read(4) != REC_SLOT_LIMIT || EEPROM.read(5) != REC_FRAME_LIMIT) {
    return false;
  }
  for (uint8_t slot = 0; slot < REC_SLOT_LIMIT; ++slot) {
    RecordingSlot& current = recording_slots[slot];
    if (current.valid > 1) return false;
    if (current.frame_count > REC_FRAME_LIMIT) return false;
    if (current.valid == 1 && current.frame_count < 2) return false;
  }
  return true;
}

void validate_recordings_for_host() {
  if (has_saved_recordings()) {
    bleSend(recording_layout_is_valid() ? "REC:VALID:SAVED" : "REC:INVALID:SAVED");
    return;
  }
  bleSend(recording_layout_is_valid() ? "REC:VALID:EMPTY" : "REC:INVALID:EMPTY");
}

void clear_all_recordings() {
  active_recording_slot = -1;
  for (uint8_t slot = 0; slot < REC_SLOT_LIMIT; ++slot) {
    recording_slots[slot].valid = 0;
    recording_slots[slot].frame_count = 0;
    save_slot_to_eeprom(slot);
  }
  bleSend("REC:CLEARED:ALL");
  emit_recording_slots();
}

void emit_recording_slots() {
  String line = "REC:SLOTS:";
  for (uint8_t i = 0; i < REC_SLOT_LIMIT; ++i) {
    line += (recording_slots[i].valid > 0 ? '1' : '0');
  }
  bleSend(line);
}

void capture_recording_frame(uint8_t slot_index) {
  if (slot_index >= REC_SLOT_LIMIT) return;
  RecordingSlot& slot = recording_slots[slot_index];
  if (slot.frame_count >= REC_FRAME_LIMIT) return;

  unsigned long now = millis();
  uint8_t dt_ticks = 0;
  if (slot.frame_count != 0) {
    unsigned long dt = now - last_record_ms;
    unsigned long ticks = dt / REC_TIME_QUANTUM_MS;
    if (ticks > 255UL) ticks = 255UL;
    dt_ticks = (uint8_t)ticks;
  }
  last_record_ms = now;

  RecordingFrame& frame = slot.frames[slot.frame_count];
  for (uint8_t s = 0; s < 4; ++s) {
    frame.servo[s] = (uint8_t)servo_values[s];
  }
  frame.dt_ticks = dt_ticks;
  slot.frame_count += 1;
}

void start_recording(uint8_t slot_index) {
  if (slot_index >= REC_SLOT_LIMIT) return;
  recording_slots[slot_index].valid = 0;
  recording_slots[slot_index].frame_count = 0;
  active_recording_slot = slot_index;
  last_record_ms = millis();
  capture_recording_frame(slot_index);
  bleSend("REC:STARTED:" + String(slot_index + 1));
}

void stop_recording() {
  if (active_recording_slot < 0) {
    bleSend("REC:STOPPED:0");
    return;
  }
  uint8_t slot_index = (uint8_t)active_recording_slot;
  if (recording_slots[slot_index].frame_count > 1) {
    recording_slots[slot_index].valid = 1;
  }
  save_slot_to_eeprom(slot_index);
  active_recording_slot = -1;
  bleSend("REC:STOPPED:" + String(slot_index + 1));
  emit_recording_slots();
}

void clear_recording_slot(uint8_t slot_index) {
  if (slot_index >= REC_SLOT_LIMIT) return;
  if (active_recording_slot == slot_index) {
    active_recording_slot = -1;
  }
  recording_slots[slot_index].valid = 0;
  recording_slots[slot_index].frame_count = 0;
  save_slot_to_eeprom(slot_index);
  bleSend("REC:CLEARED:" + String(slot_index + 1));
  emit_recording_slots();
}

void playback_recording_slot(uint8_t slot_index) {
  if (slot_index >= REC_SLOT_LIMIT) return;
  RecordingSlot& slot = recording_slots[slot_index];
  if (slot.valid == 0 || slot.frame_count == 0) {
    bleSend("REC:EMPTY:" + String(slot_index + 1));
    return;
  }
  bleSend("REC:PLAYING:" + String(slot_index + 1));
  for (uint8_t i = 0; i < slot.frame_count; ++i) {
    RecordingFrame& frame = slot.frames[i];
    unsigned long dt = (unsigned long)frame.dt_ticks * REC_TIME_QUANTUM_MS;
    if (dt > 0) delay(dt);
    for (uint8_t s = 0; s < 4; ++s) {
      apply_servo(s, frame.servo[s]);
    }
  }
  bleSend("REC:PLAYED:" + String(slot_index + 1));
}

// ============================================================================
// Servos
// ============================================================================
void apply_servo(uint8_t index, int angle) {
  int clamped = constrain(angle, SERVO_MIN_ANGLE[index], SERVO_MAX_ANGLE[index]);
  servos[index].write(clamped);
  servo_values[index] = clamped;
  if (active_recording_slot >= 0) {
    RecordingSlot& slot = recording_slots[(uint8_t)active_recording_slot];
    if (slot.frame_count < REC_FRAME_LIMIT) {
      capture_recording_frame((uint8_t)active_recording_slot);
    } else {
      stop_recording();
      bleSend("REC:FULL");
    }
  }
  // Sin confirmación por cada comando: al arrastrar un slider llegan ~30
  // comandos/s y el eco satura el enlace BLE (igual criterio que el original).
}

// ============================================================================
// Intérprete de comandos (idéntico al original)
// ============================================================================
void handle_command(const String& command) {
  markHostActivity();

  if (command.equalsIgnoreCase("ID?")) {
    bleSend("ID " + String(Firmware_ID_MeArm));
    return;
  }

  if (command.equalsIgnoreCase("PING") || command.equalsIgnoreCase("HELLO") || command.equalsIgnoreCase("HELLO?")) {
    bleSend(String(Firmware_ID_MeArm));
    return;
  }

  if (command.equalsIgnoreCase("REC:SLOTS?")) {
    emit_recording_slots();
    return;
  }

  if (command.equalsIgnoreCase("REC:VALIDATE?")) {
    validate_recordings_for_host();
    return;
  }

  if (command.equalsIgnoreCase("REC:CLEAR:ALL")) {
    clear_all_recordings();
    return;
  }

  if (command.equalsIgnoreCase("REC:STOP")) {
    stop_recording();
    return;
  }

  if (command.startsWith("REC:START:")) {
    int slot = command.substring(10).toInt();
    if (slot >= 1 && slot <= REC_SLOT_LIMIT) {
      start_recording((uint8_t)(slot - 1));
      emit_recording_slots();
    }
    return;
  }

  if (command.startsWith("REC:PLAY:")) {
    int slot = command.substring(9).toInt();
    if (slot >= 1 && slot <= REC_SLOT_LIMIT) {
      playback_recording_slot((uint8_t)(slot - 1));
    }
    return;
  }

  if (command.startsWith("REC:CLEAR:")) {
    int slot = command.substring(10).toInt();
    if (slot >= 1 && slot <= REC_SLOT_LIMIT) {
      clear_recording_slot((uint8_t)(slot - 1));
    }
    return;
  }

  if (command.length() >= 4 && (command.startsWith("S") || command.startsWith("s"))) {
    int colon = command.indexOf(':');
    if (colon > 1) {
      int servo_id = command.substring(1, colon).toInt();
      int value = command.substring(colon + 1).toInt();
      if (servo_id >= 1 && servo_id <= SERVO_COUNT) {
        apply_servo((uint8_t)(servo_id - 1), value);
        return;
      }
    }
  }
}

// Alimenta el intérprete de comandos con datos que llegaron en cualquier
// fuente (BLE o Serie de depuración), partiendo por saltos de línea, igual
// que hacía el "while (Serial.available())" del sketch original.
void feed_input_stream(const uint8_t* data, size_t length) {
  for (size_t i = 0; i < length; ++i) {
    char incoming = (char)data[i];
    if (incoming == '\n' || incoming == '\r') {
      if (input_buffer.length() > 0) {
        handle_command(input_buffer);
        input_buffer = "";
      }
    } else if (input_buffer.length() < 63) {
      input_buffer += incoming;
    }
  }
}

// ============================================================================
// BLE: callbacks de conexión y de datos entrantes
// ============================================================================
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* server) override {
    deviceConnected = true;
  }
  void onDisconnect(BLEServer* server) override {
    deviceConnected = false;
  }
};

class RxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    String value = characteristic->getValue();
    if (value.length() > 0) {
      feed_input_stream((const uint8_t*)value.c_str(), value.length());
    }
  }
};

void setup_ble() {
  BLEDevice::init(BLE_DEVICE_NAME);
  BLEDevice::setMTU(247); // permite notificaciones/paquetes más grandes que el default de 23 bytes

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService* pService = pServer->createService(SERVICE_UUID);

  pTxCharacteristic = pService->createCharacteristic(
      CHARACTERISTIC_UUID_TX, BLECharacteristic::PROPERTY_NOTIFY);
  pTxCharacteristic->addDescriptor(new BLE2902());

  pRxCharacteristic = pService->createCharacteristic(
      CHARACTERISTIC_UUID_RX, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  pRxCharacteristic->setCallbacks(new RxCallbacks());

  pService->start();

  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->start();
}

// ============================================================================
// setup() / loop()
// ============================================================================
void setup() {
  Serial.begin(115200);
  input_buffer.reserve(64);

  initialize_recordings_storage();

  for (uint8_t i = 0; i < SERVO_COUNT; ++i) {
    servo_values[i] = constrain(servo_values[i], SERVO_MIN_ANGLE[i], SERVO_MAX_ANGLE[i]);
    servos[i].setPeriodHertz(50);
    servos[i].attach(SERVO_PINS[i], 500, 2400);
    delay(30);
    servos[i].write(servo_values[i]);
  }

  setup_ble();

  Serial.println(Firmware_ID_MeArm);
  Serial.println("READY");
  Serial.println("Esperando conexion BLE ('" + String(BLE_DEVICE_NAME) + "')...");

  lastHeartbeatMs = millis();
  lastHostActivityMs = lastHeartbeatMs;
}

void loop() {
  connectionHealthTick();

  // Cuando un cliente se conecta recién, le mandamos el mismo saludo que el
  // Arduino original mandaba una sola vez al encender (ID + READY + estado
  // de grabaciones), porque en BLE el "puerto" se abre y se cierra muchas
  // veces (cada vez que la página web se conecta), no solo al arrancar.
  if (deviceConnected && !oldDeviceConnected) {
    delay(300); // pequeño margen para que el cliente termine de suscribirse a notify
    markHostActivity();
    bleSend(String(Firmware_ID_MeArm));
    bleSend("READY");
    emit_recording_slots();
  }
  if (!deviceConnected && oldDeviceConnected) {
    stop_recording();
    delay(200);
    pServer->startAdvertising(); // vuelve a ser visible para reconectar
  }
  oldDeviceConnected = deviceConnected;

  // Además de BLE, se puede seguir probando por USB con el Monitor Serie.
  while (Serial.available()) {
    char incoming = (char)Serial.read();
    uint8_t byteValue = (uint8_t)incoming;
    feed_input_stream(&byteValue, 1);
  }
}
