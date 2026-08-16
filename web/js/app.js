/**
 * app.js
 * ----------------------------------------------------------------------------
 * Punto de entrada: conecta la capa de transporte (ble.js), la l├│gica de
 * protocolo (protocol.js) y la capa visual (ui.js). Aqu├¡ vive el "estado"
 * de la aplicaci├│n y las reglas de cu├índo mostrar qu├®.
 * ----------------------------------------------------------------------------
 */

import { GruaBleClient, BluetoothNotSupportedError } from './ble.js';
import { GruaSerialClient, SerialNotSupportedError } from './serial.js';
import { MouseControl } from './mouseControl.js';
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
  connectUsbButton: document.getElementById('connectUsbButton'),
  disconnectButton: document.getElementById('disconnectButton'),
  linkStatusDot: document.getElementById('linkStatusDot'),
  autoConnectionHint: document.getElementById('autoConnectionHint'),
  connectionLabel: document.getElementById('connectionLabel'),
  mouseControlZone: document.getElementById('mouseControlZone'),
  mouseCtrBaseValue: document.getElementById('mouseCtrBaseValue'),
  mouseCtrHombroValue: document.getElementById('mouseCtrHombroValue'),
  mouseCtrCodoValue: document.getElementById('mouseCtrCodoValue'),
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
// Utilidad: throttle con "trailing call" (manda el ├║ltimo valor pendiente)
// Evita saturar el enlace BLE cuando se arrastra un slider muy r├ípido.
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
// Estado de la aplicaci├│n
// ----------------------------------------------------------------------------
const ble = new GruaBleClient();
const serial = new GruaSerialClient();
let mouseControl = null; // Se inicializa cuando se conecta
let activeConnection = null;
let recSlotBits = [false, false, false, false, false, false];
let activeRecordingSlot = null;
let activePlayingSlot = null;
let lastAnyMessageAt = 0;

const transport = {
  get isConnected() {
    return Boolean(activeConnection?.isConnected);
  },
  async send(command) {
    if (!activeConnection) {
      throw new Error('No hay ninguna conexi├│n activa.');
    }
    return activeConnection.send(command);
  },
  async connect(kind = 'ble') {
    const nextClient = kind === 'usb' ? serial : ble;
    const otherClient = kind === 'usb' ? ble : serial;

    if (otherClient?.isConnected) {
      await otherClient.disconnect();
    }

    if (nextClient.isConnected) {
      activeConnection = nextClient;
      return;
    }

    activeConnection = nextClient;
    return nextClient.connect();
  },
  async disconnect() {
    if (!activeConnection) return;
    await activeConnection.disconnect();
    activeConnection = null;
  },
  addEventListener(eventName, handler) {
    ble.addEventListener(eventName, handler);
    serial.addEventListener(eventName, handler);
  },
  removeEventListener(eventName, handler) {
    ble.removeEventListener(eventName, handler);
    serial.removeEventListener(eventName, handler);
  },
};

function log(message, kind = 'info') {
  appendLog(els.activityLog, message, kind);
}

function setAutoConnectionHint(message) {
  if (els.autoConnectionHint) {
    els.autoConnectionHint.textContent = message;
  }
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
// Cada servo tiene su propio throttle independiente: as├¡, si se mueven dos
// servos a la vez (por ejemplo Base + Hombro en diagonal con el D-pad, o dos
// teclas de flecha al tiempo), ninguno le "roba" el turno de env├¡o al otro.
const throttledServoSenders = {};
function sendServoThrottled(servoKey, uiValue) {
  if (!throttledServoSenders[servoKey]) {
    throttledServoSenders[servoKey] = throttle(async (value) => {
      try {
        const { command } = buildServoCommand(servoKey, value);
        await transport.send(command);
      } catch (error) {
        log(`Error enviando comando de servo: ${error.message}`, 'error');
      }
    }, 40); // ~25 comandos/seg como m├íximo por servo: fluido y sin saturar el enlace
  }
  throttledServoSenders[servoKey](uiValue);
}

// ├Ültima posici├│n conocida de cada servo (├íngulo "de interfaz", antes del
// espejado). Es la referencia que usa el mando tipo videojuego para saber
// desde d├│nde seguir sumando/restando grados mientras se mantiene presionado.
const currentAngles = {};
for (const [key, config] of Object.entries(SERVOS)) {
  currentAngles[key] = config.default;
}

function updateServo(servoKey, rawValue) {
  const { uiValue } = buildServoCommand(servoKey, rawValue);
  currentAngles[servoKey] = uiValue;
  servoControls[servoKey].setValue(uiValue);
  sendServoThrottled(servoKey, uiValue);
  
  // Actualizar la información visual en mouseControl
  if (servoKey === 'base' && els.mouseCtrBaseValue) {
    els.mouseCtrBaseValue.textContent = uiValue;
  } else if (servoKey === 'hombro' && els.mouseCtrHombroValue) {
    els.mouseCtrHombroValue.textContent = uiValue;
  } else if (servoKey === 'codo' && els.mouseCtrCodoValue) {
    els.mouseCtrCodoValue.textContent = uiValue;
  }
}

const servoControls = createServoSliders(els.servoSliders, (servoKey, uiValue) => {
  if (!transport.isConnected) {
    log('Conecta la gr├║a antes de mover los servos.', 'warning');
    return;
  }
  updateServo(servoKey, uiValue);
});

let gripperIsOpen = false; // el firmware arranca con la garra cerrada (145┬░, ver GRIPPER_CLOSED_ANGLE)

async function setGripper(angle) {
  if (!transport.isConnected) {
    log('Conecta la gr├║a antes de mover la garra.', 'warning');
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
// Mando tipo videojuego: mantener presionado un bot├│n (o una tecla) mueve el
// servo correspondiente de a poco, igual que el joystick f├¡sico del sketch
// original (JOY_SPEED por ciclo), pero disparado desde botones en pantalla o
// el teclado en vez de un potenci├│metro.
//
// Convenci├│n de signos (si al probarlo alguna direcci├│n queda "al rev├®s"
// respecto al movimiento f├¡sico real de tu gr├║a, solo cambia el -1/1 de la
// direcci├│n correspondiente aqu├¡ abajo):
//   - Base:   Derecha = +1 ┬À Izquierda = -1
//   - Hombro: Arriba  = +1 ┬À Abajo     = -1
//   - Codo:   Extender = +1 ┬À Recoger  = -1
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
  if (!transport.isConnected) {
    log('Conecta la gr├║a antes de moverla.', 'warning');
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

// Salvaguarda: si la pesta├▒a/ventana pierde el foco mientras se manten├¡a
// presionado un control (alt-tab, cambia de app en el celular, etc.), no
// debe quedar un servo "movi├®ndose solo" en segundo plano.
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
  if (!transport.isConnected) {
    log('Conecta la gr├║a antes de usar las grabaciones.', 'warning');
    return;
  }
  try {
    await transport.send(command);
  } catch (error) {
    log(`Error en ┬½${description}┬╗: ${error.message}`, 'error');
  }
}

const slotControls = createRecordingSlots(els.recordingSlots, {
  onStart: (slot) => sendRecCommand(buildRecordingCommand.start(slot), `grabar slot ${slot}`),
  onStop: () => sendRecCommand(buildRecordingCommand.stop(), 'detener grabaci├│n'),
  onPlay: (slot) => sendRecCommand(buildRecordingCommand.play(slot), `reproducir slot ${slot}`),
  onClear: (slot) => sendRecCommand(buildRecordingCommand.clear(slot), `borrar slot ${slot}`),
});

els.clearAllRecordingsButton.addEventListener('click', () => {
  if (window.confirm('┬┐Borrar los 6 slots de grabaci├│n? Esta acci├│n no se puede deshacer.')) {
    sendRecCommand(buildRecordingCommand.clearAll(), 'borrar todas las grabaciones');
  }
});

els.clearLogButton.addEventListener('click', () => clearLog(els.activityLog));

// ----------------------------------------------------------------------------
// Conexi├│n / desconexi├│n
// ----------------------------------------------------------------------------
async function connectWithTransport(kind) {
  setConnectionStatus(els.linkStatusDot, els.connectionLabel, 'connecting');
  els.connectButton.disabled = true;
  els.connectUsbButton.disabled = true;
  try {
    await transport.connect(kind);
  } catch (error) {
    els.connectButton.disabled = false;
    els.connectUsbButton.disabled = false;
    setConnectionStatus(els.linkStatusDot, els.connectionLabel, 'offline');
    if (error?.name === 'NotFoundError' || error?.name === 'AbortError') {
      log('Selecci├│n de dispositivo cancelada.', 'info');
      return;
    }
    if (error?.name === 'SecurityError') {
      log('La conexi├│n USB requiere autorizar el puerto desde el navegador y abrir la p├ígina en localhost o HTTPS.', 'warning');
      setAutoConnectionHint('USB bloqueado por el navegador: autoriza el puerto y vuelve a intentarlo.');
      return;
    }
    log(`No se pudo conectar: ${error.message}`, 'error');
  }
}

els.connectButton.addEventListener('click', () => connectWithTransport('ble'));
els.connectUsbButton.addEventListener('click', () => connectWithTransport('usb'));

els.disconnectButton.addEventListener('click', async () => {
  await transport.disconnect();
});

/**
 * Mueve un servo gradualmente hasta un ├íngulo objetivo (en vez de saltar de
 * golpe), igual que hac├¡a la app de escritorio original al conectar.
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

/** Lleva los 4 servos a su posici├│n conocida de "inicio" al conectar. */
async function rampAllToDefaults() {
  await Promise.all(Object.entries(SERVOS).map(([key, config]) => rampServoTo(key, config.default)));
  gripperIsOpen = currentAngles.pinza === GRIPPER_OPEN_ANGLE;
}

transport.addEventListener('connected', async ({ detail }) => {
  lastAnyMessageAt = Date.now();
  setConnectionStatus(els.linkStatusDot, els.connectionLabel, 'online');
  els.connectButton.hidden = true;
  els.connectUsbButton.hidden = true;
  els.connectButton.disabled = false;
  els.connectUsbButton.disabled = false;
  els.disconnectButton.hidden = false;
  els.welcomePanel.hidden = true;
  els.controlPanel.hidden = false;
  els.linkLostBanner.hidden = true;
  log(`Conectado a ½${detail.deviceName ?? 'la grúa'}½.`, 'success');

  try {
    await transport.send(buildIdentityCommand.id());
    await transport.send(buildRecordingCommand.requestSlots());
  } catch (error) {
    log(`No se pudo pedir el estado inicial: ${error.message}`, 'warning');
  }

  log('Llevando la grúa a la posición inicialÔ¬¶', 'info');
  await rampAllToDefaults();

  // Inicializar control por mouse
  if (!mouseControl && els.mouseControlZone) {
    mouseControl = new MouseControl('#mouseControlZone', SERVOS);
    mouseControl.onServoChange((servoKey, angle) => {
      if (!transport.isConnected) return;
      updateServo(servoKey, angle);
    });
  }
});

transport.addEventListener('disconnected', () => {
  setConnectionStatus(els.linkStatusDot, els.connectionLabel, 'offline');
  els.connectButton.hidden = false;
  els.connectUsbButton.hidden = false;
  els.disconnectButton.hidden = true;
  els.controlPanel.hidden = true;
  els.welcomePanel.hidden = false;
  
  // Limpiar control por mouse
  if (mouseControl) {
    mouseControl.destroy();
    mouseControl = null;
  }
});
  els.linkLostBanner.hidden = true;
  activeConnection = null;
  activeRecordingSlot = null;
  activePlayingSlot = null;
  endAllDirections();
  stopMoveLoop();
  log('Desconectado.', 'warning');
});

transport.addEventListener('line', ({ detail }) => {
  lastAnyMessageAt = Date.now();
  const event = parseIncomingLine(detail.line);
  if (!event) return;

  switch (event.type) {
    case 'ready':
      log('La gr├║a est├í lista.', 'success');
      break;
    case 'heartbeat':
      if (els.linkStatusDot.classList.contains('status-dot--warning')) {
        setConnectionStatus(els.linkStatusDot, els.connectionLabel, 'online');
      }
      break;
    case 'linkLost':
      setConnectionStatus(els.linkStatusDot, els.connectionLabel, 'warning');
      els.linkLostBanner.hidden = false;
      log('La gr├║a reporta p├®rdida de enlace (sin comandos por 7s).', 'warning');
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
      log(`Grabando en el slot ${event.slot}ÔÇª`, 'info');
      break;
    case 'recStopped':
      activeRecordingSlot = null;
      refreshSlotUi();
      if (event.slot > 0) log(`Grabaci├│n del slot ${event.slot} guardada.`, 'success');
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
      log(`Reproduciendo slot ${event.slot}ÔÇª`, 'info');
      break;
    case 'recPlayed':
      activePlayingSlot = null;
      refreshSlotUi();
      log(`Reproducci├│n del slot ${event.slot} terminada.`, 'success');
      break;
    case 'recEmpty':
      log(`El slot ${event.slot} est├í vac├¡o, no hay nada que reproducir.`, 'warning');
      break;
    case 'recFull':
      activeRecordingSlot = null;
      refreshSlotUi();
      log('Se alcanz├│ el m├íximo de fotogramas: la grabaci├│n se detuvo autom├íticamente.', 'warning');
      break;
    case 'recValidate':
      log(
        `Memoria de grabaciones: ${event.valid ? 'OK' : 'da├▒ada'} (${event.hasSaved ? 'con datos guardados' : 'vac├¡a'}).`,
        event.valid ? 'info' : 'error'
      );
      break;
    default:
      // L├¡nea no reconocida: se muestra igual en el log para depurar, pero sin alarmar a la UI.
      log(event.raw, 'info');
  }
});

// ----------------------------------------------------------------------------
// Env├¡o peri├│dico de PING: mantiene vivo el enlace ante el firmware aunque
// la persona no est├® moviendo sliders (el firmware corta la grabaci├│n activa
// y avisa WARN:LINK:LOST si no recibe nada por 7s).
// ----------------------------------------------------------------------------
setInterval(() => {
  if (transport.isConnected) {
    transport.send(buildIdentityCommand.ping()).catch(() => {
      /* si falla, el propio evento 'disconnected' de la conexi├│n ya se encarga de avisar */
    });
  }
}, 3000);

// Vigilante local: si hace demasiado tiempo que no llega NING├ÜN dato del
// dispositivo (m├ís all├í de lo que el propio firmware tarda en avisar),
// lo reflejamos igual en el punto de estado como salvaguarda extra.
setInterval(() => {
  if (!transport.isConnected) return;
  const idleMs = Date.now() - lastAnyMessageAt;
  if (idleMs > 9000 && !els.linkStatusDot.classList.contains('status-dot--warning')) {
    setConnectionStatus(els.linkStatusDot, els.connectionLabel, 'warning', 'Sin datos recientes');
  }
}, 2000);

// ----------------------------------------------------------------------------
// Arranque: valida soporte del navegador
// ----------------------------------------------------------------------------
const supportsBle = GruaBleClient.isSupported();
const supportsSerial = GruaSerialClient.isSupported();

if (!supportsBle && !supportsSerial) {
  els.unsupportedBanner.hidden = false;
  els.connectButton.disabled = true;
  els.connectUsbButton.disabled = true;
  els.connectButton.title = new BluetoothNotSupportedError().message;
  els.connectUsbButton.title = new SerialNotSupportedError().message;
} else {
  if (!supportsBle) {
    els.connectButton.disabled = true;
    els.connectButton.title = new BluetoothNotSupportedError().message;
  }

  if (!supportsSerial) {
    els.connectUsbButton.disabled = true;
    els.connectUsbButton.title = new SerialNotSupportedError().message;
  }
}
async function autoDetectUsbConnection() {
  if (!GruaSerialClient.isSupported()) {
    setAutoConnectionHint('USB no disponible en este navegador.');
    return;
  }

  try {
    const ports = await navigator.serial.getPorts();
    if (ports.length > 0) {
      setAutoConnectionHint('✅ Arduino detectado por USB. Conectando…');
      await connectWithTransport('usb');
      return;
    }
    setAutoConnectionHint('📌 Primera vez: haz clic en "USB" para autorizar el puerto del Arduino.');
  } catch (error) {
    setAutoConnectionHint('📌 Haz clic en "USB" para conectar el Arduino.');
    log(`Detección automática USB: ${error.message}`, 'warning');
  }
}

if (supportsSerial) {
  void autoDetectUsbConnection();
}

