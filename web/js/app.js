/**
 * app.js
 * ----------------------------------------------------------------------------
 * Punto de entrada: conecta la capa de transporte (ble.js), la lógica de
 * protocolo (protocol.js) y la capa visual (ui.js). Aquí vive el "estado"
 * de la aplicación y las reglas de cuándo mostrar qué.
 * ----------------------------------------------------------------------------
 */

import { GruaBleClient, BluetoothNotSupportedError } from './ble.js';
import {
  SERVOS,
  buildServoCommand,
  buildRecordingCommand,
  buildIdentityCommand,
  parseIncomingLine,
  nextAngleForDirection,
  GRIPPER_OPEN_ANGLE,
  GRIPPER_CLOSED_ANGLE,
} from './protocol.js';
import { createServoSliders, createRecordingSlots, setConnectionStatus, appendLog, clearLog } from './ui.js';

// ----------------------------------------------------------------------------
// Referencias al DOM
// ----------------------------------------------------------------------------
const els = {
  unsupportedBanner: document.getElementById('unsupportedBanner'),
  linkLostBanner: document.getElementById('linkLostBanner'),
  welcomePanel: document.getElementById('welcomePanel'),
  controlPanel: document.getElementById('controlPanel'),
  connectButton: document.getElementById('connectButton'),
  disconnectButton: document.getElementById('disconnectButton'),
  linkStatusDot: document.getElementById('linkStatusDot'),
  connectionLabel: document.getElementById('connectionLabel'),
  servoSliders: document.getElementById('servoSliders'),
  gripperOpenButton: document.getElementById('gripperOpenButton'),
  gripperCloseButton: document.getElementById('gripperCloseButton'),
  recordingSlots: document.getElementById('recordingSlots'),
  clearAllRecordingsButton: document.getElementById('clearAllRecordingsButton'),
  activityLog: document.getElementById('activityLog'),
  clearLogButton: document.getElementById('clearLogButton'),
  firmwareIdLabel: document.getElementById('firmwareIdLabel'),
};

// ----------------------------------------------------------------------------
// Utilidad: throttle con "trailing call" (manda el último valor pendiente)
// Evita saturar el enlace BLE cuando se arrastra un slider muy rápido.
// ----------------------------------------------------------------------------
function throttle(fn, waitMs) {
  let lastCallAt = 0;
  let pendingArgs = null;
  let timer = null;

  const flush = () => {
    lastCallAt = Date.now();
    timer = null;
    if (pendingArgs) {
      const args = pendingArgs;
      pendingArgs = null;
      fn(...args);
    }
  };

  return (...args) => {
    const elapsed = Date.now() - lastCallAt;
    pendingArgs = args;
    if (elapsed >= waitMs) {
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, waitMs - elapsed);
    }
  };
}

// ----------------------------------------------------------------------------
// Estado de la aplicación
// ----------------------------------------------------------------------------
const ble = new GruaBleClient();
let recSlotBits = [false, false, false, false, false, false];
let activeRecordingSlot = null;
let activePlayingSlot = null;
let lastAnyMessageAt = 0;

function log(message, kind = 'info') {
  appendLog(els.activityLog, message, kind);
}

function refreshSlotUi() {
  for (let slot = 1; slot <= 6; slot += 1) {
    let state = recSlotBits[slot - 1] ? 'saved' : 'empty';
    if (slot === activeRecordingSlot) state = 'recording';
    else if (slot === activePlayingSlot) state = 'playing';
    slotControls[slot]?.setState(state);
  }
}

// ----------------------------------------------------------------------------
// Controles: servos (sliders de ajuste fino + mando tipo videojuego)
// ----------------------------------------------------------------------------
// Cada servo tiene su propio throttle independiente: así, si se mueven dos
// servos a la vez (por ejemplo Base + Hombro en diagonal con el D-pad, o dos
// teclas de flecha al tiempo), ninguno le "roba" el turno de envío al otro.
const throttledServoSenders = {};
function sendServoThrottled(servoKey, uiValue) {
  if (!throttledServoSenders[servoKey]) {
    throttledServoSenders[servoKey] = throttle(async (value) => {
      try {
        const { command } = buildServoCommand(servoKey, value);
        await ble.send(command);
      } catch (error) {
        log(`Error enviando comando de servo: ${error.message}`, 'error');
      }
    }, 40); // ~25 comandos/seg como máximo por servo: fluido y sin saturar el enlace
  }
  throttledServoSenders[servoKey](uiValue);
}

// Última posición conocida de cada servo (ángulo "de interfaz", antes del
// espejado). Es la referencia que usa el mando tipo videojuego para saber
// desde dónde seguir sumando/restando grados mientras se mantiene presionado.
const currentAngles = {};
for (const [key, config] of Object.entries(SERVOS)) {
  currentAngles[key] = config.default;
}

function updateServo(servoKey, rawValue) {
  const { uiValue } = buildServoCommand(servoKey, rawValue);
  currentAngles[servoKey] = uiValue;
  servoControls[servoKey].setValue(uiValue);
  sendServoThrottled(servoKey, uiValue);
}

const servoControls = createServoSliders(els.servoSliders, (servoKey, uiValue) => {
  if (!ble.isConnected) {
    log('Conecta la grúa antes de mover los servos.', 'warning');
    return;
  }
  updateServo(servoKey, uiValue);
});

let gripperIsOpen = false; // el firmware arranca con la garra cerrada (145°, ver GRIPPER_CLOSED_ANGLE)

async function setGripper(angle) {
  if (!ble.isConnected) {
    log('Conecta la grúa antes de mover la garra.', 'warning');
    return;
  }
  gripperIsOpen = angle === GRIPPER_OPEN_ANGLE;
  updateServo('pinza', angle);
}

function toggleGripper() {
  setGripper(gripperIsOpen ? GRIPPER_CLOSED_ANGLE : GRIPPER_OPEN_ANGLE);
}

els.gripperOpenButton.addEventListener('click', () => setGripper(GRIPPER_OPEN_ANGLE));
els.gripperCloseButton.addEventListener('click', () => setGripper(GRIPPER_CLOSED_ANGLE));

// ----------------------------------------------------------------------------
// Mando tipo videojuego: mantener presionado un botón (o una tecla) mueve el
// servo correspondiente de a poco, igual que el joystick físico del sketch
// original (JOY_SPEED por ciclo), pero disparado desde botones en pantalla o
// el teclado en vez de un potenciómetro.
//
// Convención de signos (si al probarlo alguna dirección queda "al revés"
// respecto al movimiento físico real de tu grúa, solo cambia el -1/1 de la
// dirección correspondiente aquí abajo):
//   - Base:   Derecha = +1 · Izquierda = -1
//   - Hombro: Arriba  = +1 · Abajo     = -1
//   - Codo:   Extender = +1 · Recoger  = -1
// ----------------------------------------------------------------------------
const GAMEPAD_STEP_DEGREES = 3;
const GAMEPAD_TICK_MS = 45;

const activeDirections = new Set();
let moveLoopHandle = null;

function moveLoopTick() {
  const baseDir = (activeDirections.has('right') ? 1 : 0) - (activeDirections.has('left') ? 1 : 0);
  const hombroDir = (activeDirections.has('up') ? 1 : 0) - (activeDirections.has('down') ? 1 : 0);
  const codoDir = (activeDirections.has('extend') ? 1 : 0) - (activeDirections.has('retract') ? 1 : 0);

  if (baseDir !== 0) {
    updateServo('base', nextAngleForDirection(SERVOS.base.min, SERVOS.base.max, currentAngles.base, baseDir, GAMEPAD_STEP_DEGREES));
  }
  if (hombroDir !== 0) {
    updateServo(
      'hombro',
      nextAngleForDirection(SERVOS.hombro.min, SERVOS.hombro.max, currentAngles.hombro, hombroDir, GAMEPAD_STEP_DEGREES)
    );
  }
  if (codoDir !== 0) {
    updateServo('codo', nextAngleForDirection(SERVOS.codo.min, SERVOS.codo.max, currentAngles.codo, codoDir, GAMEPAD_STEP_DEGREES));
  }
}

function startMoveLoop() {
  if (moveLoopHandle === null) {
    moveLoopHandle = setInterval(moveLoopTick, GAMEPAD_TICK_MS);
  }
}

function stopMoveLoop() {
  if (moveLoopHandle !== null) {
    clearInterval(moveLoopHandle);
    moveLoopHandle = null;
  }
}

const directionButtons = document.querySelectorAll('.panel--gamepad [data-direction]');
const directionButtonByName = {};
directionButtons.forEach((button) => {
  directionButtonByName[button.dataset.direction] = button;
});

function setDirectionHighlight(direction, isActive) {
  directionButtonByName[direction]?.classList.toggle('is-active', isActive);
}

function beginDirection(direction) {
  if (!ble.isConnected) {
    log('Conecta la grúa antes de moverla.', 'warning');
    return;
  }
  if (!activeDirections.has(direction)) {
    activeDirections.add(direction);
    setDirectionHighlight(direction, true);
    startMoveLoop();
  }
}

function endDirection(direction) {
  activeDirections.delete(direction);
  setDirectionHighlight(direction, false);
  if (activeDirections.size === 0) {
    stopMoveLoop();
  }
}

function endAllDirections() {
  for (const direction of [...activeDirections]) {
    endDirection(direction);
  }
}

directionButtons.forEach((button) => {
  const direction = button.dataset.direction;
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    beginDirection(direction);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((eventName) => {
    button.addEventListener(eventName, () => endDirection(direction));
  });
});

// Salvaguarda: si la pestaña/ventana pierde el foco mientras se mantenía
// presionado un control (alt-tab, cambia de app en el celular, etc.), no
// debe quedar un servo "moviéndose solo" en segundo plano.
window.addEventListener('blur', endAllDirections);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) endAllDirections();
});

const KEY_TO_DIRECTION = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  q: 'retract',
  Q: 'retract',
  e: 'extend',
  E: 'extend',
};

window.addEventListener('keydown', (event) => {
  if (event.repeat) return; // el auto-repeat del teclado no debe reiniciar el conteo
  if (event.target instanceof HTMLInputElement) return; // no interferir con los sliders

  const direction = KEY_TO_DIRECTION[event.key];
  if (direction) {
    event.preventDefault();
    beginDirection(direction);
    return;
  }
  if (event.code === 'Space' && !els.controlPanel.hidden) {
    event.preventDefault();
    toggleGripper();
  }
});

window.addEventListener('keyup', (event) => {
  const direction = KEY_TO_DIRECTION[event.key];
  if (direction) {
    event.preventDefault();
    endDirection(direction);
  }
});

// ----------------------------------------------------------------------------
// Controles: grabaciones
// ----------------------------------------------------------------------------
async function sendRecCommand(command, description) {
  if (!ble.isConnected) {
    log('Conecta la grúa antes de usar las grabaciones.', 'warning');
    return;
  }
  try {
    await ble.send(command);
  } catch (error) {
    log(`Error en «${description}»: ${error.message}`, 'error');
  }
}

const slotControls = createRecordingSlots(els.recordingSlots, {
  onStart: (slot) => sendRecCommand(buildRecordingCommand.start(slot), `grabar slot ${slot}`),
  onStop: () => sendRecCommand(buildRecordingCommand.stop(), 'detener grabación'),
  onPlay: (slot) => sendRecCommand(buildRecordingCommand.play(slot), `reproducir slot ${slot}`),
  onClear: (slot) => sendRecCommand(buildRecordingCommand.clear(slot), `borrar slot ${slot}`),
});

els.clearAllRecordingsButton.addEventListener('click', () => {
  if (window.confirm('¿Borrar los 6 slots de grabación? Esta acción no se puede deshacer.')) {
    sendRecCommand(buildRecordingCommand.clearAll(), 'borrar todas las grabaciones');
  }
});

els.clearLogButton.addEventListener('click', () => clearLog(els.activityLog));

// ----------------------------------------------------------------------------
// Conexión / desconexión
// ----------------------------------------------------------------------------
els.connectButton.addEventListener('click', async () => {
  setConnectionStatus(els.linkStatusDot, els.connectionLabel, 'connecting');
  els.connectButton.disabled = true;
  try {
    await ble.connect();
  } catch (error) {
    els.connectButton.disabled = false;
    setConnectionStatus(els.linkStatusDot, els.connectionLabel, 'offline');
    if (error?.name === 'NotFoundError') {
      // La persona cerró el selector de dispositivos sin elegir ninguno: no es un error real.
      log('Selección de dispositivo cancelada.', 'info');
      return;
    }
    log(`No se pudo conectar: ${error.message}`, 'error');
  }
});

els.disconnectButton.addEventListener('click', () => ble.disconnect());

/**
 * Mueve un servo gradualmente hasta un ángulo objetivo (en vez de saltar de
 * golpe), igual que hacía la app de escritorio original al conectar.
 */
function rampServoTo(servoKey, targetAngle, stepDegrees = 2, delayMs = 20) {
  return new Promise((resolve) => {
    const id = setInterval(() => {
      const current = currentAngles[servoKey];
      if (current === targetAngle) {
        clearInterval(id);
        resolve();
        return;
      }
      const direction = targetAngle > current ? 1 : -1;
      const step = Math.min(stepDegrees, Math.abs(targetAngle - current));
      updateServo(servoKey, current + direction * step);
      if (currentAngles[servoKey] === targetAngle) {
        clearInterval(id);
        resolve();
      }
    }, delayMs);
  });
}

/** Lleva los 4 servos a su posición conocida de "inicio" al conectar. */
async function rampAllToDefaults() {
  await Promise.all(Object.entries(SERVOS).map(([key, config]) => rampServoTo(key, config.default)));
  gripperIsOpen = currentAngles.pinza === GRIPPER_OPEN_ANGLE;
}

ble.addEventListener('connected', async ({ detail }) => {
  lastAnyMessageAt = Date.now();
  setConnectionStatus(els.linkStatusDot, els.connectionLabel, 'online');
  els.connectButton.hidden = true;
  els.connectButton.disabled = false;
  els.disconnectButton.hidden = false;
  els.welcomePanel.hidden = true;
  els.controlPanel.hidden = false;
  els.linkLostBanner.hidden = true;
  log(`Conectado a «${detail.deviceName ?? 'la grúa'}».`, 'success');

  // El firmware manda un saludo (ID + READY + estado de slots) apenas se
  // conecta, pero lo volvemos a pedir explícitamente por si esa primera
  // ráfaga se perdiera o llegara antes de que termináramos de suscribirnos.
  try {
    await ble.send(buildIdentityCommand.id());
    await ble.send(buildRecordingCommand.requestSlots());
  } catch (error) {
    log(`No se pudo pedir el estado inicial: ${error.message}`, 'warning');
  }

  log('Llevando la grúa a la posición inicial…', 'info');
  await rampAllToDefaults();
});

ble.addEventListener('disconnected', () => {
  setConnectionStatus(els.linkStatusDot, els.connectionLabel, 'offline');
  els.connectButton.hidden = false;
  els.disconnectButton.hidden = true;
  els.controlPanel.hidden = true;
  els.welcomePanel.hidden = false;
  els.linkLostBanner.hidden = true;
  activeRecordingSlot = null;
  activePlayingSlot = null;
  endAllDirections();
  stopMoveLoop();
  log('Desconectado.', 'warning');
});

ble.addEventListener('line', ({ detail }) => {
  lastAnyMessageAt = Date.now();
  const event = parseIncomingLine(detail.line);
  if (!event) return;

  switch (event.type) {
    case 'ready':
      log('La grúa está lista.', 'success');
      break;
    case 'heartbeat':
      if (els.linkStatusDot.classList.contains('status-dot--warning')) {
        setConnectionStatus(els.linkStatusDot, els.connectionLabel, 'online');
      }
      break;
    case 'linkLost':
      setConnectionStatus(els.linkStatusDot, els.connectionLabel, 'warning');
      els.linkLostBanner.hidden = false;
      log('La grúa reporta pérdida de enlace (sin comandos por 7s).', 'warning');
      break;
    case 'linkRestored':
      setConnectionStatus(els.linkStatusDot, els.connectionLabel, 'online');
      els.linkLostBanner.hidden = true;
      log('Enlace restablecido.', 'success');
      break;
    case 'firmwareId':
    case 'firmwareGreeting':
      els.firmwareIdLabel.textContent = event.firmwareId;
      log(`Firmware: ${event.firmwareId}`, 'info');
      break;
    case 'recSlots':
      recSlotBits = event.slots;
      refreshSlotUi();
      break;
    case 'recStarted':
      activeRecordingSlot = event.slot;
      refreshSlotUi();
      log(`Grabando en el slot ${event.slot}…`, 'info');
      break;
    case 'recStopped':
      activeRecordingSlot = null;
      refreshSlotUi();
      if (event.slot > 0) log(`Grabación del slot ${event.slot} guardada.`, 'success');
      break;
    case 'recCleared':
      log(`Slot ${event.slot} borrado.`, 'info');
      break;
    case 'recClearedAll':
      log('Todos los slots fueron borrados.', 'info');
      break;
    case 'recPlaying':
      activePlayingSlot = event.slot;
      refreshSlotUi();
      log(`Reproduciendo slot ${event.slot}…`, 'info');
      break;
    case 'recPlayed':
      activePlayingSlot = null;
      refreshSlotUi();
      log(`Reproducción del slot ${event.slot} terminada.`, 'success');
      break;
    case 'recEmpty':
      log(`El slot ${event.slot} está vacío, no hay nada que reproducir.`, 'warning');
      break;
    case 'recFull':
      activeRecordingSlot = null;
      refreshSlotUi();
      log('Se alcanzó el máximo de fotogramas: la grabación se detuvo automáticamente.', 'warning');
      break;
    case 'recValidate':
      log(
        `Memoria de grabaciones: ${event.valid ? 'OK' : 'dañada'} (${event.hasSaved ? 'con datos guardados' : 'vacía'}).`,
        event.valid ? 'info' : 'error'
      );
      break;
    default:
      // Línea no reconocida: se muestra igual en el log para depurar, pero sin alarmar a la UI.
      log(event.raw, 'info');
  }
});

// ----------------------------------------------------------------------------
// Envío periódico de PING: mantiene vivo el enlace ante el firmware aunque
// la persona no esté moviendo sliders (el firmware corta la grabación activa
// y avisa WARN:LINK:LOST si no recibe nada por 7s).
// ----------------------------------------------------------------------------
setInterval(() => {
  if (ble.isConnected) {
    ble.send(buildIdentityCommand.ping()).catch(() => {
      /* si falla, el propio evento 'disconnected' de BLE ya se encarga de avisar */
    });
  }
}, 3000);

// Vigilante local: si hace demasiado tiempo que no llega NINGÚN dato del
// dispositivo (más allá de lo que el propio firmware tarda en avisar),
// lo reflejamos igual en el punto de estado como salvaguarda extra.
setInterval(() => {
  if (!ble.isConnected) return;
  const idleMs = Date.now() - lastAnyMessageAt;
  if (idleMs > 9000 && !els.linkStatusDot.classList.contains('status-dot--warning')) {
    setConnectionStatus(els.linkStatusDot, els.connectionLabel, 'warning', 'Sin datos recientes');
  }
}, 2000);

// ----------------------------------------------------------------------------
// Arranque: valida soporte del navegador
// ----------------------------------------------------------------------------
if (!GruaBleClient.isSupported()) {
  els.unsupportedBanner.hidden = false;
  els.connectButton.disabled = true;
  els.connectButton.title = new BluetoothNotSupportedError().message;
}
