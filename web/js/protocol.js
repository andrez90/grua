/**
 * protocol.js
 * ----------------------------------------------------------------------------
 * Lógica pura del protocolo de comandos de la Grúa (ESP32/Arduino).
 *
 * Intencionalmente NO toca el DOM ni el Bluetooth: solo construye strings de
 * comando y traduce las líneas de texto que manda el firmware en objetos
 * fáciles de consumir por la interfaz. Esto permite probarlo con pruebas
 * unitarias simples (ver tests/protocol.test.js) sin necesitar un navegador
 * ni un dispositivo BLE real.
 * ----------------------------------------------------------------------------
 */

// Configuración de cada servo: debe coincidir EXACTAMENTE con los límites
// definidos en el firmware (grua_ble.ino) para que nunca se mande un ángulo
// fuera de rango.
export const SERVOS = Object.freeze({
  base: Object.freeze({ id: 1, label: 'Base', min: 0, max: 180, default: 90, mirrored: true }),
  codo: Object.freeze({ id: 2, label: 'Codo', min: 0, max: 180, default: 60, mirrored: false }),
  hombro: Object.freeze({ id: 3, label: 'Hombro', min: 0, max: 180, default: 150, mirrored: false }),
  pinza: Object.freeze({ id: 4, label: 'Pinza', min: 80, max: 145, default: 145, mirrored: false }),
});

export const GRIPPER_OPEN_ANGLE = 80;
export const GRIPPER_CLOSED_ANGLE = 145;

export const RECORDING_SLOT_COUNT = 6;

/** Redondea y recorta un ángulo al rango [min, max]. */
export function clampAngle(min, max, value) {
  const rounded = Math.round(Number(value));
  if (Number.isNaN(rounded)) {
    throw new TypeError(`Ángulo inválido: ${value}`);
  }
  return Math.min(max, Math.max(min, rounded));
}

/**
 * Refleja un ángulo dentro de su propio rango (min+max-valor).
 * Se usa para el servo de la base, que está montado "al revés" respecto
 * al valor que se muestra en pantalla (igual que en la app de escritorio
 * original: SendBaseCommand en Form1.cs).
 */
export function mirrorAngle(min, max, value) {
  return min + max - value;
}

/**
 * Construye el comando de texto para mover un servo, dado un valor "de
 * interfaz" (el que ve/arrastra la persona). Devuelve tanto el comando
 * final como el valor efectivamente aplicado, por si la interfaz necesita
 * re-sincronizar el slider tras el clamping.
 *
 * @param {keyof typeof SERVOS | object} servo - clave en SERVOS, o el
 *   objeto de configuración del servo directamente.
 * @param {number} uiValue
 */
export function buildServoCommand(servo, uiValue) {
  const config = typeof servo === 'string' ? SERVOS[servo] : servo;
  if (!config) {
    throw new RangeError(`Servo desconocido: ${servo}`);
  }
  const clampedUiValue = clampAngle(config.min, config.max, uiValue);
  const physicalAngle = config.mirrored
    ? mirrorAngle(config.min, config.max, clampedUiValue)
    : clampedUiValue;

  return {
    command: `S${config.id}:${physicalAngle}`,
    uiValue: clampedUiValue,
    physicalAngle,
  };
}

/**
 * Calcula el siguiente ángulo al mantener presionado un control direccional
 * tipo "joystick" (por ejemplo, el D-pad de la interfaz o las flechas del
 * teclado): avanza `stepDegrees` en la dirección indicada y recorta al
 * rango del servo. Es lo mismo que hacía el firmware original con los
 * joysticks físicos (JOY_SPEED por ciclo), pero como función pura y
 * reutilizable tanto para botones como para teclado.
 *
 * @param {number} min
 * @param {number} max
 * @param {number} currentAngle
 * @param {-1|0|1} direction
 * @param {number} [stepDegrees]
 */
export function nextAngleForDirection(min, max, currentAngle, direction, stepDegrees = 2) {
  if (direction !== -1 && direction !== 0 && direction !== 1) {
    throw new RangeError(`Dirección inválida: ${direction} (debe ser -1, 0 o 1)`);
  }
  return clampAngle(min, max, currentAngle + direction * stepDegrees);
}

function assertValidSlot(slot) {
  const n = Number(slot);
  if (!Number.isInteger(n) || n < 1 || n > RECORDING_SLOT_COUNT) {
    throw new RangeError(`Slot de grabación inválido: ${slot} (debe ser 1-${RECORDING_SLOT_COUNT})`);
  }
  return n;
}

/** Construye los comandos de texto relacionados con grabaciones. */
export const buildRecordingCommand = Object.freeze({
  start: (slot) => `REC:START:${assertValidSlot(slot)}`,
  play: (slot) => `REC:PLAY:${assertValidSlot(slot)}`,
  clear: (slot) => `REC:CLEAR:${assertValidSlot(slot)}`,
  clearAll: () => 'REC:CLEAR:ALL',
  stop: () => 'REC:STOP',
  requestSlots: () => 'REC:SLOTS?',
  validate: () => 'REC:VALIDATE?',
});

export const buildIdentityCommand = Object.freeze({
  id: () => 'ID?',
  ping: () => 'PING',
});

/**
 * Interpreta una línea de texto recibida del firmware y la convierte en un
 * objeto estructurado con un campo `type` discriminante. Las líneas que no
 * se reconocen devuelven `{ type: 'unknown', raw }` en vez de lanzar error,
 * porque el enlace BLE es no confiable y no debe tumbar la interfaz por un
 * mensaje inesperado o cortado.
 *
 * @param {string} rawLine
 */
export function parseIncomingLine(rawLine) {
  const line = String(rawLine ?? '').trim();
  if (line.length === 0) {
    return null;
  }

  if (line === 'READY') {
    return { type: 'ready', raw: line };
  }
  if (line === 'HB:ALIVE') {
    return { type: 'heartbeat', raw: line };
  }
  if (line === 'WARN:LINK:LOST') {
    return { type: 'linkLost', raw: line };
  }
  if (line === 'INFO:LINK:RESTORED') {
    return { type: 'linkRestored', raw: line };
  }
  if (line === 'REC:FULL') {
    return { type: 'recFull', raw: line };
  }
  if (line.startsWith('ID ')) {
    return { type: 'firmwareId', firmwareId: line.slice(3).trim(), raw: line };
  }
  if (line.startsWith('REC:SLOTS:')) {
    const bits = line.slice('REC:SLOTS:'.length).trim();
    const slots = bits.split('').map((c) => c === '1');
    return { type: 'recSlots', slots, raw: line };
  }
  if (line.startsWith('REC:STARTED:')) {
    return { type: 'recStarted', slot: Number(line.slice('REC:STARTED:'.length)), raw: line };
  }
  if (line.startsWith('REC:STOPPED:')) {
    return { type: 'recStopped', slot: Number(line.slice('REC:STOPPED:'.length)), raw: line };
  }
  if (line === 'REC:CLEARED:ALL') {
    return { type: 'recClearedAll', raw: line };
  }
  if (line.startsWith('REC:CLEARED:')) {
    return { type: 'recCleared', slot: Number(line.slice('REC:CLEARED:'.length)), raw: line };
  }
  if (line.startsWith('REC:PLAYING:')) {
    return { type: 'recPlaying', slot: Number(line.slice('REC:PLAYING:'.length)), raw: line };
  }
  if (line.startsWith('REC:PLAYED:')) {
    return { type: 'recPlayed', slot: Number(line.slice('REC:PLAYED:'.length)), raw: line };
  }
  if (line.startsWith('REC:EMPTY:')) {
    return { type: 'recEmpty', slot: Number(line.slice('REC:EMPTY:'.length)), raw: line };
  }
  if (line === 'REC:VALID:SAVED') {
    return { type: 'recValidate', valid: true, hasSaved: true, raw: line };
  }
  if (line === 'REC:VALID:EMPTY') {
    return { type: 'recValidate', valid: true, hasSaved: false, raw: line };
  }
  if (line === 'REC:INVALID:SAVED') {
    return { type: 'recValidate', valid: false, hasSaved: true, raw: line };
  }
  if (line === 'REC:INVALID:EMPTY') {
    return { type: 'recValidate', valid: false, hasSaved: false, raw: line };
  }

  // Heurística: el firmware manda su ID "pelado" (sin prefijo) como saludo
  // al conectar o como respuesta a PING/HELLO.
  if (/^[A-Za-z0-9_-]{6,}$/.test(line)) {
    return { type: 'firmwareGreeting', firmwareId: line, raw: line };
  }

  return { type: 'unknown', raw: line };
}
