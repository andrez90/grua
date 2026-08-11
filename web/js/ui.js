/**
 * ui.js
 * ----------------------------------------------------------------------------
 * Todo lo que toca el DOM vive aquí: construir los controles (sliders de
 * servos, tarjetas de grabación), pintar el log de actividad y reflejar el
 * estado de la conexión. No sabe nada de BLE ni del protocolo de comandos;
 * recibe callbacks y los invoca cuando la persona interactúa.
 * ----------------------------------------------------------------------------
 */

import { SERVOS, RECORDING_SLOT_COUNT } from './protocol.js';

const MAX_LOG_ENTRIES = 300;

/**
 * Crea un slider por cada servo definido en protocol.js y lo agrega al
 * contenedor. Devuelve un mapa `clave -> { setValue(uiValue) }` para que
 * quien llama pueda re-sincronizar el slider si el ángulo fue recortado.
 *
 * @param {HTMLElement} container
 * @param {(servoKey: string, uiValue: number) => void} onChange
 */
export function createServoSliders(container, onChange) {
  container.innerHTML = '';
  const controls = {};

  for (const [key, config] of Object.entries(SERVOS)) {
    const wrapper = document.createElement('div');
    wrapper.className = 'servo-control';

    const label = document.createElement('label');
    label.className = 'servo-control__label';
    label.textContent = config.label;
    label.htmlFor = `servo-${key}`;

    const valueLabel = document.createElement('span');
    valueLabel.className = 'servo-control__value';
    valueLabel.id = `servo-${key}-value`;
    valueLabel.textContent = `${config.default}°`;

    const input = document.createElement('input');
    input.type = 'range';
    input.id = `servo-${key}`;
    input.min = String(config.min);
    input.max = String(config.max);
    input.value = String(config.default);
    input.setAttribute('aria-describedby', valueLabel.id);
    input.setAttribute('aria-label', `Ángulo del servo ${config.label}`);

    input.addEventListener('input', () => {
      const uiValue = Number(input.value);
      valueLabel.textContent = `${uiValue}°`;
      onChange(key, uiValue);
    });

    wrapper.append(label, valueLabel, input);
    container.appendChild(wrapper);

    controls[key] = {
      setValue(uiValue) {
        input.value = String(uiValue);
        valueLabel.textContent = `${uiValue}°`;
      },
    };
  }

  return controls;
}

const SLOT_BADGE_TEXT = {
  empty: 'Vacío',
  saved: 'Guardado',
  recording: 'Grabando…',
  playing: 'Reproduciendo…',
};

/**
 * Crea las 6 tarjetas de slots de grabación.
 *
 * @param {HTMLElement} container
 * @param {{ onStart(slot:number):void, onStop(slot:number):void, onPlay(slot:number):void, onClear(slot:number):void }} handlers
 */
export function createRecordingSlots(container, handlers) {
  container.innerHTML = '';
  const slotControls = {};

  for (let slot = 1; slot <= RECORDING_SLOT_COUNT; slot += 1) {
    const card = document.createElement('div');
    card.className = 'recording-slot';

    const title = document.createElement('div');
    title.className = 'recording-slot__title';

    const titleText = document.createElement('span');
    titleText.textContent = `Slot ${slot}`;

    const badge = document.createElement('span');
    badge.className = 'recording-slot__badge';
    badge.textContent = SLOT_BADGE_TEXT.empty;

    title.append(titleText, badge);

    const actions = document.createElement('div');
    actions.className = 'recording-slot__actions';

    const recordButton = document.createElement('button');
    recordButton.type = 'button';
    recordButton.className = 'btn btn--small btn--pink';
    recordButton.textContent = '● Grabar';
    recordButton.addEventListener('click', () => {
      if (recordButton.dataset.recording === 'true') {
        handlers.onStop(slot);
      } else {
        handlers.onStart(slot);
      }
    });

    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = 'btn btn--small btn--mint';
    playButton.textContent = '▶ Reproducir';
    playButton.addEventListener('click', () => handlers.onPlay(slot));

    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'btn btn--small btn--ghost';
    clearButton.textContent = 'Borrar';
    clearButton.addEventListener('click', () => handlers.onClear(slot));

    actions.append(recordButton, playButton, clearButton);
    card.append(title, actions);
    container.appendChild(card);

    slotControls[slot] = {
      /** @param {'empty'|'saved'|'recording'|'playing'} state */
      setState(state) {
        badge.textContent = SLOT_BADGE_TEXT[state] ?? state;
        badge.className = 'recording-slot__badge';
        if (state === 'saved') badge.classList.add('recording-slot__badge--saved');
        if (state === 'recording') badge.classList.add('recording-slot__badge--recording');
        if (state === 'playing') badge.classList.add('recording-slot__badge--playing');

        recordButton.dataset.recording = state === 'recording' ? 'true' : 'false';
        recordButton.textContent = state === 'recording' ? '■ Detener' : '● Grabar';
        playButton.disabled = state === 'empty' || state === 'recording';
      },
    };
  }

  return slotControls;
}

/**
 * @param {HTMLElement} dotEl
 * @param {HTMLElement} labelEl
 * @param {'offline'|'connecting'|'online'|'warning'} state
 * @param {string} [text]
 */
export function setConnectionStatus(dotEl, labelEl, state, text) {
  dotEl.className = `status-dot status-dot--${state}`;
  const defaults = {
    offline: 'Desconectado',
    connecting: 'Conectando…',
    online: 'Conectado',
    warning: 'Sin respuesta',
  };
  labelEl.textContent = text ?? defaults[state] ?? state;
}

/**
 * Agrega una entrada al log de actividad visible en pantalla.
 * @param {HTMLElement} listEl
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [kind]
 */
export function appendLog(listEl, message, kind = 'info') {
  const item = document.createElement('li');
  const timestamp = new Date().toLocaleTimeString('es-CO', { hour12: false });
  item.textContent = `[${timestamp}] ${message}`;
  item.dataset.kind = kind;
  listEl.appendChild(item);
  listEl.scrollTop = listEl.scrollHeight;

  while (listEl.children.length > MAX_LOG_ENTRIES) {
    listEl.removeChild(listEl.firstChild);
  }
}

export function clearLog(listEl) {
  listEl.innerHTML = '';
}
